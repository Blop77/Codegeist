import type {
  DecisionCandidate,
  DecisionKind,
  ExtractionInput,
  ExtractionOptions,
  ExtractionResult,
  ExtractionWarning,
  IssueRecord,
  SentenceClassification,
  SentenceClassifier,
  SentenceContext,
  SourceRecord,
  SourceType,
} from './decisionTypes';
import { buildIssueIndex, jaccard, matchIssues, tokenSet } from './matchIssues';

export const MAX_QUOTE_LENGTH = 280;

// ---------------------------------------------------------------------------
// Default sentence rules
// ---------------------------------------------------------------------------

const SELF_REFERENCE = [
  /\b(?:this|the following)\s+(?:page|doc(?:ument)?|section|table|list|log)\s+(?:records|captures|lists|summari[sz]es|tracks|describes|contains)\b/i,
  /\bwhat (?:the team|we|everyone|the group) (?:decided|agreed)\b/i,
];

/**
 * Disclaimers that say a passage is not a real decision ("This is a sample decision, not an
 * approved team decision", "not a final decision", "for illustration only"). Skipped entirely,
 * so they never surface as decisions, proposals or open questions.
 */
const DISCLAIMER = [
  /\b(?:not|never|isn't|is not|wasn't|was not)\s+(?:yet\s+)?(?:an?\s+|the\s+)?(?:actual|real|official|approved|final|binding|formal|confirmed|agreed)\b[^.!?]{0,40}?\bdecisions?\b/i,
  /\b(?:not|isn't|is not|wasn't|was not)\s+(?:an?\s+|the\s+)?decision\b/i,
  /\b(?:this|it)\s+(?:is|was)\s+(?:only\s+|just\s+|purely\s+)?(?:an?\s+)?(?:sample|example|demo|dummy|placeholder|hypothetical|fictional|illustrative)\s+(?:\w+\s+){0,2}?(?:decision|data|page|content|entry|record|text)\b/i,
  /\bfor\s+(?:illustration|demonstration|testing)\s+(?:purposes\s+)?only\b/i,
];

const OPEN_LABEL = /^\s*(?:open (?:decision|question)|undecided|tbd)\s*[:\-–]/i;

