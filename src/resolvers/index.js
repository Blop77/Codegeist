import Resolver from '@forge/resolver';
import api, { route, startsWith, storage } from '@forge/api';
import { extractDecisions } from '../domain/extractDecisions';
import { issueSources, noteCommentBody, pageSource, toIssueRecord, toIssueSummary } from './normalize';

const resolver = new Resolver();

const ISSUE_FIELDS = 'summary,status,labels,updated,description,comment,reporter';
const MAX_CANDIDATES = 50;
const REVIEW_CHOICES = new Set(['relevant', 'dismissed']);
// Forge storage returns at most 20 entries per query page.
const REVIEW_PAGE_SIZE = 20;
const MAX_REVIEW_PAGES = 50;

function reviewPrefix(projectKey) {
  return `review:${projectKey}:`;
}

function reviewKey(projectKey, candidateId) {
  return `${reviewPrefix(projectKey)}${candidateId}`;
}

function notePrefix(projectKey) {
  return `note:${projectKey}:`;
}

/** One record per finding and issue, so the same note is never posted twice. */
function noteKey(projectKey, candidateId, issueKey) {
  return `${notePrefix(projectKey)}${candidateId}:${issueKey}`;
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
async function attachReviewState(projectKey, candidates) {
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

/** Review state is per project, so only people who can see the project may change it. */
async function canAccessProject(projectKey) {
  const response = await api.asUser().requestJira(route`/rest/api/3/project/${projectKey}`);
  return response.ok;
}

function validReviewTarget(projectKey, candidateId) {
  return /^[A-Z][A-Z0-9_]{1,9}$/.test(projectKey) && /^dc_[a-f0-9]{16}$/.test(candidateId);
}

const NO_PROJECT_ACCESS = 'You do not have access to this Jira project, so you cannot review its findings.';

function safeError(status, product) {
  if (status === 401 || status === 403) {
    return `${product} denied access. Check your account access and the app's granted permissions.`;
  }
  return `${product} could not complete the request (HTTP ${status}).`;
}

async function searchDecisionPages(projectKey) {
  const cql = `type = page AND text ~ "${projectKey}" ORDER BY lastmodified DESC`;
  const response = await api.asUser().requestConfluence(
    route`/wiki/rest/api/content/search?cql=${cql}&limit=10&expand=version,body.atlas_doc_format,body.storage`
  );
  if (!response.ok) {
    return { pages: [], warnings: [safeError(response.status, 'Confluence source search')] };
  }
  const data = await response.json();
  return { pages: (data.results ?? []).map((page) => pageSource(page, projectKey)), warnings: [] };
}

/** Runs the domain module and keeps only what the UI needs. */
function analyze(sources, issues) {
  const { candidates, warnings } = extractDecisions({ sources, issues, maxCandidates: MAX_CANDIDATES });
  const skipped = warnings.filter((w) => w.code !== 'candidates_truncated' && w.code !== 'empty_input');
  if (skipped.length > 0) console.warn('Decision extraction skipped records', skipped);
  const truncated = warnings.find((w) => w.code === 'candidates_truncated');
  return { candidates, notice: truncated?.message ?? null };
}

const pageList = (pages) => pages.map(({ id, title, url }) => ({ id, title, url }));

resolver.define('getProjectRadar', async ({ payload }) => {
  const projectKey = String(payload?.projectKey ?? '').trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{1,9}$/.test(projectKey)) {
    return { ok: false, error: 'Choose a Jira project, or enter a valid project key such as MC.' };
  }

  try {
    const jql = `project = "${projectKey}" ORDER BY updated DESC`;
    const jiraResponse = await api.asUser().requestJira(
      route`/rest/api/3/search/jql?jql=${jql}&maxResults=25&fields=${ISSUE_FIELDS}`
    );
    if (!jiraResponse.ok) {
      return { ok: false, error: safeError(jiraResponse.status, 'Jira') };
    }
    const rawIssues = (await jiraResponse.json()).issues ?? [];
    const { pages, warnings } = await searchDecisionPages(projectKey);

    const sources = [...pages, ...rawIssues.flatMap((issue) => issueSources(issue, projectKey))];
    const issueRecords = rawIssues.map((issue) => toIssueRecord(issue, projectKey));
    const { candidates: extractedCandidates, notice } = analyze(sources, issueRecords);
    const { candidates, reviewWarning } = await attachReviewState(projectKey, extractedCandidates);

    return {
      ok: true,
      projectKey,
      issues: rawIssues.map(toIssueSummary),
      pages: pageList(pages),
      candidates,
      notice,
      reviewWarning,
      warnings
    };
  } catch (error) {
    console.error('Decision Drift Radar project scan failed', error);
    return { ok: false, error: 'Could not reach Atlassian. Refresh and try again.' };
  }
});

resolver.define('getIssueDecisionContext', async ({ payload }) => {
  const issueKey = String(payload?.issueKey ?? '').trim().toUpperCase();
  const match = issueKey.match(/^([A-Z][A-Z0-9_]{1,9})-\d+$/);
  if (!match) return { ok: false, error: 'Could not identify this Jira issue.' };
  const projectKey = match[1];

  try {
    const issueResponse = await api.asUser().requestJira(
      route`/rest/api/3/issue/${issueKey}?fields=${ISSUE_FIELDS}`
    );
    if (!issueResponse.ok) {
      return { ok: false, error: safeError(issueResponse.status, 'Jira issue lookup') };
    }
    const rawIssue = await issueResponse.json();
    const { pages, warnings } = await searchDecisionPages(projectKey);

    const sources = [...pages, ...issueSources(rawIssue, projectKey)];
    const { candidates: extractedCandidates, notice } = analyze(sources, [toIssueRecord(rawIssue, projectKey)]);
    const forIssue = extractedCandidates.filter((c) => c.affectedIssues.some((a) => a.issueKey === rawIssue.key));
    const { candidates, reviewWarning } = await attachReviewState(projectKey, forIssue);

    return { ok: true, issueKey, candidates, notice, reviewWarning, warnings };
  } catch (error) {
    console.error('Decision Drift Radar issue context failed', error);
    return { ok: false, error: 'Could not load decision context for this issue.' };
  }
});

resolver.define('reviewDecision', async ({ payload, context }) => {
  const projectKey = String(payload?.projectKey ?? '').trim().toUpperCase();
  const candidateId = String(payload?.candidateId ?? '').trim();
  const choice = String(payload?.choice ?? '').trim();
  if (!validReviewTarget(projectKey, candidateId) || !REVIEW_CHOICES.has(choice)) {
    return { ok: false, error: 'This review action is invalid. Refresh the project scan and try again.' };
  }
  if (!context?.accountId) {
    return { ok: false, error: 'Your Atlassian account could not be identified. Sign in and try again.' };
  }

  try {
    if (!(await canAccessProject(projectKey))) return { ok: false, error: NO_PROJECT_ACCESS };
    const review = {
      status: choice,
      reviewedAt: new Date().toISOString()
    };
    await storage.set(reviewKey(projectKey, candidateId), review);
    return { ok: true, review };
  } catch (error) {
    console.error('Decision Drift Radar review update failed', error);
    return { ok: false, error: 'Could not save this review. Check app permissions and try again.' };
  }
});

resolver.define('clearDecisionReview', async ({ payload, context }) => {
  const projectKey = String(payload?.projectKey ?? '').trim().toUpperCase();
  const candidateId = String(payload?.candidateId ?? '').trim();
  if (!validReviewTarget(projectKey, candidateId)) {
    return { ok: false, error: 'This review action is invalid. Refresh the project scan and try again.' };
  }
  if (!context?.accountId) {
    return { ok: false, error: 'Your Atlassian account could not be identified. Sign in and try again.' };
  }
  try {
    if (!(await canAccessProject(projectKey))) return { ok: false, error: NO_PROJECT_ACCESS };
    await storage.delete(reviewKey(projectKey, candidateId));
    return { ok: true };
  } catch (error) {
    console.error('Decision Drift Radar review reset failed', error);
    return { ok: false, error: 'Could not reset this review. Check app permissions and try again.' };
  }
});

const MAX_NOTE_LENGTH = 2000;
const MAX_QUOTE_LENGTH = 320;
const MAX_TITLE_LENGTH = 255;

/** A link on this site to a Confluence page or Jira issue; anything else is dropped. */
function trustedSourceUrl(value, siteUrl) {
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

/**
 * The app's only Jira write: posts one reviewed note as a comment, as the signed-in user.
 * Requires a finding already marked relevant, and records the comment so it is not posted twice.
 */
resolver.define('applyDecisionNote', async ({ payload, context }) => {
  const projectKey = String(payload?.projectKey ?? '').trim().toUpperCase();
  const candidateId = String(payload?.candidateId ?? '').trim();
  const issueKey = String(payload?.issueKey ?? '').trim().toUpperCase();
  const note = String(payload?.note ?? '').trim();
  const quote = String(payload?.quote ?? '').trim();
  const sourceTitle = String(payload?.sourceTitle ?? '').trim().slice(0, MAX_TITLE_LENGTH);

  if (!validReviewTarget(projectKey, candidateId) || !new RegExp(`^${projectKey}-\\d+$`).test(issueKey)) {
    return { ok: false, error: 'This note is invalid. Refresh the project scan and try again.' };
  }
  if (!note || note.length > MAX_NOTE_LENGTH) {
    return { ok: false, error: `Write a note of up to ${MAX_NOTE_LENGTH} characters.` };
  }
  if (!quote || quote.length > MAX_QUOTE_LENGTH) {
    return { ok: false, error: 'This note is missing its source quote. Refresh the project scan and try again.' };
  }
  if (!context?.accountId) {
    return { ok: false, error: 'Your Atlassian account could not be identified. Sign in and try again.' };
  }

  try {
    const review = await storage.get(reviewKey(projectKey, candidateId));
    if (review?.status !== 'relevant') {
      return { ok: false, error: 'Mark this finding relevant before adding a note to Jira.' };
    }
    const key = noteKey(projectKey, candidateId, issueKey);
    const existing = await storage.get(key);
    if (existing) return { ok: true, note: existing, alreadyApplied: true };

    const body = noteCommentBody({ note, quote, sourceTitle, sourceUrl: trustedSourceUrl(payload?.sourceUrl, context?.siteUrl) });
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
    const record = { issueKey, commentId: String(comment.id ?? ''), appliedAt: new Date().toISOString() };
    try {
      await storage.set(key, record);
    } catch (error) {
      console.error('Decision Drift Radar note posted but its record was not saved', error);
      return {
        ok: true,
        note: record,
        warning: `The comment was added to ${issueKey}, but the app could not record it. Do not add it again.`
      };
    }
    return { ok: true, note: record };
  } catch (error) {
    console.error('Decision Drift Radar note failed', error);
    return { ok: false, error: 'Could not add the note. Check the issue before trying again, in case the comment was posted.' };
  }
});

/** Projects the signed-in user can see, for the project picker. */
resolver.define('listProjects', async () => {
  try {
    const response = await api.asUser().requestJira(route`/rest/api/3/project/search?maxResults=50&orderBy=name`);
    if (!response.ok) return { ok: false, error: safeError(response.status, 'Jira project list') };
    const data = await response.json();
    const projects = (data.values ?? [])
      .filter((project) => /^[A-Z][A-Z0-9_]{1,9}$/.test(project.key ?? ''))
      .map((project) => ({ key: project.key, name: project.name ?? project.key }));
    return { ok: true, projects, more: data.isLast === false };
  } catch (error) {
    console.error('Decision Drift Radar project list failed', error);
    return { ok: false, error: 'Could not load your Jira projects.' };
  }
});

export const handler = resolver.getDefinitions();
