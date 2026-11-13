/** Run the frozen one-page-per-call benchmark against an approved development endpoint. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { prepareMarkdown } from './prepare.ts';

const targets = [
  { dir: 'corpus', labels: 'labels.json' },
  { dir: 'recall', labels: 'labels-recall.json' },
  { dir: 'heldout', labels: 'labels-heldout.json' }
];
const path = 'benchmark/ai-results.json';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const endpoint = process.env.DDR_BENCH_URL;
const token = process.env.DDR_BENCH_TOKEN;
if (!endpoint || new URL(endpoint).protocol !== 'https:' || !token) {
  throw new Error('Set DDR_BENCH_URL to the approved HTTPS development endpoint and DDR_BENCH_TOKEN to its token.');
}

type Finding = { kind: 'decision' | 'open_question' | 'proposal'; quote: string };
type Entry = { set: string; file: string; inputSha256: string; status: 'started' | 'complete'; ai?: Finding[]; rejected?: number; usage?: unknown };
type Run = { model: string | null; ranAt: string; protocol: string; labels: Record<string, string>; files: Entry[] };
const protocol = 'forge-numbered-v1: corpus pipeline check, then recall, then heldout; one prepared page per call';
const labels = Object.fromEntries(targets.map(({ labels }) => [labels, hash(readFileSync(`benchmark/${labels}`, 'utf8'))]));
const run: Run = existsSync(path)
  ? JSON.parse(readFileSync(path, 'utf8'))
  : { model: null, ranAt: new Date().toISOString(), protocol, labels, files: [] };

if (run.protocol !== protocol || JSON.stringify(run.labels) !== JSON.stringify(labels)) {
  throw new Error('The existing run uses a different protocol or different labels.');
}

for (const { dir, labels } of targets) {
  const documents = JSON.parse(readFileSync(`benchmark/${labels}`, 'utf8')).documents as Array<{ file: string }>;
  for (const { file } of documents) {
    const text = prepareMarkdown(readFileSync(`benchmark/${dir}/${file}`, 'utf8'));
    const inputSha256 = hash(text);
    const prior = run.files.find((entry) => entry.set === dir && entry.file === file);
    if (prior) {
      if (prior.inputSha256 !== inputSha256 || prior.status !== 'complete') {
        throw new Error(`Review the existing record for ${dir}/${file} before continuing. It will not be sent again automatically.`);
      }
      continue;
    }
    const entry: Entry = { set: dir, file, inputSha256, status: 'started' };
    run.files.push(entry);
    writeFileSync(path, JSON.stringify(run, null, 2) + '\n');
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-benchmark-token': token },
      redirect: 'error',
      body: JSON.stringify({ file, text }),
      signal: AbortSignal.timeout(60_000)
    }).catch(() => { throw new Error(`Request did not complete for ${dir}/${file}.`); });
    if (!response.ok) throw new Error(`Endpoint returned HTTP ${response.status} for ${dir}/${file}.`);
    const result = await response.json();
    if (!result.ok || result.file !== file || !Array.isArray(result.ai) || !Number.isInteger(result.rejected)
        || typeof result.model !== 'string' || (run.model && run.model !== result.model)
        || result.ai.some((item: Finding) => !item || !['decision', 'open_question', 'proposal'].includes(item.kind)
          || typeof item.quote !== 'string' || !item.quote.trim() || !text.includes(item.quote))) {
      throw new Error(`Unexpected benchmark result for ${dir}/${file}. The run was stopped.`);
    }
    run.model = result.model;
    Object.assign(entry, { status: 'complete', ai: result.ai, rejected: result.rejected, usage: result.usage ?? null });
    writeFileSync(path, JSON.stringify(run, null, 2) + '\n');
    console.log(`${dir}/${file}: ${entry.ai?.length} verified AI findings, ${entry.rejected} rejected`);
  }
}