const UNRESOLVED = [
  /\b(?:not|never|haven't|have not|hasn't|has not|didn't|did not|yet to|no)\s+(?:been\s+|yet\s+)?(?:decided|agreed|decision|reached a decision)\b/i,
  /\b(?:open question|tbd|to be (?:decided|determined|confirmed)|undecided|needs? to decide|pending (?:a )?decision|still deciding|not sure yet)\b/i,
];

const NEGATED_APPROVAL =
  /\b(?:(?:not|never|isn't|aren't|wasn't|weren't|hasn't|haven't|hadn't)\s+(?:(?:an?|been|yet|currently)\s+){0,2}|(?:nothing|no one|nobody|none)\s+(?:(?:has|have|had|was|were|is|been|yet)\s+){0,3})(?:approved|signed off)\b/i;

/**
 * "approved" used as a verb or label ("was approved by legal", "leadership approved the plan",
 * "Approved: …", "Budget approved."), not as an adjective ("Approved requests go to the queue").
 */
const APPROVAL =
  /\b(?:(?:is|was|were|are|been|be|being|got|gets|get|it|they|we|team|leadership|stakeholders|legal|management)\s+approved\b|approved\s+(?:by|the|this|that|these|those|it|them|our|their|a|an|on|for)\b|signed off\b)|^\s*approved\s*[:\-–]|\bapproved\s*[.!]*\s*$/i;

const EXPLICIT: Array<{ re: RegExp; confidence: number; reason: string; unless?: RegExp }> = [
  { re: /^\s*(?:final\s+)?decision\s*[:\-–]/i, confidence: 0.85, reason: 'Starts with a "Decision:" label' },
  { re: /^\s*(?:agreed|decided|resolved|outcome)\b[^.?!:]{0,40}:/i, confidence: 0.85, reason: 'Starts with an "Agreed:" or "Decided:" label' },
  {
    re: /\b(?:we|team|we've|we have|everyone|the group|stakeholders|leadership)\s+(?:all\s+)?(?:have\s+)?(?:decided|agreed|chose|chosen|settled on|signed off)\b/i,
    confidence: 0.8,
    reason: 'Says the team decided or agreed',
  },
  { re: /\b(?:decided|agreed)\s+(?:to|that|on)\b/i, confidence: 0.8, reason: 'Says something was decided or agreed' },
  { re: /\bfinal (?:call|decision)\b/i, confidence: 0.8, reason: 'Calls it a final decision' },
  { re: /\b(?:we(?:'ll| will| are|'re))\s+(?:going\s+(?:with|to go with)|go(?:ing)? with)\b/i, confidence: 0.65, reason: 'States what the team is going with' },
  { re: APPROVAL, confidence: 0.6, reason: 'Mentions an approval', unless: NEGATED_APPROVAL },
  { re: /\bgoing forward\b/i, confidence: 0.6, reason: 'States a rule going forward' },
];

const PROPOSAL =
  /\b(?:we should|we could|let'?s|i propose|we propose|proposal|recommend(?:ation)?|suggest(?:ion)?|plan is to|leaning (?:towards?)|probably|tentatively|likely (?:go|going) with)\b/i;

const DECISION_QUESTION = /\b(?:should we|do we|are we|can we|will we|which|whether)\b/i;

/** Lines that only point elsewhere ("Related Jira issues: MC-1, MC-5."), never a decision on their own. */
const REFERENCE_LINE = /^\s*(?:related|linked|see(?: also)?|tracked in|tracking|references?|links?|jira(?: issues?| tickets?)?|issues?|tickets?|owners?|attendees|status)\b[^:]{0,30}:/i;

/** Words in a sentence, not counting issue keys. */
function contentWords(sentence: string): number {
  return sentence.replace(/\b[A-Z][A-Z0-9]{1,9}-\d+\b/g, ' ').split(/\s+/).filter((w) => /[A-Za-z]{2,}/.test(w)).length;
}

/** The built-in rules. Exported so a custom classifier can fall back to them. */
export const defaultClassifier: SentenceClassifier = (sentence, ctx) => {
  if (SELF_REFERENCE.some((re) => re.test(sentence))) return null;
  if (DISCLAIMER.some((re) => re.test(sentence))) return null;
  const isQuestion = sentence.trim().endsWith('?');

  if (OPEN_LABEL.test(sentence)) return { kind: 'open_question', confidence: 0.8, reasons: ['Starts with an "Open question:" label'] };
  for (const re of UNRESOLVED) {
    if (re.test(sentence)) return { kind: 'open_question', confidence: 0.7, reasons: ['Says the decision is still open'] };
  }
  const explicit = EXPLICIT.find((rule) => rule.re.test(sentence) && !rule.unless?.test(sentence));
  if (explicit && !isQuestion) {
    const reasons = [explicit.reason];
    let confidence = explicit.confidence;
    if (ctx.underDecisionHeading) {
      reasons.push('Listed under a decisions heading');
      confidence += 0.05;
    }
    return { kind: 'decision', confidence, reasons };
  }
  if (isQuestion && DECISION_QUESTION.test(sentence)) {
    return { kind: 'open_question', confidence: 0.6, reasons: ['Asks a question that is not answered in the same sentence'] };
  }
  if (PROPOSAL.test(sentence)) {
    return { kind: 'proposal', confidence: 0.6, reasons: ['Uses proposal wording such as "we should" or "probably"'] };
  }
  if (ctx.underDecisionHeading && !isQuestion && !REFERENCE_LINE.test(sentence) && contentWords(sentence) >= 4) {
    return { kind: 'decision', confidence: 0.6, reasons: ['Listed under a decisions heading'] };
  }
  return null;
};

// ---------------------------------------------------------------------------
// Text layout: lines, headings, list markers, sentences (all with exact offsets)
// ---------------------------------------------------------------------------

const MARKDOWN_HEADING = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/;
const BARE_HEADING =
  /^\s*(decisions?|decision log|outcomes?|agreed|agreements?|resolutions?|conclusions?|action items?|open questions?|notes|discussion|attendees|agenda|next steps|summary|background|context)\s*:?\s*$/i;
const LABEL_HEADING = /^\s*([^.!?:]{1,60}):\s*$/;
const DECISION_HEADING = /\b(?:decisions?|decision log|outcomes?|agreed|agreements?|resolutions?|conclusions?)\b/i;
const LIST_MARKER = /^\s*(?:[-*•‣◦]|\d{1,3}[.)]|\[[ xX]\])\s+/;

interface Sentence {
  text: string;
  start: number;
  end: number;
}

function headingOf(line: string): string | null {
  const md = MARKDOWN_HEADING.exec(line);
  if (md) return md[1];
  if (BARE_HEADING.test(line)) return line.trim().replace(/:$/, '');
  const label = LABEL_HEADING.exec(line);
  if (label && label[1].trim().split(/\s+/).length <= 6) return label[1].trim();
  return null;
}

/** Splits [from, to) of `text` into trimmed sentences with absolute offsets. */
function sentencesIn(text: string, from: number, to: number): Sentence[] {
  const out: Sentence[] = [];
  const push = (s: number, e: number) => {
    while (s < e && /\s/.test(text[s])) s++;
    while (e > s && /\s/.test(text[e - 1])) e--;
    if (e > s) out.push({ text: text.slice(s, e), start: s, end: e });
  };
  let start = from;
  for (let i = from; i < to; i++) {
    const c = text[i];
    if ((c === '.' || c === '!' || c === '?') && (i + 1 === to || /\s/.test(text[i + 1]))) {
      push(start, i + 1);
      start = i + 1;
    }
  }
  push(start, to);
  return out;
}

/** Yields each sentence with whether it sits under a decisions heading. */
function* walkSentences(text: string): Generator<Sentence & { underDecisionHeading: boolean }> {
  let underDecisionHeading = false;
  let lineStart = 0;
  while (lineStart <= text.length) {
    let lineEnd = text.indexOf('\n', lineStart);
    if (lineEnd === -1) lineEnd = text.length;
    const line = text.slice(lineStart, lineEnd);
    const heading = line.trim() ? headingOf(line) : null;
    if (heading !== null) {
      underDecisionHeading = DECISION_HEADING.test(heading);
    } else if (line.trim()) {
      const marker = LIST_MARKER.exec(line);
      const contentStart = lineStart + (marker ? marker[0].length : 0);
      for (const s of sentencesIn(text, contentStart, lineEnd)) yield { ...s, underDecisionHeading };
    }
    lineStart = lineEnd + 1;
  }
}

/** Keeps quotes short while still reproducing exactly via offsets. */
function shortenSpan(text: string, s: Sentence): Sentence & { shortened: boolean } {
  if (s.end - s.start <= MAX_QUOTE_LENGTH) return { ...s, shortened: false };
  const limit = s.start + MAX_QUOTE_LENGTH;
  let end = text.lastIndexOf(' ', limit);
  if (end <= s.start + MAX_QUOTE_LENGTH / 2) end = limit;
  // Never split a UTF-16 surrogate pair.
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end--;
  while (end > s.start && /[\s,;:]/.test(text[end - 1])) end--;
  return { text: text.slice(s.start, end), start: s.start, end, shortened: true };
}

const LABEL_PREFIX = /^\s*(?:final\s+)?(?:decision|agreed|decided|resolved|outcome|open decision|open question|undecided|tbd)\b[^.?!:]{0,40}[:\-–]\s*/i;

/** The quote without labels such as "Decision:", first letter capitalized. */
export function summarize(quote: string, shortened: boolean): string {
  const stripped = quote.replace(LABEL_PREFIX, '').trim();
  const base = stripped.length > 0 ? stripped : quote.trim();
  const summary = base.charAt(0).toUpperCase() + base.slice(1);
  return shortened ? `${summary}…` : summary;
}

// ---------------------------------------------------------------------------
// Stable ids (no crypto dependency, so this runs in any JS runtime)
// ---------------------------------------------------------------------------

function fnv1a(text: string, seed: number): string {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function stableId(sourceId: string, summary: string): string {
  const key = `${sourceId}␟${summary.toLowerCase().replace(/\s+/g, ' ').trim()}`;
  return `dc_${fnv1a(key, 0x811c9dc5)}${fnv1a(key, 0x01234567)}`;
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

const SOURCE_TYPES = new Set<SourceType>(['confluence_page', 'jira_issue', 'jira_comment']);
const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function isValidTimestamp(v: unknown): boolean {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) && !Number.isNaN(Date.parse(v));
}

function describe(v: unknown, index: number): string {
  return isObject(v) && isNonEmptyString(v.id) ? `"${v.id}"` : `at index ${index}`;
}

function validateSources(raw: unknown[], warnings: ExtractionWarning[]): SourceRecord[] {
  const seen = new Set<string>();
  const out: SourceRecord[] = [];
  raw.forEach((v, i) => {
    const missing: string[] = [];
    if (!isObject(v)) {
      warnings.push({ code: 'invalid_source', message: `Source at index ${i} is not an object; skipped.` });
      return;
    }
    if (!isNonEmptyString(v.id)) missing.push('id');
    if (!SOURCE_TYPES.has(v.type as SourceType)) missing.push('type');
    if (typeof v.text !== 'string') missing.push('text');
    if (!isNonEmptyString(v.projectKey)) missing.push('projectKey');
    if (missing.length > 0) {
      warnings.push({
        code: 'invalid_source',
        message: `Source ${describe(v, i)} has a missing or invalid ${missing.join(', ')}; skipped.`,
        ...(isNonEmptyString(v.id) ? { recordId: v.id } : {}),
      });
      return;
    }
    const id = v.id as string;
    if (seen.has(id)) {
      warnings.push({ code: 'duplicate_source', message: `Source "${id}" appears more than once; kept the first.`, recordId: id });
      return;
    }
    seen.add(id);
    if (!isValidTimestamp(v.updatedAt)) {
      warnings.push({ code: 'invalid_timestamp', message: `Source "${id}" has an invalid updatedAt; it is ranked as oldest.`, recordId: id });
    }
    const record: SourceRecord = {
      id,
      type: v.type as SourceType,
      title: typeof v.title === 'string' ? v.title : '',
      url: typeof v.url === 'string' ? v.url : '',
      text: v.text as string,
      projectKey: v.projectKey as string,
      updatedAt: typeof v.updatedAt === 'string' ? v.updatedAt : '',
    };
    if (typeof v.author === 'string') record.author = v.author;
    if (typeof v.via === 'string' && v.via.trim()) record.via = v.via.trim().slice(0, 160);
    out.push(record);
  });
  return out;
}

function validateIssues(raw: unknown[], warnings: ExtractionWarning[]): IssueRecord[] {
  const seen = new Set<string>();
  const out: IssueRecord[] = [];
  raw.forEach((v, i) => {
    if (!isObject(v)) {
      warnings.push({ code: 'invalid_issue', message: `Issue at index ${i} is not an object; skipped.` });
      return;
    }
    const missing: string[] = [];
    if (!isNonEmptyString(v.id)) missing.push('id');
    if (!isNonEmptyString(v.key)) missing.push('key');
    if (typeof v.title !== 'string') missing.push('title');
    if (!isNonEmptyString(v.projectKey)) missing.push('projectKey');
    if (missing.length > 0) {
      warnings.push({
        code: 'invalid_issue',
        message: `Issue ${isNonEmptyString(v.key) ? `"${v.key}"` : describe(v, i)} has a missing or invalid ${missing.join(', ')}; skipped.`,
        ...(isNonEmptyString(v.id) ? { recordId: v.id } : {}),
      });
      return;
    }
    const key = v.key as string;
    const scoped = `${v.projectKey as string}␟${key}`;
    if (seen.has(scoped)) {
      warnings.push({ code: 'duplicate_issue', message: `Issue ${key} appears more than once; kept the first.`, recordId: v.id as string });
      return;
    }
    seen.add(scoped);
    if (!isValidTimestamp(v.updatedAt)) {
      warnings.push({ code: 'invalid_timestamp', message: `Issue ${key} has an invalid updatedAt.`, recordId: v.id as string });
    }
    const issue: IssueRecord = {
      id: v.id as string,
      key,
      title: v.title as string,
      projectKey: v.projectKey as string,
      updatedAt: typeof v.updatedAt === 'string' ? v.updatedAt : '',
    };
    if (typeof v.description === 'string') issue.description = v.description;
    if (typeof v.status === 'string') issue.status = v.status;
    if (Array.isArray(v.labels)) issue.labels = v.labels.filter((l): l is string => typeof l === 'string');
    out.push(issue);
  });
  return out;
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

const AUTHORITATIVE_TITLE = /\b(?:decision|decisions|adr|rfc|design doc|spec|architecture)\b/i;
const MAX_CONFIDENCE = 0.95;
const round2 = (n: number) => Math.round(n * 100) / 100;

interface Draft {
  kind: DecisionKind;
  summary: string;
  span: Sentence;
  confidence: number;
  reasons: string[];
  tokens: Set<string>;
  mentions: number;
}

function isSameStatement(a: Draft, b: Draft): boolean {
  if (a.summary.toLowerCase().replace(/\W+/g, ' ').trim() === b.summary.toLowerCase().replace(/\W+/g, ' ').trim()) return true;
  return a.kind === b.kind && a.tokens.size >= 3 && b.tokens.size >= 3 && jaccard(a.tokens, b.tokens) >= 0.8;
}

function extractFromSource(source: SourceRecord, classify: SentenceClassifier): Draft[] {
  const drafts: Draft[] = [];
  for (const sentence of walkSentences(source.text)) {
    const ctx: SentenceContext = { sourceType: source.type, sourceTitle: source.title, underDecisionHeading: sentence.underDecisionHeading };
    let cls: SentenceClassification | null;
    try {
      cls = classify(sentence.text, ctx);
    } catch {
      cls = null;
    }
    if (!cls) continue;

    const span = shortenSpan(source.text, sentence);
    const summary = summarize(span.text, span.shortened);
    const draft: Draft = {
      kind: cls.kind,
      summary,
      span,
      confidence: Math.max(0, Math.min(1, cls.confidence)),
      reasons: [...cls.reasons],
      tokens: tokenSet(summary),
      mentions: 1,
    };

    // Repeated mentions in the same source collapse into the clearest one.
    const twin = drafts.findIndex((d) => isSameStatement(d, draft));
    if (twin === -1) {
      drafts.push(draft);
    } else {
      const kept = draft.confidence > drafts[twin].confidence ? draft : drafts[twin];
      kept.mentions = drafts[twin].mentions + 1;
      drafts[twin] = kept;
    }
  }
  return drafts;
}

const KIND_ORDER: Record<DecisionKind, number> = { decision: 0, open_question: 1, proposal: 2 };

/** The text line (paragraph or list item) that holds the span. */
function paragraphAround(text: string, start: number, end: number): string {
  const from = text.lastIndexOf('\n', start - 1) + 1;
  const to = text.indexOf('\n', end);
  return text.slice(from, to === -1 ? text.length : to);
}

function timeValue(ts: string): number {
  return isValidTimestamp(ts) ? Date.parse(ts) : Number.NEGATIVE_INFINITY;
}

/**
 * Finds decisions, proposals and open questions in the sources and ties each to the issues
 * in the same project that it concretely points at. Pure and deterministic: no network,
 * no clock, no randomness, no shared state.
 */
export function extractDecisions(input: ExtractionInput, options: ExtractionOptions = {}): ExtractionResult {
  const warnings: ExtractionWarning[] = [];
  if (!isObject(input)) {
    return { candidates: [], warnings: [{ code: 'invalid_input', message: 'Input must be an object with sources and issues.' }] };
  }
  const rawSources: unknown[] = Array.isArray(input.sources) ? input.sources : [];
  const rawIssues: unknown[] = Array.isArray(input.issues) ? input.issues : [];
  if (!Array.isArray(input.sources)) warnings.push({ code: 'invalid_input', message: 'input.sources is not an array; treated as empty.' });
  if (input.issues !== undefined && !Array.isArray(input.issues)) {
    warnings.push({ code: 'invalid_input', message: 'input.issues is not an array; treated as empty.' });
  }

  let maxCandidates: number | undefined;
  if (input.maxCandidates !== undefined) {
    if (Number.isInteger(input.maxCandidates) && input.maxCandidates >= 0) maxCandidates = input.maxCandidates;
    else warnings.push({ code: 'invalid_option', message: 'maxCandidates must be a non-negative integer; ignored.' });
  }

  const sources = validateSources(rawSources, warnings);
  const issues = validateIssues(rawIssues, warnings);
  if (sources.length === 0) warnings.push({ code: 'empty_input', message: 'No valid sources to analyze.' });
  else if (issues.length === 0) warnings.push({ code: 'empty_input', message: 'No valid issues; candidates will have no affected issues.' });

  const classify = options.classifier ?? defaultClassifier;
  const index = buildIssueIndex(issues);
  const candidates: DecisionCandidate[] = [];

  for (const source of sources) {
    const authoritative = AUTHORITATIVE_TITLE.test(source.title);
    for (const draft of extractFromSource(source, classify)) {
      const reasons = [...draft.reasons];
      let confidence = draft.confidence;
      if (authoritative && draft.kind === 'decision') {
        reasons.push('Source title suggests a decision record');
        confidence += 0.05;
      }
      if (draft.mentions > 1) {
        reasons.push(`Stated ${draft.mentions} times in this source`);
        confidence += 0.05;
      }
      const candidate: DecisionCandidate = {
        id: stableId(source.id, draft.summary),
        kind: draft.kind,
        summary: draft.summary,
        evidence: { quote: draft.span.text, start: draft.span.start, end: draft.span.end },
        source: {
          id: source.id,
          type: source.type,
          title: source.title,
          url: source.url,
          projectKey: source.projectKey,
          updatedAt: source.updatedAt,
          ...(source.author !== undefined ? { author: source.author } : {}),
          ...(source.via !== undefined ? { via: source.via } : {}),
        },
        confidence: round2(Math.min(MAX_CONFIDENCE, confidence)),
        confidenceReasons: reasons,
        affectedIssues: matchIssues(
          { summary: draft.summary, quote: draft.span.text, source, paragraph: paragraphAround(source.text, draft.span.start, draft.span.end) },
          index,
        ),
      };
      candidates.push(candidate);
    }
  }

  candidates.sort(
    (a, b) =>
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      Number(b.affectedIssues.length > 0) - Number(a.affectedIssues.length > 0) ||
      b.confidence - a.confidence ||
      (b.affectedIssues[0]?.relevance ?? 0) - (a.affectedIssues[0]?.relevance ?? 0) ||
      timeValue(b.source.updatedAt) - timeValue(a.source.updatedAt) ||
      (a.source.id < b.source.id ? -1 : a.source.id > b.source.id ? 1 : 0) ||
      a.evidence.start - b.evidence.start,
  );

  if (maxCandidates !== undefined && candidates.length > maxCandidates) {
    warnings.push({
      code: 'candidates_truncated',
      message: `Found ${candidates.length} candidates; returned the top ${maxCandidates}.`,
    });
    candidates.length = maxCandidates;
  }
  return { candidates, warnings };
}

// ---------------------------------------------------------------------------
// Verifying findings proposed by a model (optional AI pass)
// ---------------------------------------------------------------------------

/** One finding a model proposes. Only `quote` is trusted, and only after it is found in the source. */
export interface ProposedFinding {
  sourceId: string;
  quote: string;
  kind: DecisionKind;
  reason?: string;
}

export interface VerifiedFindings {
  candidates: DecisionCandidate[];
  /** Proposals dropped because the quote was not found verbatim, was too long, or was already found. */
  rejected: number;
}

const KINDS = new Set<DecisionKind>(['decision', 'proposal', 'open_question']);
const MAX_REASON_LENGTH = 160;

/**
 * Turns proposals from a model into candidates, keeping only those whose quote appears verbatim
 * in the named source. Spans, ids and issue matching use the same rules as `extractDecisions`,
 * so a verified finding is indistinguishable in shape from a rule-based one. `known` holds the
 * candidates already found; proposals overlapping one of them are dropped. Pure and deterministic.
 */
export function verifyProposedFindings(
  input: { sources: SourceRecord[]; issues: IssueRecord[] },
  proposals: ProposedFinding[],
  known: DecisionCandidate[] = [],
): VerifiedFindings {
  const warnings: ExtractionWarning[] = [];
  const sources = new Map(validateSources(Array.isArray(input.sources) ? input.sources : [], warnings).map((s) => [s.id, s]));
  const index = buildIssueIndex(validateIssues(Array.isArray(input.issues) ? input.issues : [], warnings));
  const taken = new Map<string, Array<[number, number]>>();
  for (const c of known) {
    if (!taken.has(c.source.id)) taken.set(c.source.id, []);
    taken.get(c.source.id)!.push([c.evidence.start, c.evidence.end]);
  }

  const candidates: DecisionCandidate[] = [];
  let rejected = 0;
  for (const p of Array.isArray(proposals) ? proposals : []) {
    const source = isObject(p) ? sources.get(String(p.sourceId)) : undefined;
    const quote = typeof p?.quote === 'string' ? p.quote.trim() : '';
    if (!source || !KINDS.has(p.kind) || quote.length < 12 || quote.length > MAX_QUOTE_LENGTH) {
      rejected++;
      continue;
    }
    const start = source.text.indexOf(quote);
    if (start === -1) {
      rejected++;
      continue;
    }
    const end = start + quote.length;
    const spans = taken.get(source.id) ?? [];
    if (spans.some(([a, b]) => start < b && end > a)) {
      rejected++;
      continue;
    }
    spans.push([start, end]);
    taken.set(source.id, spans);

    const summary = summarize(quote, false);
    const reasons = ['Found by the AI pass; the quote was checked word for word against the source'];
    const reason = typeof p.reason === 'string' ? p.reason.replace(/\s+/g, ' ').trim().slice(0, MAX_REASON_LENGTH) : '';
    if (reason) reasons.push(`AI note: ${reason}`);
    candidates.push({
      id: stableId(source.id, summary),
      kind: p.kind,
      summary,
      evidence: { quote, start, end },
      source: {
        id: source.id,
        type: source.type,
        title: source.title,
        url: source.url,
        projectKey: source.projectKey,
        updatedAt: source.updatedAt,
        ...(source.author !== undefined ? { author: source.author } : {}),
          ...(source.via !== undefined ? { via: source.via } : {}),
      },
      confidence: 0.5,
      confidenceReasons: reasons,
      affectedIssues: matchIssues({ summary, quote, source, paragraph: paragraphAround(source.text, start, end) }, index),
    });
  }
  candidates.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || Number(b.affectedIssues.length > 0) - Number(a.affectedIssues.length > 0));
  return { candidates, rejected };
}
