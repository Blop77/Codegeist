/**
 * Self-check for the domain module against its fixtures. Run from the repo root after
 * compiling (see README). Pass --update to regenerate expectedDemoOutput.json.
 */
import { strict as assert } from 'node:assert';
import { readFileSync, writeFileSync } from 'node:fs';
import type { ExtractionInput, ExtractionResult, SentenceClassifier } from '../decisionTypes';
import { defaultClassifier, extractDecisions, MAX_QUOTE_LENGTH, verifyProposedFindings } from '../extractDecisions';
import { demoInput } from './demoInput';
import { emptyInput, longSentence, malformedInput } from './edgeCases';
import { mcDemoInput } from './mcDemoInput';

const GOLDEN = 'src/domain/fixtures/expectedDemoOutput.json';
let failures = 0;

function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`✔ ${name}`);
  } catch (err) {
    failures++;
    console.log(`✖ ${name}\n  ${(err as Error).message.split('\n').join('\n  ')}`);
  }
}

function assertEvidenceExact(input: ExtractionInput, result: ExtractionResult) {
  // The module keeps the first record when ids repeat, so the lookup does too.
  const textById = new Map<string, string>();
  for (const s of input.sources) if (s && typeof s === 'object' && !textById.has(s.id)) textById.set(s.id, s.text);
  for (const c of result.candidates) {
    const text = textById.get(c.source.id);
    assert.equal(text?.slice(c.evidence.start, c.evidence.end), c.evidence.quote, `offsets reproduce the quote for ${c.id}`);
    assert.ok(c.evidence.quote.length <= MAX_QUOTE_LENGTH, `quote is at most ${MAX_QUOTE_LENGTH} chars`);
  }
}

const demo = extractDecisions(demoInput);
const find = (text: string) => {
  const c = demo.candidates.find((x) => x.summary.includes(text));
  assert.ok(c, `expected a candidate containing "${text}"`);
  return c;
};

if (process.argv.includes('--update')) {
  writeFileSync(GOLDEN, JSON.stringify(demo, null, 2) + '\n');
  console.log(`Wrote ${GOLDEN}`);
}

check('same input yields identical output', () => {
  assert.deepEqual(extractDecisions(demoInput), demo);
  assert.deepEqual(extractDecisions(structuredClone(demoInput)), demo);
});

check('demo output matches expectedDemoOutput.json', () => {
  assert.deepEqual(demo, JSON.parse(readFileSync(GOLDEN, 'utf8')));
});

check('evidence offsets reproduce quotes exactly', () => {
  assertEvidenceExact(demoInput, demo);
  assertEvidenceExact(malformedInput, extractDecisions(malformedInput));
});

check('clear decisions are labelled decisions', () => {
  for (const text of ['Stripe Payment Element', 'Guest checkout', 'Postmark', 'cap retries', 'Segment', 'PAY-106 ships']) {
    assert.equal(find(text).kind, 'decision', text);
  }
});

check('proposals and open questions are kept apart from decisions', () => {
  assert.equal(find('rate limiting').kind, 'proposal');
  assert.equal(find('Apple Pay').kind, 'open_question');
  assert.equal(find('second approver').kind, 'open_question');
});

check('ordinary discussion is not extracted', () => {
  for (const text of ['Lunch', 'layout looks cleaner', 'deliverability', 'Attendees', 'This page records', 'Design shared']) {
    assert.ok(!demo.candidates.some((c) => c.summary.includes(text)), text);
  }
});

check('explicit issue-key signals', () => {
  const release = find('PAY-106 ships');
  assert.equal(release.affectedIssues[0].issueKey, 'PAY-106');
  assert.match(release.affectedIssues[0].reasons[0], /names PAY-106/);

  const retries = find('cap retries');
  assert.deepEqual(retries.affectedIssues.map((m) => m.issueKey), ['PAY-107']);
  assert.match(retries.affectedIssues[0].reasons.join(' '), /comment on PAY-107/);
  assert.match(retries.affectedIssues[0].reasons.join(' '), /still mentions “5”/);

  const analytics = find('Segment');
  assert.ok(analytics.affectedIssues.some((m) => m.issueKey === 'PAY-108' && m.reasons.some((r) => /written in PAY-108/.test(r))));
});

check('lexical matches explain the shared terms', () => {
  const email = find('Postmark');
  assert.deepEqual(email.affectedIssues.map((m) => m.issueKey), ['PAY-103']);
  assert.match(email.affectedIssues[0].reasons.join(' '), /Shares terms/);
  assert.match(email.affectedIssues[0].reasons.join(' '), /still mentions “SendGrid”/);

  assert.ok(find('Segment').affectedIssues.some((m) => m.issueKey === 'PAY-109'));
  assert.equal(find('Stripe Payment Element').affectedIssues[0].issueKey, 'PAY-101');
  assert.deepEqual(find('Guest checkout').affectedIssues.map((m) => m.issueKey), ['PAY-102']);
});

