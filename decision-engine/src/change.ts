import type { DecisionChange } from './types.ts';

// A phrase stops at punctuation or at a word that usually starts a trailing clause.
const STOP = String.raw`(?=\s+(?:for|in|on|at|because|so|since|until|by|when|after|before|across|per)\b|[,.;:!?()]|$)`;

const LEAD = /^(?:the|a|an|our|their|its|this|that|all|any|existing|current)\s+/i;

/** Trims a captured phrase; returns undefined when it is too long to be a reliable term. */
function cleanPhrase(raw: string | undefined, maxWords = 6): string | undefined {
  if (!raw) return undefined;
  let phrase = raw.trim().replace(/^["'“‘]|["'”’]$/g, '').trim();
  while (LEAD.test(phrase)) phrase = phrase.replace(LEAD, '');
  phrase = phrase.replace(/[\s.,;:]+$/, '');
  const words = phrase.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > maxWords) return undefined;
  return phrase;
}

function lastWords(raw: string, n: number): string {
  return raw.trim().split(/\s+/).slice(-n).join(' ');
}

const RULES: Array<(text: string) => DecisionChange | undefined> = [
  // "use Stripe Payment Element instead of the legacy card form"
  (t) => {
    const m = new RegExp(
      String.raw`\b(?:use|adopt|go with|going with|switch to|move to|choose|pick|ship|keep|build)\s+(.+?)\s+instead of\s+(.+?)${STOP}`,
      'i',
    ).exec(t);
    return m ? { to: cleanPhrase(m[1]), from: cleanPhrase(m[2]) } : undefined;
  },
  // "replace X with Y"
  (t) => {
    const m = new RegExp(String.raw`\breplac(?:e|ing)\s+(.+?)\s+with\s+(.+?)${STOP}`, 'i').exec(t);
    return m ? { from: cleanPhrase(m[1]), to: cleanPhrase(m[2]) } : undefined;
  },
  // "move the confirmation email from SendGrid to Postmark"
  (t) => {
    const m = new RegExp(
      String.raw`\b(?:switch|switching|move|moving|migrate|migrating|change|changing|go|going)\b.*?\bfrom\s+(.+?)\s+to\s+(.+?)${STOP}`,
      'i',
    ).exec(t);
    return m ? { from: cleanPhrase(m[1]), to: cleanPhrase(m[2]) } : undefined;
  },
  // "Guest checkout is out of scope for v1"
  (t) => {
    const body = t.replace(/^(?:we\s+)?(?:have\s+)?(?:decided|agreed)\s+(?:that\s+)?/i, '');
    const m = /^(.+?)\s+(?:is|are|will be|has been|have been)\s+(?:now\s+)?(?:out of scope|descoped|deferred|dropped|cut|removed|not in scope|postponed|deprecated)\b/i.exec(
      body,
    );
    return m ? { removed: cleanPhrase(m[1]) } : undefined;
  },
  // "drop guest checkout", "no longer support IE11"
  (t) => {
    const m = new RegExp(
      String.raw`\b(?:drop|dropping|remove|removing|cut|cutting|deprecate|deprecating|descope|descoping|stop supporting|no longer support(?:ing)?)\s+(.+?)${STOP}`,
      'i',
    ).exec(t);
    return m ? { removed: cleanPhrase(m[1]) } : undefined;
  },
  // Fallback: "cap retries at 3 instead of 5"
  (t) => {
    const m = new RegExp(String.raw`(.+?)\s+instead of\s+(.+?)${STOP}`, 'i').exec(t);
    return m ? { to: cleanPhrase(lastWords(m[1], 4)), from: cleanPhrase(m[2], 4) } : undefined;
  },
];

/** Extracts the old/new/removed terms a decision names, if its wording makes that clear. */
export function extractChange(decisionText: string): DecisionChange | undefined {
  for (const rule of RULES) {
    const change = rule(decisionText);
    if (!change) continue;
    const result: DecisionChange = {};
    if (change.from) result.from = change.from;
    if (change.to) result.to = change.to;
    if (change.removed) result.removed = change.removed;
    if (result.from || result.removed) return result;
  }
  return undefined;
}
