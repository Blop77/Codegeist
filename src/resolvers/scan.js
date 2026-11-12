/**
 * Reads a project's or an issue's sources from Jira and Confluence as the signed-in user and
 * runs the domain module over them. Shared by the UI resolvers and the Rovo agent actions.
 */
import api, { route } from '@forge/api';
import { extractDecisions } from '../domain/extractDecisions';
import { issueSources, pageSource, toIssueRecord } from './normalize';
import { discoverViaGraph } from './graph';
import { savedAiCandidates } from './ai';

const ISSUE_FIELDS = 'summary,status,labels,updated,description,comment,reporter,project';
const MAX_CANDIDATES = 50;
const MAX_ISSUES = 50;
const MAX_PAGES = 20;

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
    route`/wiki/rest/api/content/search?cql=${cql}&limit=${MAX_PAGES}&expand=version,body.atlas_doc_format,body.storage`
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

/** Page sources from the key search plus those found through the Teamwork Graph. */
async function projectPages(projectKey, projectId, cloudId) {
  const { pages, warnings } = await searchDecisionPages(projectKey);
  const knownPageIds = pages.map((page) => page.id.replace(/^page-/, ''));
  const { pages: graphPages, summary } = await discoverViaGraph({ projectKey, projectId, cloudId, knownPageIds });
  return { pages: [...pages, ...graphPages], warnings, graph: summary };
}

/**
 * Scans the 50 most recently updated issues of a project, the pages that mention its key, and
 * pages the Teamwork Graph connects to it. `cloudId` comes from the Forge context. Findings from
 * earlier AI passes are re-checked against these sources and returned as `aiCandidates`.
 */
export async function scanProject(projectKey, { cloudId } = {}) {
  const jql = `project = "${projectKey}" ORDER BY updated DESC`;
  const jiraResponse = await api.asUser().requestJira(
    route`/rest/api/3/search/jql?jql=${jql}&maxResults=${MAX_ISSUES}&fields=${ISSUE_FIELDS}`
  );
  if (!jiraResponse.ok) return { ok: false, error: safeError(jiraResponse.status, 'Jira') };
  const rawIssues = (await jiraResponse.json()).issues ?? [];
  const projectId = rawIssues[0]?.fields?.project?.id ?? null;
  const { pages, warnings, graph } = await projectPages(projectKey, projectId, cloudId);

  const sources = [...pages, ...rawIssues.flatMap((issue) => issueSources(issue, projectKey))];
  const issueRecords = rawIssues.map((issue) => toIssueRecord(issue, projectKey));
  const { candidates, notice } = analyze(sources, issueRecords);
  const ai = await savedAiCandidates({ projectKey, sources, issues: issueRecords, known: candidates });
  return {
    ok: true, rawIssues, pages, warnings, candidates, notice, sources, issueRecords, graph,
    aiCandidates: ai.candidates, aiSavedAt: ai.savedAt
  };
}

/** Scans one issue and its project's pages, keeping only findings that point at that issue. */
export async function scanIssue(issueKey, projectKey, { cloudId } = {}) {
  const issueResponse = await api.asUser().requestJira(route`/rest/api/3/issue/${issueKey}?fields=${ISSUE_FIELDS}`);
  if (!issueResponse.ok) return { ok: false, error: safeError(issueResponse.status, 'Jira issue lookup') };
  const rawIssue = await issueResponse.json();
  const { pages, warnings, graph } = await projectPages(projectKey, rawIssue.fields?.project?.id ?? null, cloudId);

  const sources = [...pages, ...issueSources(rawIssue, projectKey)];
  const issueRecords = [toIssueRecord(rawIssue, projectKey)];
  const { candidates, notice } = analyze(sources, issueRecords);
  const ai = await savedAiCandidates({ projectKey, sources, issues: issueRecords, known: candidates });
  const pointsHere = (c) => c.affectedIssues.some((a) => a.issueKey === rawIssue.key);
  return {
    ok: true,
    sources,
    issueRecords,
    rawIssue,
    pages,
    warnings,
    graph,
    candidates: candidates.filter(pointsHere),
    aiCandidates: ai.candidates.filter(pointsHere),
    notice
  };
}
