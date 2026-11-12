import type { AffectedIssue, IssueRecord, SourceRecord } from './decisionTypes';

// ---------------------------------------------------------------------------
// Lexical helpers (shared with extractDecisions)
// ---------------------------------------------------------------------------

const STOPWORDS = new Set(
  `a an the and or but if then else of to in on at by for with from into onto over under as is are was were be been
  being it its this that these those we our us you your they their them i me my he she his her will would shall should
  can could may might must do does did done have has had not no yes so than too very just also only about after before
  again all any both each few more most other some such own same up down out off once here there when where why how
  what which who whom whose because until while let lets let's we'll we've we're it's there's per via vs etc going go
  use using get got make made new now still need needs`.split(/\s+/),
);

/** Words about the act of deciding rather than its subject. They never count as overlap. */
const META_WORDS = new Set(
  `decision decisions decide decided deciding agree agreed agreement scope scoped standup meeting team instead forward
  final call outcome approved approve sign signed off support move moving build add update proposal propose suggest
  recommend plan planned probably think question replace replacing switch migrate drop remove cut deprecate descope
  open undecided tbd`.split(/\s+/),
);

export function stem(word: string): string {
  if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith('ies')) return word.slice(0, -3) + 'y';
  if (word.length > 4 && word.endsWith('ed')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss') && !word.endsWith('us')) return word.slice(0, -1);
  return word;
}

