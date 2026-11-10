import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeDecisions } from '../src/index.ts';
import { demoInput } from '../fixtures/demo-scenario.ts';
import type { DecisionCandidate } from '../src/types.ts';

const find = (candidates: DecisionCandidate[], text: string) => {
  const c = candidates.find((x) => x.decisionText.includes(text));
  assert.ok(c, `expected a candidate containing "${text}"`);
  return c;
};

test('demo: each seeded drift is found with the right issue and reason', async () => {
  const { candidates } = await analyzeDecisions(demoInput);

  const cardForm = find(candidates, 'Stripe Payment Element');
  const pay101 = cardForm.affectedIssues.find((m) => m.issueKey === 'PAY-101');
  assert.equal(pay101?.drift, 'stale-reference');
  assert.match(pay101?.driftReasons[0] ?? '', /legacy card form/);
  assert.equal(cardForm.affectedIssues.find((m) => m.issueKey === 'PAY-104')?.drift, 'possibly-reflected');

  const guest = find(candidates, 'Guest checkout');
  assert.deepEqual(guest.affectedIssueKeys, ['PAY-102']);
  assert.equal(guest.affectedIssues[0].drift, 'stale-reference');

  const email = find(candidates, 'Postmark');
  assert.deepEqual(email.affectedIssueKeys, ['PAY-103']);
  assert.ok(email.priority.signals.some((s) => s.code === 'blocked-work'));

  const retries = find(candidates, 'cap retries');
  assert.deepEqual(retries.affectedIssueKeys, ['PAY-107']);
  assert.equal(retries.affectedIssues[0].reasons[0].code, 'same-issue-discussion');
});

test('demo: drift decisions rank above proposals and open questions', async () => {
  const { candidates } = await analyzeDecisions(demoInput);
  const tiers = candidates.map((c) => c.priority.tier);
  assert.deepEqual(tiers.slice(0, 4), ['high', 'high', 'high', 'high']);
  for (const c of candidates.slice(4)) assert.notEqual(c.kind, 'explicit');
});

test('demo: the same decision on two pages is merged with both sources kept', async () => {
  const { candidates, diagnostics } = await analyzeDecisions(demoInput);
  const guest = find(candidates, 'Guest checkout');
  assert.equal(diagnostics.duplicatesMerged, 1);
  assert.equal(guest.sourceTitle, 'Checkout redesign: decision log');
  assert.equal(guest.alsoSeenIn.length, 1);
  assert.equal(guest.alsoSeenIn[0].sourceTitle, '2026-11-06 Payments sync');
});

test('demo: other projects are ignored', async () => {
  const { candidates } = await analyzeDecisions(demoInput);
  assert.ok(!candidates.some((c) => c.decisionText.includes('certificates')));
  assert.ok(!candidates.some((c) => c.affectedIssueKeys.some((k) => k.startsWith('OPS-'))));
});

test('page-level links alone do not tie every decision on a page to an issue', async () => {
  const { candidates } = await analyzeDecisions(demoInput);
  const apple = find(candidates, 'Apple Pay');
  assert.deepEqual(apple.affectedIssueKeys, []);
});

test('every candidate carries a citation that matches its source', async () => {
  const { candidates } = await analyzeDecisions(demoInput);
  for (const c of candidates) {
    assert.ok(c.sourceUrl.startsWith('https://'));
    assert.ok(c.evidenceExcerpt.length > 0);
    assert.ok(c.confidenceReasons.length > 0);
    assert.equal(c.affectedIssueKeys.length, c.affectedIssues.length);
    for (const m of c.affectedIssues) assert.ok(m.reasons.length > 0 && m.driftReasons.length > 0);
  }
});

test('since filters sources by date', async () => {
  const { candidates, diagnostics } = await analyzeDecisions({ ...demoInput, since: '2026-11-05T00:00:00Z' });
  // The decision log (Nov 4) and the PAY-101 comment (Oct 29) fall outside the window.
  assert.equal(diagnostics.sourcesSkippedByWindow, 2);
  assert.ok(!candidates.some((c) => c.sourceTitle === 'Checkout redesign: decision log'));
  assert.ok(candidates.some((c) => c.decisionText.includes('Postmark')));
});

test('options narrow the output', async () => {
  const explicitOnly = await analyzeDecisions({ ...demoInput, options: { includeKinds: ['explicit'] } });
  assert.ok(explicitOnly.candidates.every((c) => c.kind === 'explicit'));

  const capped = await analyzeDecisions({ ...demoInput, options: { maxCandidates: 2 } });
  assert.equal(capped.candidates.length, 2);
});

test('results are deterministic', async () => {
  const a = await analyzeDecisions(demoInput);
  const b = await analyzeDecisions(demoInput);
  assert.deepEqual(a, b);
});

test('empty input returns nothing without throwing', async () => {
  const { candidates } = await analyzeDecisions({ projectKey: 'PAY', issues: [], sources: [] });
  assert.deepEqual(candidates, []);
});
