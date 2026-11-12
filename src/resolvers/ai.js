/**
 * Optional AI pass: asks an Atlassian-hosted model (Forge LLMs) for decisions the wording rules
 * missed, then keeps only proposals whose quote is found word for word in the source. It runs
 * only when a person asks for it, and is rate-limited per site because usage is billed to the
 * app developer.
 */
import { chat } from '@forge/llm';
import { storage } from '@forge/api';
import { verifyProposedFindings } from '../domain/extractDecisions';

export const AI_MODEL = 'claude-sonnet-5';
const MAX_SOURCES = 15;
const MAX_CHARS_PER_SOURCE = 3000;
const MAX_TOTAL_CHARS = 24000;
const MAX_OUTPUT_TOKENS = 1500;
const MAX_PROPOSALS = 20;
export const DAILY_RUNS_PER_SITE = 40;
export const COOLDOWN_SECONDS = 30;

const SYSTEM_PROMPT = `You find decisions in a team's Jira and Confluence text that may not have reached the work they affect.

You receive numbered sources. Return the decisions, open questions and proposals that the "already found" list does not contain. Include ones phrased indirectly, for example "the team is going ahead with Tuesday-only sends" or "Marcus confirmed we're locking in weekly payouts".

Rules:
- "quote" must be one sentence copied exactly, character for character, from that source. Never paraphrase, shorten or fix it.
- Only include text that states a decision, an unresolved question, or a suggestion. Skip status updates, plans of individual people, attendee lists, disclaimers, and anything negated ("not approved", "not a decision").
- In Jira issue descriptions, skip sentences that only describe how the work is currently planned, scheduled or scoped ("the email campaign keeps separate channel plans"). That is the work item, not a decision about it. Report a sentence from a description only if it records that something was decided, agreed or approved.
- "kind" is "decision", "open_question" or "proposal".
- "reason" is at most 15 words on why it is a decision, question or proposal.
- If there is nothing new, return an empty list.

Reply with JSON only, no other text:
{"findings":[{"sourceId":"…","quote":"…","kind":"decision","reason":"…"}]}`;

function pickSources(sources) {
  const ordered = [...sources].sort((a, b) => (a.type === 'confluence_page' ? 0 : 1) - (b.type === 'confluence_page' ? 0 : 1));
  const picked = [];
  let total = 0;
  for (const source of ordered) {
    if (picked.length >= MAX_SOURCES || total >= MAX_TOTAL_CHARS) break;
    const text = source.text.slice(0, Math.min(MAX_CHARS_PER_SOURCE, MAX_TOTAL_CHARS - total));
    if (!text.trim()) continue;
    picked.push({ ...source, text });
    total += text.length;
  }
  return picked;
}

function userPrompt(sources, known) {
  const knownList = known.length ? known.map((c) => `- [${c.source.id}] ${c.evidence.quote}`).join('\n') : '(none)';
  const body = sources.map((s) => `### sourceId: ${s.id}\nTitle: ${s.title}\n${s.text}`).join('\n\n');
  return `Already found (do not repeat):\n${knownList}\n\nSources:\n\n${body}`;
}

/** The model's JSON reply, tolerating a code fence or stray text around it. */
export function parseProposals(content) {
  const text = Array.isArray(content) ? content.map((part) => part?.text ?? '').join('') : String(content ?? '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return [];
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(parsed?.findings) ? parsed.findings.slice(0, MAX_PROPOSALS) : [];
  } catch {
    return [];
  }
}

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

const SAVED_LIMIT = 30;
const savedKey = (projectKey) => `ai-proposals:${projectKey}`;

/** The proposal behind each verified candidate, in the compact form that is saved. */
function toSaved(candidates, proposals) {
  return candidates.map((c) => {
    const proposal = proposals.find((p) => String(p?.sourceId) === c.source.id && String(p?.quote ?? '').trim() === c.evidence.quote);
    const reason = typeof proposal?.reason === 'string' ? proposal.reason.slice(0, 200) : '';
    return { sourceId: c.source.id, quote: c.evidence.quote, kind: c.kind, ...(reason ? { reason } : {}) };
  });
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
  }).slice(0, SAVED_LIMIT);
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
    const { candidates } = verifyProposedFindings({ sources, issues }, stored.proposals, known);
    return { candidates: candidates.map((c) => ({ ...c, ai: true })), savedAt: stored.savedAt ?? null };
  } catch (error) {
    console.warn('Decision Drift Radar saved AI findings could not be read', error);
    return { candidates: [], savedAt: null };
  }
}

/**
 * Runs the AI pass over `sources`. `known` are the candidates already found (by the rules, and
 * earlier AI passes), so the model is asked only for what they missed and its proposals cannot
 * duplicate them. With `saveFor`, verified findings are saved for that project's later scans.
 */
export async function findWithAi({ scopeKey, sources, issues, known, saveFor = null }) {
  const limited = await claimRun(scopeKey);
  if (limited) return { ok: false, error: limited };

  const picked = pickSources(sources);
  if (picked.length === 0) return { ok: true, candidates: [], rejected: 0, sourcesSent: 0, model: AI_MODEL };

  let response;
  try {
    response = await chat({
      model: AI_MODEL,
      max_completion_tokens: MAX_OUTPUT_TOKENS,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt(picked, known) }
      ]
    });
  } catch (error) {
    console.error('Decision Drift Radar AI pass failed', error?.context?.responseText ?? error);
    return { ok: false, error: 'The AI pass is unavailable right now. The rule-based findings above are unaffected.' };
  }

  const proposals = parseProposals(response?.choices?.[0]?.message?.content);
  // Verify against the full source text, not the truncated copy sent to the model.
  const { candidates, rejected } = verifyProposedFindings({ sources, issues }, proposals, known);
  if (saveFor) {
    try {
      await saveProposals(saveFor, toSaved(candidates, proposals));
    } catch (error) {
      console.warn('Decision Drift Radar AI findings could not be saved', error);
    }
  }
  return {
    ok: true,
    candidates,
    rejected,
    sourcesSent: picked.length,
    model: AI_MODEL,
    usage: response?.usage ?? null
  };
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
    console.error('Decision Drift Radar note draft failed', error?.context?.responseText ?? error);
    return { ok: false, error: 'The AI could not draft a note right now. You can still write it yourself.' };
  }

  const draft = parseJsonObject(response?.choices?.[0]?.message?.content);
  const note = typeof draft?.note === 'string' ? draft.note.replace(/[ \t]+/g, ' ').trim().slice(0, 1200) : '';
  if (!note) return { ok: false, error: 'The AI returned no usable draft. You can still write the note yourself.' };
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