check('every match has reasons and a relevance in 0..1', () => {
  for (const c of demo.candidates) {
    assert.ok(c.confidence > 0 && c.confidence < 1, `confidence for ${c.summary}`);
    assert.ok(c.confidenceReasons.length > 0);
    for (const m of c.affectedIssues) {
      assert.ok(m.relevance > 0 && m.relevance < 1);
      assert.ok(m.reasons.length > 0);
    }
  }
});

check('issues match only within the same project', () => {
  const ops = find('OPS-9 certificate');
  assert.deepEqual(ops.affectedIssues, []);
  const opsWeekly = find('rotate staging certificates');
  assert.deepEqual(opsWeekly.affectedIssues.map((m) => m.issueKey), ['OPS-9']);
  for (const c of demo.candidates) {
    for (const m of c.affectedIssues) assert.ok(m.issueKey.startsWith(`${c.source.projectKey}-`), `${m.issueKey} vs ${c.source.projectKey}`);
  }
});

check('repeated mentions in one source collapse into one candidate', () => {
  const email = demo.candidates.filter((c) => c.summary.includes('Postmark'));
  assert.equal(email.length, 1);
  assert.ok(email[0].confidenceReasons.includes('Stated 2 times in this source'));
});

check('ids are stable and unique', () => {
  const ids = demo.candidates.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every((id) => /^dc_[0-9a-f]{16}$/.test(id)));
});

check('empty input returns no candidates and a warning', () => {
  const r = extractDecisions(emptyInput);
  assert.deepEqual(r.candidates, []);
  assert.deepEqual(r.warnings.map((w) => w.code), ['empty_input']);
});

check('non-object input is reported, not thrown', () => {
  assert.deepEqual(extractDecisions(null as unknown as ExtractionInput).warnings.map((w) => w.code), ['invalid_input']);
  assert.deepEqual(extractDecisions({} as ExtractionInput).warnings.map((w) => w.code), ['invalid_input', 'empty_input']);
});

check('malformed records are skipped with warnings; good records still work', () => {
  const r = extractDecisions(malformedInput);
  const codes = r.warnings.map((w) => w.code).sort();
  assert.deepEqual(codes, [
    'duplicate_issue',
    'duplicate_source',
    'invalid_issue',
    'invalid_issue',
    'invalid_option',
    'invalid_source',
    'invalid_source',
    'invalid_source',
    'invalid_source',
    'invalid_source',
    'invalid_timestamp',
    'invalid_timestamp',
  ]);
  const flags = r.candidates.find((c) => c.source.id === 'bad-time');
  assert.equal(flags?.source.updatedAt, 'last tuesday');
  assert.deepEqual(flags?.affectedIssues.map((m) => m.issueKey), ['PAY-1']);
});

check('long sentences are shortened at a word boundary and marked', () => {
  const r = extractDecisions(malformedInput);
  const long = r.candidates.find((c) => c.source.id === 'long');
  assert.ok(long);
  assert.ok(longSentence.length > MAX_QUOTE_LENGTH && long.evidence.quote.length <= MAX_QUOTE_LENGTH);
  assert.ok(long.summary.endsWith('…'));
  assert.ok(!/\s$/.test(long.evidence.quote));
});

check('maxCandidates truncates and warns', () => {
  const r = extractDecisions({ ...demoInput, maxCandidates: 3 });
  assert.deepEqual(r.candidates, demo.candidates.slice(0, 3));
  assert.ok(r.warnings.some((w) => w.code === 'candidates_truncated'));
});

check('a custom classifier can be injected and fall back to the defaults', () => {
  const strict: SentenceClassifier = (sentence, ctx) => {
    const result = defaultClassifier(sentence, ctx);
    return result?.kind === 'decision' ? result : null;
  };
  const r = extractDecisions(demoInput, { classifier: strict });
  assert.ok(r.candidates.length > 0 && r.candidates.every((c) => c.kind === 'decision'));
});

check('a throwing classifier skips sentences instead of failing', () => {
  const r = extractDecisions(demoInput, {
    classifier: () => {
      throw new Error('boom');
    },
  });
  assert.deepEqual(r.candidates, []);
});

const kindOf = (sentence: string) =>
  defaultClassifier(sentence, { sourceType: 'confluence_page', sourceTitle: 'Notes', underDecisionHeading: false })?.kind ?? null;

check('disclaimers and negated approvals are not decisions', () => {
  for (const sentence of [
    'This is a sample decision, not an approved Marketing team decision.',
    'This is not a final decision.',
    'This is not a decision, just a summary of options.',
    'It was only an example decision for training.',
    'The pricing table is for illustration only.',
    'The budget was not yet approved.',
    'Nothing has been approved yet.',
    'No one has signed off on the rollout.',
    'Approved requests go to the MC intake queue.',
    'See the list of approved vendors in the wiki.',
  ]) {
    assert.equal(kindOf(sentence), null, sentence);
  }
  assert.equal(kindOf('We never decided to drop the legacy API.'), 'open_question');
});

check('real approvals and decisions still count', () => {
  for (const sentence of [
    'Decision: We agreed to coordinate the MC website, email, and social campaign under one launch plan.',
    'The vendor contract was approved by legal.',
    'Leadership signed off on the Q3 launch date.',
    'Not only was it approved, it shipped early.',
    'The CFO approved the Q4 budget.',
    'Approved: launch the campaign on November 20.',
    'Budget approved.',
    'Final decision: ship the sample data importer in 2.4.',
    'Decision: Use sample data for the staging environment.',
  ]) {
    assert.equal(kindOf(sentence), 'decision', sentence);
  }
});

