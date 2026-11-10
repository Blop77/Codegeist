import { createHash } from 'node:crypto';

export interface TextSpan {
  text: string;
  start: number;
  end: number;
}

/**
 * Splits text into sentences with exact offsets into the original string.
 * A sentence ends at a newline, or at . ! ? followed by whitespace or the end.
 */
export function splitSentences(text: string): TextSpan[] {
  const out: TextSpan[] = [];
  let start = 0;
  const push = (from: number, to: number) => {
    while (from < to && /\s/.test(text[from])) from++;
    while (to > from && /\s/.test(text[to - 1])) to--;
    if (to > from) out.push({ text: text.slice(from, to), start: from, end: to });
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const terminal = (c === '.' || c === '!' || c === '?') && (i + 1 === text.length || /\s/.test(text[i + 1]));
    if (c === '\n' || terminal) {
      push(start, c === '\n' ? i : i + 1);
      start = i + 1;
    }
  }
  push(start, text.length);
  return out;
}

const STOPWORDS = new Set(
  `a an the and or but if then else of to in on at by for with from into onto over under as is are was were be been
  being it its this that these those we our us you your they their them i me my he she his her will would shall should
  can could may might must do does did done have has had not no yes so than too very just also only about after before
  again all any both each few more most other some such own same up down out off once here there when where why how
  what which who whom whose because until while let lets let's we'll we've we're it's there's per via vs etc going go
  use using get got make made new now still need needs`.split(/\s+/),
);

/** Words that describe the act of deciding rather than the subject of the decision. */
const META_WORDS = new Set(
  `decision decisions decide decided deciding agree agreed agreement scope scoped standup meeting team instead forward
  final call outcome approved approve sign signed off support move moving build add update proposal propose suggest
  recommend plan planned probably think question replace replacing switch migrate drop remove cut deprecate
  descope`.split(/\s+/),
);

export function stem(word: string): string {
  if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith('ies')) return word.slice(0, -3) + 'y';
  if (word.length > 4 && word.endsWith('ed')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss') && !word.endsWith('us')) return word.slice(0, -1);
  return word;
}

/** Lowercased, stemmed content words. Numbers and decision meta-words are dropped. */
export function tokenize(text: string): string[] {
  const words = text.toLowerCase().match(/[a-z0-9][a-z0-9'+-]*[a-z0-9]|[a-z]/g) ?? [];
  const out: string[] = [];
  for (const raw of words) {
    const w = raw.replace(/'s$/, '');
    if (w.length < 2 || /^\d+$/.test(w) || STOPWORDS.has(w) || META_WORDS.has(w)) continue;
    out.push(stem(w));
  }
  return out;
}

export function tokenSet(text: string): Set<string> {
  return new Set(tokenize(text));
}

const ISSUE_KEY = /\b[A-Z][A-Z0-9]{1,9}-\d+\b/g;

export function findIssueKeys(text: string): string[] {
  return [...new Set(text.match(ISSUE_KEY) ?? [])];
}

export function normalizeSpace(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whole-word, case-insensitive phrase search that tolerates plural endings. */
export function containsPhrase(haystack: string, phrase: string): boolean {
  const words = phrase.trim().split(/\s+/).filter(Boolean).map(escapeRegExp);
  if (words.length === 0) return false;
  const pattern = new RegExp(`(?:^|[^A-Za-z0-9])${words.join('\\s+')}(?:s|es)?(?![A-Za-z0-9])`, 'i');
  return pattern.test(haystack);
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / (a.size + b.size - shared);
}

export function stableId(...parts: string[]): string {
  return createHash('sha1').update(parts.join('␟')).digest('hex').slice(0, 16);
}

export function daysBetween(earlier: string, later: string): number {
  return (Date.parse(later) - Date.parse(earlier)) / 86_400_000;
}
