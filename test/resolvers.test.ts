/**
 * Resolver and Rovo action tests against mocked Jira, Confluence, Teamwork Graph, storage and
 * Forge LLM responses (see test/mocks). Run with `npm test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mc9Description, mcIssues } from '../src/domain/fixtures/mcDemoInput.ts';

const SITE = 'https://one-atlas-pxox.atlassian.net';
const g = globalThis as any;
const memory: Map<string, any> = g.__memory ?? (await import('./mocks/api.mjs')).memory;

const t = (text: string) => ({ type: 'text', text });
const P = (line: string) => (line.startsWith('## ')
  ? { type: 'heading', attrs: { level: 2 }, content: [t(line.slice(3))] }
  : { type: 'paragraph', content: [t(line)] });

const pageText = [
  'Launch sync for the MC campaign, 4 November. Attendees: Priya, Marcus, Lena.',
  '## Decisions',
  'Decision: We agreed to use one shared launch plan instead of separate channel plans for the MC website, email, and social campaign. Related Jira issues: MC-1, MC-5, MC-9, MC-10.',
  'Decision: Product documentation is out of scope for launch week. Related Jira issues: MC-8.',
  '## Open questions',
  'Open question: Do we need a legal review of the email copy before launch?',
  '## Notes',
  'Lena shared last quarter’s open rates. After the review, the team is going ahead with Tuesday-only sends for the email campaign.'
];
const INDIRECT = 'After the review, the team is going ahead with Tuesday-only sends for the email campaign.';

g.__confluence = (_path: string, json: any) => json({
  results: [{
    id: '777', title: 'MC launch sync: decisions', version: { when: '2026-11-12T10:00:00Z' },
    _links: { base: SITE, webui: '/spaces/MAR/pages/777' },
    body: { atlas_doc_format: { value: JSON.stringify({ type: 'doc', content: pageText.map(P) }) } }
  }]
});

const rawIssues = mcIssues.map((issue, n) => ({
  id: String(10000 + n),
  key: issue.key,
  fields: {
    summary: issue.title, status: { name: issue.status }, labels: issue.labels, updated: issue.updatedAt,
    project: { id: '10001', key: 'MC' },
    description: issue.key === 'MC-9' ? { type: 'doc', content: mc9Description.split('\n').map(P) } : null,
    comment: { comments: [] }
  }
}));

const comments: Array<{ issueKey: string; body: any }> = [];
g.__jira = (path: string, json: any, options: any) => {
  if (/\/project\/MC$/.test(path)) return json({ key: 'MC' });
  const post = /\/rest\/api\/3\/issue\/([^/]+)\/comment$/.exec(path);
  if (post && options?.method === 'POST') {
    comments.push({ issueKey: decodeURIComponent(post[1]), body: JSON.parse(options.body).body });
    return json({ id: String(500 + comments.length) }, 201);
  }
  const one = /\/rest\/api\/3\/issue\/([^?/]+)\?/.exec(path);
  if (one) return json(rawIssues.find((r) => r.key === decodeURIComponent(one[1])));
  return json({ issues: rawIssues });
};

const aiReply = (findings: unknown[]) => async () => ({
  choices: [{ message: { role: 'assistant', content: '```json\n' + JSON.stringify({ findings }) + '\n```' } }]
});

const { handler } = await import('../src/resolvers/index.js');
const actions = await import('../src/rovo/actions.js');
const ctx = { accountId: 'acc-1', siteUrl: SITE, cloudId: 'cloud-1' };
const rovo = (inputs: Record<string, unknown>, accountId = 'acc-1') => ({
  ...inputs,
  context: { cloudId: 'cloud-1', accountId, jira: { url: `${SITE}/browse/MC-9`, issueKey: 'MC-9', projectKey: 'MC' } }
});
const clearCooldowns = () => { for (const key of [...memory.keys()]) if (key.startsWith('ai-last:')) memory.delete(key); };

test('sample scan shows a Teamwork Graph finding and context', async () => {
  const sample = await handler.getSampleRadar({});
  assert.equal(sample.graph.used, true);
  assert.deepEqual(sample.graph.teams, ['Payments']);
  const viaGraph = sample.candidates.filter((c: any) => c.source.via?.startsWith('Teamwork Graph'));
  assert.equal(viaGraph.length, 1);
  assert.equal(viaGraph[0].affectedIssues[0].issueKey, 'PAY-108');
  assert.ok(viaGraph[0].affectedIssues[0].reasons.some((r: string) => r.includes('international orders')));
  assert.ok(sample.pages.some((p: any) => p.via));
  assert.equal(sample.candidates.filter((c: any) => c.kind === 'decision').length, 5);
});

let aiFinding: any;

test('AI findings are verified, saved, and come back on later scans and in the issue panel', async () => {
  g.__chat = aiReply([
    { sourceId: 'page-777', quote: INDIRECT, kind: 'decision', reason: 'States what the team is going ahead with.' },
    { sourceId: 'page-777', quote: 'The team will send email on Tuesdays only.', kind: 'decision' }
  ]);
  const ai = await handler.getAiFindings({ payload: { projectKey: 'MC' }, context: ctx });
  assert.equal(ai.ok, true);
  assert.equal(ai.candidates.length, 1);
  assert.equal(ai.newCount, 1);
  assert.equal(ai.rejected, 1);
  aiFinding = ai.candidates[0];
  assert.equal(aiFinding.ai, true);
  assert.equal(memory.get('ai-proposals:MC').proposals.length, 1);

  const llmCallsBefore = g.__llmCalls.length;
  const scan = await handler.getProjectRadar({ payload: { projectKey: 'MC' }, context: ctx });
  assert.equal(g.__llmCalls.length, llmCallsBefore, 'a normal scan never calls the model');
  assert.equal(scan.aiCandidates.length, 1);
  assert.equal(scan.aiCandidates[0].id, aiFinding.id);
  assert.ok(scan.aiSavedAt);

  const panel = await handler.getIssueDecisionContext({ payload: { issueKey: 'MC-9' }, context: ctx });
  assert.ok(panel.candidates.some((c: any) => c.id === aiFinding.id && c.ai));

  // A second run asks the model only for what is new, and does not save duplicates.
  clearCooldowns();
  g.__chat = async (req: any) => {
    assert.ok(req.messages[1].content.includes('Tuesday-only sends'), 'saved AI findings are listed as already found');
    return aiReply([{ sourceId: 'page-777', quote: INDIRECT, kind: 'decision' }])();
  };
  const again = await handler.getAiFindings({ payload: { projectKey: 'MC' }, context: ctx });
  assert.equal(again.newCount, 0);
  assert.equal(again.candidates.length, 1);
  assert.equal(memory.get('ai-proposals:MC').proposals.length, 1);
});

test('a saved AI finding disappears once its quote is no longer in the source', async () => {
  const original = g.__confluence;
  g.__confluence = (_p: string, json: any) => json({
    results: [{
      id: '777', title: 'MC launch sync: decisions', version: { when: '2026-11-13T10:00:00Z' },
      _links: { base: SITE, webui: '/spaces/MAR/pages/777' },
      body: { atlas_doc_format: { value: JSON.stringify({ type: 'doc', content: pageText.slice(0, -1).map(P) }) } }
    }]
  });
  const scan = await handler.getProjectRadar({ payload: { projectKey: 'MC' }, context: ctx });
  assert.equal(scan.aiCandidates.length, 0);
  g.__confluence = original;
});

test('AI note drafts keep a description change only when it quotes the issue exactly', async () => {
  const scan = await handler.getProjectRadar({ payload: { projectKey: 'MC' }, context: ctx });
  const shared = scan.candidates.find((c: any) => c.summary.includes('shared launch plan'));
  clearCooldowns();
  g.__chat = async () => ({ choices: [{ message: { content: JSON.stringify({
    note: 'The team agreed on one shared launch plan on 4 November. This issue still plans email separately.',
    outdated: 'the email campaign keeps separate channel plans',
    replacement: 'the email campaign follows the shared launch plan'
  }) } }] });
  const drafted = await handler.draftDecisionNote({ payload: { projectKey: 'MC', candidateId: shared.id, issueKey: 'MC-9' }, context: ctx });
  assert.equal(drafted.ok, true);
  assert.ok(drafted.note.includes('Suggested change to the description: replace "the email campaign keeps separate channel plans"'));

  clearCooldowns();
  g.__chat = async () => ({ choices: [{ message: { content: JSON.stringify({
    note: 'A shared plan was agreed.', outdated: 'email runs on Mondays', replacement: 'email runs on Tuesdays'
  }) } }] });
  const invented = await handler.draftDecisionNote({ payload: { projectKey: 'MC', candidateId: shared.id, issueKey: 'MC-9' }, context: ctx });
  assert.equal(invented.ok, true);
  assert.equal(invented.suggestion, null);
  assert.ok(!invented.note.includes('Suggested change'));
});

test('the app still requires a relevant review before posting', async () => {
  const scan = await handler.getProjectRadar({ payload: { projectKey: 'MC' }, context: ctx });
  const docs = scan.candidates.find((c: any) => c.summary.includes('Product documentation'));
  const payload = { projectKey: 'MC', candidateId: docs.id, issueKey: 'MC-8', note: 'Check scope.', quote: docs.evidence.quote, sourceTitle: 'x', sourceUrl: `${SITE}/wiki/x` };
  const refused = await handler.applyDecisionNote({ payload, context: ctx });
  assert.equal(refused.ok, false);
  assert.equal(comments.length, 0);
  await handler.reviewDecision({ payload: { projectKey: 'MC', candidateId: docs.id, choice: 'relevant' }, context: ctx });
  const posted = await handler.applyDecisionNote({ payload, context: ctx });
  assert.equal(posted.ok, true);
  assert.equal(comments.length, 1);
  assert.match(comments[0].body.content[0].content[1].text, /reviewed by a teammate/);
});

test('Rovo: findings carry ids, review state and how they were found', async () => {
  const found = await actions.findIssueDecisions(rovo({ issueKey: 'MC-9' }));
  assert.equal(found.ok, true);
  assert.ok(found.findings.every((f: any) => /^dc_[a-f0-9]{16}$/.test(f.findingId)));
  assert.ok(found.findings.some((f: any) => f.foundBy === 'wording rules'));
  assert.ok(found.findings.every((f: any) => typeof f.review === 'string'));
});

test('Rovo: a note is posted only with a valid confirmation, exactly as prepared, once', async () => {
  const found = await actions.findIssueDecisions(rovo({ issueKey: 'MC-9' }));
  const shared = found.findings.find((f: any) => f.statement.includes('shared launch plan'));
  const note = 'The team agreed one shared launch plan. MC-9 still plans email on its own timeline; please align it.';

  const prepared = await actions.prepareDecisionNote(rovo({ issueKey: 'MC-9', findingId: shared.findingId, note }));
  assert.equal(prepared.ok, true);
  assert.equal(prepared.comment.note, note);
  assert.match(prepared.confirmationCode, /^DDR-[0-9A-F]{8}$/);
  assert.equal(comments.filter((c) => c.issueKey === 'MC-9').length, 0, 'preparing changes nothing');

  // Someone else cannot use the code.
  const stranger = await actions.postDecisionNote(rovo({ confirmationCode: prepared.confirmationCode }, 'acc-2'));
  assert.equal(stranger.ok, false);

  // An expired code is refused.
  const key = `pending-note:acc-1:${prepared.confirmationCode}`;
  memory.set(key, { ...memory.get(key), expiresAt: Date.now() - 1 });
  assert.equal((await actions.postDecisionNote(rovo({ confirmationCode: prepared.confirmationCode }))).ok, false);

  const fresh = await actions.prepareDecisionNote(rovo({ issueKey: 'MC-9', findingId: shared.findingId, note }));
  const posted = await actions.postDecisionNote(rovo({ confirmationCode: fresh.confirmationCode }));
  assert.equal(posted.ok, true);
  assert.match(posted.commentLink, /^https:\/\/one-atlas-pxox\.atlassian\.net\/browse\/MC-9\?focusedCommentId=\d+$/);
  const comment = comments.filter((c) => c.issueKey === 'MC-9');
  assert.equal(comment.length, 1);
  assert.match(comment[0].body.content[0].content[1].text, /confirmed by a teammate/);
  assert.equal(comment[0].body.content[1].content[0].text, note.split('\n')[0]);
  const linkMark = comment[0].body.content.at(-1).content[1].marks?.[0];
  assert.equal(linkMark?.attrs?.href, `${SITE}/wiki/spaces/MAR/pages/777`);

  // The finding is now marked relevant, the code is used up, and a second note is refused.
  assert.equal(memory.get(`review:MC:${shared.findingId}`).status, 'relevant');
  assert.equal((await actions.postDecisionNote(rovo({ confirmationCode: fresh.confirmationCode }))).ok, false);
  const again = await actions.prepareDecisionNote(rovo({ issueKey: 'MC-9', findingId: shared.findingId }));
  assert.equal(again.ok, false);
  assert.equal(comments.filter((c) => c.issueKey === 'MC-9').length, 1);
});

test('Rovo: a dismissed finding cannot be posted, even with a code prepared earlier', async () => {
  const found = await actions.findProjectDecisions(rovo({ projectKey: 'MC' }));
  const question = found.findings.find((f: any) => f.kind === 'open question');
  const decision = found.findings.find((f: any) => f.kind === 'decision' && f.review === 'not reviewed yet' && f.affectedIssues.length > 0);
  assert.ok(question && decision);
  const issueKey = decision.affectedIssues[0].issueKey;
  const prepared = await actions.prepareDecisionNote(rovo({ issueKey, findingId: decision.findingId }));
  assert.equal(prepared.ok, true);
  await handler.reviewDecision({ payload: { projectKey: 'MC', candidateId: decision.findingId, choice: 'dismissed' }, context: ctx });
  const posted = await actions.postDecisionNote(rovo({ confirmationCode: prepared.confirmationCode }));
  assert.equal(posted.ok, false);
  const refused = await actions.prepareDecisionNote(rovo({ issueKey, findingId: decision.findingId }));
  assert.equal(refused.ok, false);
});

test('Rovo: the AI action runs the AI pass and respects the cooldown', async () => {
  clearCooldowns();
  g.__chat = aiReply([]);
  const first = await actions.findMoreDecisionsWithAi(rovo({ projectKey: 'MC' }));
  assert.equal(first.ok, true);
  assert.equal(first.newAiFindings, 0);
  const second = await actions.findMoreDecisionsWithAi(rovo({ projectKey: 'MC' }));
  assert.equal(second.ok, false);
  assert.match(second.error, /moments ago/);
});
