import type { DecisionDraft } from './extract.ts';
import { normalizeSpace } from './text.ts';
import type { DecisionKind, Diagnostics, ModelReview } from './types.ts';

/**
 * Optional model review. The engine works without it. Implement this with Rovo, an
 * approved LLM endpoint, or anything else; the engine never calls a vendor directly.
 */
export interface DecisionModel {
  review(input: DecisionModelInput): Promise<DecisionModelOutput>;
}

export interface DecisionModelInput {
  /** The passage the deterministic rules flagged. */
  passage: string;
  /** The surrounding block or comment, for context. */
  context: string;
  sourceTitle: string;
  currentKind: DecisionKind;
}

export interface DecisionModelOutput {
  kind: DecisionKind | 'none';
  /** A short restatement of the decision. Shown as a summary, never as evidence. */
  summary?: string;
  /** Must be copied word for word from the context. Output is rejected otherwise. */
  quotedEvidence: string;
  rationale: string;
}

export interface ModelReviewOptions {
  /** Most passages sent to the model per run. Default 20. */
  maxCalls: number;
  /** Per-call timeout. Default 8000 ms. */
  timeoutMs: number;
  /** Review high-confidence explicit decisions too. Default false. */
  reviewHighConfidence: boolean;
}

const KINDS = new Set(['explicit', 'possible', 'unresolved', 'none']);

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Model review timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Lets a model reclassify or drop uncertain drafts. Every change is recorded, and output
 * whose quoted evidence is not in the source is discarded so the model cannot invent a
 * decision. Failures leave the deterministic result unchanged.
 */
export async function reviewWithModel(
  drafts: Array<DecisionDraft & { model?: ModelReview }>,
  model: DecisionModel,
  options: Partial<ModelReviewOptions> = {},
): Promise<{ drafts: Array<DecisionDraft & { model?: ModelReview }>; report: NonNullable<Diagnostics['model']> }> {
  const opts: ModelReviewOptions = { maxCalls: 20, timeoutMs: 8000, reviewHighConfidence: false, ...options };
  const report: NonNullable<Diagnostics['model']> = { reviewed: 0, changedKind: 0, dropped: [], rejectedUnverifiedEvidence: 0, errors: 0 };
  const kept: Array<DecisionDraft & { model?: ModelReview }> = [];

  for (const draft of drafts) {
    const eligible = opts.reviewHighConfidence || draft.confidence !== 'high' || draft.kind === 'possible';
    if (!eligible || report.reviewed + report.errors >= opts.maxCalls) {
      kept.push(draft);
      continue;
    }
    let output: DecisionModelOutput;
    try {
      output = await withTimeout(
        model.review({ passage: draft.evidenceExcerpt, context: draft.contextText, sourceTitle: draft.sourceTitle, currentKind: draft.kind }),
        opts.timeoutMs,
      );
    } catch {
      report.errors++;
      kept.push(draft);
      continue;
    }
    report.reviewed++;

    const valid =
      output &&
      KINDS.has(output.kind) &&
      typeof output.rationale === 'string' &&
      output.rationale.trim().length > 0 &&
      typeof output.quotedEvidence === 'string' &&
      output.quotedEvidence.trim().length > 0 &&
      normalizeSpace(draft.contextText).includes(normalizeSpace(output.quotedEvidence));
    if (!valid) {
      report.rejectedUnverifiedEvidence++;
      kept.push(draft);
      continue;
    }

    const rationale = output.rationale.trim().slice(0, 500);
    if (output.kind === 'none') {
      report.dropped.push({ candidateId: draft.id, rationale });
      continue;
    }
    const review: ModelReview = { rationale };
    if (output.summary?.trim()) review.summary = output.summary.trim().slice(0, 300);
    const next = { ...draft, confidenceReasons: [...draft.confidenceReasons, `Model review: ${rationale}`], model: review };
    if (output.kind !== draft.kind) {
      report.changedKind++;
      review.previousKind = draft.kind;
      next.kind = output.kind;
      // A model alone never earns high confidence; deterministic evidence does.
      next.confidence = output.kind === 'explicit' && !draft.flags.markedDecision ? 'medium' : 'low';
      if (output.kind === 'unresolved') delete next.change;
    }
    kept.push(next);
  }
  return { drafts: kept, report };
}
