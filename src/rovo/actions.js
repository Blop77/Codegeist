/**
 * Actions for the Decision Drift Radar Rovo agent. Both are read-only: they run the same
 * scan as the app's pages, as the person talking to the agent, and return findings with
 * their evidence. Posting a note to Jira stays in the app, behind its review step.
 */
import { scanIssue, scanProject, validProjectKey } from '../resolvers/scan';

const MAX_FINDINGS = 15;

const KIND_LABEL = { decision: 'decision', open_question: 'open question', proposal: 'proposal' };
const SOURCE_LABEL = { confluence_page: 'Confluence page', jira_issue: 'Jira issue description', jira_comment: 'Jira comment' };

/** The site the conversation is on, when Rovo passes it, so links can be absolute. */
function siteOrigin(payload) {
  for (const url of [payload?.context?.jira?.url, payload?.context?.confluence?.url]) {
    try {
      if (url) return new URL(url).origin;
    } catch {
      // Not a URL; try the next one.
    }
  }
  return '';
}

function link(origin, path) {
  if (!path) return null;
  return origin ? `${origin}${path}` : path;
}

function toFinding(candidate, origin) {
  return {
    kind: KIND_LABEL[candidate.kind] ?? candidate.kind,
    statement: candidate.summary,
    quote: candidate.evidence.quote,
    source: {
      type: SOURCE_LABEL[candidate.source.type] ?? candidate.source.type,
      title: candidate.source.title,
      link: link(origin, candidate.source.url),
      updated: candidate.source.updatedAt ? candidate.source.updatedAt.slice(0, 10) : null,
      author: candidate.source.author ?? null
    },
    wordingSignals: candidate.confidenceReasons,
    affectedIssues: candidate.affectedIssues.map((affected) => ({
      issueKey: affected.issueKey,
      link: link(origin, `/browse/${affected.issueKey}`),
      relevance: affected.relevance,
      reasons: affected.reasons
    }))
  };
}

function report(scope, scanned, origin, extra = {}) {
  const findings = scanned.candidates.slice(0, MAX_FINDINGS).map((candidate) => toFinding(candidate, origin));
  return {
    ok: true,
    ...scope,
    ...extra,
    confluencePagesScanned: scanned.pages.length,
    findingCount: scanned.candidates.length,
    findings,
    warnings: [
      ...scanned.warnings,
      ...(scanned.candidates.length > findings.length ? [`Showing the first ${findings.length} of ${scanned.candidates.length} findings.`] : [])
    ],
    howToRead:
      'Findings come from wording rules, not certainty. Quote the evidence exactly and cite the source. '
      + 'Relevance is a 0 to 1 signal strength, not a probability. To record a review or post a note on an issue, '
      + 'the user opens the Decision Drift Radar app in Jira.'
  };
}

/** A project key from the action input, or from the Jira page the user is on. */
function projectKeyFrom(payload) {
  const fromInput = String(payload?.projectKey ?? '').trim().toUpperCase();
  if (validProjectKey(fromInput)) return fromInput;
  const fromContext = String(payload?.context?.jira?.projectKey ?? '').trim().toUpperCase();
  return validProjectKey(fromContext) ? fromContext : null;
}

function issueKeyFrom(payload) {
  for (const value of [payload?.issueKey, payload?.context?.jira?.issueKey]) {
    const key = String(value ?? '').trim().toUpperCase();
    if (/^[A-Z][A-Z0-9_]{1,9}-\d+$/.test(key)) return key;
  }
  return null;
}

export async function findProjectDecisions(payload) {
  const projectKey = projectKeyFrom(payload);
  if (!projectKey) return { ok: false, error: 'A valid Jira project key is needed, for example MC.' };
  try {
    const scanned = await scanProject(projectKey);
    if (!scanned.ok) return { ok: false, error: scanned.error };
    return report({ projectKey }, scanned, siteOrigin(payload), { issuesScanned: scanned.rawIssues.length });
  } catch (error) {
    console.error('Decision Drift Radar agent project scan failed', error);
    return { ok: false, error: 'The scan could not reach Jira or Confluence. Try again.' };
  }
}

export async function findIssueDecisions(payload) {
  const issueKey = issueKeyFrom(payload);
  if (!issueKey) return { ok: false, error: 'A valid Jira issue key is needed, for example MC-9.' };
  try {
    const scanned = await scanIssue(issueKey, issueKey.split('-')[0]);
    if (!scanned.ok) return { ok: false, error: scanned.error };
    return report({ issueKey }, scanned, siteOrigin(payload), {
      issueSummary: scanned.rawIssue.fields?.summary ?? null,
      issueStatus: scanned.rawIssue.fields?.status?.name ?? null
    });
  } catch (error) {
    console.error('Decision Drift Radar agent issue scan failed', error);
    return { ok: false, error: 'The scan could not reach Jira or Confluence. Try again.' };
  }
}
