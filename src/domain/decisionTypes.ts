/**
 * Shared contract for the Decision Drift Radar domain module.
 *
 * This module reads normalized records and returns candidates. It never fetches data,
 * stores review state or writes to Jira; those belong to the resolver and UI layers.
 */

/** Where a passage came from. Text is plain text (see README for the expected format). */
export type SourceType = 'confluence_page' | 'jira_issue' | 'jira_comment';

export interface SourceRecord {
  id: string;
  type: SourceType;
  title: string;
  url: string;
  /** Plain text. Offsets in EvidenceSpan are UTF-16 indexes into this string. */
  text: string;
  /** The Jira project this source belongs to. Issues are matched only within it. */
  projectKey: string;
  /** ISO 8601. A malformed value produces a warning, not a failure. */
  updatedAt: string;
  author?: string;
  /** How the source was found, when not by the plain project-key search, e.g. "Teamwork Graph: space of team Marketing". */
  via?: string;
}

export interface IssueRecord {
  id: string;
  key: string;
  title: string;
  description?: string;
  projectKey: string;
  status?: string;
  labels?: string[];
  /** ISO 8601. A malformed value produces a warning, not a failure. */
  updatedAt: string;
}

/**
 * - decision: the source states a commitment was made.
 * - proposal: a suggestion or leaning that has not been committed to.
 * - open_question: something the source says is still undecided.
 */
export type DecisionKind = 'decision' | 'proposal' | 'open_question';

/** `sourceText.slice(start, end) === quote`, always. Offsets are UTF-16 code units. */
export interface EvidenceSpan {
  quote: string;
  start: number;
  end: number;
}

export interface CandidateSource {
  id: string;
  type: SourceType;
  title: string;
  url: string;
  projectKey: string;
  /** As given in the input, even when malformed (a warning is raised in that case). */
  updatedAt: string;
  author?: string;
  /** How the source was found, when not by the plain project-key search, e.g. "Teamwork Graph: space of team Marketing". */
  via?: string;
}

export interface AffectedIssue {
  issueKey: string;
  /** 0..1. How strongly the observable signals tie the issue to the decision. Not a probability. */
  relevance: number;
  /** Observable wording in the current issue. Omitted when the scan has no clear change evidence. */
  wordingStatus?: 'outdated' | 'replacement-found';
  /** One entry per signal that contributed. Never empty. */
  reasons: string[];
}

export interface DecisionCandidate {
  /** Stable for the same source id and passage, so review state can be keyed on it. */
  id: string;
  kind: DecisionKind;
  /** The quote with labels and list markers removed. Uses only words from the quote. */
  summary: string;
  evidence: EvidenceSpan;
  source: CandidateSource;
  /** 0..1. How clearly the wording supports `kind`. Never 1: this is a heuristic. */
  confidence: number;
  /** Observable signals behind `confidence`, e.g. 'Starts with a "Decision:" label'. */
  confidenceReasons: string[];
  affectedIssues: AffectedIssue[];
}

export interface ExtractionInput {
  sources: SourceRecord[];
  issues: IssueRecord[];
  /** Keep at most this many candidates, after ranking. */
  maxCandidates?: number;
}

export type ExtractionWarningCode =
  | 'invalid_input'
  | 'empty_input'
  | 'invalid_source'
  | 'invalid_issue'
  | 'duplicate_source'
  | 'duplicate_issue'
  | 'invalid_timestamp'
  | 'invalid_option'
  | 'candidates_truncated';

export interface ExtractionWarning {
  code: ExtractionWarningCode;
  message: string;
  /** The source or issue id the warning is about, when there is one. */
  recordId?: string;
}

export interface ExtractionResult {
  candidates: DecisionCandidate[];
  warnings: ExtractionWarning[];
}

// ---------------------------------------------------------------------------
// Extension point (optional)
// ---------------------------------------------------------------------------

/** What a classifier says about one sentence. */
export interface SentenceClassification {
  kind: DecisionKind;
  /** 0..1, before source-level adjustments. */
  confidence: number;
  reasons: string[];
}

export interface SentenceContext {
  sourceType: SourceType;
  sourceTitle: string;
  /** True when the sentence sits under a heading such as "Decisions". */
  underDecisionHeading: boolean;
  /** True when the sentence is a list item under a heading that only names decisions ("Decisions", "Decision log", "Agreed"). */
  decisionListItem?: boolean;
}

/**
 * Replaces the built-in rules for classifying a sentence. Must be pure and synchronous
 * so `extractDecisions` stays deterministic. A model-backed path should run outside this
 * module (for example, re-ranking candidates afterwards) rather than inside it.
 */
export type SentenceClassifier = (sentence: string, context: SentenceContext) => SentenceClassification | null;

export interface ExtractionOptions {
  classifier?: SentenceClassifier;
}
