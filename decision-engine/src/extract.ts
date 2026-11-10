import { extractChange } from './change.ts';
import { findIssueKeys, splitSentences, stableId } from './text.ts';
import type {
  Confidence,
  ConfluencePageRecord,
  DecisionChange,
  DecisionKind,
  EvidenceSpan,
  JiraCommentRecord,
  SourceRecord,
  SourceType,
} from './types.ts';

/** A decision passage before issue matching and ranking. */
export interface DecisionDraft {
  id: string;
  projectId: string;
  kind: DecisionKind;
  decisionText: string;
  change?: DecisionChange;
  sourceType: SourceType;
  sourceId: string;
  sourceTitle: string;
  sourceUrl: string;
  sourceAuthor: string;
  sourceUpdatedAt: string;
  evidenceExcerpt: string;
  evidenceSpan: EvidenceSpan;
  /** The full block or comment text the excerpt came from (model context, verification). */
  contextText: string;
  confidence: Confidence;
  confidenceReasons: string[];
  /** Issue keys written in the passage itself. */
  passageIssueKeys: string[];
  /** Issue keys written anywhere on the source page. */
  pageIssueKeys: string[];
  /** For Jira comments: the issue the comment belongs to. */
  sourceIssueKey?: string;
  flags: { markedDecision: boolean; decisionSection: boolean; authoritativeSource: boolean };
}

interface Classification {
  kind: DecisionKind;
  confidence: Confidence;
  reasons: string[];
  markedDecision?: boolean;
  decisionSection?: boolean;
}

interface PassageContext {
  decisionState?: 'DECIDED' | 'UNDECIDED';
  underDecisionHeading: boolean;
}

