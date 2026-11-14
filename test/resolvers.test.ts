/**
 * Resolver and Rovo action tests against mocked Jira, Confluence, Teamwork Graph, storage and
 * Forge LLM responses (see test/mocks). Run with `npm test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kvs, kvsMemory } from './mocks/kvs.mjs';
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
const COMMENT_DECISION = 'Decided in standup: email sends use the shared launch plan instead of separate channel plans.';
/** Sharing checks on Jira sources: security levels and comment visibility. */
const restricted = { issueSecurity: false, commentVisibility: false, cannotComment: false };

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
    comment: { comments: issue.key === 'MC-9' ? [{
      id: '9001', author: { displayName: 'Priya' }, created: '2026-11-12T09:00:00.000+0000',
      body: { type: 'doc', content: [P(COMMENT_DECISION)] }
    }] : [] }
  }
}));

const comments: Array<{ issueKey: string; id: string; body: any; properties: any[] }> = [];
g.__jira = (path: string, json: any, options: any) => {
  if (path.startsWith('/rest/api/3/mypermissions')) {
    return json({ permissions: { ADD_COMMENTS: { havePermission: !restricted.cannotComment } } });
  }
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
  const singleComment = /\/rest\/api\/3\/issue\/([^/?]+)\/comment\/(\d+)$/.exec(path);
  if (singleComment) {
    return json({ id: singleComment[2], ...(restricted.commentVisibility ? { visibility: { type: 'role', value: 'Developers' } } : {}) });
  }
  const one = /\/rest\/api\/3\/issue\/([^?/]+)\?/.exec(path);
  if (one) {
    const found = rawIssues.find((r) => r.key === decodeURIComponent(one[1]));
    return json(found && restricted.issueSecurity ? { ...found, fields: { ...found.fields, security: { id: '1', name: 'Staff' } } } : found);
  }
  return json({ issues: rawIssues });
};

/**
 * A model reply naming sentences by the numbers the AI pass showed. Each `quote` is looked up in
 * the prompt; one the prompt does not number gets a number that does not exist.
 */
const aiReply = (findings: Array<{ quote: string; kind: string }>) => async (req: any) => {
  const numbered = new Map<string, string>();
  for (const line of String(req?.messages?.[1]?.content ?? '').split('\n')) {
    const m = /^(\d+\.\d+) (.*)$/.exec(line);
    if (m) numbered.set(m[2], m[1]);
  }
  const reply = findings.map(({ quote, kind }) => ({ id: numbered.get(quote) ?? '99.99', kind }));
  return { choices: [{ message: { role: 'assistant', content: '```json\n' + JSON.stringify({ findings: reply }) + '\n```' } }] };
};

const { handler } = await import('../src/resolvers/index.js');
const actions = await import('../src/rovo/actions.js');
const ctx = { accountId: 'acc-1', siteUrl: SITE };

const { runAiJob } = await import('../src/resolvers/ai.js');
/** Starts the AI pass, runs the queued job as Forge would, then reads the result as the page does. */
async function runAiPass(projectKey: string) {
  const started = await handler.getAiFindings({ payload: { projectKey }, context: ctx });
  if (!started.ok || !started.pending) return started;
  const waiting = await handler.getAiJob({ payload: { projectKey }, context: ctx });
  assert.equal(waiting.pending, true, 'the page sees the job running');
  while (g.__queued?.length) await runAiJob(g.__queued.shift());
  return handler.getAiJob({ payload: { projectKey }, context: ctx });
}

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