/** Lowercased, stemmed content words. Numbers, stopwords and decision meta-words are dropped. */
export function tokenize(text: string): string[] {
  const words = text.toLowerCase().match(/[a-z0-9][a-z0-9'+-]*[a-z0-9]|[a-z]/g) ?? [];
  const out: string[] = [];
  for (const raw of words) {
    const w = raw.replace(/'s$/, '');
    if (w.length < 2 || /^\d+$/.test(w) || STOPWORDS.has(w) || META_WORDS.has(w)) continue;
    out.push(stem(w));
  }
  return out;
}

export function tokenSet(text: string): Set<string> {
  return new Set(tokenize(text));
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / (a.size + b.size - shared);
}

const ISSUE_KEY = /\b[A-Z][A-Z0-9]{1,9}-\d+\b/g;

export function findIssueKeys(text: string): string[] {
  return [...new Set(text.match(ISSUE_KEY) ?? [])].sort();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whole-word, case-insensitive phrase search that tolerates plural endings. */
export function containsPhrase(haystack: string, phrase: string): boolean {
  const words = phrase.trim().split(/\s+/).filter(Boolean).map(escapeRegExp);
  if (words.length === 0) return false;
  return new RegExp(`(?:^|[^A-Za-z0-9])${words.join('\\s+')}(?:s|es)?(?![A-Za-z0-9])`, 'i').test(haystack);
}

// ---------------------------------------------------------------------------
// What a decision changes ("X instead of Y", "drop X", ...)
// ---------------------------------------------------------------------------

export interface DecisionChange {
  from?: string;
  to?: string;
  removed?: string;
}

const STOP = String.raw`(?=\s+(?:for|in|on|at|because|so|since|until|by|when|after|before|across|per)\b|[,.;:!?()]|$)`;
const LEAD = /^(?:the|a|an|our|their|its|this|that|all|any|existing|current)\s+/i;

function cleanPhrase(raw: string | undefined, maxWords = 6): string | undefined {
  if (!raw) return undefined;
  let phrase = raw.trim().replace(/^["'“‘]|["'”’]$/g, '').trim();
  while (LEAD.test(phrase)) phrase = phrase.replace(LEAD, '');
  phrase = phrase.replace(/[\s.,;:]+$/, '');
  const words = phrase.split(/\s+/).filter(Boolean);
  return words.length === 0 || words.length > maxWords ? undefined : phrase;
}

const CHANGE_RULES: Array<(t: string) => DecisionChange | undefined> = [
  (t) => {
    const m = new RegExp(String.raw`\b(?:use|adopt|go with|going with|switch to|move to|choose|pick|ship|keep|build)\s+(.+?)\s+instead of\s+(.+?)${STOP}`, 'i').exec(t);
    return m ? { to: cleanPhrase(m[1]), from: cleanPhrase(m[2]) } : undefined;
  },
  (t) => {
    const m = new RegExp(String.raw`\breplac(?:e|ing)\s+(.+?)\s+with\s+(.+?)${STOP}`, 'i').exec(t);
    return m ? { from: cleanPhrase(m[1]), to: cleanPhrase(m[2]) } : undefined;
  },
  (t) => {
    const m = new RegExp(String.raw`\b(?:switch|switching|move|moving|migrate|migrating|change|changing)\b.*?\bfrom\s+(.+?)\s+to\s+(.+?)${STOP}`, 'i').exec(t);
    return m ? { from: cleanPhrase(m[1]), to: cleanPhrase(m[2]) } : undefined;
  },
  (t) => {
    const body = t.replace(/^(?:we\s+)?(?:have\s+)?(?:decided|agreed)\s+(?:that\s+)?/i, '');
    const m = /^(.+?)\s+(?:is|are|will be|has been|have been)\s+(?:now\s+)?(?:out of scope|descoped|deferred|dropped|cut|removed|not in scope|postponed|deprecated)\b/i.exec(body);
    return m ? { removed: cleanPhrase(m[1]) } : undefined;
  },
  (t) => {
    const m = new RegExp(String.raw`\b(?:drop|dropping|remove|removing|cut|cutting|deprecate|deprecating|descope|descoping|stop supporting|no longer support(?:ing)?)\s+(.+?)${STOP}`, 'i').exec(t);
    return m ? { removed: cleanPhrase(m[1]) } : undefined;
  },
  (t) => {
    const m = new RegExp(String.raw`(.+?)\s+instead of\s+(.+?)${STOP}`, 'i').exec(t);
    return m ? { to: cleanPhrase(m[1].trim().split(/\s+/).slice(-4).join(' ')), from: cleanPhrase(m[2], 4) } : undefined;
  },
];

/** The old/new/removed terms a decision names, when its wording makes that clear. */
export function extractChange(text: string): DecisionChange | undefined {
  for (const rule of CHANGE_RULES) {
    const c = rule(text);
    if (!c) continue;
    const result: DecisionChange = {};
    if (c.from) result.from = c.from;
    if (c.to) result.to = c.to;
    if (c.removed) result.removed = c.removed;
    if (result.from || result.removed) return result;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Issue matching
// ---------------------------------------------------------------------------

interface ProjectIndex {
  issues: IssueRecord[];
  tokens: Map<string, Set<string>>;
  df: Map<string, number>;
}

export interface IssueIndex {
  byProject: Map<string, ProjectIndex>;
}

function issueText(issue: IssueRecord): string {
  return `${issue.title}\n${issue.description ?? ''}`;
}

/** Precomputes per-project term statistics. Issues must already be validated. */
export function buildIssueIndex(issues: IssueRecord[]): IssueIndex {
  const byProject = new Map<string, ProjectIndex>();
  for (const issue of issues) {
    let p = byProject.get(issue.projectKey);
    if (!p) {
      p = { issues: [], tokens: new Map(), df: new Map() };
      byProject.set(issue.projectKey, p);
    }
    const tokens = tokenSet([issue.title, issue.title, issue.description ?? '', (issue.labels ?? []).join(' ')].join('\n'));
    p.issues.push(issue);
    p.tokens.set(issue.key, tokens);
    for (const t of tokens) p.df.set(t, (p.df.get(t) ?? 0) + 1);
  }
  return { byProject };
}

function idf(p: ProjectIndex, token: string): number {
  return Math.log((p.issues.length + 1) / ((p.df.get(token) ?? 0) + 1)) + 1;
}

/** Share of the decision's term weight found in the issue; rarer terms weigh more. */
function overlap(decision: Set<string>, issue: Set<string>, p: ProjectIndex): { score: number; shared: string[] } {
  let total = 0;
  let sharedWeight = 0;
  const shared: Array<[string, number]> = [];
  for (const t of decision) {
    const w = idf(p, t);
    total += w;
    if (issue.has(t)) {
      sharedWeight += w;
      shared.push([t, w]);
    }
  }
  if (shared.length < 2 || total === 0) return { score: 0, shared: [] };
  shared.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  return { score: sharedWeight / total, shared: shared.map(([t]) => t) };
}

/** A replaced term is specific enough on its own when it has a 4+ letter word used by few issues. */
function isDistinctive(term: string, p: ProjectIndex): boolean {
  const tokens = tokenize(term).filter((t) => /[a-z]{4,}/.test(t));
  if (tokens.length === 0) return false;
  const limit = Math.max(2, Math.ceil(p.issues.length * 0.25));
  return Math.min(...tokens.map((t) => p.df.get(t) ?? 0)) <= limit;
}

function displayTerms(stems: string[], issue: IssueRecord, max = 4): string[] {
  const words = issueText(issue).match(/[A-Za-z0-9][A-Za-z0-9'+-]*/g) ?? [];
  return stems.slice(0, max).map((s) => words.find((w) => tokenize(w)[0] === s) ?? s);
}

const BROWSE_KEY = /\/browse\/([A-Z][A-Z0-9]{1,9}-\d+)/;

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Minimum overlap score that is enough to include an issue without any other signal. */
const OVERLAP_INCLUDE = 0.36;

export interface MatchSubject {
  summary: string;
  quote: string;
  source: SourceRecord;
  /** The paragraph (text line) that contains the quote, e.g. "Decision: … Related Jira issues: MC-1, MC-5." */
  paragraph?: string;
}

/**
 * Issues in the source's project that the decision concretely points at, each with the
 * signals that tied it. Issues with no explicit key signal and no lexical overlap are left out.
 */
export function matchIssues(subject: MatchSubject, index: IssueIndex): AffectedIssue[] {
  const p = index.byProject.get(subject.source.projectKey);
  if (!p) return [];

  const change = extractChange(subject.summary);
  const oldTerm = change?.from ?? change?.removed;
  const decisionTokens = tokenSet([subject.summary, oldTerm ?? ''].join(' '));
  const quoteKeys = new Set(findIssueKeys(subject.quote));
  const sourceKeys = new Set(findIssueKeys(subject.source.text));
  const paragraphKeys = new Set(findIssueKeys(subject.paragraph ?? ''));
  const urlKey = BROWSE_KEY.exec(subject.source.url)?.[1];

  const out: AffectedIssue[] = [];
  for (const issue of p.issues) {
    const parts: Array<[number, string]> = [];
    let explicit = false;

    if (quoteKeys.has(issue.key)) {
      parts.push([0.6, `The quoted text names ${issue.key}`]);
      explicit = true;
    } else if (paragraphKeys.has(issue.key)) {
      parts.push([0.5, `The same paragraph as the decision lists ${issue.key}`]);
      explicit = true;
    }
    if (subject.source.type === 'jira_issue' && (subject.source.id === issue.id || urlKey === issue.key)) {
      parts.push([0.55, `The decision is written in ${issue.key} itself`]);
      explicit = true;
    } else if (subject.source.type === 'jira_comment' && urlKey === issue.key) {
      parts.push([0.55, `The decision is in a comment on ${issue.key}`]);
      explicit = true;
    }

    const o = overlap(decisionTokens, p.tokens.get(issue.key) ?? new Set(), p);
    const lexical = o.score >= OVERLAP_INCLUDE;
    if (o.score >= 0.2) {
      const terms = displayTerms(o.shared, issue).map((t) => `“${t}”`).join(', ');
      parts.push([o.score * 0.8, `Shares terms with the issue: ${terms}`]);
      if (sourceKeys.has(issue.key) && !quoteKeys.has(issue.key) && !paragraphKeys.has(issue.key)) {
        parts.push([0.15, `The source also mentions ${issue.key}`]);
      }
    }

    const text = issueText(issue);
    const stale = oldTerm !== undefined && containsPhrase(text, oldTerm);
    const staleCounts = stale && (explicit || lexical || isDistinctive(oldTerm, p));
    if (staleCounts) {
      parts.push([0.2, `The issue still mentions “${oldTerm}”, which this decision ${change?.from ? 'replaces' : 'removes'}`]);
    }

    if (!explicit && !lexical && !staleCounts) continue;
    if (explicit && !stale && change?.from && change.to && containsPhrase(text, change.to)) {
      parts.push([0, `The issue mentions the replacement “${change.to}” and no longer mentions “${change.from}”`]);
    }
    const relevance = round2(Math.min(0.99, parts.reduce((sum, [w]) => sum + w, 0)));
    out.push({ issueKey: issue.key, relevance, reasons: parts.map(([, r]) => r) });
  }
  return out.sort((a, b) => b.relevance - a.relevance || (a.issueKey < b.issueKey ? -1 : 1));
}
