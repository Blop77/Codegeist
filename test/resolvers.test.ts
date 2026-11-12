/**
 * Resolver and Rovo action tests against mocked Jira, Confluence, Teamwork Graph, storage and
 * Forge LLM responses (see test/mocks). Run with `npm test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kvsMemory } from './mocks/kvs.mjs';
import { storage } from './mocks/api.mjs';
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

const comments: Array<{ issueKey: string; id: string; body: any; properties: any[] }> = [];
g.__jira = (path: string, json: any, options: any) => {
  if (/\/project\/MC$/.test(path)) return json({ key: 'MC' });
  const commentPath = /\/rest\/api\/3\/issue\/([^/]+)\/comment(?:\?|$)/.exec(path);
  if (commentPath) {
    const issueKey = decodeURIComponent(commentPath[1]);
    if (options?.method === 'POST') {
      const id = String(501 + comments.length);
      const { body, properties } = JSON.parse(options.body);
      comments.push({ issueKey, id, body, properties });
      return json({ id }, 201);
    }
    const listed = comments.filter((comment) => comment.issueKey === issueKey)
      .map(({ properties: _properties, ...comment }) => comment);
    return json({ comments: listed, total: listed.length });
  }
  const propertyPath = /\/rest\/api\/3\/comment\/([^/]+)\/properties\/([^/]+)$/.exec(path);
  if (propertyPath) {
    const property = comments.find((comment) => comment.id === propertyPath[1])?.properties
      .find((entry) => entry.key === propertyPath[2]);
    return property ? json(property) : json({}, 404);
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
const ctx = { accountId: 'acc-1', siteUrl: SITE };
const rovo = (inputs: Record<string, unknown>, accountId = 'acc-1') => ({
  ...inputs,
  context: { accountId, jira: { url: `${SITE}/browse/MC-9`, issueKey: 'MC-9', projectKey: 'MC' } }
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
    { sourceId: 'page-777', quote: INDIRECT, kind: 'decision', reason: 'Detail from a different source.' },
    { sourceId: 'page-777', quote: 'The team will send email on Tuesdays only.', kind: 'decision' }
  ]);
  const ai = await handler.getAiFindings({ payload: { projectKey: 'MC' }, context: ctx });
  assert.equal(ai.ok, true);
  assert.equal(ai.candidates.length, 1);
  assert.equal(ai.newCount, 1);
  assert.equal(ai.rejected, 1);
  aiFinding = ai.candidates[0];
  assert.equal(aiFinding.ai, true);
  const saved = memory.get('ai-proposals:MC');
  assert.equal(saved.proposals.length, 1);
  assert.equal(saved.proposals[0].reason, undefined, 'free-form model text must not be stored or shared');
  assert.ok(!aiFinding.confidenceReasons.some((reason: string) => reason.startsWith('AI note:')));
  saved.proposals[0].reason = 'Legacy detail from a different source.';

  const llmCallsBefore = g.__llmCalls.length;
  const scan = await handler.getProjectRadar({ payload: { projectKey: 'MC' }, context: ctx });
  assert.equal(g.__llmCalls.length, llmCallsBefore, 'a normal scan never calls the model');
  assert.equal(scan.aiCandidates.length, 1);
  assert.equal(scan.aiCandidates[0].id, aiFinding.id);
  assert.ok(!scan.aiCandidates[0].confidenceReasons.some((reason: string) => reason.startsWith('AI note:')));
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
  const payload = { projectKey: 'MC', candidateId: docs.id, issueKey: 'MC-8', note: 'Check scope.', quote: docs.evidence.quote, sourceTitle: 'Client-supplied title', sourceUrl: `${SITE}/wiki/x` };
  const refused = await handler.applyDecisionNote({ payload, context: ctx });
  assert.equal(refused.ok, false);
  assert.equal(comments.length, 0);
  await handler.reviewDecision({ payload: { projectKey: 'MC', candidateId: docs.id, choice: 'relevant' }, context: ctx });
  const wrongIssue = await handler.applyDecisionNote({ payload: { ...payload, issueKey: 'MC-61' }, context: ctx });
  assert.equal(wrongIssue.ok, false);
  const oldQuote = await handler.applyDecisionNote({ payload: { ...payload, quote: 'Older wording.' }, context: ctx });
  assert.equal(oldQuote.ok, false);
  assert.equal(comments.length, 0);

  const posted = await handler.applyDecisionNote({ payload, context: ctx });
  assert.equal(posted.ok, true);
  assert.equal(comments.length, 1);
  assert.match(comments[0].body.content[0].content[1].text, /reviewed by a teammate/);
  const source = comments[0].body.content.at(-1).content[1];
  assert.equal(source.text, 'MC launch sync: decisions');
  assert.equal(source.marks[0].attrs.href, `${SITE}/wiki/spaces/MAR/pages/777`);
});

test('reviewing requires a currently visible finding', async () => {
  const payload = { projectKey: 'MC', candidateId: 'dc_0000000000000000', choice: 'relevant' };
  const refused = await handler.reviewDecision({ payload, context: ctx });
  assert.equal(refused.ok, false);
  assert.equal(memory.has(`review:MC:${payload.candidateId}`), false);
});

test('Rovo: findings carry ids, review state and how they were found', async () => {
  const found = await actions.findIssueDecisions(rovo({ issueKey: 'MC-9' }));
  assert.equal(found.ok, true);
  assert.ok(found.findings.every((f: any) => /^dc_[a-f0-9]{16}$/.test(f.findingId)));
  assert.ok(found.findings.some((f: any) => f.foundBy === 'wording rules'));
  assert.ok(found.findings.every((f: any) => typeof f.review === 'string'));
});

async function prepareFromRovo(issueKey: string, contains: string, note?: string) {
  const found = await actions.findIssueDecisions(rovo({ issueKey }));
  const finding = found.findings.find((f: any) => f.statement.includes(contains));
  assert.ok(finding);
  return actions.prepareDecisionNote(rovo({ issueKey, findingId: finding.findingId, ...(note ? { note } : {}) }));
}

const loadDraft = (issueKey: string, context = ctx) => handler.getRovoDraft({ payload: { issueKey }, context });
const postDraft = (issueKey: string, draftId: string, context = ctx) =>
  handler.postRovoDraft({ payload: { issueKey, draftId }, context });

test('Rovo prepares a private draft and Jira posts the exact preview only for its owner', async () => {
  const issueKey = 'MC-9';
  const note = 'Follow the shared campaign plan.';
  const prepared = await prepareFromRovo(issueKey, 'shared launch plan', note);
  assert.equal(prepared.ok, true);
  assert.equal(prepared.issueLink, `${SITE}/browse/${issueKey}`);
  assert.equal('postDecisionNote' in actions, false, 'Rovo cannot invoke the Jira write');
  assert.equal(comments.filter((comment) => comment.issueKey === issueKey).length, 0);

  const { draft } = await loadDraft(issueKey);
  assert.ok(draft);
  assert.equal(draft.note, note);
  assert.equal(draft.sourceUrl, `${SITE}/wiki/spaces/MAR/pages/777`);
  const stranger = { ...ctx, accountId: 'acc-2' };
  assert.equal((await loadDraft(issueKey, stranger)).draft, null);
  assert.equal((await postDraft(issueKey, draft.id, stranger)).ok, false);
  assert.equal((await postDraft('MC-8', draft.id)).ok, false);

  const posted = await postDraft(issueKey, draft.id);
  assert.equal(posted.ok, true);
  assert.ok(posted.note.commentId);
  const [comment] = comments.filter((entry) => entry.issueKey === issueKey);
  assert.match(comment.body.content[0].content[1].text, /approved in the Jira issue panel/);
  assert.equal(comment.body.content[1].content[0].text, note);
  assert.equal(comment.body.content.at(-1).content[1].marks[0].attrs.href, draft.sourceUrl);
  assert.equal(memory.get(`review:MC:${posted.candidateId}`).status, 'relevant');
  assert.equal((await postDraft(issueKey, draft.id)).ok, false);
  assert.equal(comments.filter((entry) => entry.issueKey === issueKey).length, 1);
});

test('an old preview cannot post a replaced or expired draft', async () => {
  const issueKey = 'MC-1';
  assert.equal((await prepareFromRovo(issueKey, 'shared launch plan', 'First draft.')).ok, true);
  const first = (await loadDraft(issueKey)).draft;
  assert.equal((await prepareFromRovo(issueKey, 'shared launch plan', 'Second draft.')).ok, true);
  const second = (await loadDraft(issueKey)).draft;
  assert.equal((await postDraft(issueKey, first.id)).ok, false);
  const key = [...kvsMemory.keys()].find((key) => key.startsWith('rovo-draft:') && key.endsWith(`:${issueKey}`))!;
  kvsMemory.get(key).expiresAt = Date.now() - 1;
  assert.equal((await loadDraft(issueKey)).ok, false);
  assert.equal((await postDraft(issueKey, second.id)).ok, false);
});

test('Jira refuses a draft when source access is revoked after preview', async () => {
  const issueKey = 'MC-5';
  assert.equal((await prepareFromRovo(issueKey, 'shared launch plan')).ok, true);
  const { draft } = await loadDraft(issueKey);
  const originalConfluence = g.__confluence;
  const count = comments.length;
  try {
    g.__confluence = (_path: string, json: any) => json({}, 403);
    assert.equal((await loadDraft(issueKey)).ok, false);
    const result = await postDraft(issueKey, draft.id);
    assert.equal(result.ok, false);
    assert.equal(comments.length, count);
  } finally {
    g.__confluence = originalConfluence;
  }
});

test('Jira requires a fresh Rovo preview after an issue edit or dismissal', async () => {
  const issue = rawIssues.find((r) => r.key === 'MC-10')!;
  assert.equal((await prepareFromRovo(issue.key, 'shared launch plan')).ok, true);
  const { draft } = await loadDraft(issue.key);
  const previous = issue.fields.updated;
  const count = comments.length;
  try {
    issue.fields.updated = '2026-11-14T00:00:00Z';
    const result = await postDraft(issue.key, draft.id);
    assert.equal(result.ok, false);
    assert.match(result.error, /changed after the draft/);
  } finally {
    issue.fields.updated = previous;
  }
  const found = await actions.findIssueDecisions(rovo({ issueKey: issue.key }));
  const shared = found.findings.find((f: any) => f.statement.includes('shared launch plan'));
  await handler.reviewDecision({ payload: { projectKey: 'MC', candidateId: shared.findingId, choice: 'dismissed' }, context: ctx });
  assert.equal((await postDraft(issue.key, draft.id)).ok, false);
  assert.equal(comments.length, count);
});

test('simultaneous Jira and Rovo confirmations can create only one comment', async () => {
  const issueKey = 'MC-1';
  const found = await actions.findIssueDecisions(rovo({ issueKey }));
  const shared = found.findings.find((f: any) => f.statement.includes('shared launch plan'));
  await handler.reviewDecision({ payload: { projectKey: 'MC', candidateId: shared.findingId, choice: 'relevant' }, context: ctx });
  assert.equal((await prepareFromRovo(issueKey, 'shared launch plan', 'One note.')).ok, true);
  const { draft } = await loadDraft(issueKey);
  const payload = { projectKey: 'MC', candidateId: shared.findingId, issueKey, note: 'One note.', quote: shared.quote };
  const originalJira = g.__jira;
  const firstStarted = Promise.withResolvers<void>();
  const letFirstFinish = Promise.withResolvers<void>();
  let jiraWrites = 0;
  g.__jira = async (path: string, json: any, options: any) => {
    if (options?.method === 'POST' && path.endsWith('/comment')) {
      jiraWrites++;
      if (jiraWrites === 1) {
        firstStarted.resolve();
        await letFirstFinish.promise;
      }
    }
    return originalJira(path, json, options);
  };
  const first = postDraft(issueKey, draft.id);
  try {
    await firstStarted.promise;
    const second = await handler.applyDecisionNote({ payload, context: ctx });
    assert.equal(second.ok, false, 'a request with no receipt yet does not attempt another post');
    assert.equal(jiraWrites, 1);
  } finally {
    letFirstFinish.resolve();
    g.__jira = originalJira;
    const posted = await first;
    assert.equal(posted.ok, true);
  }
  assert.equal(comments.filter((entry) => entry.issueKey === issueKey).length, 1);
});

test('a missing receipt is recovered without a second Jira comment', async () => {
  const issueKey = 'MC-5';
  const found = await actions.findIssueDecisions(rovo({ issueKey }));
  const shared = found.findings.find((f: any) => f.statement.includes('shared launch plan'));
  await handler.reviewDecision({ payload: { projectKey: 'MC', candidateId: shared.findingId, choice: 'relevant' }, context: ctx });
  const payload = { projectKey: 'MC', candidateId: shared.findingId, issueKey, note: 'Keep the shared plan.', quote: shared.quote };
  const receiptKey = `note:MC:${shared.findingId}:${issueKey}`;
  const set = storage.set;
  try {
    storage.set = async (key, value) => {
      if (key === receiptKey) throw new Error('Receipt write failed');
      return set(key, value);
    };
    const first = await handler.applyDecisionNote({ payload, context: ctx });
    assert.equal(first.ok, true);
    assert.ok(first.warning);
  } finally {
    storage.set = set;
  }
  const retry = await handler.applyDecisionNote({ payload, context: ctx });
  assert.equal(retry.ok, true);
  assert.equal(retry.alreadyApplied, true);
  assert.equal(comments.filter((entry) => entry.issueKey === issueKey).length, 1);
  assert.ok(memory.get(receiptKey)?.commentId);
});

test('an unconfirmed Jira response can be retried after a complete recovery check', async () => {
  const issueKey = 'MC-10';
  const found = await actions.findIssueDecisions(rovo({ issueKey }));
  const shared = found.findings.find((f: any) => f.statement.includes('shared launch plan'));
  await handler.reviewDecision({ payload: { projectKey: 'MC', candidateId: shared.findingId, choice: 'relevant' }, context: ctx });
  const payload = { projectKey: 'MC', candidateId: shared.findingId, issueKey, note: 'Use the shared plan.', quote: shared.quote };
  const lockKey = `posting:note:MC:${shared.findingId}:${issueKey}`;
  const originalJira = g.__jira;
  let attempts = 0;
  let complete = false;
  g.__jira = (path: string, json: any, options: any) => {
    if (options?.method === 'POST' && path.endsWith('/comment') && ++attempts === 1) return json({}, 503);
    if (path.includes('/comment?') && !complete) {
      const comments = path.includes('startAt=0') ? [
        { id: '997', created: new Date(Date.now() - 300_000).toISOString() },
        { id: '998', created: new Date().toISOString() }
      ] : [];
      return json({ comments, total: 5 });
    }
    return originalJira(path, json, options);
  };
  try {
    assert.equal((await handler.applyDecisionNote({ payload, context: ctx })).ok, false);
    assert.equal((await handler.applyDecisionNote({ payload, context: ctx })).ok, false);
    assert.equal(attempts, 1);
    kvsMemory.get(lockKey).startedAt = new Date(Date.now() - 121_000).toISOString();

    await handler.applyDecisionNote({ payload, context: ctx });
    assert.equal(kvsMemory.has(lockKey), true, 'an incomplete, out-of-order comment window cannot clear a reservation');
    complete = true;
    const recovered = await handler.applyDecisionNote({ payload, context: ctx });
    assert.match(recovered.error, /No matching app comment was found/);
    assert.equal(kvsMemory.has(lockKey), false);
    assert.equal(attempts, 1, 'recovery never posts on its own');

    assert.equal((await handler.applyDecisionNote({ payload, context: ctx })).ok, true);
    assert.equal(attempts, 2);
    assert.equal(comments.filter((entry) => entry.issueKey === issueKey).length, 1);
  } finally {
    g.__jira = originalJira;
  }
});

test('recovery cannot clear a newer posting reservation', async () => {
  const { postNote } = await import('../src/resolvers/notes.js');
  const issueKey = 'MC-61';
  const candidateId = 'dc_0000000000000001';
  const request = { projectKey: 'MC', candidateId, issueKey, note: 'Synthetic note.', quote: 'Synthetic decision.', sourceTitle: 'Fixture' };
  const lockKey = `posting:note:MC:${candidateId}:${issueKey}`;
  kvsMemory.set(lockKey, { attemptId: 'older', startedAt: new Date(Date.now() - 121_000).toISOString() });
  const originalJira = g.__jira;
  let wrote = false;
  g.__jira = (path: string, json: any, options: any) => {
    if (options?.method === 'POST') wrote = true;
    if (path.includes('/comment?')) {
      kvsMemory.set(lockKey, { attemptId: 'newer', startedAt: new Date().toISOString() });
      return json({ comments: [], total: 0 });
    }
    return originalJira(path, json, options);
  };
  try {
    assert.equal((await postNote(request)).ok, false);
    assert.equal(kvsMemory.get(lockKey).attemptId, 'newer');
    assert.equal(wrote, false);
  } finally {
    g.__jira = originalJira;
    kvsMemory.delete(lockKey);
  }
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
