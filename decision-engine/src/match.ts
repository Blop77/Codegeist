import type { DecisionDraft } from './extract.ts';
import { containsPhrase, daysBetween, jaccard, tokenSet, tokenize } from './text.ts';
import type { DriftStatus, IssueMatch, JiraCommentRecord, JiraIssueRecord, MatchReason, MatchStrength } from './types.ts';

const LEVEL: Record<MatchStrength, number> = { weak: 1, moderate: 2, strong: 3 };
const STRENGTH: MatchStrength[] = ['weak', 'weak', 'moderate', 'strong'];

/** Precomputed per-scope data so matching many drafts stays cheap. */
export interface MatchIndex {
  issues: JiraIssueRecord[];
  issueTokens: Map<string, Set<string>>;
  commentsByIssue: Map<string, JiraCommentRecord[]>;
  idf: (token: string) => number;
  /** Number of issues in scope containing the token. */
  df: (token: string) => number;
}

/**
 * True when a replaced/removed term is specific enough to identify affected work on its
 * own: it has a word of 4+ letters that appears in few issues ("Jenkins", not "5").
 */
function isDistinctive(term: string, index: MatchIndex): boolean {
  const tokens = tokenize(term).filter((t) => /[a-z]{4,}/.test(t));
  if (tokens.length === 0) return false;
  const limit = Math.max(2, Math.ceil(index.issues.length * 0.25));
  return Math.min(...tokens.map(index.df)) <= limit;
}

