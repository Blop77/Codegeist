import { extractDrafts, type DecisionDraft } from './extract.ts';
import { reviewWithModel, type DecisionModel, type ModelReviewOptions } from './llm.ts';
import { buildMatchIndex, matchIssues } from './match.ts';
import { prioritize } from './rank.ts';
import { jaccard, tokenSet } from './text.ts';
import type {
  AnalyzeInput,
  AnalyzeOptions,
  AnalyzeResult,
  Confidence,
  DecisionCandidate,
  Diagnostics,
  JiraCommentRecord,
  ModelReview,
  PriorityTier,
  SourceRef,
} from './types.ts';

export interface AnalyzeDeps {
  /** Optional model review of uncertain passages. Omit for the deterministic baseline. */
  model?: DecisionModel;
  modelOptions?: Partial<ModelReviewOptions>;
}

const DEFAULTS: AnalyzeOptions = {
  includeKinds: ['explicit', 'possible', 'unresolved'],
  minMatchStrength: 'moderate',
  hideReflected: false,
  maxCandidates: 50,
};

const CONFIDENCE_RANK: Record<Confidence, number> = { high: 3, medium: 2, low: 1 };
const TIER_RANK: Record<PriorityTier, number> = { high: 3, medium: 2, low: 1 };

type Draft = DecisionDraft & { model?: ModelReview; alsoSeenIn: SourceRef[] };

function toRef(d: DecisionDraft): SourceRef {
  return {
    sourceType: d.sourceType,
    sourceId: d.sourceId,
    sourceTitle: d.sourceTitle,
    sourceUrl: d.sourceUrl,
    evidenceExcerpt: d.evidenceExcerpt,
    sourceUpdatedAt: d.sourceUpdatedAt,
  };
}

function strongerDraft(a: Draft, b: Draft): boolean {
  return (
    CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence] ||
    Number(a.flags.markedDecision) - Number(b.flags.markedDecision) ||
    Number(a.flags.authoritativeSource) - Number(b.flags.authoritativeSource) ||
    Date.parse(a.sourceUpdatedAt) - Date.parse(b.sourceUpdatedAt)
  ) > 0;
}

/** Merges the same decision stated in several places, keeping the strongest statement. */
function dedupe(drafts: DecisionDraft[]): { drafts: Draft[]; merged: number } {
  const kept: Array<{ draft: Draft; tokens: Set<string> }> = [];
  let merged = 0;
  for (const raw of drafts) {
    const draft: Draft = { ...raw, alsoSeenIn: [] };
    const tokens = tokenSet(draft.decisionText);
    const twin = kept.find((k) => k.draft.kind === draft.kind && tokens.size >= 3 && jaccard(tokens, k.tokens) >= 0.75);
    if (!twin) {
      kept.push({ draft, tokens });
      continue;
    }
    merged++;
    const [winner, loser] = strongerDraft(draft, twin.draft) ? [draft, twin.draft] : [twin.draft, draft];
    winner.alsoSeenIn = [...twin.draft.alsoSeenIn, ...draft.alsoSeenIn, toRef(loser)];
    winner.flags = {
      markedDecision: winner.flags.markedDecision || loser.flags.markedDecision,
      decisionSection: winner.flags.decisionSection || loser.flags.decisionSection,
      authoritativeSource: winner.flags.authoritativeSource || loser.flags.authoritativeSource,
    };
    winner.passageIssueKeys = [...new Set([...winner.passageIssueKeys, ...loser.passageIssueKeys])];
    winner.confidenceReasons = [...winner.confidenceReasons, `Also stated in ${loser.sourceTitle}`];
    twin.draft = winner;
    twin.tokens = tokenSet(winner.decisionText);
  }
  return { drafts: kept.map((k) => k.draft), merged };
}

/**
 * Finds decision candidates in the given sources and matches them to Jira issues.
 * Pure function of its input: no network calls, no storage, no Jira writes.
 */
export async function analyzeDecisions(input: AnalyzeInput, deps: AnalyzeDeps = {}): Promise<AnalyzeResult> {
  const options: AnalyzeOptions = { ...DEFAULTS, ...input.options };
  const now = input.now ?? new Date().toISOString();
  const since = input.since ? Date.parse(input.since) : undefined;

  const issues = input.issues.filter((i) => i.projectKey === input.projectKey);
  const issueKeys = new Set(issues.map((i) => i.key));
  const issuesByKey = new Map(issues.map((i) => [i.key, i]));

  const inScope = input.sources.filter((s) => s.kind === 'confluence-page' || issueKeys.has(s.issueKey));
  const inWindow = inScope.filter((s) => {
    if (since === undefined) return true;
    return Date.parse(s.kind === 'confluence-page' ? s.updatedAt : s.createdAt) >= since;
  });

  const extracted = extractDrafts(inWindow, input.projectKey);
  const deduped = dedupe(extracted.drafts);
  let drafts: Draft[] = deduped.drafts;

  const diagnostics: Diagnostics = {
    sourcesScanned: inWindow.length,
    sourcesSkippedByWindow: inScope.length - inWindow.length,
    passagesScanned: extracted.passages,
    candidatesBeforeDedupe: extracted.drafts.length,
    duplicatesMerged: deduped.merged,
    candidatesReturned: 0,
  };

  if (deps.model) {
    const reviewed = await reviewWithModel(drafts, deps.model, deps.modelOptions);
    drafts = reviewed.drafts as Draft[];
    diagnostics.model = reviewed.report;
  }

  // Every comment in scope is drift evidence, even ones outside the time window.
  const comments = inScope.filter((s): s is JiraCommentRecord => s.kind === 'jira-comment');
  const index = buildMatchIndex(issues, comments);

  const ranked: Array<{ candidate: DecisionCandidate; points: number }> = [];
  for (const draft of drafts) {
    if (!options.includeKinds.includes(draft.kind)) continue;
    const matches = matchIssues(draft, index, options.minMatchStrength);
    if (options.hideReflected && matches.length > 0 && matches.every((m) => m.drift === 'possibly-reflected')) continue;
    const priority = prioritize(draft, matches, issuesByKey, now);

    const candidate: DecisionCandidate = {
      id: draft.id,
      projectId: draft.projectId,
      kind: draft.kind,
      decisionText: draft.decisionText,
      sourceType: draft.sourceType,
      sourceId: draft.sourceId,
      sourceTitle: draft.sourceTitle,
      sourceUrl: draft.sourceUrl,
      sourceAuthor: draft.sourceAuthor,
      sourceUpdatedAt: draft.sourceUpdatedAt,
      evidenceExcerpt: draft.evidenceExcerpt,
      evidenceSpan: draft.evidenceSpan,
      alsoSeenIn: draft.alsoSeenIn,
      confidence: draft.confidence,
      confidenceReasons: draft.confidenceReasons,
      affectedIssues: matches,
      affectedIssueKeys: matches.map((m) => m.issueKey),
      priority: { tier: priority.tier, signals: priority.signals },
    };
    if (draft.change) candidate.change = draft.change;
    if (draft.model) candidate.model = draft.model;
    ranked.push({ candidate, points: priority.points });
  }

  ranked.sort(
    (a, b) =>
      TIER_RANK[b.candidate.priority.tier] - TIER_RANK[a.candidate.priority.tier] ||
      b.points - a.points ||
      Date.parse(b.candidate.sourceUpdatedAt) - Date.parse(a.candidate.sourceUpdatedAt),
  );
  const candidates = ranked.slice(0, options.maxCandidates).map((r) => r.candidate);
  diagnostics.candidatesReturned = candidates.length;
  return { candidates, diagnostics };
}
