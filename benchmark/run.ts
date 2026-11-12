/**
 * Accuracy benchmark for the rule-based extractor (src/domain) on real, openly licensed meeting
 * notes. Run: npm run benchmark. Prints a summary and writes benchmark/RESULTS.md.
 *
 * Two sets: the development set (corpus/, used to tune the rules) and the held-out set
 * (heldout/, labelled after tuning and never used to change the rules). Each is scored with the
 * current rules and with the rules as they were before tuning (git ref BASELINE_REF), so the
 * effect of the tuning can be read on data it never saw.
 *
 * Matching: a finding matches a label when one normalised text contains the other, and the
 * shorter is at least half as long as the longer. Each label and each finding is used at most
 * once. Findings that match an ambiguous label are ignored; strict labels decide the score.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { normalize, prepareMarkdown } from './prepare.ts';

const BASELINE_REF = 'd04822a';

type Kind = 'decision' | 'open_question' | 'proposal';
interface Label { kind: Kind; text: string; ambiguous?: boolean }
interface Tally { tp: number; fp: number; fn: number }
type Extract = (input: unknown) => { candidates: Array<{ kind: string; evidence: { quote: string } }> };

const KINDS: Kind[] = ['decision', 'open_question', 'proposal'];
const KIND_NAME: Record<Kind, string> = { decision: 'Decisions', open_question: 'Open questions', proposal: 'Proposals' };
const SETS = [
  { name: 'Held-out set', dir: 'heldout', labels: 'labels-heldout.json', sources: 'sources-heldout.tsv' },
  { name: 'Development set (used for tuning)', dir: 'corpus', labels: 'labels.json', sources: 'sources.tsv' }
];

function matches(finding: string, label: string): boolean {
  const a = normalize(finding);
  const b = normalize(label);
  if (!a || !b) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return long.includes(short) && short.length >= long.length / 2;
}

function score(set: (typeof SETS)[number], extract: Extract) {
  const docs = (JSON.parse(readFileSync(`benchmark/${set.labels}`, 'utf8')) as { documents: Array<{ file: string; labels: Label[] }> }).documents;
  const byKind = Object.fromEntries(KINDS.map((k) => [k, { tp: 0, fp: 0, fn: 0 }])) as Record<Kind, Tally>;
  const any: Tally = { tp: 0, fp: 0, fn: 0 };
  const misses: string[] = [];
  const wrongKind: string[] = [];
  const falseAlarms: string[] = [];
  let ignored = 0;
  let findingsTotal = 0;

  for (const doc of docs) {
    const text = prepareMarkdown(readFileSync(`benchmark/${set.dir}/${doc.file}`, 'utf8'));
    const { candidates } = extract({
      sources: [{ id: `bench-${doc.file}`, type: 'confluence_page', title: doc.file, url: '', projectKey: 'BENCH', updatedAt: '2026-01-01T00:00:00Z', text }],
      issues: []
    });
    findingsTotal += candidates.length;
    const used = new Set<number>();
    for (const c of candidates) {
      const kind = c.kind as Kind;
      const hit = doc.labels
        .map((label, index) => ({ label, index }))
        .filter(({ index, label }) => !used.has(index) && matches(c.evidence.quote, label.text))
        .sort((x, y) => Number(y.label.kind === kind) - Number(x.label.kind === kind))[0];
      if (!hit) {
        byKind[kind].fp++;
        any.fp++;
        falseAlarms.push(`${doc.file} · ${kind} · “${c.evidence.quote}”`);
        continue;
      }
      used.add(hit.index);
      if (hit.label.ambiguous) {
        ignored++;
        continue;
      }
      any.tp++;
      if (hit.label.kind === kind) byKind[kind].tp++;
      else {
        byKind[kind].fp++;
        byKind[hit.label.kind].fn++;
        wrongKind.push(`${doc.file} · labelled ${hit.label.kind}, found as ${kind} · “${hit.label.text}”`);
      }
    }
    doc.labels.forEach((label, index) => {
      if (label.ambiguous || used.has(index)) return;
      byKind[label.kind].fn++;
      any.fn++;
      misses.push(`${doc.file} · ${label.kind} · “${label.text}”`);
    });
  }
  const all = docs.flatMap((d) => d.labels);
  return {
    byKind, any, misses, wrongKind, falseAlarms, ignored, findingsTotal,
    strict: all.filter((l) => !l.ambiguous).length, ambiguous: all.filter((l) => l.ambiguous).length, files: docs.length
  };
}

/** The extractor as it was at BASELINE_REF, copied to a temporary directory. */
async function baselineExtractor(): Promise<Extract> {
  const dir = mkdtempSync(join(tmpdir(), 'ddr-baseline-'));
  for (const file of ['extractDecisions.ts', 'matchIssues.ts', 'decisionTypes.ts']) {
    writeFileSync(join(dir, file), execFileSync('git', ['show', `${BASELINE_REF}:src/domain/${file}`]));
  }
  return (await import(pathToFileURL(join(dir, 'extractDecisions.ts')).href)).extractDecisions;
}

