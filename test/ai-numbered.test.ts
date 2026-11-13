/**
 * The AI pass shows the model numbered sentences and takes back numbers, so an answer cannot be
 * lost to a copying slip (curly apostrophes, "e.g.", list markers). Fictional fixtures.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const g = globalThis as any;
const { askModel, numberSources } = await import('../src/resolvers/ai.js');
const { extractDecisions } = await import('../src/domain/extractDecisions.ts');

const page = (id: string, text: string) => ({ id, type: 'confluence_page', title: `Page ${id}`, url: '', projectKey: 'NB', updatedAt: '2026-11-01T00:00:00Z', text });
const NOTES = [
  '## Notes',
  '- Lena shared last quarter’s open rates, e.g. the April send.',
  'After the review, the team is going ahead with Tuesday-only sends.',
  '## Decisions',
  'Decision: We agreed to use one shared launch plan instead of separate channel plans.',
  'OK.'
].join('\n');

test('every number stands for a sentence exactly as the verifier splits it; found and unquotable ones are not numbered', () => {
  const sources = [page('p1', NOTES)];
  const { candidates: known } = extractDecisions({ sources, issues: [] });
  assert.equal(known.length, 1, 'the rules find the labelled decision');
  const { text, ids } = numberSources(sources, known);
  // The splitter breaks at "e.g."; a model copying the whole line would fail verification, but
  // numbered pieces always match.
  assert.deepEqual([...ids.entries()].map(([id, v]: any) => `${id} ${v.quote}`), [
    '1.1 Lena shared last quarter’s open rates, e.g.',
    '1.2 the April send.',
    '1.3 After the review, the team is going ahead with Tuesday-only sends.'
  ]);
  assert.match(text, /^## Decisions$/m, 'headings are shown for context');
  assert.match(text, /^\(already found\) Decision: We agreed/m);
  assert.match(text, /^\(context\) OK\.$/m, 'too short to quote');
});

test('a single long page is sent in full; many sources share the budget', () => {
  const long = Array.from({ length: 300 }, (_, i) => `The team discussed item number ${i} at length today.`).join('\n');
  const one = numberSources([page('p1', long)]);
  assert.equal(one.ids.size, 300, 'well past the old 3,000-character cut');
  const many = numberSources(Array.from({ length: 15 }, (_, i) => page(`p${i}`, long)));
  assert.ok(many.text.length <= 24000 + 15 * 40, 'the total stays within the budget');
  assert.equal(many.sourcesSent, 15);
  const displayed = many.text.split('\n');
  for (const [id, entry] of many.ids) {
    assert.ok(displayed.includes(`${id} ${entry.quote}`), `only displayed IDs can be selected: ${id}`);
  }
});

test('the model answers with numbers: the sentence verifies, unknown and already found numbers are rejected', async () => {
  const sources = [page('p1', NOTES)];
  const { candidates: known } = extractDecisions({ sources, issues: [] });
  g.__chat = async () => ({ choices: [{ message: { content: '{"findings":[{"id":"1.3","kind":"decision"},{"id":"1.9","kind":"decision"},{"id":"1.4","kind":"decision"}]}' } }] });
  const result = await askModel({ sources, issues: [], known });
  assert.equal(result.ok, true);
  assert.deepEqual(result.candidates.map((c: any) => c.evidence.quote), ['After the review, the team is going ahead with Tuesday-only sends.']);
  assert.equal(result.rejected, 2, 'the unknown number and the already found sentence');
  assert.ok(g.__llmCalls.at(-1).messages[1].content.includes('1.1 Lena shared last quarter’s open rates, e.g.'), 'curly apostrophes are shown as stored');
});

test('nothing to ask means no model call', async () => {
  const before = g.__llmCalls?.length ?? 0;
  const result = await askModel({ sources: [page('p1', 'OK.')], issues: [], known: [] });
  assert.equal(result.ok, true);
  assert.equal(result.asked, false);
  assert.equal(g.__llmCalls?.length ?? 0, before);
});