test('sample: the note preview reads only bundled data and never writes, posts or saves a review', async () => {
  const sample = await handler.getSampleRadar({});
  const fromPage = sample.candidates.find((c: any) => c.source.type === 'confluence_page' && c.affectedIssues.length > 0);
  const fromComment = sample.candidates.find((c: any) => c.source.type === 'jira_comment' && c.affectedIssues.length > 0);
  assert.ok(fromPage && fromComment);
  const memoryBefore = JSON.stringify([...memory.entries()]);
  const kvsBefore = JSON.stringify([...kvsMemory.entries()]);
  const originalJira = g.__jira;
  const originalConfluence = g.__confluence;
  const touched: string[] = [];
  g.__jira = (path: string, json: any, options: any) => { touched.push(path); return originalJira(path, json, options); };
  g.__confluence = (path: string, json: any) => { touched.push(path); return originalConfluence(path, json); };
  try {
    const generic = await handler.previewSampleNote({ payload: { candidateId: fromPage.id, issueKey: fromPage.affectedIssues[0].issueKey } });
    assert.equal(generic.ok, true);
    assert.equal(generic.sample, true);
    assert.equal(generic.mode, 'generic');
    assert.ok(!generic.text.includes(fromPage.evidence.quote));
    assert.match(generic.explanation, /^Sample only/);
    const quoted = await handler.previewSampleNote({ payload: { candidateId: fromComment.id, issueKey: fromComment.affectedIssues[0].issueKey, note: 'Cap retries at 3.' } });
    assert.equal(quoted.mode, 'quoted');
    assert.ok(quoted.text.includes('Cap retries at 3.') && quoted.text.includes(fromComment.evidence.quote));
    assert.equal((await handler.previewSampleNote({ payload: { candidateId: fromPage.id, issueKey: 'PAY-999' } })).ok, false);
  } finally {
    g.__jira = originalJira;
    g.__confluence = originalConfluence;
  }
  assert.deepEqual(touched, [], 'no Jira or Confluence request');
  assert.equal(JSON.stringify([...memory.entries()]), memoryBefore, 'no storage write');
  assert.equal(JSON.stringify([...kvsMemory.entries()]), kvsBefore, 'no KVS write');
});

let aiFinding: any;

test('AI findings are verified, saved, and come back on later scans and in the issue panel', async () => {
  g.__chat = aiReply([
    { quote: INDIRECT, kind: 'decision' },
    { quote: 'The team will send email on Tuesdays only.', kind: 'decision' }
  ]);
  const ai = await runAiPass('MC');
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
    assert.ok(req.messages[1].content.includes(`(already found) ${INDIRECT}`), 'and are not numbered, so they cannot be returned again');
    return aiReply([{ quote: INDIRECT, kind: 'decision' }])(req);
  };
  const again = await runAiPass('MC');
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

/** Finds a finding in a fresh project scan, and the payload for a note about it. */
async function findingFor(contains: string) {
  const scan = await handler.getProjectRadar({ payload: { projectKey: 'MC' }, context: ctx });
  const candidate = scan.candidates.find((c: any) => c.summary.includes(contains));
  assert.ok(candidate, contains);
  return candidate;
}

/** The exact comment preview, and the payload that posts it. */
async function previewed(payload: Record<string, unknown>) {
  const preview = await handler.previewDecisionNote({ payload, context: ctx });
  assert.equal(preview.ok, true, preview.error);
  return { preview, payload: { ...payload, digest: preview.digest } };
}

const COMMENT_SUMMARY = 'Email sends use the shared launch plan';
const textOf = (body: any): string => JSON.stringify(body);

test('AI note drafts keep a description change only when it quotes the issue exactly, and only for a quotable source', async () => {
  const fromComment = await findingFor(COMMENT_SUMMARY);
  clearCooldowns();
  g.__chat = async () => ({ choices: [{ message: { content: JSON.stringify({
    note: 'The team agreed on one shared launch plan. This issue still plans email separately.',
    outdated: 'the email campaign keeps separate channel plans',
    replacement: 'the email campaign follows the shared launch plan'
  }) } }] });
  const drafted = await handler.draftDecisionNote({ payload: { projectKey: 'MC', candidateId: fromComment.id, issueKey: 'MC-9' }, context: ctx });
  assert.equal(drafted.ok, true, drafted.error);
  assert.ok(drafted.note.includes('Suggested change to the description: replace "the email campaign keeps separate channel plans"'));

  clearCooldowns();
  g.__chat = async () => ({ choices: [{ message: { content: JSON.stringify({
    note: 'A shared plan was agreed.', outdated: 'email runs on Mondays', replacement: 'email runs on Tuesdays'
  }) } }] });
  const invented = await handler.draftDecisionNote({ payload: { projectKey: 'MC', candidateId: fromComment.id, issueKey: 'MC-9' }, context: ctx });
  assert.equal(invented.ok, true);
  assert.equal(invented.suggestion, null);
  assert.ok(!invented.note.includes('Suggested change'));

  // A Confluence source cannot be quoted, so there is nothing for the AI to draft.
  const fromPage = await findingFor('shared launch plan instead of separate channel plans for the MC');
  const calls = g.__llmCalls.length;
  const refused = await handler.draftDecisionNote({ payload: { projectKey: 'MC', candidateId: fromPage.id, issueKey: 'MC-9' }, context: ctx });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /cannot be quoted/);
  assert.equal(g.__llmCalls.length, calls, 'no model call');
});