check('MC demo: one decision, no disclaimer, MC-9 flagged as drift, listed issues matched', () => {
  const r = extractDecisions(mcDemoInput);
  assertEvidenceExact(mcDemoInput, r);
  assert.equal(r.candidates.length, 1, r.candidates.map((c) => c.summary).join(' | '));
  const [c] = r.candidates;
  assert.equal(c.kind, 'decision');
  assert.equal(c.source.type, 'confluence_page', "MC-9's own description is not a finding");
  assert.equal(
    c.evidence.quote,
    'Decision: We agreed to use one shared launch plan instead of separate channel plans for the MC website, email, and social campaign.',
  );
  assert.ok(!r.candidates.some((x) => /sample decision|not an approved/i.test(x.evidence.quote)));
  const keys = c.affectedIssues.map((a) => a.issueKey);
  for (const key of ['MC-1', 'MC-5', 'MC-9', 'MC-10']) {
    const a = c.affectedIssues.find((x) => x.issueKey === key);
    assert.ok(a, `${key} is matched`);
    assert.ok(a.reasons.includes(`The same paragraph as the decision lists ${key}`), `${key} explains the listing`);
  }
  assert.deepEqual(keys.slice(0, 4).sort(), ['MC-1', 'MC-10', 'MC-5', 'MC-9'], 'listed issues rank first');
  // Drift: MC-9 still describes the plan the decision replaces, so it ranks first.
  assert.equal(keys[0], 'MC-9');
  assert.ok(c.affectedIssues[0].reasons.includes('The issue still mentions “separate channel plans”, which this decision replaces'));
});

check('reference lines under a decisions heading are not decisions', () => {
  const heading = { sourceType: 'confluence_page' as const, sourceTitle: 'Launch sync', underDecisionHeading: true, decisionListItem: true };
  for (const sentence of ['Related Jira issues: MC-1, MC-5, MC-9, MC-10.', 'See also: PAY-101 and PAY-104.', 'Owners: Priya and Marcus.', 'MC-1, MC-5, MC-9 and MC-10.']) {
    assert.equal(defaultClassifier(sentence, heading), null, sentence);
  }
  assert.equal(defaultClassifier('Social posts go live after the website update.', heading)?.kind, 'decision');
});

check('AI proposals are kept only when the quote is verbatim, new and well formed', () => {
  const page = mcDemoInput.sources[0];
  const known = extractDecisions(mcDemoInput).candidates;
  const indirect = 'Status: Demo example only.';
  const r = verifyProposedFindings(mcDemoInput, [
    { sourceId: page.id, quote: indirect, kind: 'decision', reason: 'states the page status' },
    { sourceId: page.id, quote: 'We agreed to use one shared launch plan for every channel.', kind: 'decision' },
    { sourceId: page.id, quote: known[0].evidence.quote, kind: 'decision' },
    { sourceId: 'no-such-source', quote: indirect, kind: 'decision' },
    { sourceId: page.id, quote: indirect, kind: 'verdict' as never },
    { sourceId: page.id, quote: 'Status:', kind: 'decision' },
  ], known);
  assert.equal(r.candidates.length, 1);
  assert.equal(r.rejected, 5);
  const [c] = r.candidates;
  assert.equal(page.text.slice(c.evidence.start, c.evidence.end), indirect);
  assert.match(c.id, /^dc_[a-f0-9]{16}$/);
  assert.ok(c.confidenceReasons[0].startsWith('Found by the AI pass'));
  assert.ok(c.confidenceReasons.includes('AI note: states the page status'));
  assert.deepEqual(verifyProposedFindings(mcDemoInput, r.candidates.map((x) => ({ sourceId: x.source.id, quote: x.evidence.quote, kind: x.kind })), [...known, ...r.candidates]).candidates, []);
  assert.deepEqual(verifyProposedFindings(mcDemoInput, 'nonsense' as never).candidates, []);
});

check('only list items under a Decisions heading fall back to decisions', () => {
  const run = (text: string) => extractDecisions({ sources: [{ id: 's', type: 'confluence_page', title: 'DACI: Enablement approach', url: '', text, projectKey: 'PAY', updatedAt: '2026-11-01T00:00:00Z' }], issues: [] }).candidates;
  // Template prose under decision-like headings is not a decision.
  assert.deepEqual(run(['## Decision', 'This document outlines the decision-making process for training options.', '## Outcomes', 'An hour ago, you felt the project was going along just fine.', '## Conclusion', 'Key factors include cost, speed of onboarding, and quality.'].join('\n')), []);
  // A bulleted item under "Decisions" still counts.
  const items = run(['## Decisions', '- Virtual async training for all new hires from January.', 'Prose under the heading is ignored for now.'].join('\n'));
  assert.equal(items.length, 1);
  assert.equal(items[0].summary, 'Virtual async training for all new hires from January.');
});

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll checks passed');
