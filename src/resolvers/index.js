import Resolver from '@forge/resolver';
import api, { route, storage } from '@forge/api';
import { extractDecisions } from '../domain/extractDecisions';
import { issueSources, pageSource, toIssueRecord, toIssueSummary } from './normalize';

const resolver = new Resolver();

const ISSUE_FIELDS = 'summary,status,labels,updated,description,comment,reporter';
const MAX_CANDIDATES = 50;
const REVIEW_CHOICES = new Set(['relevant', 'dismissed']);

function reviewKey(projectKey, candidateId) {
  return `review:${projectKey}:${candidateId}`;
}

async function attachReviewState(candidates) {
  let unavailable = false;
  const results = await Promise.all(candidates.map(async (candidate) => {
    try {
      const review = await storage.get(reviewKey(candidate.source.projectKey, candidate.id));
      return { ...candidate, review: review ?? null };
    } catch (error) {
      unavailable = true;
      console.warn('Decision Drift Radar review state could not be read', error);
      return { ...candidate, review: null };
    }
  }));
  return {
    candidates: results,
    reviewWarning: unavailable ? 'Review history is unavailable. Review actions may require the app storage permission to be granted again.' : null
  };
}

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
    return { ok: false, error: 'Enter a valid Jira project key, such as KAN.' };
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
    const { candidates, reviewWarning } = await attachReviewState(extractedCandidates);

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
    const { candidates, reviewWarning } = await attachReviewState(extractedCandidates);
    const relevant = candidates.filter((c) => c.affectedIssues.some((a) => a.issueKey === rawIssue.key));

    return { ok: true, issueKey, candidates: relevant, notice, reviewWarning, warnings };
  } catch (error) {
    console.error('Decision Drift Radar issue context failed', error);
    return { ok: false, error: 'Could not load decision context for this issue.' };
  }
});

resolver.define('reviewDecision', async ({ payload, context }) => {
  const projectKey = String(payload?.projectKey ?? '').trim().toUpperCase();
  const candidateId = String(payload?.candidateId ?? '').trim();
  const choice = String(payload?.choice ?? '').trim();
  if (!/^[A-Z][A-Z0-9_]{1,9}$/.test(projectKey)
    || !/^dc_[a-f0-9]{16}$/.test(candidateId)
    || !REVIEW_CHOICES.has(choice)) {
    return { ok: false, error: 'This review action is invalid. Refresh the project scan and try again.' };
  }
  if (!context?.accountId) {
    return { ok: false, error: 'Your Atlassian account could not be identified. Sign in and try again.' };
  }

  try {
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
  if (!/^[A-Z][A-Z0-9_]{1,9}$/.test(projectKey) || !/^dc_[a-f0-9]{16}$/.test(candidateId)) {
    return { ok: false, error: 'This review action is invalid. Refresh the project scan and try again.' };
  }
  if (!context?.accountId) {
    return { ok: false, error: 'Your Atlassian account could not be identified. Sign in and try again.' };
  }
  try {
    await storage.delete(reviewKey(projectKey, candidateId));
    return { ok: true };
  } catch (error) {
    console.error('Decision Drift Radar review reset failed', error);
    return { ok: false, error: 'Could not reset this review. Check app permissions and try again.' };
  }
});

export const handler = resolver.getDefinitions();
