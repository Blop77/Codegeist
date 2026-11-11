import Resolver from '@forge/resolver';
import api, { route } from '@forge/api';
import { extractDecisions } from '../domain/extractDecisions';
import { issueSources, pageSource, toIssueRecord, toIssueSummary } from './normalize';

const resolver = new Resolver();

const ISSUE_FIELDS = 'summary,status,labels,updated,description,comment,reporter';
const MAX_CANDIDATES = 50;

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
    const { candidates, notice } = analyze(sources, issueRecords);

    return {
      ok: true,
      projectKey,
      issues: rawIssues.map(toIssueSummary),
      pages: pageList(pages),
      candidates,
      notice,
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
    const { candidates, notice } = analyze(sources, [toIssueRecord(rawIssue, projectKey)]);
    const relevant = candidates.filter((c) => c.affectedIssues.some((a) => a.issueKey === rawIssue.key));

    return { ok: true, issueKey, candidates: relevant, notice, warnings };
  } catch (error) {
    console.error('Decision Drift Radar issue context failed', error);
    return { ok: false, error: 'Could not load decision context for this issue.' };
  }
});

export const handler = resolver.getDefinitions();
