/**
 * Reads a project's or an issue's sources from Jira and Confluence as the signed-in user and
 * runs the domain module over them. Shared by the UI resolvers and the Rovo agent actions.
 */
import api, { route } from '@forge/api';
import { extractDecisions } from '../domain/extractDecisions';
import { issueSources, pageSource, toIssueRecord } from './normalize';

const ISSUE_FIELDS = 'summary,status,labels,updated,description,comment,reporter';
const MAX_CANDIDATES = 50;

export function validProjectKey(projectKey) {
  return /^[A-Z][A-Z0-9_]{1,9}$/.test(projectKey);
}

export function safeError(status, product) {
  if (status === 401 || status === 403) {
    return `${product} denied access. Check your account access and the app's granted permissions.`;
  }
  return `${product} could not complete the request (HTTP ${status}).`;
}

export async function searchDecisionPages(projectKey) {
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

/** Runs the domain module and keeps only what callers need. */
export function analyze(sources, issues) {
  const { candidates, warnings } = extractDecisions({ sources, issues, maxCandidates: MAX_CANDIDATES });
  const skipped = warnings.filter((w) => w.code !== 'candidates_truncated' && w.code !== 'empty_input');
  if (skipped.length > 0) console.warn('Decision extraction skipped records', skipped);
  const truncated = warnings.find((w) => w.code === 'candidates_truncated');
  return { candidates, notice: truncated?.message ?? null };
}

/** Scans the 25 most recently updated issues of a project and the pages that mention its key. */
export async function scanProject(projectKey) {
  const jql = `project = "${projectKey}" ORDER BY updated DESC`;
  const jiraResponse = await api.asUser().requestJira(
    route`/rest/api/3/search/jql?jql=${jql}&maxResults=25&fields=${ISSUE_FIELDS}`
  );
  if (!jiraResponse.ok) return { ok: false, error: safeError(jiraResponse.status, 'Jira') };
  const rawIssues = (await jiraResponse.json()).issues ?? [];
  const { pages, warnings } = await searchDecisionPages(projectKey);

  const sources = [...pages, ...rawIssues.flatMap((issue) => issueSources(issue, projectKey))];
  const issueRecords = rawIssues.map((issue) => toIssueRecord(issue, projectKey));
  const { candidates, notice } = analyze(sources, issueRecords);
  return { ok: true, rawIssues, pages, warnings, candidates, notice };
}

/** Scans one issue and its project's pages, keeping only findings that point at that issue. */
export async function scanIssue(issueKey, projectKey) {
  const issueResponse = await api.asUser().requestJira(route`/rest/api/3/issue/${issueKey}?fields=${ISSUE_FIELDS}`);
  if (!issueResponse.ok) return { ok: false, error: safeError(issueResponse.status, 'Jira issue lookup') };
  const rawIssue = await issueResponse.json();
  const { pages, warnings } = await searchDecisionPages(projectKey);

  const sources = [...pages, ...issueSources(rawIssue, projectKey)];
  const { candidates, notice } = analyze(sources, [toIssueRecord(rawIssue, projectKey)]);
  return {
    ok: true,
    rawIssue,
    pages,
    warnings,
    candidates: candidates.filter((c) => c.affectedIssues.some((a) => a.issueKey === rawIssue.key)),
    notice
  };
}
