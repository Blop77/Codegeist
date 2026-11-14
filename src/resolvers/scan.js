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
// Teamwork Graph lookups stop starting new requests after this long, so a scan stays well within
// Forge's 25-second limit for a resolver.
const GRAPH_BUDGET_MS = 12000;

export function validProjectKey(projectKey) {
  return /^[A-Z][A-Z0-9_]{1,9}$/.test(projectKey);
}

export function safeError(status, product) {
  if (status === 401 || status === 403) {
    return `${product} denied access. Check your account access and the app's granted permissions.`;
  }
  if (status === 429) return `${product} is limiting requests right now. Wait a minute, then scan again.`;
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
  return {
    pages: (data.results ?? []).map((page) => pageSource(page, projectKey)), warnings: [],
    morePages: Boolean(data._links?.next)
  };
}

/** Runs the domain module and keeps only what callers need. */
export function analyze(sources, issues) {
  const { candidates, warnings } = extractDecisions({ sources, issues, maxCandidates: MAX_CANDIDATES });
  const skipped = warnings.filter((w) => w.code !== 'candidates_truncated' && w.code !== 'empty_input');
  if (skipped.length > 0) console.warn('Decision extraction skipped records', skipped);
  const truncated = warnings.find((w) => w.code === 'candidates_truncated');
  return { candidates, notice: truncated?.message ?? null };
}

/**
 * Page sources from the key search plus those found through the Teamwork Graph. `keySearch` is
 * the already started key search, so it runs alongside the Jira reads.
 */
async function projectPages(projectKey, projectId, cloudId, keySearch, deadline) {
  const { pages, warnings, morePages = false } = await keySearch;
  const knownPageIds = pages.map((page) => page.id.replace(/^page-/, ''));
  const { pages: graphPages, summary } = await discoverViaGraph({ projectKey, projectId, cloudId, knownPageIds, deadline });
  return { pages: [...pages, ...graphPages], warnings, graph: summary, morePages };
}

/** The 50 most recently updated issues of a project, read through search. */
async function searchProjectIssues(projectKey) {
  const jql = `project = "${projectKey}" ORDER BY updated DESC`;
  const response = await api.asUser().requestJira(
    route`/rest/api/3/search/jql?jql=${jql}&maxResults=${MAX_ISSUES}&fields=${ISSUE_FIELDS}`
  );
  if (!response.ok) return { ok: false, status: response.status };
  const body = await response.json();
  // Enhanced search pages with a token instead of a total; either signal means older issues exist.
  return { ok: true, rawIssues: body.issues ?? [], moreIssues: body.isLast === false || Boolean(body.nextPageToken) };
}

/** Up to three visible projects whose name or key resembles `text`, as "Name (KEY)". */
async function similarProjects(text) {
  try {
    const response = await api.asUser().requestJira(route`/rest/api/3/project/search?query=${text}&maxResults=3`);
    if (!response.ok) return [];
    return ((await response.json()).values ?? [])
      .filter((project) => validProjectKey(project.key ?? ''))
      .map((project) => `${project.name ?? project.key} (${project.key})`);
  } catch {
    return [];
  }
}

/**
 * The project itself, read as the user: its id (which Teamwork Graph needs even when the project
 * has no issues yet) and its current key. An unknown key gets a plain message naming similar
 * projects, since people often type a project's name instead of its key.
 */
export async function lookUpProject(projectKey) {
  const response = await api.asUser().requestJira(route`/rest/api/3/project/${projectKey}`);
  if (response.ok) {
    const project = await response.json();
    if (project?.key && project.key !== projectKey) {
      return { ok: false, error: `Project ${projectKey} is now ${project.key}. Scan ${project.key} instead.` };
    }
    return { ok: true, id: project?.id ?? null };
  }
  if (response.status === 404) {
    const similar = await similarProjects(projectKey);
    const hint = similar.length > 0 ? ` Did you mean ${similar.join(' or ')}?` : ' Check the key in the project\'s settings.';
    return { ok: false, error: `No Jira project with the key ${projectKey} is visible to you.${hint}` };
  }
  return { ok: false, error: safeError(response.status, 'Jira project lookup') };
}

/**
 * Scans the 50 most recently updated issues of a project, the pages that mention its key, and
 * pages the Teamwork Graph connects to it. `cloudId` comes from the Forge context. Findings from
 * earlier AI passes are re-checked against these sources and returned as `aiCandidates`.
 */