test('a Confluence source gets the generic follow-up: no quote, title, link or free text, on the exact previewed comment', async () => {
  const docs = await findingFor('Product documentation');
  const base = { projectKey: 'MC', candidateId: docs.id, issueKey: 'MC-8', note: `Check scope. ${docs.evidence.quote} See MC launch sync: decisions.` };
  const before = comments.length;
  assert.equal((await handler.applyDecisionNote({ payload: base, context: ctx })).ok, false, 'needs a relevant review');
  await handler.reviewDecision({ payload: { projectKey: 'MC', candidateId: docs.id, choice: 'relevant' }, context: ctx });
  assert.equal((await handler.applyDecisionNote({ payload: { ...base, issueKey: 'MC-61' }, context: ctx })).ok, false);

  const { preview, payload } = await previewed(base);
  assert.equal(preview.mode, 'generic');
  assert.match(preview.explanation, /Confluence page/);
  for (const leaked of [docs.evidence.quote, 'MC launch sync', '/wiki/', 'Check scope']) {
    assert.ok(!preview.text.includes(leaked), `preview must not contain ${leaked}`);
  }
  const stale = await handler.applyDecisionNote({ payload: { ...payload, digest: 'not-the-preview' }, context: ctx });
  assert.equal(stale.ok, false);
  assert.match(stale.error, /changed since you previewed/);
  assert.equal(comments.length, before);

  const posted = await handler.applyDecisionNote({ payload, context: ctx });
  assert.equal(posted.ok, true, posted.error);
  const comment = comments.at(-1)!;
  assert.equal(comments.length, before + 1);
  assert.match(comment.body.content[0].content[1].text, /reviewed by a teammate/);
  for (const leaked of [docs.evidence.quote, 'MC launch sync', '/wiki/', 'Check scope', 'Product documentation']) {
    assert.ok(!textOf(comment.body).includes(leaked), `posted comment must not contain ${leaked}`);
  }
  assert.ok(textOf(comment.body).includes('Its source may not be visible to everyone'));
});

test('a same-project Jira comment can be quoted, with the person\'s note, unless the source is restricted', async () => {
  const fromComment = await findingFor(COMMENT_SUMMARY);
  await handler.reviewDecision({ payload: { projectKey: 'MC', candidateId: fromComment.id, choice: 'relevant', issueKey: 'MC-9' }, context: ctx });
  const base = { projectKey: 'MC', candidateId: fromComment.id, issueKey: 'MC-9', note: 'Please follow the shared plan for email.' };

  for (const flag of ['issueSecurity', 'commentVisibility'] as const) {
    restricted[flag] = true;
    try {
      const { preview } = await previewed(base);
      assert.equal(preview.mode, 'generic', `${flag} prevents quoting`);
      assert.ok(!preview.text.includes(COMMENT_DECISION));
    } finally {
      restricted[flag] = false;
    }
  }

  const { preview, payload } = await previewed(base);
  assert.equal(preview.mode, 'quoted');
  assert.ok(preview.text.includes('Please follow the shared plan for email.'));
  assert.ok(preview.text.includes(COMMENT_DECISION));
  // The source became restricted between preview and posting: nothing is posted.
  restricted.commentVisibility = true;
  const before = comments.length;
  try {
    const refused = await handler.applyDecisionNote({ payload, context: ctx });
    assert.equal(refused.ok, false);
    assert.equal(refused.preview.mode, 'generic');
    assert.equal(comments.length, before);
  } finally {
    restricted.commentVisibility = false;
  }
  const posted = await handler.applyDecisionNote({ payload, context: ctx });
  assert.equal(posted.ok, true, posted.error);
  const body = textOf(comments.at(-1)!.body);
  assert.ok(body.includes('Please follow the shared plan for email.'));
  assert.ok(body.includes(COMMENT_DECISION));
  assert.ok(body.includes('focusedCommentId=9001'));
});


