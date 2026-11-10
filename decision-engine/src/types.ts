/**
 * Shared contracts for the Decision Drift Radar extraction/matching module.
 *
 * Ownership: this module only reads normalized records and returns candidates.
 * Review state (`state`, `createdAt`, `updatedAt`), persistence and Jira writes
 * belong to the Forge resolver layer and are deliberately absent here.
 */

export type IsoDate = string;

// ---------------------------------------------------------------------------
// Normalized source records (input)
// ---------------------------------------------------------------------------

export type StatusCategory = 'todo' | 'in-progress' | 'done';

/** A Jira issue that decisions may affect. Text fields are plain text. */
export interface JiraIssueRecord {
  kind: 'jira-issue';
  key: string;
  projectKey: string;
  summary: string;
  /** Plain text. Convert Jira REST v3 ADF with `adfToPlainText`. */
  description: string;
  status: string;
  statusCategory: StatusCategory;
  /** True when the issue is flagged/impeded or its status reads as blocked. */
  flagged?: boolean;
  labels: string[];
  components: string[];
  updatedAt: IsoDate;
  url: string;
  /** Confluence page ids or URLs attached to the issue (remote links). */
  linkedSourceIds?: string[];
}

/** A Jira comment. Comments are both decision sources and drift evidence. */
export interface JiraCommentRecord {
  kind: 'jira-comment';
  id: string;
  issueKey: string;
  author: string;
  /** Plain text. Convert Jira REST v3 ADF with `adfToPlainText`. */
  body: string;
  createdAt: IsoDate;
  url: string;
}

export type BlockType =
  | 'heading'
  | 'paragraph'
  | 'list-item'
  | 'decision-item'
  | 'task-item'
  | 'table-cell'
  | 'quote';

/** One block of a Confluence page, in reading order. */
export interface ContentBlock {
  /** Stable within the page (ADF localId when present, otherwise positional). */
  id: string;
  type: BlockType;
  text: string;
  headingLevel?: number;
  /** Set only for Confluence decision items. */
  decisionState?: 'DECIDED' | 'UNDECIDED';
}

/** A Confluence page, flattened to blocks. Build with `confluenceAdfToBlocks`. */
export interface ConfluencePageRecord {
  kind: 'confluence-page';
  id: string;
  spaceKey: string;
  title: string;
  url: string;
  author: string;
  labels: string[];
  updatedAt: IsoDate;
  blocks: ContentBlock[];
}

export type SourceRecord = JiraCommentRecord | ConfluencePageRecord;
export type SourceType = SourceRecord['kind'];

// ---------------------------------------------------------------------------
// Candidates (output)
// ---------------------------------------------------------------------------

/**
 * - explicit: the source states a decision was made.
 * - possible: a proposal or leaning that may become a decision.
 * - unresolved: an open question or undecided item.
 */
export type DecisionKind = 'explicit' | 'possible' | 'unresolved';

/**
 * How sure the engine is that the passage is what `kind` says it is.
 * It is a label with reasons, never a probability.
 */
export type Confidence = 'high' | 'medium' | 'low';

/** What the decision changes, when the wording makes that clear. */
export interface DecisionChange {
  /** The thing being replaced ("legacy card form"). */
  from?: string;
  /** The replacement ("Stripe Payment Element"). */
  to?: string;
  /** The thing removed or descoped ("guest checkout"). */
  removed?: string;
}

/** Character offsets into the block text (pages) or comment body (comments). */
export interface EvidenceSpan {
  blockId: string | null;
  start: number;
  end: number;
}

export interface SourceRef {
  sourceType: SourceType;
  sourceId: string;
  sourceTitle: string;
  sourceUrl: string;
  evidenceExcerpt: string;
  sourceUpdatedAt: IsoDate;
}

export type MatchStrength = 'strong' | 'moderate' | 'weak';

export type MatchReasonCode =
  | 'same-issue-discussion'
  | 'issue-key-in-passage'
  | 'issue-links-source'
  | 'issue-key-on-page'
  | 'shared-terms';

export interface MatchReason {
  code: MatchReasonCode;
  label: string;
}

/**
 * - stale-reference: the issue still names the thing the decision replaced or removed.
 * - not-reflected: no sign the issue was updated for the decision.
 * - possibly-reflected: the issue links the source or names the new direction; a
 *   person should confirm.
 */
export type DriftStatus = 'stale-reference' | 'not-reflected' | 'possibly-reflected';

export interface IssueMatch {
  issueKey: string;
  issueSummary: string;
  issueStatus: string;
  issueUrl: string;
  strength: MatchStrength;
  reasons: MatchReason[];
  drift: DriftStatus;
  driftReasons: string[];
}

export type PriorityTier = 'high' | 'medium' | 'low';

/** A transparent ranking input. Show these to the reviewer instead of a score. */
export interface PrioritySignal {
  code: string;
  label: string;
  /** Contribution to ordering only. Not a probability or a confidence. */
  weight: number;
}

export interface ModelReview {
  summary?: string;
  rationale: string;
  /** Kind before the model review, when the model changed it. */
  previousKind?: DecisionKind;
}

export interface DecisionCandidate extends SourceRef {
  /** Stable across runs for the same passage, so review state can key on it. */
  id: string;
  projectId: string;
  kind: DecisionKind;
  /** The passage with labels such as "Decision:" removed. */
  decisionText: string;
  change?: DecisionChange;
  sourceAuthor: string;
  evidenceSpan: EvidenceSpan;
  /** Other sources that state the same decision. */
  alsoSeenIn: SourceRef[];
  confidence: Confidence;
  confidenceReasons: string[];
  affectedIssues: IssueMatch[];
  affectedIssueKeys: string[];
  priority: { tier: PriorityTier; signals: PrioritySignal[] };
  model?: ModelReview;
}

// ---------------------------------------------------------------------------
// Engine entry point
// ---------------------------------------------------------------------------

export interface AnalyzeOptions {
  /** Kinds to return. Default: all three. */
  includeKinds: DecisionKind[];
  /** Weakest issue match to keep. Default: 'moderate'. */
  minMatchStrength: MatchStrength;
  /** Drop candidates whose only matches look already reflected. Default: false. */
  hideReflected: boolean;
  /** Cap on returned candidates, after ranking. Default: 50. */
  maxCandidates: number;
}

export interface AnalyzeInput {
  projectKey: string;
  issues: JiraIssueRecord[];
  sources: SourceRecord[];
  /** Reference time for recency signals. Default: now. */
  now?: IsoDate;
  /** Ignore sources last updated before this time. */
  since?: IsoDate;
  options?: Partial<AnalyzeOptions>;
}

export interface Diagnostics {
  sourcesScanned: number;
  sourcesSkippedByWindow: number;
  passagesScanned: number;
  candidatesBeforeDedupe: number;
  duplicatesMerged: number;
  candidatesReturned: number;
  model?: {
    reviewed: number;
    changedKind: number;
    dropped: Array<{ candidateId: string; rationale: string }>;
    rejectedUnverifiedEvidence: number;
    errors: number;
  };
}

export interface AnalyzeResult {
  candidates: DecisionCandidate[];
  diagnostics: Diagnostics;
}
