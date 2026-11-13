/**
 * What a judge hits on a fresh site: the issue panel agreeing with the project scan, empty and
 * mistyped projects, rate limits, the Teamwork Graph time budget, Rovo key handling, and AI
 * replies that cannot be read. Fictional fixtures; in-memory Forge mocks (test/mocks).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const g = globalThis as any;
const SITE = 'https://example.atlassian.net';
const memory: Map<string, any> = (await import('./mocks/api.mjs')).memory;
const doc = (lines: string[]) => ({ type: 'doc', content: lines.map((l) => ({ type: 'paragraph', content: [{ type: 'text', text: l }] })) });

// Project QA: twelve issues that all mention email, so "email" alone says little about any one of them.
const qIssue = (n: number, description: string, comments: unknown[] = []) => ({
  id: String(500 + n), key: `QA-${n}`,
  fields: {
    summary: `Task ${n}`, status: { name: 'To Do' }, labels: [], updated: `2026-11-1${n % 10}T09:00:00.000+0000`,
    project: { id: '40001', key: 'QA' }, description: doc([description]), comment: { comments }
  }
});
const qIssues = [
  ...Array.from({ length: 11 }, (_, i) => qIssue(i + 1, `Email newsletter draft number ${i + 1}.`)),
  qIssue(12, 'Update the email footer.'),
  qIssue(13, 'Plan the footer review.', [{
    id: '9001', author: { displayName: 'Priya' }, created: '2026-11-10T10:00:00.000+0000',
    body: doc(['Decision: We agreed to hold the footer review on Thursdays instead of Tuesdays. Related: QA-14.'])
  }]),
  qIssue(14, 'Footer review happens on Tuesdays with the design team.')
];

const calls: string[] = [];
let projectSearchStatus = 200;
g.__jira = (path: string, json: any) => {
  calls.push(path);
  if (path.startsWith('/rest/api/3/search/jql')) {
    if (decodeURIComponent(path).includes('"EMPTY"')) return json({ issues: [] });
    if (decodeURIComponent(path).includes('"MARKETING"')) return json({ errorMessages: ['bad project'] }, 400);
    if (decodeURIComponent(path).includes('"BUSY"')) return json({}, 429);
    return json({ issues: qIssues }, projectSearchStatus);
  }
  if (/\/rest\/api\/3\/project\/QA$/.test(path)) return json({ id: '40001', key: 'QA' });
  if (/\/rest\/api\/3\/project\/EMPTY$/.test(path)) return json({ id: '40002', key: 'EMPTY' });
  if (/\/rest\/api\/3\/project\/MARKETING$/.test(path)) return json({}, 404);
  if (path.startsWith('/rest/api/3/project/search')) {
    return json({ values: decodeURIComponent(path).includes('query=MARKETING') ? [{ key: 'MC', name: 'Marketing Content' }] : [] });
  }
  const one = /\/rest\/api\/3\/issue\/([^?/]+)\?/.exec(path);
  if (one) {
    const found = qIssues.find((issue) => issue.key === decodeURIComponent(one[1]));
    return found ? json(found) : json({}, 404);
  }
  return json({}, 404);
};
g.__confluence = (path: string, json: any) => {
  calls.push(path);
  if (path.includes('space%20in') || path.includes('id%20in')) return json({ results: [] });
  return json({ results: [{
    id: '880', title: 'Messaging decisions', version: { when: '2026-11-09T09:00:00Z' },
    _links: { base: `${SITE}/wiki`, webui: '/spaces/Q/pages/880' },
    body: { atlas_doc_format: { value: JSON.stringify(doc(['## Decisions', 'Decision: We agreed to send reminders by SMS instead of email.'])) } }
  }] });
};
const graphQueries: Array<{ query: string; variables: any }> = [];
g.__twg = (query: string, variables: any, json: any) => {
  graphQueries.push({ query, variables });
  return json({ data: query.includes('teamsBySpace') ? { atlassianTeamsBySpace: { edges: [] } } : {} });
};

const { handler } = await import('../src/resolvers/index.js');
const actions = await import('../src/rovo/actions.js');
const { discoverViaGraph } = await import('../src/resolvers/graph.js');
const ctx = { accountId: 'judge-1', siteUrl: SITE, cloudId: 'cloud-1' };

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

const affectedKeys = (candidates: any[]) => candidates.flatMap((c: any) => c.affectedIssues.map((a: any) => a.issueKey));

test('the issue panel weighs words across the project, so it agrees with the project scan', async () => {
  const project = await handler.getProjectRadar({ payload: { projectKey: 'QA' }, context: ctx });
  assert.equal(project.ok, true);
  const sms = project.candidates.find((c: any) => c.summary.includes('SMS'));
  assert.ok(sms, 'the project scan finds the decision');
  assert.ok(!affectedKeys([sms]).includes('QA-12'), 'a word twelve issues share is not drift on its own');

  const panel = await handler.getIssueDecisionContext({ payload: { issueKey: 'QA-12' }, context: ctx });
  assert.equal(panel.ok, true);
  assert.deepEqual(panel.candidates.filter((c: any) => c.summary.includes('SMS')), [], 'the panel does not report what the project scan does not');
  const again = await handler.getProjectRadar({ payload: { projectKey: 'QA' }, context: ctx });
  assert.equal(again.radar.drifting, project.radar.drifting, 'opening the panel recorded no extra drift');
});

test('a decision recorded on another issue shows in the panel and is reviewed without a second project scan', async () => {
  const panel = await handler.getIssueDecisionContext({ payload: { issueKey: 'QA-14' }, context: ctx });
  const thursday = panel.candidates.find((c: any) => c.summary.includes('Thursdays'));
  assert.ok(thursday, 'found in a comment on QA-13');
  assert.deepEqual(affectedKeys([thursday]), ['QA-14'], 'narrowed to the panel’s issue');
  assert.equal(thursday.affectedIssues[0].wordingStatus, 'outdated');

  calls.length = 0;
  const review = await handler.reviewDecision({ payload: { projectKey: 'QA', candidateId: thursday.id, choice: 'relevant', issueKey: 'QA-14' }, context: ctx });
  assert.equal(review.ok, true);
  assert.equal(calls.filter((p) => p.startsWith('/rest/api/3/search/jql')).length, 1, 'one issue search, not a second full scan');
  assert.equal(calls.filter((p) => p.startsWith('/wiki/rest/api/content/search')).length, 1);
});

test('an empty project still reads its id, so Teamwork Graph is queried', async () => {
  graphQueries.length = 0;
  const result = await handler.getProjectRadar({ payload: { projectKey: 'EMPTY' }, context: ctx });
  assert.equal(result.ok, true);
  assert.equal(result.graph.status.teams, 'none');
  assert.equal(graphQueries[0]?.variables.spaceAri, 'ari:cloud:jira:cloud-1:project/40002');
  assert.doesNotMatch(String(result.graph.note), /was not queried/);
});

test('a project name instead of a key names the likely project; a rate limit says to wait', async () => {
  const unknown = await handler.getProjectRadar({ payload: { projectKey: 'MARKETING' }, context: ctx });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error, 'No Jira project with the key MARKETING is visible to you. Did you mean Marketing Content (MC)?');

  const busy = await handler.getProjectRadar({ payload: { projectKey: 'BUSY' }, context: ctx });
  assert.equal(busy.error, 'Jira is limiting requests right now. Wait a minute, then scan again.');
});

test('Teamwork Graph lookups stop at the time budget instead of running past Forge’s limit', async () => {
  graphQueries.length = 0;
  g.__twg = (query: string, variables: any, json: any) => {
    graphQueries.push({ query, variables });
    return json({ data: query.includes('teamsBySpace')
      ? { atlassianTeamsBySpace: { edges: [{ node: { __typename: 'AtlassianTeam', id: 't1', displayName: 'Ops' } }] } }
      : { spacesByAtlassianTeam: { edges: [] } } });
  };
  const { summary } = await discoverViaGraph({ projectKey: 'QA', projectId: '40001', cloudId: 'cloud-1', knownPageIds: ['880'], deadline: Date.now() - 1 });
  assert.deepEqual(summary.teams, ['Ops'], 'what was already found is kept');
  assert.equal(graphQueries.length, 1, 'no space or link lookups started after the budget');
  assert.match(summary.note, /stopped early/);
});

test('Rovo refuses an invalid key instead of scanning the page’s project, and uses the viewed issue’s project', async () => {
  calls.length = 0;
  const bad = await actions.findProjectDecisions({ projectKey: 'the marketing one', context: { cloudId: 'cloud-1', jira: { projectKey: 'QA' } } });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /is not a Jira project key/);
  assert.equal(calls.length, 0, 'nothing was scanned');

  const badIssue = await actions.findIssueDecisions({ issueKey: 'footer task', context: { jira: { issueKey: 'QA-14' } } });
  assert.match(badIssue.error, /is not a Jira issue key/);

  const fromIssue = await actions.findProjectDecisions({ context: { cloudId: 'cloud-1', jira: { issueKey: 'QA-14' } } });
  assert.equal(fromIssue.ok, true);
  assert.equal(fromIssue.projectKey, 'QA');
});

test('an AI reply that cannot be read is reported and does not use up the daily limit', async () => {
  const day = new Date().toISOString().slice(0, 10);
  memory.delete(`ai-usage:${day}`);
  g.__chat = async () => ({ choices: [{ finish_reason: 'length', message: { content: '{"findings":[{"id":"1.' } }] });
  const cut = await runAiPass('QA');
  assert.equal(cut.ok, false);
  assert.match(cut.error, /could not be read/);
  assert.equal(memory.get(`ai-usage:${day}`), 0, 'the run was given back');
  assert.equal(memory.has('ai-last:QA'), false, 'no cooldown after a failed run');

  g.__chat = async () => ({ choices: [{ message: { content: '{"findings":[]}' } }] });
  const none = await runAiPass('QA');
  assert.equal(none.ok, true);
  assert.equal(none.newCount, 0, 'an empty list is still a real answer');
  assert.equal(memory.get(`ai-usage:${day}`), 1);
});

test('the AI pass runs as a background job with the measured output cap, one job per project', async () => {
  memory.delete('ai-last:QA');
  memory.delete('ai-job:QA');
  g.__llmCalls = [];
  g.__chat = async () => ({ choices: [{ message: { content: '{"findings":[]}' } }] });
  const started = await handler.getAiFindings({ payload: { projectKey: 'QA' }, context: ctx });
  assert.deepEqual([started.ok, started.pending], [true, true]);
  assert.equal(g.__llmCalls.length, 0, 'the resolver itself never waits on the model');
  const again = await handler.getAiFindings({ payload: { projectKey: 'QA' }, context: ctx });
  assert.equal(again.pending, true, 'a second click joins the running job');
  assert.equal(g.__queued.length, 1, 'and starts no second job');
  assert.doesNotMatch(JSON.stringify(memory.get('ai-job:QA')), /Footer|footer|email/, 'the job record holds no page or issue text');

  await runAiJob(g.__queued.shift());
  assert.equal(g.__llmCalls.length, 1);
  assert.equal(g.__llmCalls[0].max_completion_tokens, 12000, 'the cap the benchmark measured');
  const done = await handler.getAiJob({ payload: { projectKey: 'QA' }, context: ctx });
  assert.deepEqual([done.ok, done.pending], [true, false]);
});

test('a job that cannot be queued is reported and given back', async () => {
  memory.delete('ai-last:QA');
  memory.delete('ai-job:QA');
  const day = new Date().toISOString().slice(0, 10);
  const before = memory.get(`ai-usage:${day}`) ?? 0;
  g.__queueFail = true;
  try {
    const started = await handler.getAiFindings({ payload: { projectKey: 'QA' }, context: ctx });
    assert.equal(started.ok, false);
    assert.match(started.error, /could not be started/);
    assert.equal(memory.get(`ai-usage:${day}`), before);
  } finally {
    g.__queueFail = false;
  }
});

test('saved note records are shown only for issues in the viewer’s own scan', async () => {
  const panel = await handler.getIssueDecisionContext({ payload: { issueKey: 'QA-14' }, context: ctx });
  const thursday = panel.candidates.find((c: any) => c.summary.includes('Thursdays'));
  // A teammate posted notes on QA-14 and on QA-99, an issue this viewer cannot see.
  memory.set(`note:QA:${thursday.id}:QA-14`, { issueKey: 'QA-14', commentId: '7001', appliedAt: '2026-11-12T10:00:00Z' });
  memory.set(`note:QA:${thursday.id}:QA-99`, { issueKey: 'QA-99', commentId: '7002', appliedAt: '2026-11-12T10:05:00Z' });

  const again = await handler.getIssueDecisionContext({ payload: { issueKey: 'QA-14' }, context: ctx });
  const seen = again.candidates.find((c: any) => c.id === thursday.id);
  assert.deepEqual(Object.keys(seen.notes), ['QA-14']);
  const rovo = await actions.findIssueDecisions({ issueKey: 'QA-14', context: { cloudId: 'cloud-1' } });
  assert.doesNotMatch(JSON.stringify(rovo), /QA-99|7002/, 'Rovo results do not name the hidden issue or its comment');
});
