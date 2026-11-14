import Resolver from '@forge/resolver';
import api, { route, storage } from '@forge/api';
import { toIssueSummary } from './normalize';
import { analyze, readIssueRecord, resolveFindingForIssue, safeError, scanIssue, scanProject, validProjectKey } from './scan';
import { SAMPLE_GRAPH, SAMPLE_PROJECT_KEY, sampleIssues, sampleSources } from './sample-data';
import { aiJobStatus, draftNoteWithAi, findWithAi, startAiJob } from './ai';
import { confirmRovoDraft, loadRovoDraft } from './rovo-drafts';
import { lastVisit, saveVisit, trackScan } from './drift';
import {
  attachReviewState, canChangeSharedReview, composeNote, defaultNoteText, MAX_NOTE_LENGTH, newReview, noteProblem,
  postNote, REVIEW_PERMISSION_ERROR, reviewForViewer, reviewKey, sourceSharing,
  validReviewTarget
} from './notes';
import { GENERIC_NOTE, noteComment } from './normalize';
import { createHash } from 'node:crypto';

const resolver = new Resolver();

const REVIEW_CHOICES = new Set(['relevant', 'dismissed']);

const pageList = (pages) => pages.map(({ id, title, url, via }) => ({ id, title, url, ...(via ? { via } : {}) }));

resolver.define('getProjectRadar', async ({ payload, context }) => {
  const projectKey = String(payload?.projectKey ?? '').trim().toUpperCase();
  if (!validProjectKey(projectKey)) {
    return { ok: false, error: 'Choose a Jira project, or enter a valid project key such as MC.' };
  }

  try {
    const scanned = await scanProject(projectKey, { cloudId: context?.cloudId });
    if (!scanned.ok) return { ok: false, error: scanned.error };
    const { rawIssues, pages, warnings, candidates: extractedCandidates, notice, graph } = scanned;
    const { candidates: reviewed, reviewWarning } = await attachReviewState(projectKey, [...extractedCandidates, ...scanned.aiCandidates], context?.accountId);
    const previousVisitAt = await lastVisit(context?.accountId, projectKey);
    const tracked = await trackScan(projectKey, {
      candidates: reviewed,
      issueRecords: scanned.issueRecords,
      previousVisitAt,
      observedAt: scanned.readAt,
      confirmIssue: (issueKey) => readIssueRecord(issueKey, projectKey)
    });
    await saveVisit(context?.accountId, projectKey);
    const candidates = tracked.candidates.slice(0, extractedCandidates.length);
    const aiCandidates = tracked.candidates.slice(extractedCandidates.length);

    return {
      ok: true,
      projectKey,
      issues: rawIssues.map(toIssueSummary),
      coverage: scanned.coverage,
      pages: pageList(pages),
      candidates,
      notice,
      reviewWarning,
      warnings,
      graph,
      aiCandidates,
      aiSavedAt: aiCandidates.length > 0 ? scanned.aiSavedAt : null,
      radar: tracked.summary,
      radarWarning: tracked.radarWarning,
      previousVisitAt
    };
  } catch (error) {
    console.error('Decision Drift Radar project scan failed', error);
    return { ok: false, error: 'Could not reach Atlassian. Refresh and try again.' };
  }
});

resolver.define('getIssueDecisionContext', async ({ payload, context }) => {
  const issueKey = String(payload?.issueKey ?? '').trim().toUpperCase();
  const match = issueKey.match(/^([A-Z][A-Z0-9_]{1,9})-\d+$/);
  if (!match) return { ok: false, error: 'Could not identify this Jira issue.' };
  const projectKey = match[1];

  try {
    const scanned = await scanIssue(issueKey, projectKey, { cloudId: context?.cloudId });
    if (!scanned.ok) return { ok: false, error: scanned.error };
    const { warnings, candidates: forIssue, notice, graph } = scanned;
    const { candidates: reviewed, reviewWarning } = await attachReviewState(projectKey, [...forIssue, ...scanned.aiCandidates], context?.accountId);
    const tracked = await trackScan(projectKey, { candidates: reviewed, issueRecords: scanned.issueRecords, observedAt: scanned.readAt });

    return {
      ok: true, issueKey, candidates: tracked.candidates, notice, reviewWarning, warnings, graph,
      radarWarning: tracked.radarWarning
    };
  } catch (error) {
    console.error('Decision Drift Radar issue context failed', error);
    return { ok: false, error: 'Could not load decision context for this issue.' };
  }
});