export async function scanProject(projectKey, { cloudId } = {}) {
  // When the issue text was read: the radar orders observations by it.
  const readAt = new Date().toISOString();
  const deadline = Date.now() + GRAPH_BUDGET_MS;
  const keySearch = searchDecisionPages(projectKey);
  const searched = await searchProjectIssues(projectKey);
  if (!searched.ok) {
    await keySearch.catch(() => null);
    // Jira search answers an unknown project with HTTP 400; say which key was not found instead.
    if (searched.status === 400 || searched.status === 404) {
      const project = await lookUpProject(projectKey);
      if (!project.ok) return project;
    }
    return { ok: false, error: safeError(searched.status, 'Jira') };
  }
  const { rawIssues, moreIssues = false } = searched;
  // An old project key can still find the renamed project's issues; keep its history under one key.
  const actualProjectKey = rawIssues[0]?.fields?.project?.key;
  if (actualProjectKey && actualProjectKey !== projectKey) {
    await keySearch.catch(() => null);
    return { ok: false, error: `Project ${projectKey} is now ${actualProjectKey}. Scan ${actualProjectKey} instead.` };
  }
  let projectId = rawIssues[0]?.fields?.project?.id ?? null;
  if (rawIssues.length === 0) {
    // No issue carries the project id, which Teamwork Graph needs; read the project instead.
    const project = await lookUpProject(projectKey);
    if (!project.ok) {
      await keySearch.catch(() => null);
      return project;
    }
    projectId = project.id;
  }
  const { pages, warnings, graph, morePages } = await projectPages(projectKey, projectId, cloudId, keySearch, deadline);

  const sources = [...pages, ...rawIssues.flatMap((issue) => issueSources(issue, projectKey))];
  const issueRecords = rawIssues.map((issue) => toIssueRecord(issue, projectKey));
  const { candidates, notice } = analyze(sources, issueRecords);
  const ai = await savedAiCandidates({ projectKey, sources, issues: issueRecords, known: candidates });
  return {
    ok: true, rawIssues, pages, warnings, candidates, notice, sources, issueRecords, graph, readAt,
    aiCandidates: ai.candidates, aiSavedAt: ai.savedAt, coverage: { moreIssues, morePages: Boolean(morePages), pageLimit: MAX_PAGES }
  };
}

/**
 * Scans one issue the way the project scan sees it: the issue (read directly, so an edit shows
 * at once), the project's other recent issues and its pages. Matching weighs a word by how many
 * of the project's issues use it, and a decision can be recorded on another issue, so reading
 * the issue alone would disagree with the project scan. Keeps only findings that point at this
 * issue, each narrowed to this issue.
 */
export async function scanIssue(issueKey, projectKey, { cloudId } = {}) {
  const readAt = new Date().toISOString();
  const deadline = Date.now() + GRAPH_BUDGET_MS;
  const keySearch = searchDecisionPages(projectKey);
  const [issueResponse, searched] = await Promise.all([
    api.asUser().requestJira(route`/rest/api/3/issue/${issueKey}?fields=${ISSUE_FIELDS}`),
    searchProjectIssues(projectKey)
  ]);
  if (!issueResponse.ok) {
    await keySearch.catch(() => null);
    return { ok: false, error: safeError(issueResponse.status, 'Jira issue lookup') };
  }
  const rawIssue = await issueResponse.json();
  // Jira answers an old key with the moved issue; record its history under its current key only.
  if (rawIssue.key !== issueKey || (rawIssue.fields?.project?.key ?? projectKey) !== projectKey) {
    await keySearch.catch(() => null);
    return { ok: false, error: `${issueKey} has moved to ${rawIssue.key}. Open ${rawIssue.key} instead.` };
  }
  const { pages, warnings, graph } = await projectPages(projectKey, rawIssue.fields?.project?.id ?? null, cloudId, keySearch, deadline);
  if (!searched.ok) warnings.push('Could not read the project\'s other issues, so this issue was matched on its own.');

  const others = searched.ok
    ? searched.rawIssues.filter((issue) => issue.key !== rawIssue.key && issue.fields?.project?.key === projectKey)
    : [];
  const rawIssues = [rawIssue, ...others];
  const sources = [...pages, ...rawIssues.flatMap((issue) => issueSources(issue, projectKey))];
  const projectRecords = rawIssues.map((issue) => toIssueRecord(issue, projectKey));
  const { candidates, notice } = analyze(sources, projectRecords);
  const ai = await savedAiCandidates({ projectKey, sources, issues: projectRecords, known: candidates });
  const forThisIssue = (list) => list
    .filter((c) => c.affectedIssues.some((a) => a.issueKey === issueKey))
    .map((c) => ({ ...c, affectedIssues: c.affectedIssues.filter((a) => a.issueKey === issueKey) }));
  return {
    ok: true,
    readAt,
    sources,
    // Only this issue: drift for other issues is recorded by project scans, which read them all.
    issueRecords: [projectRecords[0]],
    rawIssue,
    pages,
    warnings,
    graph,
    candidates: forThisIssue(candidates),
    aiCandidates: forThisIssue(ai.candidates),
    notice
  };
}

/**
 * One issue's current summary and description, read directly as the user (strongly consistent,
 * unlike JQL search). Null when it can't be read or has moved.
 */
export async function readIssueRecord(issueKey, projectKey) {
  const response = await api.asUser().requestJira(route`/rest/api/3/issue/${issueKey}?fields=summary,description,project,updated`);
  if (!response.ok) return null;
  const rawIssue = await response.json();
  if (rawIssue.key !== issueKey || (rawIssue.fields?.project?.key ?? projectKey) !== projectKey) return null;
  return toIssueRecord(rawIssue, projectKey);
}

/** Resolve a finding using the caller's current access and verify that it still matches this issue. */
export async function resolveFindingForIssue({ projectKey, issueKey, candidateId, cloudId }) {
  // The issue scan reads the project's other issues too, so findings recorded on another issue
  // are found here without a second, full project scan.
  const issue = await scanIssue(issueKey, projectKey, { cloudId });
  if (!issue.ok) return issue;
  const candidate = [...issue.candidates, ...issue.aiCandidates].find((c) => c.id === candidateId);
  if (!candidate) {
    return { ok: false, error: `This finding no longer points at ${issueKey}, or you can no longer see its source. Refresh the scan and try again.` };
  }

  return { ok: true, candidate, issue: issue.issueRecords[0] };
}
