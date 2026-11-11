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

/**
 * Runs the AI pass over `sources`. `known` are the rule-based candidates, so the model is asked
 * only for what they missed and its proposals cannot duplicate them.
 */
export async function findWithAi({ scopeKey, sources, issues, known }) {
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
  return {
    ok: true,
    candidates,
    rejected,
    sourcesSent: picked.length,
    model: AI_MODEL,
    usage: response?.usage ?? null
  };
}
