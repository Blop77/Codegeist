/** Rovo actions read findings and prepare drafts for approval in Jira. */
import { scanIssue, scanProject, validProjectKey } from '../resolvers/scan';
import { findWithAi } from '../resolvers/ai';
import { attachReviewState, validReviewTarget } from '../resolvers/notes';
import { trackScan } from '../resolvers/drift';
import { prepareRovoDraft } from '../resolvers/rovo-drafts';

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

function reviewLabel(candidate) {
  if (candidate.review?.status === 'relevant') return 'marked relevant by a teammate';
  if (candidate.review?.status === 'dismissed') return 'dismissed by a teammate';
  return 'not reviewed yet';
}

function toFinding(candidate, origin) {
  return {
    findingId: candidate.id,
    foundBy: candidate.ai ? 'the AI pass (its quote was checked word for word against the source)' : 'wording rules',
    review: reviewLabel(candidate),
    kind: KIND_LABEL[candidate.kind] ?? candidate.kind,
    statement: candidate.summary,
    quote: candidate.evidence.quote,
    source: {
      type: SOURCE_LABEL[candidate.source.type] ?? candidate.source.type,
      title: candidate.source.title,
      link: link(origin, candidate.source.url),
      updated: candidate.source.updatedAt ? candidate.source.updatedAt.slice(0, 10) : null,
      foundThrough: candidate.source.via ?? 'a search for the project key',
      author: candidate.source.author ?? null
    },
    wordingSignals: candidate.confidenceReasons,
    affectedIssues: candidate.affectedIssues.map((affected) => ({
      issueKey: affected.issueKey,
      link: link(origin, `/browse/${affected.issueKey}`),
      relevance: affected.relevance,
      reasons: affected.reasons,
      wordingStatus: affected.wordingStatus ?? null,
      drift: driftView(affected.drift),
      notePosted: Boolean(candidate.notes?.[affected.issueKey])
    })),
    resolvedIssues: (candidate.resolvedIssues ?? []).map((resolved) => ({ issueKey: resolved.issueKey, ...driftView(resolved) }))
  };
}

