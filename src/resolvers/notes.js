/**
 * Review records and the app's one Jira write (a reviewed note posted as a comment), shared by
 * the app's resolvers and the Rovo agent's actions so both enforce the same rules.
 */
import api, { route, startsWith, storage } from '@forge/api';
import { noteCommentBody } from './normalize';

export const MAX_NOTE_LENGTH = 2000;
export const MAX_QUOTE_LENGTH = 320;
const MAX_TITLE_LENGTH = 255;
// Forge storage returns at most 20 entries per query page.
const REVIEW_PAGE_SIZE = 20;
const MAX_REVIEW_PAGES = 50;

export function reviewPrefix(projectKey) {
  return `review:${projectKey}:`;
}

export function reviewKey(projectKey, candidateId) {
  return `${reviewPrefix(projectKey)}${candidateId}`;
}

export function notePrefix(projectKey) {
  return `note:${projectKey}:`;
}

/** One record per finding and issue, so the same note is not posted twice. */
export function noteKey(projectKey, candidateId, issueKey) {
  return `${notePrefix(projectKey)}${candidateId}:${issueKey}`;
}

export function validReviewTarget(projectKey, candidateId) {
  return /^[A-Z][A-Z0-9_]{1,9}$/.test(projectKey) && /^dc_[a-f0-9]{16}$/.test(candidateId);
}

/** Review state is per project, so only people who can see the project may change it. */
export async function canAccessProject(projectKey) {
  const response = await api.asUser().requestJira(route`/rest/api/3/project/${projectKey}`);
  return response.ok;
}

/** A link on this site to a Confluence page or Jira issue; anything else is dropped. */
export function trustedSourceUrl(value, siteUrl) {
  try {
    const url = new URL(String(value ?? ''));
    if (url.protocol !== 'https:') return null;
    if (!/^\/(?:wiki|browse)\//.test(url.pathname)) return null;
    if (siteUrl ? url.origin !== new URL(siteUrl).origin : !url.hostname.endsWith('.atlassian.net')) return null;
    return url.href;
  } catch {
    return null;
  }
}

/** The suggested note, using only the finding's own words. The person edits it before posting. */
export function defaultNoteText(candidate) {
  const where = { confluence_page: 'Confluence page', jira_issue: 'Jira issue', jira_comment: 'Jira comment' }[candidate.source.type]?.toLowerCase() ?? 'source';
  const label = candidate.kind === 'decision' ? 'A decision' : candidate.kind === 'open_question' ? 'An open question' : 'A proposal';
  return `${label} recorded in a ${where} may affect this issue: ${candidate.summary}\nPlease check whether this issue needs updating.`;
}

/**
 * Checks a note before it is posted. Returns an error message, or null when the note is valid.
 * `issueKey` must belong to `projectKey`.
 */
export function noteProblem({ projectKey, candidateId, issueKey, note, quote }) {
  if (!validReviewTarget(projectKey, candidateId) || !new RegExp(`^${projectKey}-\\d+$`).test(issueKey)) {
    return 'This note is invalid. Refresh the project scan and try again.';
  }
  if (!note || note.length > MAX_NOTE_LENGTH) return `Write a note of up to ${MAX_NOTE_LENGTH} characters.`;
  if (!quote || quote.length > MAX_QUOTE_LENGTH) return 'This note is missing its source quote. Refresh the project scan and try again.';
  return null;
}

/**
 * Posts one note as a comment on `issueKey`, as the signed-in user, and records it. The caller
 * has already checked the review. Returns `{ ok, note, alreadyApplied?, warning? }` or `{ ok: false, error }`.
 * `confirmedIn` names where the person confirmed the note, for the comment's first line.
 */
export async function postNote({ projectKey, candidateId, issueKey, note, quote, sourceTitle, sourceUrl, siteUrl, confirmedIn }) {
  const key = noteKey(projectKey, candidateId, issueKey);
  const existing = await storage.get(key);
  if (existing) return { ok: true, note: existing, alreadyApplied: true };

  const body = noteCommentBody({
    note,
    quote,
    sourceTitle: String(sourceTitle ?? '').trim().slice(0, MAX_TITLE_LENGTH),
    sourceUrl: trustedSourceUrl(sourceUrl, siteUrl),
    confirmedIn
  });
  const response = await api.asUser().requestJira(route`/rest/api/3/issue/${issueKey}/comment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ body })
  });
  if (!response.ok) {
    if (response.status === 404) return { ok: false, error: `${issueKey} was not found, or you cannot see it. Nothing was posted.` };
    if (response.status === 401 || response.status === 403) {
      return { ok: false, error: `You do not have permission to comment on ${issueKey}, or the app is missing its Jira write permission. Nothing was posted.` };
    }
    return { ok: false, error: `Jira could not add the comment (HTTP ${response.status}). Nothing was posted.` };
  }
  const comment = await response.json();
  const record = { issueKey, commentId: String(comment.id ?? ''), appliedAt: new Date().toISOString(), ...(confirmedIn ? { confirmedIn } : {}) };
  try {
    await storage.set(key, record);
  } catch (error) {
    console.error('Decision Drift Radar note posted but its record was not saved', error);
    return { ok: true, note: record, warning: `The comment was added to ${issueKey}, but the app could not record it. Do not add it again.` };
  }
  return { ok: true, note: record };
}

/** Every stored value under a key prefix, read with one paginated query. */
async function loadByPrefix(prefix) {
  const entries = new Map();
  let cursor;
  for (let page = 0; page < MAX_REVIEW_PAGES; page++) {
    let query = storage.query().where('key', startsWith(prefix)).limit(REVIEW_PAGE_SIZE);
    if (cursor) query = query.cursor(cursor);
    const { results, nextCursor } = await query.getMany();
    for (const { key, value } of results ?? []) entries.set(key.slice(prefix.length), value);
    if (!nextCursor) return { entries, complete: true };
    cursor = nextCursor;
  }
  return { entries, complete: false };
}

/** Adds each finding's saved review and the notes already posted to Jira for it. */
export async function attachReviewState(projectKey, candidates) {
  if (candidates.length === 0) return { candidates, reviewWarning: null };
  try {
    const [reviews, notes] = await Promise.all([loadByPrefix(reviewPrefix(projectKey)), loadByPrefix(notePrefix(projectKey))]);
    const complete = reviews.complete && notes.complete;
    if (!complete) console.warn(`Decision Drift Radar read only the first ${MAX_REVIEW_PAGES * REVIEW_PAGE_SIZE} review records for ${projectKey}`);
    const notesByCandidate = new Map();
    for (const [key, note] of notes.entries) {
      const split = key.indexOf(':');
      const candidateId = key.slice(0, split);
      if (!notesByCandidate.has(candidateId)) notesByCandidate.set(candidateId, {});
      notesByCandidate.get(candidateId)[key.slice(split + 1)] = note;
    }
    return {
      candidates: candidates.map((candidate) => ({
        ...candidate,
        review: reviews.entries.get(candidate.id) ?? null,
        notes: notesByCandidate.get(candidate.id) ?? {}
      })),
      reviewWarning: complete ? null : 'Some older reviews could not be loaded for this project.'
    };
  } catch (error) {
    console.warn('Decision Drift Radar review state could not be read', error);
    return {
      candidates: candidates.map((candidate) => ({ ...candidate, review: null, notes: {} })),
      reviewWarning: 'Review history is unavailable. Review actions may require the app storage permission to be granted again.'
    };
  }
}
