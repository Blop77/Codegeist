import { createHash, randomUUID } from 'node:crypto';
import { kvs } from '@forge/kvs';
import { resolveFindingForIssue } from './scan';
import { canChangeReviews, composeNote, defaultNoteText, NO_REVIEW_PERMISSION, noteKey, noteProblem, postNote, reviewerHash, reviewKey } from './notes';

const DRAFT_MINUTES = 10;
const draftKey = (accountId, issueKey) =>
  `rovo-draft:${createHash('sha256').update(accountId).digest('hex')}:${issueKey}`;

/**
 * Stores a private draft for the requesting person. The comment is composed by the same server
 * rule as manual posting: when the source cannot be quoted to the issue's audience, the agent's
 * note is discarded and the draft is the fixed generic follow-up.
 */
export async function prepareRovoDraft({ accountId, projectKey, issueKey, candidateId, note, siteUrl, cloudId }) {
  const finding = await resolveFindingForIssue({ projectKey, issueKey, candidateId, cloudId });
  if (!finding.ok) return finding;
  const { candidate, issue } = finding;
  const [review, posted] = await Promise.all([
    kvs.get(reviewKey(projectKey, candidateId)),
    kvs.get(noteKey(projectKey, candidateId, issueKey))
  ]);
  if (review?.status === 'dismissed') return { ok: false, error: 'A teammate dismissed this finding. Undo the review in Jira to prepare a note.' };
  if (posted) return { ok: false, error: `A note for this finding was already posted to ${issueKey}.` };

  const composed = await composeNote({ candidate, projectKey, note: note || defaultNoteText(candidate), siteUrl, confirmedIn: 'rovo' });
  const draft = {
    id: randomUUID(),
    projectKey,
    candidateId,
    issueKey,
    mode: composed.mode,
    note: composed.note,
    digest: composed.digest,
    sourceUpdatedAt: candidate.source.updatedAt ?? null,
    issueUpdatedAt: issue.updatedAt,
    expiresAt: Date.now() + DRAFT_MINUTES * 60 * 1000
  };
  const problem = noteProblem({ ...draft, quote: composed.quote });
  if (problem) return { ok: false, error: problem };
  await kvs.set(draftKey(accountId, issueKey), draft, { ttl: { unit: 'MINUTES', value: DRAFT_MINUTES } });
  return {
    ok: true,
    issueKey,
    expiresInMinutes: DRAFT_MINUTES,
    commentType: composed.mode === 'quoted' ? 'quotes the decision and links its source' : 'generic follow-up without the source',
    ...(composed.mode === 'quoted' ? {} : { sharingNote: composed.explanation })
  };
}

/** The draft's comment rebuilt with the person's current access; it must still match what was prepared. */
async function currentDraft({ issueKey, siteUrl, cloudId }, draft) {
  if (!draft || draft.issueKey !== issueKey || !(draft.expiresAt > Date.now())) {
    return { ok: false, error: 'No current Rovo draft. Prepare a new note in chat.' };
  }

  const finding = await resolveFindingForIssue({ ...draft, cloudId });
  if (!finding.ok) return finding;
  if ((finding.candidate.source.updatedAt ?? null) !== draft.sourceUpdatedAt || finding.issue.updatedAt !== draft.issueUpdatedAt) {
    return { ok: false, error: 'The issue or decision changed after the draft was prepared. Prepare a new note in chat.' };
  }
  const composed = await composeNote({ candidate: finding.candidate, projectKey: draft.projectKey, note: draft.note, siteUrl, confirmedIn: 'rovo' });
  if (composed.digest !== draft.digest) {
    return { ok: false, error: 'Who can see the decision\'s source, or the source itself, changed after the draft was prepared. Prepare a new note in chat.' };
  }
  const review = await kvs.get(reviewKey(draft.projectKey, draft.candidateId));
  if (review?.status === 'dismissed') return { ok: false, error: 'A teammate dismissed this finding. The note was not posted.' };
  const posted = await kvs.get(noteKey(draft.projectKey, draft.candidateId, issueKey));
  if (posted) return { ok: false, error: 'A note for this finding has already been posted.' };
  return { ok: true, draft, composed };
}

export async function loadRovoDraft(input) {
  const { accountId, issueKey } = input;
  const draft = await kvs.get(draftKey(accountId, issueKey));
  if (!draft) return { ok: true, draft: null };
  const current = await currentDraft(input, draft);
  if (!current.ok) return current;
  const { composed } = current;
  return {
    ok: true,
    draft: { id: draft.id, mode: composed.mode, text: composed.text, digest: composed.digest, explanation: composed.explanation, expiresAt: draft.expiresAt }
  };
}

/** Posts the draft only if its comment is still exactly the preview the person confirmed (`digest`). */
export async function confirmRovoDraft(input, id, digest) {
  const { accountId, issueKey } = input;
  const key = draftKey(accountId, issueKey);
  const draft = await kvs.get(key);
  if (!draft || draft.id !== id) return { ok: false, error: 'This draft has changed. Load the latest draft before posting.' };

  const current = await currentDraft(input, draft);
  if (!current.ok) return current;
  if (!digest || digest !== current.composed.digest) {
    return { ok: false, error: 'The comment changed since you loaded the preview, so nothing was posted. Load the draft again.' };
  }
  // Posting a draft also records a relevant review, which everyone in the project sees.
  if (!(await canChangeReviews(draft.projectKey, issueKey))) return { ok: false, error: NO_REVIEW_PERMISSION };
  const posted = await postNote({ ...draft, body: current.composed.body, confirmedIn: 'rovo' });
  if (!posted.ok) return posted;

  let warning = posted.warning;
  const review = reviewKey(draft.projectKey, draft.candidateId);
  try {
    if (!(await kvs.get(review))) {
      await kvs.set(review, { status: 'relevant', reviewedAt: new Date().toISOString(), via: 'rovo', reviewer: reviewerHash(accountId) });
    }
  } catch {
    warning ??= 'The comment was posted, but the review record could not be updated.';
  }
  return { ...posted, candidateId: draft.candidateId, ...(warning ? { warning } : {}) };
}
