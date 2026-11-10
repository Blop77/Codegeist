import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeDecisions, type DecisionModel } from '../src/index.ts';
import { demoInput } from '../fixtures/demo-scenario.ts';

test('a model can drop a false positive, and the drop is reported', async () => {
  const model: DecisionModel = {
    async review(input) {
      if (input.passage.includes('rate limiting')) {
        return { kind: 'none', quotedEvidence: input.passage, rationale: 'An idea raised in passing, not a proposal.' };
      }
      return { kind: input.currentKind, quotedEvidence: input.passage, rationale: 'Agrees with the rules.' };
    },
  };
  const { candidates, diagnostics } = await analyzeDecisions(demoInput, { model });
  assert.ok(!candidates.some((c) => c.decisionText.includes('rate limiting')));
  assert.equal(diagnostics.model?.dropped.length, 1);
  assert.match(diagnostics.model?.dropped[0].rationale ?? '', /in passing/);
});

test('model output with evidence not found in the source is rejected', async () => {
  const model: DecisionModel = {
    async review() {
      return { kind: 'none', quotedEvidence: 'The VP said to cancel the project.', rationale: 'Invented.' };
    },
  };
  const baseline = await analyzeDecisions(demoInput);
  const { candidates, diagnostics } = await analyzeDecisions(demoInput, { model });
  assert.equal(candidates.length, baseline.candidates.length);
  assert.ok((diagnostics.model?.rejectedUnverifiedEvidence ?? 0) > 0);
});

test('a model upgrade to explicit never reaches high confidence', async () => {
  const model: DecisionModel = {
    async review(input) {
      return { kind: 'explicit', quotedEvidence: input.passage, rationale: 'Reads as settled.', summary: 'Add rate limiting' };
    },
  };
  const { candidates } = await analyzeDecisions(demoInput, { model });
  const rate = candidates.find((c) => c.decisionText.includes('rate limiting'));
  assert.equal(rate?.kind, 'explicit');
  assert.equal(rate?.confidence, 'medium');
  assert.equal(rate?.model?.previousKind, 'possible');
  assert.equal(rate?.model?.summary, 'Add rate limiting');
});

test('model errors and timeouts fall back to the deterministic result', async () => {
  const failing: DecisionModel = {
    async review() {
      throw new Error('service unavailable');
    },
  };
  const slow: DecisionModel = { review: () => new Promise(() => {}) };
  const baseline = await analyzeDecisions(demoInput);

  const failed = await analyzeDecisions(demoInput, { model: failing });
  assert.deepEqual(failed.candidates, baseline.candidates);
  assert.ok((failed.diagnostics.model?.errors ?? 0) > 0);

  const timedOut = await analyzeDecisions(demoInput, { model: slow, modelOptions: { timeoutMs: 10, maxCalls: 2 } });
  assert.deepEqual(timedOut.candidates, baseline.candidates);
  assert.equal(timedOut.diagnostics.model?.errors, 2);
});