export function buildMatchIndex(issues: JiraIssueRecord[], comments: JiraCommentRecord[]): MatchIndex {
  const issueTokens = new Map<string, Set<string>>();
  const df = new Map<string, number>();
  for (const issue of issues) {
    const tokens = tokenSet([issue.summary, issue.summary, issue.description, issue.labels.join(' '), issue.components.join(' ')].join('\n'));
    issueTokens.set(issue.key, tokens);
    for (const t of tokens) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const n = issues.length;
  const commentsByIssue = new Map<string, JiraCommentRecord[]>();
  for (const c of comments) {
    const list = commentsByIssue.get(c.issueKey) ?? [];
    list.push(c);
    commentsByIssue.set(c.issueKey, list);
  }
  return {
    issues,
    issueTokens,
    commentsByIssue,
    idf: (t) => Math.log((n + 1) / ((df.get(t) ?? 0) + 1)) + 1,
    df: (t) => df.get(t) ?? 0,
  };
}

interface Overlap {
  level: number;
  shared: string[];
}

/** Share of the decision's term weight that also appears in the issue, weighted by rarity. */
function termOverlap(decisionTokens: Set<string>, issueTokens: Set<string>, idf: (t: string) => number): Overlap {
  let total = 0;
  let sharedWeight = 0;
  const shared: Array<[string, number]> = [];
  for (const t of decisionTokens) {
    const w = idf(t);
    total += w;
    if (issueTokens.has(t)) {
      sharedWeight += w;
      shared.push([t, w]);
    }
  }
  if (shared.length < 2 || total === 0) return { level: 0, shared: [] };
  const score = sharedWeight / total;
  const level = score >= 0.5 ? 3 : score >= 0.36 ? 2 : score >= 0.2 ? 1 : 0;
  return { level, shared: shared.sort((a, b) => b[1] - a[1]).map(([t]) => t) };
}

/** Shows original-cased words from the issue for the shared stems, for readable reasons. */
function displayTerms(stems: string[], issue: JiraIssueRecord, max = 4): string[] {
  const words = `${issue.summary} ${issue.description}`.match(/[A-Za-z0-9][A-Za-z0-9'+-]*/g) ?? [];
  return stems.slice(0, max).map((s) => words.find((w) => tokenize(w)[0] === s) ?? s);
}

export interface DriftAssessment {
  status: DriftStatus;
  reasons: string[];
}

/** Decides whether an issue still reflects the old plan, using only text the reviewer can see. */
export function assessDrift(draft: DecisionDraft, issue: JiraIssueRecord, comments: JiraCommentRecord[]): DriftAssessment {
  const issueText = `${issue.summary}\n${issue.description}`;
  const laterComments = comments.filter((c) => c.id !== draft.sourceId && Date.parse(c.createdAt) >= Date.parse(draft.sourceUpdatedAt));
  const reasons: string[] = [];

  const staleTerm = draft.change?.from ?? draft.change?.removed;
  const staleVerb = draft.change?.from ? 'replaces' : 'removes';
  const newTerm = draft.change?.to;
  const staleInIssue = staleTerm ? containsPhrase(issueText, staleTerm) : false;
  const newInIssue = newTerm ? containsPhrase(issueText, newTerm) : false;
  const linked =
    issue.linkedSourceIds?.some((id) => id === draft.sourceId || id === draft.sourceUrl) === true ||
    (draft.sourceType === 'confluence-page' && issueText.includes(draft.sourceUrl));

  const draftTokens = tokenSet(draft.decisionText);
  const discussingComment = laterComments.find((c) => jaccard(draftTokens, tokenSet(c.body)) >= 0.3 || (newTerm ? containsPhrase(c.body, newTerm) : false));

  if (staleInIssue && !newInIssue) {
    reasons.push(`Issue still mentions “${staleTerm}”, which this decision ${staleVerb}`);
    if (discussingComment) reasons.push(`A later comment discusses the change, but the issue text was not updated`);
    return { status: 'stale-reference', reasons };
  }
  if (newInIssue || linked || discussingComment) {
    if (newInIssue) reasons.push(`Issue already mentions “${newTerm}”`);
    if (linked) reasons.push('Issue links to the decision source');
    if (discussingComment) reasons.push('A comment after the decision discusses it');
    if (staleInIssue) reasons.push(`Issue also still mentions “${staleTerm}”; check the wording`);
    return { status: 'possibly-reflected', reasons };
  }
  const updatedSince = daysBetween(draft.sourceUpdatedAt, issue.updatedAt);
  reasons.push(
    updatedSince < 0
      ? `Issue has not been updated since the decision (last updated ${issue.updatedAt.slice(0, 10)})`
      : 'No sign the issue was updated for this decision',
  );
  return { status: 'not-reflected', reasons };
}

export function matchIssues(draft: DecisionDraft, index: MatchIndex, minStrength: MatchStrength): IssueMatch[] {
  const decisionTokens = tokenSet([draft.decisionText, draft.change?.from, draft.change?.removed].filter(Boolean).join(' '));
  const matches: IssueMatch[] = [];

  for (const issue of index.issues) {
    const reasons: MatchReason[] = [];
    let level = 0;
    const raise = (to: number) => {
      level = Math.max(level, to);
    };

    if (draft.sourceIssueKey === issue.key) {
      reasons.push({ code: 'same-issue-discussion', label: `The decision was made in this issue's comments` });
      raise(3);
    }
    if (draft.passageIssueKeys.includes(issue.key)) {
      reasons.push({ code: 'issue-key-in-passage', label: `The decision text mentions ${issue.key}` });
      raise(3);
    }
    // A page-level link or mention is not specific to one decision on that page, so on
    // its own it only counts as weak; together with shared terms it strengthens a match.
    const linksSource = issue.linkedSourceIds?.some((id) => id === draft.sourceId || id === draft.sourceUrl) === true;
    const keyOnPage = draft.pageIssueKeys.includes(issue.key) && !draft.passageIssueKeys.includes(issue.key);
    if (linksSource) {
      reasons.push({ code: 'issue-links-source', label: 'The issue links to the decision source' });
      raise(1);
    }
    const overlap = termOverlap(decisionTokens, index.issueTokens.get(issue.key) ?? new Set(), index.idf);
    if (overlap.level > 0) {
      const terms = displayTerms(overlap.shared, issue).map((t) => `“${t}”`);
      reasons.push({ code: 'shared-terms', label: `Shares key terms: ${terms.join(', ')}` });
      raise(overlap.level);
      if (keyOnPage) reasons.push({ code: 'issue-key-on-page', label: `The source page also references ${issue.key}` });
      if (linksSource || keyOnPage) raise(Math.min(3, overlap.level + 1));
    }
    const oldTerm = draft.change?.from ?? draft.change?.removed;
    if (level === 0 && oldTerm && isDistinctive(oldTerm, index) && containsPhrase(`${issue.summary}\n${issue.description}`, oldTerm)) {
      reasons.push({ code: 'shared-terms', label: `Names “${oldTerm}”, which the decision changes` });
      raise(1);
    }
    if (level === 0) continue;

    const drift = assessDrift(draft, issue, index.commentsByIssue.get(issue.key) ?? []);
    // Still naming the replaced thing is strong evidence the issue is about this decision.
    if (drift.status === 'stale-reference') raise(Math.min(3, level + 1));
    if (level < LEVEL[minStrength]) continue;

    matches.push({
      issueKey: issue.key,
      issueSummary: issue.summary,
      issueStatus: issue.status,
      issueUrl: issue.url,
      strength: STRENGTH[level],
      reasons,
      drift: drift.status,
      driftReasons: drift.reasons,
    });
  }

  const driftOrder: Record<DriftStatus, number> = { 'stale-reference': 0, 'not-reflected': 1, 'possibly-reflected': 2 };
  return matches.sort((a, b) => LEVEL[b.strength] - LEVEL[a.strength] || driftOrder[a.drift] - driftOrder[b.drift]);
}
