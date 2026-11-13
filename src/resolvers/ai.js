/**
 * Optional AI pass: asks an Atlassian-hosted model (Forge LLMs) for decisions the wording rules
 * missed, then keeps only proposals whose quote is found word for word in the source. It runs
 * only when a person asks for it, and is rate-limited per site because usage is billed to the
 * app developer.
 */
import { randomUUID } from 'node:crypto';
import { chat } from '@forge/llm';
import { storage } from '@forge/api';
import { Queue } from '@forge/events';
import { MAX_QUOTE_LENGTH, sourceLines, verifyProposedFindings } from '../domain/extractDecisions';

export const AI_MODEL = 'claude-sonnet-5';
const MAX_SOURCES = 15;
const MIN_CHARS_PER_SOURCE = 3000;
const MAX_TOTAL_CHARS = 24000;
// The cap the accuracy benchmark measured. Long pages need it: one held-out page used about
// 10,600 output tokens. A reply cut off mid-JSON is reported, not read as "none".
const MAX_OUTPUT_TOKENS = 12000;
const MAX_PROPOSALS = 20;
export const DAILY_RUNS_PER_SITE = 40;
export const COOLDOWN_SECONDS = 30;

const SYSTEM_PROMPT = `You find decisions in a team's Jira and Confluence text that may not have reached the work they affect.

You receive sources split into numbered sentences: "2.14" is sentence 14 of source 2. Lines starting with "##" are headings, and lines starting with "(context)" are too long to quote; both are there to help you read. Sentences marked "(already found)" were found earlier: do not return them.

Return the numbered sentences that the "already found" ones do not cover and that state a decision, an open question or a proposal. Include ones phrased indirectly, for example "the team is going ahead with Tuesday-only sends" or "Marcus confirmed we're locking in weekly payouts".

Rules:
- Return a sentence only if it states a decision, an unresolved question, or a suggestion. Skip status updates, plans of individual people, attendee lists, disclaimers, and anything negated ("not approved", "not a decision").
- In Jira issue descriptions, skip sentences that only describe how the work is currently planned, scheduled or scoped ("the email campaign keeps separate channel plans"). That is the work item, not a decision about it. Return a sentence from a description only if it records that something was decided, agreed or approved.
- "id" is the sentence number exactly as shown. "kind" is "decision", "open_question" or "proposal".
- If there is nothing new, return an empty list.

Reply with JSON only, no other text:
{"findings":[{"id":"2.14","kind":"decision"}]}`;

/**
 * The sources as numbered sentences for the model, and the sentence each number stands for.
 * Pages come first. With few sources each one gets more room, up to the total budget, so a single
 * long page is read in full. Sentences the rules (or earlier AI passes) already found are shown,
 * unnumbered, for context.
 */
export function numberSources(sources, known = []) {
  const ordered = [...sources]
    .filter((source) => String(source?.text ?? '').trim())
    .sort((a, b) => (a.type === 'confluence_page' ? 0 : 1) - (b.type === 'confluence_page' ? 0 : 1))
    .slice(0, MAX_SOURCES);
  const perSource = Math.max(MIN_CHARS_PER_SOURCE, Math.floor(MAX_TOTAL_CHARS / Math.max(1, ordered.length)));
  const knownSpans = new Map();
  for (const candidate of known) {
    const spans = knownSpans.get(candidate.source.id) ?? [];
    spans.push([candidate.evidence.start, candidate.evidence.end]);
    knownSpans.set(candidate.source.id, spans);
  }

  const ids = new Map();
  const blocks = [];
  let total = 0;
  for (const source of ordered) {
    const budget = Math.min(perSource, MAX_TOTAL_CHARS - total);
    if (budget <= 0) break;
    const number = blocks.length + 1;
    const spans = knownSpans.get(source.id) ?? [];
    const lines = [`### Source ${number}: ${source.title}`];
    let used = 0;
    let n = 0;
    for (const line of sourceLines(source.text)) {
      let rendered;
      let id;
      if ('heading' in line) rendered = `## ${line.heading}`;
      else {
        n++;
        if (spans.some(([a, b]) => line.start < b && line.end > a)) rendered = `(already found) ${line.sentence}`;
        else if (line.sentence.length < 12 || line.sentence.length > MAX_QUOTE_LENGTH) rendered = `(context) ${line.sentence}`;
        else {
          id = `${number}.${n}`;
          rendered = `${id} ${line.sentence}`;
        }
      }
      if (used + rendered.length + 1 > budget) break;
      if (id) ids.set(id, { sourceId: source.id, quote: line.sentence });
      lines.push(rendered);
      used += rendered.length + 1;
    }
    blocks.push(lines.join('\n'));
    total += used;
  }
  return { text: blocks.join('\n\n'), ids, sourcesSent: blocks.length };
}