async function canReviewFinding({ projectKey, candidateId, issueKey, cloudId }) {
  if (issueKey != null && (typeof issueKey !== 'string' || !new RegExp(`^${projectKey}-\\d+$`).test(issueKey))) {
    return { ok: false, error: 'This review action is invalid. Refresh the issue panel and try again.' };
  }
  if (!(await canChangeSharedReview(projectKey, issueKey))) return { ok: false, error: REVIEW_PERMISSION_ERROR };
  if (issueKey) return resolveFindingForIssue({ projectKey, candidateId, issueKey, cloudId });
  const project = await scanProject(projectKey, { cloudId });
  if (!project.ok) return project;
  return [...project.candidates, ...project.aiCandidates].some((candidate) => candidate.id === candidateId)
    ? { ok: true }
    : { ok: false, error: 'This finding is no longer visible to you. Refresh the scan and try again.' };
}

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
    const finding = await canReviewFinding({ projectKey, candidateId, issueKey: payload?.issueKey, cloudId: context.cloudId });
    if (!finding.ok) return finding;
    const review = newReview(projectKey, context.accountId, choice);
    await storage.set(reviewKey(projectKey, candidateId), review);
    return { ok: true, review: reviewForViewer(review, projectKey, context.accountId) };
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
    const finding = await canReviewFinding({ projectKey, candidateId, issueKey: payload?.issueKey, cloudId: context.cloudId });
    if (!finding.ok) return finding;
    await storage.delete(reviewKey(projectKey, candidateId));
    return { ok: true };
  } catch (error) {
    console.error('Decision Drift Radar review reset failed', error);
    return { ok: false, error: 'Could not reset this review. Check app permissions and try again.' };
  }
});

/** The parts of a composed comment the person sees before posting. */
const previewOf = (composed) => ({
  mode: composed.mode,
  text: composed.text,
  digest: composed.digest,
  explanation: composed.explanation,
  note: composed.note
});

function noteRequest(payload) {
  return {
    projectKey: String(payload?.projectKey ?? '').trim().toUpperCase(),
    candidateId: String(payload?.candidateId ?? '').trim(),
    issueKey: String(payload?.issueKey ?? '').trim().toUpperCase(),
    note: String(payload?.note ?? '').trim(),
    digest: String(payload?.digest ?? '').trim()
  };
}

/**
 * The exact comment the app would post for a finding and issue, built by the server with the
 * person's current access. When the app cannot establish that everyone who can see the issue may
 * also see the source, the comment is a fixed follow-up that ignores the supplied note.
 */
resolver.define('previewDecisionNote', async ({ payload, context }) => {
  const request = noteRequest(payload);
  const invalid = noteProblem({ ...request, mode: 'generic' });
  if (invalid) return { ok: false, error: invalid };
  try {
    const finding = await resolveFindingForIssue({ ...request, cloudId: context?.cloudId });
    if (!finding.ok) return finding;
    const composed = await composeNote({
      candidate: finding.candidate,
      projectKey: request.projectKey,
      note: request.note || defaultNoteText(finding.candidate),
      siteUrl: context?.siteUrl
    });
    const problem = noteProblem({ ...request, ...composed });
    if (problem) return { ok: false, error: problem };
    return { ok: true, ...previewOf(composed) };
  } catch (error) {
    console.error('Decision Drift Radar note preview failed', error?.name ?? 'error');
    return { ok: false, error: 'Could not prepare the comment preview. Try again.' };
  }
});

/**
 * The app's only Jira write: posts one reviewed note as a comment, as the signed-in user.
 * Requires a finding already marked relevant and the digest of the preview the person confirmed;
 * the server rebuilds the comment and posts only if it is still exactly what was previewed.
 * Records the comment so it is not posted twice.
 */
resolver.define('applyDecisionNote', async ({ payload, context }) => {
  const request = noteRequest(payload);
  const invalid = noteProblem({ ...request, mode: 'generic' });
  if (invalid) return { ok: false, error: invalid };
  if (!context?.accountId) {
    return { ok: false, error: 'Your Atlassian account could not be identified. Sign in and try again.' };
  }

  try {
    const review = await storage.get(reviewKey(request.projectKey, request.candidateId));
    if (review?.status !== 'relevant') {
      return { ok: false, error: 'Mark this finding relevant before adding a note to Jira.' };
    }
    const finding = await resolveFindingForIssue({ ...request, cloudId: context.cloudId });
    if (!finding.ok) return finding;
    const composed = await composeNote({ candidate: finding.candidate, projectKey: request.projectKey, note: request.note, siteUrl: context.siteUrl });
    const problem = noteProblem({ ...request, ...composed });
    if (problem) return { ok: false, error: problem };
    if (!request.digest || request.digest !== composed.digest) {
      return {
        ok: false,
        error: 'The comment changed since you previewed it, so nothing was posted. Check the new preview before posting.',
        preview: previewOf(composed)
      };
    }
    return await postNote({ ...request, body: composed.body });
  } catch (error) {
    console.error('Decision Drift Radar note failed', error?.name ?? 'error');
    return { ok: false, error: 'Could not add the note. Check the issue before trying again, in case the comment was posted.' };
  }
});