const EXPLICIT: Array<{ re: RegExp; confidence: Confidence; reason: string }> = [
  { re: /^\s*(?:final\s+)?decision\s*[:\-–]/i, confidence: 'high', reason: 'Starts with a "Decision:" label' },
  { re: /^\s*(?:agreed|decided|resolved|outcome)\b[^.?!:]{0,40}:/i, confidence: 'high', reason: 'Starts with an "Agreed:" or "Decided:" label' },
  {
    re: /\b(?:we|team|we've|we have|everyone|the group|stakeholders|leadership)\s+(?:all\s+)?(?:have\s+)?(?:decided|agreed|chose|chosen|settled on|signed off)\b/i,
    confidence: 'high',
    reason: 'Says the team decided or agreed',
  },
  { re: /\b(?:decided|agreed)\s+(?:to|that|on)\b/i, confidence: 'high', reason: 'Says something was decided or agreed' },
  { re: /\bfinal (?:call|decision)\b/i, confidence: 'high', reason: 'Calls it a final decision' },
  { re: /\b(?:we(?:'ll| will| are|'re))\s+(?:going\s+(?:with|to go with)|go(?:ing)? with)\b/i, confidence: 'medium', reason: 'States what the team is going with' },
  { re: /\b(?:approved|signed off)\b/i, confidence: 'medium', reason: 'Mentions an approval' },
  { re: /\bgoing forward\b/i, confidence: 'medium', reason: 'States a rule going forward' },
];

const UNRESOLVED = [
  /\b(?:not|haven't|have not|hasn't|has not|didn't|did not|yet to|no)\s+(?:been\s+|yet\s+)?(?:decided|agreed|decision|reached a decision)\b/i,
  /\b(?:open question|tbd|to be (?:decided|determined|confirmed)|undecided|needs? to decide|pending (?:a )?decision|still deciding|not sure yet)\b/i,
];

const POSSIBLE =
  /\b(?:we should|we could|let'?s|i propose|we propose|proposal|recommend(?:ation)?|suggest(?:ion)?|plan is to|leaning (?:towards?)|probably|tentatively|likely (?:go|going) with)\b/i;

const DECISION_QUESTION = /\b(?:should we|do we|are we|can we|will we|which|whether)\b/i;

const DECISION_HEADING = /\b(?:decisions?|decision log|outcomes?|agreed|agreements?|resolutions?|conclusions?)\b/i;

const AUTHORITY = /\b(?:decision|decisions|adr|rfc|design doc|spec|architecture)\b/i;

/** Sentences about the document itself ("This page records what we agreed"). */
const SELF_REFERENCE = [
  /\b(?:this|the following)\s+(?:page|doc(?:ument)?|section|table|list|log)\s+(?:records|captures|lists|summari[sz]es|tracks|describes|contains)\b/i,
  /\bwhat (?:the team|we|everyone|the group) (?:decided|agreed)\b/i,
];

function classify(text: string, ctx: PassageContext): Classification | null {
  if (!ctx.decisionState && SELF_REFERENCE.some((re) => re.test(text))) return null;
  if (ctx.decisionState === 'DECIDED') {
    return { kind: 'explicit', confidence: 'high', reasons: ['Marked as a decision in Confluence'], markedDecision: true };
  }
  if (ctx.decisionState === 'UNDECIDED') {
    return { kind: 'unresolved', confidence: 'high', reasons: ['Open decision item in Confluence'], markedDecision: true };
  }
  const isQuestion = text.trim().endsWith('?');
  for (const re of UNRESOLVED) {
    if (re.test(text)) return { kind: 'unresolved', confidence: 'medium', reasons: ['Says the decision is still open'] };
  }
  const explicit = EXPLICIT.find((rule) => rule.re.test(text));
  if (explicit && !isQuestion) {
    const reasons = [explicit.reason];
    if (ctx.underDecisionHeading) reasons.push('Listed under a decisions heading');
    return { kind: 'explicit', confidence: explicit.confidence, reasons, decisionSection: ctx.underDecisionHeading };
  }
  if (isQuestion && DECISION_QUESTION.test(text)) {
    return { kind: 'unresolved', confidence: 'medium', reasons: ['Asks a question the team has not answered here'] };
  }
  if (ctx.underDecisionHeading && !isQuestion && text.split(/\s+/).length >= 4 && !POSSIBLE.test(text)) {
    return { kind: 'explicit', confidence: 'medium', reasons: ['Listed under a decisions heading'], decisionSection: true };
  }
  if (POSSIBLE.test(text)) {
    return { kind: 'possible', confidence: 'low', reasons: ['Reads as a proposal, not a decision'] };
  }
  return null;
}

/** Removes leading labels such as "Decision:" or "Decided in standup:". */
export function cleanDecisionText(text: string): string {
  const stripped = text
    .replace(/^\s*(?:final\s+)?(?:decision|agreed|decided|resolved|outcome)\b[^.?!:]{0,40}:\s*/i, '')
    .trim();
  const result = stripped.length > 0 ? stripped : text.trim();
  return result.charAt(0).toUpperCase() + result.slice(1);
}

interface SourceBase {
  projectId: string;
  sourceType: SourceType;
  sourceId: string;
  sourceTitle: string;
  sourceUrl: string;
  sourceAuthor: string;
  sourceUpdatedAt: string;
  pageIssueKeys: string[];
  sourceIssueKey?: string;
  authoritativeSource: boolean;
}

interface Passage {
  text: string;
  start: number;
  end: number;
  blockId: string | null;
  contextText: string;
}

function draftFrom(base: SourceBase, passage: Passage, cls: Classification): DecisionDraft {
  const decisionText = cleanDecisionText(passage.text);
  const { authoritativeSource, ...rest } = base;
  const draft: DecisionDraft = {
    ...rest,
    id: stableId(base.projectId, base.sourceType, base.sourceId, passage.blockId ?? '', passage.text.trim().toLowerCase()),
    kind: cls.kind,
    decisionText,
    evidenceExcerpt: passage.text,
    evidenceSpan: { blockId: passage.blockId, start: passage.start, end: passage.end },
    contextText: passage.contextText,
    confidence: cls.confidence,
    confidenceReasons: [...cls.reasons],
    passageIssueKeys: findIssueKeys(passage.text),
    flags: {
      markedDecision: Boolean(cls.markedDecision),
      decisionSection: Boolean(cls.decisionSection),
      authoritativeSource,
    },
  };
  if (authoritativeSource) draft.confidenceReasons.push('Source looks like a decision record');
  if (cls.kind !== 'unresolved') {
    const change = extractChange(decisionText);
    if (change) draft.change = change;
  }
  return draft;
}

export function extractFromPage(page: ConfluencePageRecord, projectId: string): { drafts: DecisionDraft[]; passages: number } {
  const authoritativeSource = AUTHORITY.test(page.title) || page.labels.some((l) => AUTHORITY.test(l.replace(/[-_]/g, ' ')));
  const pageIssueKeys = findIssueKeys(page.blocks.map((b) => b.text).join('\n'));
  const base: SourceBase = {
    projectId,
    sourceType: 'confluence-page',
    sourceId: page.id,
    sourceTitle: page.title,
    sourceUrl: page.url,
    sourceAuthor: page.author,
    sourceUpdatedAt: page.updatedAt,
    pageIssueKeys,
    authoritativeSource,
  };
  const drafts: DecisionDraft[] = [];
  let passages = 0;
  let underDecisionHeading = false;
  let headingLevel = 0;

  for (const block of page.blocks) {
    if (block.type === 'heading') {
      const level = block.headingLevel ?? 1;
      if (DECISION_HEADING.test(block.text)) {
        underDecisionHeading = true;
        headingLevel = level;
      } else if (!underDecisionHeading || level <= headingLevel) {
        underDecisionHeading = false;
      }
      continue;
    }
    if (block.type === 'decision-item') {
      passages++;
      const cls = classify(block.text, { decisionState: block.decisionState ?? 'DECIDED', underDecisionHeading });
      const text = block.text.trim();
      if (cls && text) {
        const start = block.text.indexOf(text);
        drafts.push(draftFrom(base, { text, start, end: start + text.length, blockId: block.id, contextText: block.text }, cls));
      }
      continue;
    }
    for (const sentence of splitSentences(block.text)) {
      passages++;
      const cls = classify(sentence.text, { underDecisionHeading });
      if (cls) drafts.push(draftFrom(base, { ...sentence, blockId: block.id, contextText: block.text }, cls));
    }
  }
  return { drafts, passages };
}

export function extractFromComment(comment: JiraCommentRecord, projectId: string): { drafts: DecisionDraft[]; passages: number } {
  const base: SourceBase = {
    projectId,
    sourceType: 'jira-comment',
    sourceId: comment.id,
    sourceTitle: `Comment on ${comment.issueKey}`,
    sourceUrl: comment.url,
    sourceAuthor: comment.author,
    sourceUpdatedAt: comment.createdAt,
    pageIssueKeys: [],
    sourceIssueKey: comment.issueKey,
    authoritativeSource: false,
  };
  const drafts: DecisionDraft[] = [];
  let passages = 0;
  for (const sentence of splitSentences(comment.body)) {
    passages++;
    const cls = classify(sentence.text, { underDecisionHeading: false });
    if (cls) drafts.push(draftFrom(base, { ...sentence, blockId: null, contextText: comment.body }, cls));
  }
  return { drafts, passages };
}

export function extractDrafts(sources: SourceRecord[], projectId: string): { drafts: DecisionDraft[]; passages: number } {
  const drafts: DecisionDraft[] = [];
  let passages = 0;
  for (const source of sources) {
    const result = source.kind === 'confluence-page' ? extractFromPage(source, projectId) : extractFromComment(source, projectId);
    drafts.push(...result.drafts);
    passages += result.passages;
  }
  return { drafts, passages };
}
