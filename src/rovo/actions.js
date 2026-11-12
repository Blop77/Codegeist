/**
 * Actions for the Decision Drift Radar Rovo agent. The find actions read: they run the same scan
 * as the app's pages, as the person talking to the agent, and return findings with their evidence.
 * The AI action runs the app's AI pass. Posting a note takes two steps: `prepare-decision-note`
 * returns the exact comment and a short-lived confirmation code, and `post-decision-note` posts
 * that exact text only, for the same person, once they have confirmed it in the chat.
 */
import { randomBytes } from 'node:crypto';
import { startsWith, storage } from '@forge/api';
import { scanIssue, scanProject, validProjectKey } from '../resolvers/scan';
import { findWithAi } from '../resolvers/ai';
import {
  attachReviewState, canAccessProject, defaultNoteText, noteProblem, postNote, reviewKey
} from '../resolvers/notes';

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
      notePosted: Boolean(candidate.notes?.[affected.issueKey])
    }))
  };
}

function report(scope, scanned, origin, extra = {}, candidates = [...scanned.candidates, ...(scanned.aiCandidates ?? [])]) {
  const findings = candidates.slice(0, MAX_FINDINGS).map((candidate) => toFinding(candidate, origin));
  return {
    ok: true,
    ...scope,
    ...extra,
    confluencePagesScanned: scanned.pages.length,
    findingCount: candidates.length,
    findings,
    warnings: [
      ...scanned.warnings,
      ...(candidates.length > findings.length ? [`Showing the first ${findings.length} of ${candidates.length} findings.`] : [])
    ],
    howToRead:
      'Findings come from wording rules, not certainty. Quote the evidence exactly and cite the source. '
      + 'Relevance is a 0 to 1 signal strength, not a probability. To post a note on an affected issue, use '
      + 'prepare-decision-note with the findingId and issueKey, show the user the draft, and post only after they confirm.'
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
  const { candidates } = await attachReviewState(projectKey, all);
  return { ...scanned, candidates: candidates.slice(0, scanned.candidates.length), aiCandidates: candidates.slice(scanned.candidates.length) };
}

/** The person talking to the agent. Forge passes it in the action context. */
function accountIdFrom(payload, context) {
  const id = payload?.context?.accountId ?? context?.principal?.accountId ?? context?.accountId;
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

const CONFIRM_MINUTES = 10;
const pendingPrefix = (accountId) => `pending-note:${accountId}:`;

/** Drops this person's expired note confirmations. */
async function clearExpired(accountId) {
  const { results } = await storage.query().where('key', startsWith(pendingPrefix(accountId))).limit(20).getMany();
  await Promise.all((results ?? []).filter(({ value }) => !(value?.expiresAt > Date.now())).map(({ key }) => storage.delete(key)));
}

/**
 * Step 1 of posting a note: checks the finding still points at the issue, builds the exact
 * comment, and returns it with a confirmation code. Changes nothing in Jira.
 */
export async function prepareDecisionNote(payload, context) {
  const issueKey = issueKeyFrom(payload);
  const findingId = String(payload?.findingId ?? '').trim();
  const accountId = accountIdFrom(payload, context);
  if (!issueKey) return { ok: false, error: 'A valid Jira issue key is needed, for example MC-9.' };
  if (!/^dc_[a-f0-9]{16}$/.test(findingId)) return { ok: false, error: 'A findingId from find-issue-decisions or find-project-decisions is needed.' };
  if (!accountId) return { ok: false, error: 'Your Atlassian account could not be identified.' };
  const projectKey = issueKey.split('-')[0];
  try {
    const scanned = await withReviews(projectKey, await scanIssue(issueKey, projectKey, { cloudId: payload?.context?.cloudId }));
    if (!scanned.ok) return { ok: false, error: scanned.error };
    const candidate = [...scanned.candidates, ...scanned.aiCandidates].find((c) => c.id === findingId);
    if (!candidate) return { ok: false, error: `That finding does not point at ${issueKey} any more. Run find-issue-decisions again.` };
    if (candidate.review?.status === 'dismissed') {
      return { ok: false, error: 'A teammate dismissed this finding. To post a note anyway, they can undo the review in the Decision Drift Radar app.' };
    }
    if (candidate.notes?.[issueKey]) return { ok: false, error: `A note for this finding was already posted to ${issueKey}.` };

    const note = String(payload?.note ?? '').trim() || defaultNoteText(candidate);
    const request = { projectKey, candidateId: candidate.id, issueKey, note, quote: candidate.evidence.quote };
    const problem = noteProblem(request);
    if (problem) return { ok: false, error: problem };

    await clearExpired(accountId);
    const origin = siteOrigin(payload);
    const confirmationCode = `DDR-${randomBytes(4).toString('hex').toUpperCase()}`;
    await storage.set(`${pendingPrefix(accountId)}${confirmationCode}`, {
      ...request,
      sourceTitle: candidate.source.title,
      sourceUrl: link(origin, candidate.source.url),
      expiresAt: Date.now() + CONFIRM_MINUTES * 60 * 1000
    });
    return {
      ok: true,
      issueKey,
      comment: {
        firstLine: 'Decision Drift Radar note · drafted with the Rovo agent and confirmed by a teammate before posting',
        note,
        quote: candidate.evidence.quote,
        source: candidate.source.title
      },
      postsAs: 'the user, with their own Jira permissions',
      reviewAfterPosting: 'The finding is marked relevant for the project.',
      confirmationCode,
      expiresInMinutes: CONFIRM_MINUTES,
      nextStep: `Show the user the full comment and ask whether to post it to ${issueKey}. Call post-decision-note with this confirmationCode only after they clearly say yes. If they want changes, call prepare-decision-note again with the new note.`
    };
  } catch (error) {
    console.error('Decision Drift Radar agent note preparation failed', error);
    return { ok: false, error: 'The note could not be prepared. Try again.' };
  }
}

/**
 * Step 2: posts the comment prepared in step 1, exactly as shown, as the same person, within
 * ten minutes. Marks the finding relevant, since the person approved it, and records the note
 * so it is not posted twice.
 */
export async function postDecisionNote(payload, context) {
  const code = String(payload?.confirmationCode ?? '').trim().toUpperCase();
  const accountId = accountIdFrom(payload, context);
  if (!/^DDR-[0-9A-F]{8}$/.test(code)) return { ok: false, error: 'A confirmationCode from prepare-decision-note is needed.' };
  if (!accountId) return { ok: false, error: 'Your Atlassian account could not be identified.' };
  const pendingKey = `${pendingPrefix(accountId)}${code}`;
  try {
    const pending = await storage.get(pendingKey);
    if (!pending) return { ok: false, error: 'This confirmation code is unknown or was already used. Prepare the note again.' };
    if (!(pending.expiresAt > Date.now())) {
      await storage.delete(pendingKey);
      return { ok: false, error: `This confirmation expired after ${CONFIRM_MINUTES} minutes. Prepare the note again.` };
    }
    const { projectKey, candidateId, issueKey } = pending;
    if (!(await canAccessProject(projectKey))) return { ok: false, error: 'You do not have access to this Jira project.' };
    const review = await storage.get(reviewKey(projectKey, candidateId));
    if (review?.status === 'dismissed') return { ok: false, error: 'A teammate dismissed this finding in the meantime. Nothing was posted.' };
    if (review?.status !== 'relevant') {
      await storage.set(reviewKey(projectKey, candidateId), { status: 'relevant', reviewedAt: new Date().toISOString(), via: 'rovo' });
    }
    const origin = siteOrigin(payload);
    const posted = await postNote({ ...pending, siteUrl: origin || null, confirmedIn: 'rovo' });
    if (posted.ok) await storage.delete(pendingKey);
    if (!posted.ok) return posted;
    const commentId = posted.note?.commentId;
    return {
      ok: true,
      issueKey,
      alreadyPosted: Boolean(posted.alreadyApplied),
      commentLink: commentId ? link(origin, `/browse/${issueKey}?focusedCommentId=${commentId}`) : link(origin, `/browse/${issueKey}`),
      ...(posted.warning ? { warning: posted.warning } : {})
    };
  } catch (error) {
    console.error('Decision Drift Radar agent note failed', error);
    return { ok: false, error: `The note could not be posted. Check the issue before trying again, in case the comment was added.` };
  }
}
