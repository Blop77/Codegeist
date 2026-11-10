import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractChange } from '../src/change.ts';
import { cleanDecisionText, extractFromComment, extractFromPage } from '../src/extract.ts';
import type { ConfluencePageRecord, JiraCommentRecord } from '../src/types.ts';

const page = (blocks: ConfluencePageRecord['blocks'], extra: Partial<ConfluencePageRecord> = {}): ConfluencePageRecord => ({
  kind: 'confluence-page',
  id: 'p1',
  spaceKey: 'X',
  title: 'Weekly notes',
  url: 'https://x/wiki/p1',
  author: 'a',
  labels: [],
  updatedAt: '2026-11-01T00:00:00Z',
  blocks,
  ...extra,
});

const comment = (body: string): JiraCommentRecord => ({
  kind: 'jira-comment',
  id: 'c1',
  issueKey: 'X-1',
  author: 'a',
  body,
  createdAt: '2026-11-01T00:00:00Z',
  url: 'https://x/browse/X-1',
});

const kinds = (text: string) => extractFromComment(comment(text), 'X').drafts.map((d) => d.kind);

test('classifies explicit, possible and unresolved language', () => {
  assert.deepEqual(kinds('We decided to ship dark mode first.'), ['explicit']);
  assert.deepEqual(kinds('Decision: keep the REST API.'), ['explicit']);
  assert.deepEqual(kinds('Agreed: weekly releases.'), ['explicit']);
  assert.deepEqual(kinds('We should probably cache the results.'), ['possible']);
  assert.deepEqual(kinds('We have not decided on pricing yet.'), ['unresolved']);
  assert.deepEqual(kinds('Pricing is TBD.'), ['unresolved']);
  assert.deepEqual(kinds('Should we support Safari 15?'), ['unresolved']);
  assert.deepEqual(kinds('Lunch was great.'), []);
});

test('a question is never read as an explicit decision', () => {
  assert.deepEqual(kinds('Have we agreed to drop IE11?'), []);
});

test('sentences describing the page itself are skipped', () => {
  assert.deepEqual(kinds('This page records what the team agreed in the review.'), []);
});

test('Confluence decision items keep their state and earn high confidence', () => {
  const { drafts } = extractFromPage(
    page([
      { id: 'd1', type: 'decision-item', decisionState: 'DECIDED', text: 'Use Postgres for the ledger.' },
      { id: 'd2', type: 'decision-item', decisionState: 'UNDECIDED', text: 'Region for the EU tenant' },
    ]),
    'X',
  );
  assert.equal(drafts.length, 2);
  assert.equal(drafts[0].kind, 'explicit');
  assert.equal(drafts[0].confidence, 'high');
  assert.equal(drafts[0].flags.markedDecision, true);
  assert.equal(drafts[1].kind, 'unresolved');
});

test('statements under a Decisions heading count until the section ends', () => {
  const { drafts } = extractFromPage(
    page([
      { id: 'h', type: 'heading', headingLevel: 2, text: 'Decisions' },
      { id: 'l1', type: 'list-item', text: 'Mobile ships after web this quarter' },
      { id: 'h2', type: 'heading', headingLevel: 2, text: 'Notes' },
      { id: 'l2', type: 'list-item', text: 'Mobile designs are nearly finished' },
    ]),
    'X',
  );
  assert.deepEqual(drafts.map((d) => d.evidenceExcerpt), ['Mobile ships after web this quarter']);
  assert.equal(drafts[0].confidence, 'medium');
});

test('evidence spans point at the exact passage in the source text', () => {
  const body = 'Long discussion here. We agreed to use feature flags for the rollout. Thanks all!';
  const [draft] = extractFromComment(comment(body), 'X').drafts;
  assert.equal(body.slice(draft.evidenceSpan.start, draft.evidenceSpan.end), draft.evidenceExcerpt);
  assert.equal(draft.evidenceExcerpt, 'We agreed to use feature flags for the rollout.');
});

test('ids are stable across runs and differ between passages', () => {
  const a = extractFromComment(comment('We decided to use Redis. We decided to use Kafka.'), 'X').drafts;
  const b = extractFromComment(comment('We decided to use Redis. We decided to use Kafka.'), 'X').drafts;
  assert.deepEqual(a.map((d) => d.id), b.map((d) => d.id));
  assert.notEqual(a[0].id, a[1].id);
});

test('authoritative pages are noted as decision records', () => {
  const { drafts } = extractFromPage(page([{ id: 'p', type: 'paragraph', text: 'We decided to use gRPC.' }], { title: 'ADR-12: service transport' }), 'X');
  assert.equal(drafts[0].flags.authoritativeSource, true);
});

test('cleanDecisionText removes leading labels', () => {
  assert.equal(cleanDecisionText('Decided in standup: we will cap retries at 3.'), 'We will cap retries at 3.');
  assert.equal(cleanDecisionText('Decision - use OAuth.'), 'Decision - use OAuth.');
  assert.equal(cleanDecisionText('Decision: use OAuth.'), 'Use OAuth.');
});

test('extractChange finds replaced and removed terms', () => {
  assert.deepEqual(extractChange('Use Stripe Payment Element instead of the legacy card form for checkout.'), {
    from: 'legacy card form',
    to: 'Stripe Payment Element',
  });
  assert.deepEqual(extractChange('Replace Jenkins with GitHub Actions.'), { from: 'Jenkins', to: 'GitHub Actions' });
  assert.deepEqual(extractChange('Move the confirmation email from SendGrid to Postmark.'), { from: 'SendGrid', to: 'Postmark' });
  assert.deepEqual(extractChange('Guest checkout is out of scope for v1.'), { removed: 'Guest checkout' });
  assert.deepEqual(extractChange('We agreed that bulk export is deferred.'), { removed: 'bulk export' });
  assert.deepEqual(extractChange('We will no longer support IE11.'), { removed: 'IE11' });
  assert.equal(extractChange('We decided to hire two engineers.'), undefined);
});