/**
 * The comment a sample finding would get, built from the bundled sample only. Reads and writes
 * nothing on the site: no review is saved and nothing is posted. Uses the same sharing rule as a
 * real project: a sample Jira comment can be quoted, a sample Confluence page cannot.
 */
resolver.define('previewSampleNote', async ({ payload }) => {
  const candidateId = String(payload?.candidateId ?? '');
  const issueKey = String(payload?.issueKey ?? '').toUpperCase();
  const { candidates } = analyze(sampleSources, sampleIssues);
  const candidate = candidates.find((c) => c.id === candidateId);
  if (!candidate || !candidate.affectedIssues.some((a) => a.issueKey === issueKey)) {
    return { ok: false, error: 'This sample finding does not point at that issue.' };
  }
  const quoted = candidate.source.type === 'jira_comment' || candidate.source.type === 'jira_issue';
  const mode = quoted ? 'quoted' : 'generic';
  const note = quoted ? String(payload?.note ?? '').trim() || defaultNoteText(candidate) : GENERIC_NOTE;
  const { text } = noteComment({ mode, note, quote: candidate.evidence.quote, sourceTitle: candidate.source.title, sourceUrl: null });
  return {
    ok: true,
    sample: true,
    mode,
    text,
    digest: createHash('sha256').update(text).digest('hex').slice(0, 32),
    note,
    explanation: quoted
      ? 'Sample only: this decision comes from a Jira comment in the same project, so on a real project the comment can quote it.'
      : 'Sample only: this decision comes from a Confluence page, so on a real project the app posts this fixed follow-up instead of quoting, naming or linking the page.'
  };
});

function panelDraftContext(payload, context) {
  const issueKey = String(payload?.issueKey ?? '').trim().toUpperCase();
  if (!context?.accountId || !/^[A-Z][A-Z0-9_]{1,9}-\d+$/.test(issueKey)) return null;
  return { accountId: context.accountId, issueKey, siteUrl: context.siteUrl, cloudId: context.cloudId };
}

resolver.define('getRovoDraft', async ({ payload, context }) => {
  const input = panelDraftContext(payload, context);
  if (!input) return { ok: false, error: 'Could not identify the user or Jira issue.' };
  try {
    return await loadRovoDraft(input);
  } catch {
    return { ok: false, error: 'Could not load the draft. Refresh the issue panel and try again.' };
  }
});

resolver.define('postRovoDraft', async ({ payload, context }) => {
  const input = panelDraftContext(payload, context);
  const id = String(payload?.draftId ?? '');
  const digest = String(payload?.digest ?? '');
  if (!input || !/^[a-f0-9-]{36}$/.test(id)) return { ok: false, error: 'Could not identify this draft. Reload the panel and try again.' };
  try {
    return await confirmRovoDraft(input, id, digest);
  } catch {
    return { ok: false, error: 'Could not verify that the note posted. Check the issue before trying again.' };
  }
});

/**
 * Drafts the note for a finding and one of its issues with the AI. Changes nothing: the person
 * edits the draft and posts it with applyDecisionNote. Counts towards the site's daily AI limit.
 */
resolver.define('draftDecisionNote', async ({ payload, context }) => {
  const projectKey = String(payload?.projectKey ?? '').trim().toUpperCase();
  const candidateId = String(payload?.candidateId ?? '').trim();
  const issueKey = String(payload?.issueKey ?? '').trim().toUpperCase();
  if (!validReviewTarget(projectKey, candidateId) || !new RegExp(`^${projectKey}-\\d+$`).test(issueKey)) {
    return { ok: false, error: 'This draft request is invalid. Refresh the project scan and try again.' };
  }
  if (!context?.accountId) return { ok: false, error: 'Your Atlassian account could not be identified. Sign in and try again.' };
  try {
    const finding = await resolveFindingForIssue({ projectKey, issueKey, candidateId, cloudId: context.cloudId });
    if (!finding.ok) return finding;
    // A drafted note quotes or paraphrases the source, so it is only offered when the comment may.
    if (!(await sourceSharing(finding.candidate, projectKey)).quoted) {
      return { ok: false, error: `This decision's source cannot be quoted on ${issueKey}, so the app posts a fixed follow-up instead and there is nothing to draft.` };
    }
    const drafted = await draftNoteWithAi(finding);
    if (!drafted.ok) return drafted;
    const suggestion = drafted.suggestion
      ? `\nSuggested change to the description: replace "${drafted.suggestion.outdated}" with "${drafted.suggestion.replacement}".`
      : '';
    return { ok: true, note: `${drafted.note}${suggestion}`.slice(0, MAX_NOTE_LENGTH), suggestion: drafted.suggestion };
  } catch (error) {
    console.error('Decision Drift Radar note draft failed', error);
    return { ok: false, error: 'The AI could not draft a note right now. You can still write it yourself.' };
  }
});

