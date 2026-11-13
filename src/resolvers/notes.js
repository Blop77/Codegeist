/**
 * Review records and the app's one Jira write (a reviewed note posted as a comment), shared by
 * the app's resolvers and the Rovo agent's actions so both enforce the same rules.
 */
import { randomUUID } from 'node:crypto';
import api, { route, startsWith, storage } from '@forge/api';
import { Filter, FilterConditions, kvs } from '@forge/kvs';
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

/** Source evidence resolved by the server, using the site URL from Forge context. */
export function noteEvidence(candidate, siteUrl) {
  const path = candidate.source.url;
  const absolute = path?.startsWith('/') && siteUrl ? `${siteUrl.replace(/\/+$/, '')}${path}` : path;
  return {
    quote: candidate.evidence.quote,
    sourceTitle: String(candidate.source.title ?? '').trim().slice(0, MAX_TITLE_LENGTH) || 'Source',
    sourceUrl: trustedSourceUrl(absolute, siteUrl)
  };
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

const NOTE_PROPERTY = 'decision-drift-radar-note';
const REJECTED_BY_JIRA = new Set([400, 401, 403, 404, 413, 429]);
const RECOVERY_GRACE_MS = 2 * 60_000;
const RECOVERY_PAGE_SIZE = 25;
const MAX_RECOVERY_PAGES = 4;
const RESERVATION_ENTITY = 'note-reservation';
const reservations = kvs.entity(RESERVATION_ENTITY);

function releaseReservation(lockKey, attemptId) {
  return kvs.transact().delete(lockKey, {
    entityName: RESERVATION_ENTITY,
    conditions: new Filter().and('attemptId', FilterConditions.equalTo(attemptId))
  }).execute();
}

function uncertainNote(issueKey) {
  return { ok: false, error: `The app could not confirm the note on ${issueKey} yet. Check the issue for the comment before trying again.` };
}

async function saveNoteReceipt(key, lockKey, attemptId, record) {
  try {
    await storage.set(key, record);
  } catch {
    // Keep the reservation. A retry can recover the comment using its Jira property.
    return { ok: true, note: record, warning: `The comment was added to ${record.issueKey}, but the app could not record it yet.` };
  }
  try {
    await releaseReservation(lockKey, attemptId);
  } catch {
    // The receipt is authoritative after it has been saved.
  }
  return { ok: true, note: record };
}

async function recoverNote(key, lockKey, issueKey, attempt) {
  const startedAt = Date.parse(attempt.startedAt);
  const earliest = startedAt - 60_000;
  let allChecked = true;
  let coversAttempt = false;
  let observedTotal;
  let newestFirst = true;
  let previousTime = Infinity;
  let sawRecentComment = false;
  try {
    for (let page = 0, startAt = 0; page < MAX_RECOVERY_PAGES; page++) {
      const response = await api.asUser().requestJira(
        route`/rest/api/3/issue/${issueKey}/comment?orderBy=-created&maxResults=${RECOVERY_PAGE_SIZE}&startAt=${startAt}`
      );
      if (!response.ok) return uncertainNote(issueKey);
      const { comments, total } = await response.json();
      if (!Array.isArray(comments)) return uncertainNote(issueKey);
      if (page === 0) observedTotal = total;
      else if (total !== observedTotal) allChecked = false;
      const recent = comments.filter((comment) => {
        const createdAt = Date.parse(comment.created);
        if (!Number.isFinite(createdAt)) {
          newestFirst = false;
          return true;
        }
        if (createdAt > previousTime) newestFirst = false;
        previousTime = createdAt;
        if (createdAt < earliest) return false;
        sawRecentComment = true;
        return true;
      });
      const matches = await Promise.allSettled(recent.map(async (comment) => {
        if (!comment.id) throw new Error('Jira did not identify the comment');
        const property = await api.asUser().requestJira(route`/rest/api/3/comment/${comment.id}/properties/${NOTE_PROPERTY}`);
        if (property.status === 404) return null;
        if (!property.ok) throw new Error('Jira did not return the comment property');
        return (await property.json()).value?.attemptId === attempt.attemptId ? comment : null;
      }));
      const match = matches.find((result) => result.status === 'fulfilled' && result.value)?.value;
      if (match) {
        const result = await saveNoteReceipt(key, lockKey, attempt.attemptId, {
          issueKey, commentId: String(match.id), appliedAt: match.created || attempt.startedAt,
          ...(attempt.confirmedIn ? { confirmedIn: attempt.confirmedIn } : {})
        });
        return { ...result, alreadyApplied: true };
      }
      startAt += comments.length;
      allChecked &&= matches.every((result) => result.status === 'fulfilled');
      coversAttempt = (typeof total === 'number' && total <= startAt)
        || (newestFirst && sawRecentComment && previousTime < earliest);
      if (coversAttempt || comments.length === 0) break;
    }

    if (Date.now() - startedAt >= RECOVERY_GRACE_MS && coversAttempt && allChecked) {
      const receipt = await storage.get(key);
      if (receipt) return { ok: true, note: receipt, alreadyApplied: true };
      // A conditional delete cannot remove a newer reservation or leave a stale cleanup claim.
      await releaseReservation(lockKey, attempt.attemptId);
      return { ok: false, error: `No matching app comment was found on ${issueKey}. Check the issue before trying again.` };
    }
    return uncertainNote(issueKey);
  } catch {
    return uncertainNote(issueKey);
  }
}

/** Shared Jira write. A reservation protects both posting paths until Jira's result is known. */
export async function postNote({ projectKey, candidateId, issueKey, note, quote, sourceTitle, sourceUrl, siteUrl, confirmedIn }) {
  const key = noteKey(projectKey, candidateId, issueKey);
  const lockKey = `posting:${key}`;
  const existing = await storage.get(key);
  if (existing) return { ok: true, note: existing, alreadyApplied: true };

  const attempt = { attemptId: randomUUID(), startedAt: new Date().toISOString(), ...(confirmedIn ? { confirmedIn } : {}) };
  try {
    await reservations.set(lockKey, attempt, { keyPolicy: 'FAIL_IF_EXISTS' });
  } catch {
    const receipt = await storage.get(key);
    if (receipt) return { ok: true, note: receipt, alreadyApplied: true };
    const prior = await reservations.get(lockKey);
    return prior
      ? recoverNote(key, lockKey, issueKey, prior)
      : { ok: false, error: 'Note posting is temporarily unavailable. Try again.' };
  }

  // Another request may have saved the receipt and released its reservation since our first read.
  let receipt;
  try {
    receipt = await storage.get(key);
  } catch {
    await releaseReservation(lockKey, attempt.attemptId).catch(() => {});
    return { ok: false, error: 'The app could not check earlier comments. Nothing was posted. Try again.' };
  }
  if (receipt) {
    await releaseReservation(lockKey, attempt.attemptId).catch(() => {});
    return { ok: true, note: receipt, alreadyApplied: true };
  }

  const body = noteCommentBody({
    note,
    quote,
    sourceTitle: String(sourceTitle ?? '').trim().slice(0, MAX_TITLE_LENGTH),
    sourceUrl: trustedSourceUrl(sourceUrl, siteUrl),
    confirmedIn
  });
  try {
    const response = await api.asUser().requestJira(route`/rest/api/3/issue/${issueKey}/comment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ body, properties: [{ key: NOTE_PROPERTY, value: { attemptId: attempt.attemptId } }] })
    });
    if (!response.ok) {
      if (!REJECTED_BY_JIRA.has(response.status)) return uncertainNote(issueKey);
      await releaseReservation(lockKey, attempt.attemptId).catch(() => {});
      if (response.status === 404) return { ok: false, error: `${issueKey} was not found, or you cannot see it. Nothing was posted.` };
      if (response.status === 401 || response.status === 403) {
        return { ok: false, error: `You do not have permission to comment on ${issueKey}. Nothing was posted.` };
      }
      return { ok: false, error: `Jira could not add the comment (HTTP ${response.status}). Nothing was posted.` };
    }
    const comment = await response.json();
    if (!comment?.id) return uncertainNote(issueKey);
    return saveNoteReceipt(key, lockKey, attempt.attemptId, {
      issueKey, commentId: String(comment.id), appliedAt: comment.created || attempt.startedAt,
      ...(confirmedIn ? { confirmedIn } : {})
    });
  } catch {
    return uncertainNote(issueKey);
  }
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

/**
 * Only the note records for issues this finding lists as affected. Those come from the viewer's
 * own scan, so issue keys and comment ids of issues they cannot see are never returned.
 */
function visibleNotes(candidate, notes) {
  const visible = new Set((candidate.affectedIssues ?? []).map((affected) => affected.issueKey));
  return Object.fromEntries(Object.entries(notes ?? {}).filter(([issueKey]) => visible.has(issueKey)));
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
        notes: visibleNotes(candidate, notesByCandidate.get(candidate.id))
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