const pct = (n: number, d: number) => (d === 0 ? 'n/a' : `${Math.round((100 * n) / d)}%`);
const pair = (t: Tally) => `${pct(t.tp, t.tp + t.fp)} / ${pct(t.tp, t.tp + t.fn)}`;

const current = (await import('../src/domain/extractDecisions.ts')).extractDecisions as Extract;
let baseline: Extract | null = null;
try {
  baseline = await baselineExtractor();
} catch {
  console.warn(`Could not load the baseline rules from git ref ${BASELINE_REF}; showing current rules only.`);
}

const lines = [
  '# Accuracy benchmark results',
  '',
  `Generated by \`npm run benchmark\`. Rule-based extractor only (no AI pass). "Before" is the rules at \`${BASELINE_REF}\`, before tuning; "after" is the current rules. Each cell is precision / recall. See [README.md](README.md) for the method.`,
  ''
];
const summary: string[] = [];
for (const set of SETS) {
  const after = score(set, current);
  const before = baseline ? score(set, baseline) : null;
  lines.push(`## ${set.name}`, '', `${after.files} files, ${after.strict} strict and ${after.ambiguous} ambiguous labels.`, '');
  lines.push('| | Labels | Before tuning | After tuning |', '| --- | --- | --- | --- |');
  for (const k of KINDS) lines.push(`| ${KIND_NAME[k]} | ${after.byKind[k].tp + after.byKind[k].fn} | ${before ? pair(before.byKind[k]) : 'n/a'} | ${pair(after.byKind[k])} |`);
  lines.push(`| Anything flagged (kind ignored) | ${after.any.tp + after.any.fn} | ${before ? pair(before.any) : 'n/a'} | ${pair(after.any)} |`, '');
  lines.push(`After tuning: ${after.findingsTotal} findings, ${after.ignored} of them matching an ambiguous label (not scored).`, '');
  lines.push('### Missed after tuning', '', ...(after.misses.length ? after.misses.map((m) => `- ${m}`) : ['- none']), '');
  lines.push('### Wrong kind after tuning', '', ...(after.wrongKind.length ? after.wrongKind.map((m) => `- ${m}`) : ['- none']), '');
  lines.push('### False alarms after tuning', '', ...(after.falseAlarms.length ? after.falseAlarms.map((m) => `- ${m}`) : ['- none']), '');
  summary.push(`${set.name}: anything flagged ${before ? pair(before.any) : 'n/a'} → ${pair(after.any)}; decisions ${before ? pair(before.byKind.decision) : 'n/a'} → ${pair(after.byKind.decision)} (precision / recall)`);
}
lines.push('## Sources', '');
for (const set of SETS) {
  for (const [file, repo, path, sha] of readFileSync(`benchmark/${set.sources}`, 'utf8').trim().split('\n').map((l) => l.split('\t'))) {
    lines.push(`- \`${set.dir}/${file}\`: [${repo}/${path}](https://github.com/${repo}/blob/${sha}/${path}) at \`${sha.slice(0, 7)}\``);
  }
}
writeFileSync('benchmark/RESULTS.md', `${lines.join('\n')}\n`);
console.log(lines.slice(0, lines.indexOf('## Sources')).join('\n'));
console.log(summary.join('\n'));