test('reviewing needs permission to comment in the project, and records who reviewed only as a hash', async () => {
  const radar = await handler.getProjectRadar({ payload: { projectKey: 'MC' }, context: ctx });
  const finding = radar.candidates[0];
  const payload = { projectKey: 'MC', candidateId: finding.id, choice: 'dismissed' };
  const key = `review:MC:${finding.id}`;
  const before = memory.get(key);
  restricted.cannotComment = true;
  try {
    const refused = await handler.reviewDecision({ payload, context: ctx });
    assert.equal(refused.ok, false);
    assert.match(refused.error, /permission to add comments/);
    assert.deepEqual(memory.get(key), before);
    const cleared = await handler.clearDecisionReview({ payload, context: ctx });
    assert.equal(cleared.ok, false);
    assert.deepEqual(memory.get(key), before);
  } finally {
    restricted.cannotComment = false;
  }
  const saved = await handler.reviewDecision({ payload, context: ctx });
  assert.equal(saved.ok, true, saved.error);
  assert.equal(saved.review.reviewedBy, 'you');
  assert.equal(saved.review.reviewer, undefined);
  const stored = memory.get(key);
  assert.match(stored.reviewer, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(stored).includes(ctx.accountId));
  const mine = await handler.getProjectRadar({ payload: { projectKey: 'MC' }, context: ctx });
  assert.equal(mine.candidates.find((c: any) => c.id === finding.id).review.reviewedBy, 'you');
  const theirs = await handler.getProjectRadar({ payload: { projectKey: 'MC' }, context: { ...ctx, accountId: 'acc-2' } });
  const seen = theirs.candidates.find((c: any) => c.id === finding.id).review;
  assert.equal(seen.reviewedBy, 'teammate');
  assert.equal(seen.reviewer, undefined);
  if (before === undefined) memory.delete(key); else memory.set(key, before);
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
  const launchPlan = found.findings.find((f: any) => f.statement.includes('shared launch plan'));
  const email = launchPlan?.affectedIssues.find((issue: any) => issue.issueKey === 'MC-9');
  assert.equal(email?.wordingStatus, 'outdated');
});

async function prepareFromRovo(issueKey: string, contains: string, note?: string) {
  const found = await actions.findIssueDecisions(rovo({ issueKey }));
  const finding = found.findings.find((f: any) => f.statement.includes(contains));
  assert.ok(finding);
  return actions.prepareDecisionNote(rovo({ issueKey, findingId: finding.findingId, ...(note ? { note } : {}) }));
}

const loadDraft = (issueKey: string, context = ctx) => handler.getRovoDraft({ payload: { issueKey }, context });
const postDraft = (issueKey: string, draft: { id: string; digest: string }, context = ctx) =>
  handler.postRovoDraft({ payload: { issueKey, draftId: draft.id, digest: draft.digest }, context });

test('Rovo prepares a private draft and Jira posts the exact preview only for its owner', async () => {
  const issueKey = 'MC-9';
  const note = 'Follow the shared campaign plan.';
  // The shared-plan decision is on a Confluence page: the draft becomes the generic follow-up.
  const prepared = await prepareFromRovo(issueKey, 'shared launch plan instead of separate channel plans for the MC', note);
  assert.equal(prepared.ok, true);
  assert.equal(prepared.issueLink, `${SITE}/browse/${issueKey}`);
  assert.match(prepared.nextStep, /does not quote it, name it or link to it/);
  assert.equal('postDecisionNote' in actions, false, 'Rovo cannot invoke the Jira write');
  const before = comments.filter((comment) => comment.issueKey === issueKey).length;

  const { draft } = await loadDraft(issueKey);
  assert.ok(draft);
  assert.equal(draft.mode, 'generic');
  assert.ok(!draft.text.includes(note), 'the agent\'s note is not carried into a generic follow-up');
  assert.ok(!draft.text.includes('/wiki/'));
  const stranger = { ...ctx, accountId: 'acc-2' };
  assert.equal((await loadDraft(issueKey, stranger)).draft, null);
  assert.equal((await postDraft(issueKey, draft, stranger)).ok, false);
  assert.equal((await postDraft('MC-8', draft)).ok, false);
  assert.equal((await postDraft(issueKey, { ...draft, digest: 'other' })).ok, false, 'only the previewed comment can be posted');

  const posted = await postDraft(issueKey, draft);
  assert.equal(posted.ok, true, posted.error);
  assert.ok(posted.note.commentId);
  const comment = comments.at(-1)!;
  assert.match(comment.body.content[0].content[1].text, /approved in the Jira issue panel/);
  assert.ok(!textOf(comment.body).includes(note));
  assert.ok(!textOf(comment.body).includes('MC launch sync'));
  assert.equal(memory.get(`review:MC:${posted.candidateId}`).status, 'relevant');
  assert.equal((await postDraft(issueKey, draft)).ok, false);
  assert.equal(comments.filter((entry) => entry.issueKey === issueKey).length, before + 1);
});