/**
 * The model's JSON reply, tolerating a code fence or stray text around it. Null when the reply
 * has no readable findings list (for example, cut off mid-way), so a broken reply is never
 * mistaken for "nothing new".
 */
export function parseProposals(content) {
  const parsed = parseJsonObject(content);
  return Array.isArray(parsed?.findings) ? parsed.findings.slice(0, MAX_PROPOSALS) : null;
}

const errorLabel = (error) => [error?.name, error?.code ?? error?.status].filter(Boolean).join(' ') || 'unknown error';

/** Per-site daily cap and a short cooldown per scope. Returns an error message, or null to proceed. */
async function claimRun(scopeKey) {
  const now = Date.now();
  const day = new Date(now).toISOString().slice(0, 10);
  const usageKey = `ai-usage:${day}`;
  const lastKey = `ai-last:${scopeKey}`;
  const [used, last] = await Promise.all([storage.get(usageKey), storage.get(lastKey)]);
  if ((used ?? 0) >= DAILY_RUNS_PER_SITE) {
    return `The AI pass has reached today's limit of ${DAILY_RUNS_PER_SITE} runs for this site. The rule-based findings above are unaffected.`;
  }
  if (last && now - last < COOLDOWN_SECONDS * 1000) {
    return `The AI pass ran for this scan moments ago. Try again in ${Math.ceil((COOLDOWN_SECONDS * 1000 - (now - last)) / 1000)} seconds.`;
  }
  await Promise.all([storage.set(usageKey, (used ?? 0) + 1), storage.set(lastKey, now)]);
  return null;
}

/** Gives back a run that never reached a usable model answer, so it does not use up the day's limit. */
async function releaseRun(scopeKey) {
  try {
    const usageKey = `ai-usage:${new Date().toISOString().slice(0, 10)}`;
    const used = (await storage.get(usageKey)) ?? 0;
    await Promise.all([storage.set(usageKey, Math.max(0, used - 1)), storage.delete(`ai-last:${scopeKey}`)]);
  } catch (error) {
    console.warn('Decision Drift Radar could not release an AI run', errorLabel(error));
  }
}

const SAVED_LIMIT = 30;
const savedKey = (projectKey) => `ai-proposals:${projectKey}`;

// Model-written explanations can contain details from another source in the prompt.
function evidenceOnly({ sourceId, quote, kind }) {
  return { sourceId, quote, kind };
}