function report(scope, scanned, origin, extra = {}, candidates = [...scanned.candidates, ...(scanned.aiCandidates ?? [])]) {
  const aiCandidates = candidates.filter((candidate) => candidate.ai);
  const rules = candidates.filter((candidate) => !candidate.ai);
  const reservedForAi = Math.min(3, aiCandidates.length);
  const visibleRules = rules.slice(0, MAX_FINDINGS - reservedForAi);
  const findings = [...visibleRules, ...aiCandidates.slice(0, MAX_FINDINGS - visibleRules.length)]
    .map((candidate) => toFinding(candidate, origin));
  return {
    ok: true,
    ...scope,
    ...extra,
    confluencePagesScanned: scanned.pages.length,
    ...(scanned.graph ? { teamworkGraph: {
      teams: scanned.graph.teams,
      spaces: scanned.graph.spaces,
      note: scanned.graph.note
    } } : {}),
    findingCount: candidates.length,
    findings,
    warnings: [
      ...scanned.warnings,
      ...(candidates.length > findings.length ? [`Showing the first ${findings.length} of ${candidates.length} findings.`] : [])
    ],
    howToRead:
      'Findings come from wording rules, not certainty. Quote the evidence exactly and cite the source. '
      + 'Relevance is a 0 to 1 signal strength, not a probability. Use prepare-decision-note with the findingId '
      + 'and issueKey, then send the user to the Jira panel to review and post it.'
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

/** Adds the team's saved reviews and posted notes to a scan's findings. */
async function withReviews(projectKey, scanned) {
  if (!scanned.ok) return scanned;
  const all = [...scanned.candidates, ...(scanned.aiCandidates ?? [])];
  const { candidates: reviewed } = await attachReviewState(projectKey, all);
  const scannedIssueKeys = scanned.rawIssues ? scanned.rawIssues.map((issue) => issue.key) : [scanned.rawIssue.key];
  const { candidates } = await trackScan(projectKey, { candidates: reviewed, scannedIssueKeys });
  return { ...scanned, candidates: candidates.slice(0, scanned.candidates.length), aiCandidates: candidates.slice(scanned.candidates.length) };
}

/** Drift state for the agent: whether the issue still uses the replaced wording, and since when. */
function driftView(drift) {
  if (!drift) return null;
  return drift.status === 'resolved'
    ? { status: 'resolved', phrase: drift.phrase, resolvedOn: String(drift.resolvedAt ?? '').slice(0, 10), resolvedBy: drift.resolvedBy === 'issue-update' ? 'an edit to the issue' : 'a later scan' }
    : { status: 'still drifting', phrase: drift.phrase, since: String(drift.firstSeenAt ?? '').slice(0, 10) };
}

/** The person talking to the agent. Forge passes it in the action context. */
function accountIdFrom(payload, context) {
  const id = context?.principal?.accountId ?? context?.accountId ?? payload?.context?.accountId;
  return typeof id === 'string' && id ? id : null;
}

export async function findProjectDecisions(payload) {
  const projectKey = projectKeyFrom(payload);
  if (!projectKey) return { ok: false, error: 'A valid Jira project key is needed, for example MC.' };
  try {
    const scanned = await withReviews(projectKey, await scanProject(projectKey, { cloudId: payload?.context?.cloudId }));
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
    const projectKey = issueKey.split('-')[0];
    const scanned = await withReviews(projectKey, await scanIssue(issueKey, projectKey, { cloudId: payload?.context?.cloudId }));
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

/**
 * Runs the app's AI pass for a project: asks the Atlassian-hosted model for decisions the wording
 * rules missed, and keeps only those whose quote is found word for word in a source. Verified
 * findings are saved, so the app's pages and later scans show them too.
 */
export async function findMoreDecisionsWithAi(payload, context) {
  const projectKey = projectKeyFrom(payload);
  if (!projectKey) return { ok: false, error: 'A valid Jira project key is needed, for example MC.' };
  if (!accountIdFrom(payload, context)) return { ok: false, error: 'Your Atlassian account could not be identified.' };
  try {
    const scanned = await scanProject(projectKey, { cloudId: payload?.context?.cloudId });
    if (!scanned.ok) return { ok: false, error: scanned.error };
    const result = await findWithAi({
      scopeKey: projectKey,
      sources: scanned.sources,
      issues: scanned.issueRecords,
      known: [...scanned.candidates, ...scanned.aiCandidates],
      saveFor: projectKey
    });
    if (!result.ok) return { ok: false, error: result.error };
    const fresh = result.candidates.map((c) => ({ ...c, ai: true }));
    const { candidates } = await attachReviewState(projectKey, fresh);
    return report({ projectKey }, { ...scanned, candidates: [], aiCandidates: [] }, siteOrigin(payload), {
      newAiFindings: candidates.length,
      droppedAiSuggestions: result.rejected,
      model: result.model
    }, candidates);
  } catch (error) {
    console.error('Decision Drift Radar agent AI pass failed', error);
    return { ok: false, error: 'The AI pass could not complete. The rule-based findings are unaffected.' };
  }
}

/** Prepares a note for the requesting teammate to review in Jira. */
export async function prepareDecisionNote(payload, context) {
  const issueKey = issueKeyFrom(payload);
  const candidateId = String(payload?.findingId ?? '').trim();
  const accountId = accountIdFrom(payload, context);
  if (!issueKey) return { ok: false, error: 'A valid Jira issue key is needed, for example MC-9.' };
  const projectKey = issueKey.split('-')[0];
  if (!validReviewTarget(projectKey, candidateId)) return { ok: false, error: 'Choose a finding from a project or issue scan first.' };
  if (!accountId) return { ok: false, error: 'Your Atlassian account could not be identified.' };

  try {
    const siteUrl = siteOrigin(payload);
    const result = await prepareRovoDraft({
      projectKey, issueKey, candidateId, accountId, siteUrl,
      cloudId: payload?.context?.cloudId,
      note: String(payload?.note ?? '').trim()
    });
    if (!result.ok) return result;
    return {
      ...result,
      issueLink: link(siteUrl, `/browse/${issueKey}`),
      nextStep: `Open ${issueKey} and choose the Decision Drift Radar panel to review the exact note and post it. The draft expires in ${result.expiresInMinutes} minutes.`
    };
  } catch {
    console.error('Decision Drift Radar could not prepare a Rovo draft');
    return { ok: false, error: 'The note could not be prepared. Try again.' };
  }
}