test('Rovo: a quotable Jira source posts the agent\'s note and quote after confirmation', async () => {
  const issueKey = 'MC-9';
  const note = 'Email should follow the shared launch plan.';
  // An earlier test posted this finding's manual note; start from a clean receipt.
  for (const key of [...memory.keys()]) if (key.startsWith('note:MC:') && key.endsWith(':MC-9')) memory.delete(key);
  const prepared = await prepareFromRovo(issueKey, COMMENT_SUMMARY, note);
  assert.equal(prepared.ok, true, prepared.error);
  const { draft } = await loadDraft(issueKey);
  assert.equal(draft.mode, 'quoted');
  assert.ok(draft.text.includes(note));
  assert.ok(draft.text.includes(COMMENT_DECISION));
  const posted = await postDraft(issueKey, draft);
  assert.equal(posted.ok, true, posted.error);
  const body = textOf(comments.at(-1)!.body);
  assert.ok(body.includes(note) && body.includes(COMMENT_DECISION));
});

test('an old preview cannot post a replaced or expired draft', async () => {
  const issueKey = 'MC-1';
  assert.equal((await prepareFromRovo(issueKey, 'shared launch plan', 'First draft.')).ok, true);
  const first = (await loadDraft(issueKey)).draft;
  assert.equal((await prepareFromRovo(issueKey, 'shared launch plan', 'Second draft.')).ok, true);
  const second = (await loadDraft(issueKey)).draft;
  assert.equal((await postDraft(issueKey, first)).ok, false);
  const key = [...kvsMemory.keys()].find((key) => key.startsWith('rovo-draft:') && key.endsWith(`:${issueKey}`))!;
  kvsMemory.get(key).expiresAt = Date.now() - 1;
  assert.equal((await loadDraft(issueKey)).ok, false);
  assert.equal((await postDraft(issueKey, second)).ok, false);
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
    const result = await postDraft(issueKey, draft);
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
    const result = await postDraft(issue.key, draft);
    assert.equal(result.ok, false);
    assert.match(result.error, /changed after the draft/);
  } finally {
    issue.fields.updated = previous;
  }
  const found = await actions.findIssueDecisions(rovo({ issueKey: issue.key }));
  const shared = found.findings.find((f: any) => f.statement.includes('shared launch plan'));
  await handler.reviewDecision({ payload: { projectKey: 'MC', candidateId: shared.findingId, choice: 'dismissed' }, context: ctx });
  assert.equal((await postDraft(issue.key, draft)).ok, false);
  assert.equal(comments.length, count);
});

test('simultaneous Jira and Rovo confirmations can create only one comment', async () => {
  const issueKey = 'MC-1';
  const found = await actions.findIssueDecisions(rovo({ issueKey }));
  const shared = found.findings.find((f: any) => f.statement.includes('shared launch plan'));
  await handler.reviewDecision({ payload: { projectKey: 'MC', candidateId: shared.findingId, choice: 'relevant' }, context: ctx });
  assert.equal((await prepareFromRovo(issueKey, 'shared launch plan', 'One note.')).ok, true);
  const { draft } = await loadDraft(issueKey);
  const { payload } = await previewed({ projectKey: 'MC', candidateId: shared.findingId, issueKey, note: 'One note.' });
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
  const first = postDraft(issueKey, draft);
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
  const { payload } = await previewed({ projectKey: 'MC', candidateId: shared.findingId, issueKey, note: 'Keep the shared plan.' });
  const receiptKey = `note:MC:${shared.findingId}:${issueKey}`;
  const set = kvs.set;
  try {
    kvs.set = async (key: string, value: any, options?: any) => {
      if (key === receiptKey) throw new Error('Receipt write failed');
      return set(key, value, options);
    };
    const first = await handler.applyDecisionNote({ payload, context: ctx });
    assert.equal(first.ok, true);
    assert.ok(first.warning);
  } finally {
    kvs.set = set;
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
  const { payload } = await previewed({ projectKey: 'MC', candidateId: shared.findingId, issueKey, note: 'Use the shared plan.' });
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

test('Rovo: the AI action starts the background AI pass and respects the cooldown', async () => {
  clearCooldowns();
  g.__chat = aiReply([]);
  const first = await actions.findMoreDecisionsWithAi(rovo({ projectKey: 'MC' }));
  assert.equal(first.ok, true);
  assert.equal(first.started, true);
  assert.match(first.message, /running in the background/);
  while (g.__queued?.length) await runAiJob(g.__queued.shift());
  const second = await actions.findMoreDecisionsWithAi(rovo({ projectKey: 'MC' }));
  assert.equal(second.ok, false);
  assert.match(second.error, /moments ago/);
});