/** Adds newly verified proposals to the project's saved AI findings, newest first. */
async function saveProposals(projectKey, saved) {
  if (saved.length === 0) return;
  const stored = (await storage.get(savedKey(projectKey)))?.proposals ?? [];
  const seen = new Set();
  const merged = [...saved, ...stored].filter((p) => {
    const id = `${p.sourceId}\u0000${p.quote}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  }).slice(0, SAVED_LIMIT).map(evidenceOnly);
  await storage.set(savedKey(projectKey), { savedAt: new Date().toISOString(), proposals: merged });
}

/**
 * Earlier AI findings for a project, checked again against the sources of this scan: a finding
 * whose quote is no longer in its source (or that the rules now find) is dropped. Costs no model call.
 */
export async function savedAiCandidates({ projectKey, sources, issues, known }) {
  try {
    const stored = await storage.get(savedKey(projectKey));
    if (!stored?.proposals?.length) return { candidates: [], savedAt: null };
    const { candidates } = verifyProposedFindings({ sources, issues }, stored.proposals.map(evidenceOnly), known);
    return { candidates: candidates.map((c) => ({ ...c, ai: true })), savedAt: stored.savedAt ?? null };
  } catch (error) {
    console.warn('Decision Drift Radar saved AI findings could not be read', error);
    return { candidates: [], savedAt: null };
  }
}

/** Asks the model about numbered text. Returns its findings list, or an error message. */
async function callModel(text) {
  let response;
  try {
    response = await chat({
      model: AI_MODEL,
      max_completion_tokens: MAX_OUTPUT_TOKENS,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: text }
      ]
    });
  } catch (error) {
    console.error('Decision Drift Radar AI pass failed', errorLabel(error));
    return { ok: false, error: 'The AI pass is unavailable right now. The rule-based findings above are unaffected.' };
  }
  const choice = response?.choices?.[0];
  const parsed = parseProposals(choice?.message?.content);
  if (parsed === null || ['length', 'max_tokens'].includes(choice?.finish_reason)) {
    console.warn('Decision Drift Radar AI reply could not be read', choice?.finish_reason ?? 'no finish reason');
    return { ok: false, error: 'The AI reply could not be read, so nothing was added. It did not count towards today\'s limit; try again.' };
  }
  return { ok: true, parsed, usage: response?.usage ?? null };
}

/** The exact sentences the model's numbers stand for. A number the listing did not contain is rejected. */
function mapProposals(parsed, ids) {
  let unknownIds = 0;
  const proposals = [];
  for (const finding of parsed) {
    const target = ids.get(String(finding?.id ?? '').trim());
    if (target) proposals.push({ ...target, kind: finding.kind });
    else unknownIds++;
  }
  return { proposals, unknownIds };
}

/**
 * One model call over `sources`: numbers their sentences, asks for the numbers of decisions the
 * `known` candidates missed, and keeps a proposal only if `verifyProposedFindings` accepts it.
 * Counts nothing against usage limits and saves nothing. Used for the bundled sample and by the
 * accuracy benchmark; real projects run the same steps as a background job (`startAiJob`).
 */
export async function askModel({ sources, issues, known }) {
  const numbered = numberSources(sources, known);
  if (numbered.ids.size === 0) return { ok: true, candidates: [], rejected: 0, sourcesSent: numbered.sourcesSent, model: AI_MODEL, asked: false };
  const answer = await callModel(numbered.text);
  if (!answer.ok) return answer;
  const { proposals, unknownIds } = mapProposals(answer.parsed, numbered.ids);
  // Verified against the full source text with the same rules as rule-based findings.
  const { candidates, rejected } = verifyProposedFindings({ sources, issues }, proposals, known);
  return {
    ok: true,
    candidates,
    rejected: rejected + unknownIds,
    sourcesSent: numbered.sourcesSent,
    model: AI_MODEL,
    usage: answer.usage,
    asked: true
  };
}

/**
 * Runs the AI pass synchronously over `sources`, within the usage limits. Used for the bundled
 * sample, which is small. A run that never reaches a usable answer is given back to the daily limit.
 */
export async function findWithAi({ scopeKey, sources, issues, known }) {
  const limited = await claimRun(scopeKey);
  if (limited) return { ok: false, error: limited };
  const result = await askModel({ sources, issues, known });
  if (!result.ok || !result.asked) await releaseRun(scopeKey);
  if (!result.ok) return result;
  const { asked: _asked, ...answer } = result;
  return answer;
}

// ---------------------------------------------------------------------------
// The AI pass for a real project, as a background job. A long page can take the model longer
// than a resolver may run, so the scan (as the user) prepares the numbered text, and an async
// event consumer, which may run for up to 15 minutes, asks the model and saves what it found.
// ---------------------------------------------------------------------------

const aiQueue = new Queue({ key: 'ai-pass' });
const jobKey = (projectKey) => `ai-job:${projectKey}`;
const JOB_STALE_MS = 16 * 60 * 1000;

/** Whether the job record says a run is still in progress. */
const stillRunning = (job) => job?.state === 'running' && Date.now() - Date.parse(job.startedAt) < JOB_STALE_MS;

/**
 * The text-only checks `verifyProposedFindings` applies to a quote (kind, length, negated
 * approvals, reference lines). Source access and issue matching are checked again on every scan.
 */
function passesQuoteRules(proposal, projectKey) {
  const source = { id: proposal.sourceId, type: 'confluence_page', title: 'check', url: '', projectKey, updatedAt: '', text: proposal.quote };
  const { candidates } = verifyProposedFindings({ sources: [source], issues: [] }, [proposal]);
  return candidates[0] ?? null;
}

/**
 * Starts the AI pass for a project as a background job. `sources` and `known` come from a scan
 * the person just ran, so only text they can read is sent. One job per project runs at a time.
 */
export async function startAiJob({ projectKey, sources, known }) {
  const current = await storage.get(jobKey(projectKey));
  if (stillRunning(current)) return { ok: true, pending: true, startedAt: current.startedAt };
  const limited = await claimRun(projectKey);
  if (limited) return { ok: false, error: limited };

  const numbered = numberSources(sources, known);
  if (numbered.ids.size === 0) {
    await releaseRun(projectKey);
    return { ok: true, pending: false, candidates: [], newCount: 0, rejected: 0, model: AI_MODEL };
  }
  const job = { jobId: randomUUID(), state: 'running', startedAt: new Date().toISOString(), sourcesSent: numbered.sourcesSent };
  await storage.set(jobKey(projectKey), job);
  try {
    await aiQueue.push({ body: {
      jobId: job.jobId,
      projectKey,
      text: numbered.text,
      ids: [...numbered.ids].map(([id, { sourceId, quote }]) => [id, sourceId, quote])
    } });
  } catch (error) {
    console.error('Decision Drift Radar could not start the AI pass', errorLabel(error));
    await storage.set(jobKey(projectKey), { ...job, state: 'failed', finishedAt: new Date().toISOString(), error: 'The AI pass could not be started. Try again in a minute.' });
    await releaseRun(projectKey);
    return { ok: false, error: 'The AI pass could not be started. Try again in a minute. The rule-based findings above are unaffected.' };
  }
  return { ok: true, pending: true, startedAt: job.startedAt };
}

/**
 * The async event consumer: asks the model, maps its numbers to exact sentences, and saves those
 * that pass the quote rules to the project's AI findings. Every scan checks saved findings again
 * against the viewer's own sources, word for word. The job record keeps only state, times, counts
 * and finding ids, never text.
 */
export async function runAiJob(event) {
  const { jobId, projectKey, text, ids } = event?.body ?? {};
  if (typeof jobId !== 'string' || !/^[A-Z][A-Z0-9_]{1,9}$/.test(String(projectKey)) || typeof text !== 'string' || !Array.isArray(ids)) return;
  const job = await storage.get(jobKey(projectKey));
  if (job?.jobId !== jobId || job.state !== 'running') return;
  const finish = (fields) => storage.set(jobKey(projectKey), { ...job, ...fields, finishedAt: new Date().toISOString() });

  const answer = await callModel(text);
  if (!answer.ok) {
    await finish({ state: 'failed', error: answer.error });
    await releaseRun(projectKey);
    return;
  }
  const { proposals, unknownIds } = mapProposals(answer.parsed, new Map(ids.map(([id, sourceId, quote]) => [id, { sourceId, quote }])));
  const kept = proposals.map((proposal) => ({ proposal, candidate: passesQuoteRules(proposal, projectKey) })).filter(({ candidate }) => candidate);
  try {
    await saveProposals(projectKey, kept.map(({ proposal }) => evidenceOnly(proposal)));
  } catch (error) {
    console.error('Decision Drift Radar AI findings could not be saved', errorLabel(error));
    await finish({ state: 'failed', error: 'The AI pass finished, but its findings could not be saved. Try again in a minute.' });
    return;
  }
  await finish({
    state: 'done',
    findingIds: kept.map(({ candidate }) => candidate.id),
    rejected: unknownIds + proposals.length - kept.length,
    usage: answer.usage ? { input: answer.usage.input_tokens ?? null, output: answer.usage.output_tokens ?? null } : null
  });
}

/** The project's AI job record: `none`, `running`, `failed` (with its message) or `done`. */
export async function aiJobStatus(projectKey) {
  const job = await storage.get(jobKey(projectKey));
  if (!job) return { state: 'none' };
  if (job.state === 'running' && !stillRunning(job)) {
    return { state: 'failed', error: 'The AI pass took too long and was stopped. Try again.' };
  }
  return job;
}

const DRAFT_PROMPT = `You help a teammate write a short Jira comment about a decision that may not have reached this issue.

You receive the decision (with its exact quote and source), why the app thinks the issue may be affected, and the issue's title and description.

Write:
- "note": 2 to 3 plain sentences for the issue's comment: what was decided and where, what in this issue looks out of date, and what to check or update. Use only facts from the input. Do not invent names, dates or numbers. Do not repeat the quote word for word; the app adds it below the note.
- "outdated": the shortest phrase, copied exactly from the issue description, that still describes the old plan. Use "" if no phrase in the description conflicts with the decision.
- "replacement": what that phrase should say instead, based only on the decision. Use "" when "outdated" is "".

Reply with JSON only, no other text:
{"note":"…","outdated":"…","replacement":"…"}`;

const MAX_DRAFT_TOKENS = 400;

/**
 * Drafts the note for one finding and issue. The person edits it before posting. A suggested
 * description change is offered only when its "outdated" phrase is found word for word in the issue.
 */
export async function draftNoteWithAi({ candidate, issue }) {
  const limited = await claimRun(`draft:${issue.key}:${candidate.id}`);
  if (limited) return { ok: false, error: limited.replace('The rule-based findings above are unaffected.', 'You can still write the note yourself.') };

  const affected = candidate.affectedIssues.find((a) => a.issueKey === issue.key);
  const input = [
    `Decision kind: ${candidate.kind}`,
    `Decision: ${candidate.summary}`,
    `Exact quote: "${candidate.evidence.quote}"`,
    `Source: ${candidate.source.title}${candidate.source.updatedAt ? ` (updated ${candidate.source.updatedAt.slice(0, 10)})` : ''}`,
    `Why the issue may be affected: ${(affected?.reasons ?? []).join('; ') || 'not stated'}`,
    `Issue: ${issue.key}: ${issue.title}`,
    `Issue description:\n${String(issue.description ?? '').slice(0, 4000) || '(empty)'}`
  ].join('\n');

  let response;
  try {
    response = await chat({
      model: AI_MODEL,
      max_completion_tokens: MAX_DRAFT_TOKENS,
      messages: [
        { role: 'system', content: DRAFT_PROMPT },
        { role: 'user', content: input }
      ]
    });
  } catch (error) {
    console.error('Decision Drift Radar AI note draft failed', errorLabel(error));
    await releaseRun(`draft:${issue.key}:${candidate.id}`);
    return { ok: false, error: 'The AI could not draft a note right now. You can still write it yourself.' };
  }

  const draft = parseJsonObject(response?.choices?.[0]?.message?.content);
  const note = typeof draft?.note === 'string' ? draft.note.replace(/[ \t]+/g, ' ').trim().slice(0, 1200) : '';
  if (!note) {
    await releaseRun(`draft:${issue.key}:${candidate.id}`);
    return { ok: false, error: 'The AI returned no usable draft. You can still write the note yourself.' };
  }
  const outdated = typeof draft.outdated === 'string' ? draft.outdated.trim() : '';
  const replacement = typeof draft.replacement === 'string' ? draft.replacement.trim() : '';
  const verified = outdated.length >= 3 && outdated.length <= 200 && replacement && replacement.length <= 200
    && String(issue.description ?? '').includes(outdated);
  return { ok: true, note, suggestion: verified ? { outdated, replacement } : null, model: AI_MODEL };
}

/** A JSON object in a model reply, tolerating a code fence or stray text around it. */
function parseJsonObject(content) {
  const text = Array.isArray(content) ? content.map((part) => part?.text ?? '').join('') : String(content ?? '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}
