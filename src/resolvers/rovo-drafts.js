import { createHash, randomUUID } from 'node:crypto';
import { storage } from '@forge/api';
import { kvs } from '@forge/kvs';
import { resolveFindingForIssue } from './scan';
import { defaultNoteText, noteEvidence, noteKey, noteProblem, postNote, reviewKey } from './notes';

const DRAFT_MINUTES = 10;
const draftKey = (accountId, issueKey) =>
  `rovo-draft:${createHash('sha256').update(accountId).digest('hex')}:${issueKey}`;

export async function prepareRovoDraft({ accountId, projectKey, issueKey, candidateId, note, siteUrl, cloudId }) {
  const finding = await resolveFindingForIssue({ projectKey, issueKey, candidateId, cloudId });
  if (!finding.ok) return finding;
  const { candidate, issue } = finding;
  const [review, posted] = await Promise.all([
    storage.get(reviewKey(projectKey, candidateId)),
    storage.get(noteKey(projectKey, candidateId, issueKey))
  ]);
  if (review?.status === 'dismissed') return { ok: false, error: 'A teammate dismissed this finding. Undo the review in Jira to prepare a note.' };
  if (posted) return { ok: false, error: `A note for this finding was already posted to ${issueKey}.` };

  const draft = {
    id: randomUUID(),
    projectKey,
    candidateId,
    issueKey,
    note: note || defaultNoteText(candidate),
    ...noteEvidence(candidate, siteUrl),
    sourceUpdatedAt: candidate.source.updatedAt ?? null,
    issueUpdatedAt: issue.updatedAt,
    expiresAt: Date.now() + DRAFT_MINUTES * 60 * 1000
  };
  const problem = noteProblem(draft);
  if (problem) return { ok: false, error: problem };
  await kvs.set(draftKey(accountId, issueKey), draft, { ttl: { unit: 'MINUTES', value: DRAFT_MINUTES } });
  return { ok: true, issueKey, expiresInMinutes: DRAFT_MINUTES };
}

async function currentDraft({ accountId, issueKey, siteUrl, cloudId }, draft) {
  if (!draft || draft.issueKey !== issueKey || !(draft.expiresAt > Date.now())) {
    return { ok: false, error: 'No current Rovo draft. Prepare a new note in chat.' };
  }

  const finding = await resolveFindingForIssue({ ...draft, cloudId });
  if (!finding.ok) return finding;
  const evidence = noteEvidence(finding.candidate, siteUrl);
  if (evidence.quote !== draft.quote || evidence.sourceTitle !== draft.sourceTitle
    || (draft.sourceUrl && evidence.sourceUrl !== draft.sourceUrl)
    || (finding.candidate.source.updatedAt ?? null) !== draft.sourceUpdatedAt
    || finding.issue.updatedAt !== draft.issueUpdatedAt) {
    return { ok: false, error: 'The issue or decision changed after the draft was prepared. Prepare a new note in chat.' };
  }
  const review = await storage.get(reviewKey(draft.projectKey, draft.candidateId));
  if (review?.status === 'dismissed') return { ok: false, error: 'A teammate dismissed this finding. The note was not posted.' };
  const posted = await storage.get(noteKey(draft.projectKey, draft.candidateId, issueKey));
  if (posted) return { ok: false, error: 'A note for this finding has already been posted.' };
  return { ok: true, draft: { ...draft, ...evidence } };
}

export async function loadRovoDraft(input) {
  const { accountId, issueKey } = input;
  const draft = await kvs.get(draftKey(accountId, issueKey));
  if (!draft) return { ok: true, draft: null };
  const current = await currentDraft(input, draft);
  if (!current.ok) return current;
  const { id, note, quote, sourceTitle, sourceUrl, expiresAt } = current.draft;
  return { ok: true, draft: { id, note, quote, sourceTitle, sourceUrl, expiresAt } };
}

export async function confirmRovoDraft(input, id) {
  const { accountId, issueKey, siteUrl } = input;
  const key = draftKey(accountId, issueKey);
  const draft = await kvs.get(key);
  if (!draft || draft.id !== id) return { ok: false, error: 'This draft has changed. Load the latest draft before posting.' };

  const current = await currentDraft(input, draft);
  if (!current.ok) return current;
  const posted = await postNote({ ...current.draft, siteUrl, confirmedIn: 'rovo' });
  if (!posted.ok) return posted;

  let warning = posted.warning;
  const review = reviewKey(draft.projectKey, draft.candidateId);
  try {
    if (!(await storage.get(review))) {
      await storage.set(review, { status: 'relevant', reviewedAt: new Date().toISOString(), via: 'rovo' });
    }
  } catch {
    warning ??= 'The comment was posted, but the review record could not be updated.';
  }
  return { ...posted, candidateId: draft.candidateId, ...(warning ? { warning } : {}) };
}