/**
 * The same analysis over a small bundled project, for sites with no decision pages yet.
 * Reads and writes nothing on the site; findings cannot be reviewed or posted.
 */
resolver.define('getSampleRadar', async () => {
  const { candidates, notice } = analyze(sampleSources, sampleIssues);
  return {
    ok: true,
    sample: true,
    projectKey: SAMPLE_PROJECT_KEY,
    issues: sampleIssues.map((issue) => ({
      key: issue.key,
      summary: issue.title,
      status: issue.status,
      labels: issue.labels,
      url: null,
      updated: issue.updatedAt
    })),
    pages: sampleSources.filter((source) => source.type === 'confluence_page').map(({ id, title, via }) => ({ id, title, url: '', ...(via ? { via } : {}) })),
    candidates: candidates.map((candidate) => ({ ...candidate, source: { ...candidate.source, url: '' }, review: null, notes: {} })),
    notice,
    reviewWarning: null,
    warnings: [],
    graph: SAMPLE_GRAPH,
    aiCandidates: []
  };
});

/**
 * Optional AI pass for a real project: rescans as the user, then starts a background job that asks
 * the model only for what the rules missed. The page polls `getAiJob` for the result.
 */
resolver.define('getAiFindings', async ({ payload, context }) => {
  const projectKey = String(payload?.projectKey ?? '').trim().toUpperCase();
  if (!validProjectKey(projectKey)) return { ok: false, error: 'Choose a Jira project first.' };
  if (!context?.accountId) return { ok: false, error: 'Your Atlassian account could not be identified. Sign in and try again.' };
  try {
    const scanned = await scanProject(projectKey, { cloudId: context?.cloudId });
    if (!scanned.ok) return { ok: false, error: scanned.error };
    return await startAiJob({ projectKey, sources: scanned.sources, known: [...scanned.candidates, ...scanned.aiCandidates] });
  } catch (error) {
    console.error('Decision Drift Radar AI findings failed', error);
    return { ok: false, error: 'The AI pass could not start. The rule-based findings above are unaffected.' };
  }
});

/**
 * The project's AI job. While it runs: `{ pending: true }`. When done: the project's AI findings
 * from a fresh scan as the user (so only sources they can read), with reviews, and how many are new.
 */
resolver.define('getAiJob', async ({ payload, context }) => {
  const projectKey = String(payload?.projectKey ?? '').trim().toUpperCase();
  if (!validProjectKey(projectKey)) return { ok: false, error: 'Choose a Jira project first.' };
  if (!context?.accountId) return { ok: false, error: 'Your Atlassian account could not be identified. Sign in and try again.' };
  try {
    const job = await aiJobStatus(projectKey);
    if (job.state === 'running') return { ok: true, pending: true, startedAt: job.startedAt };
    if (job.state === 'failed') return { ok: false, error: job.error };
    if (job.state !== 'done') return { ok: false, error: 'No AI pass has run for this project yet.' };
    const scanned = await scanProject(projectKey, { cloudId: context?.cloudId });
    if (!scanned.ok) return { ok: false, error: scanned.error };
    const { candidates } = await attachReviewState(projectKey, scanned.aiCandidates, context?.accountId);
    const fresh = new Set(job.findingIds ?? []);
    return {
      ok: true,
      pending: false,
      candidates,
      newCount: candidates.filter((c) => fresh.has(c.id)).length,
      rejected: job.rejected ?? 0,
      finishedAt: job.finishedAt
    };
  } catch (error) {
    console.error('Decision Drift Radar AI job status failed', error);
    return { ok: false, error: 'Could not read the AI pass status. Refresh and try again.' };
  }
});

/** The AI pass over the bundled sample project. Reads nothing from the site. */
resolver.define('getSampleAiFindings', async ({ context }) => {
  if (!context?.accountId) return { ok: false, error: 'Your Atlassian account could not be identified. Sign in and try again.' };
  try {
    const { candidates: known } = analyze(sampleSources, sampleIssues);
    const result = await findWithAi({ scopeKey: `sample-${SAMPLE_PROJECT_KEY}`, sources: sampleSources, issues: sampleIssues, known });
    if (!result.ok) return result;
    return {
      ...result,
      candidates: result.candidates.map((c) => ({ ...c, source: { ...c.source, url: '' }, review: null, notes: {}, ai: true }))
    };
  } catch (error) {
    console.error('Decision Drift Radar sample AI findings failed', error);
    return { ok: false, error: 'The AI pass could not complete.' };
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
