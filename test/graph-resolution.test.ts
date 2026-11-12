/**
 * The demo story end to end (as on MC-10, with fictional fixtures): Teamwork Graph finds a
 * decision page that never mentions the project, a person edits the Jira issue, the
 * issue-update trigger marks the drift resolved, the issue panel shows it, and restoring the old
 * wording reopens the drift on the next scan.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const g = globalThis as any;
const SITE = 'https://example.atlassian.net';
const doc = (lines: string[]) => ({ type: 'doc', content: lines.map((l) => ({ type: 'paragraph', content: [{ type: 'text', text: l }] })) });
const ORIGINAL = 'Scheduling: social posts go live on the same day as the website update.';
let description = [ORIGINAL];
const issue = () => ({
  id: '10', key: 'MK-10',
  fields: {
    summary: 'Campaign - Social media posting', status: { name: 'To Do' }, labels: [], updated: '2026-11-12T09:00:00.000+0000',
    project: { id: '20000', key: 'MK' }, description: doc(description), comment: { comments: [] }
  }
});
g.__jira = (path: string, json: any) => {
  if (/\/project\/MK$/.test(path)) return json({ key: 'MK' });
  if (path.startsWith('/rest/api/3/search/jql')) return json({ issues: [issue()] });
  if (path.startsWith('/rest/api/3/issue/MK-10')) return json(issue());
  return json({}, 404);
};
const page = { id: '700', title: 'Social calendar: decisions', space: { key: 'MAR' }, version: { when: '2026-11-11T08:00:00Z' },
  _links: { base: `${SITE}/wiki`, webui: '/spaces/MAR/pages/700' },
  body: { atlas_doc_format: { value: JSON.stringify(doc(['## Decisions', '- Decision: Social posts go live the day after the website update, instead of on the same day.'])) } } };
g.__confluence = (path: string, json: any) => json({ results: path.includes('space%20in') ? [page] : [] });
g.__twg = (query: string, _v: unknown, json: any) => json({
  data: query.includes('teamsBySpace')
    ? { atlassianTeamsBySpace: { edges: [{ node: { __typename: 'AtlassianTeam', id: 'ari:team/1', displayName: 'Marketing' } }] } }
    : query.includes('spacesByTeam')
      ? { spacesByAtlassianTeam: { edges: [{ node: { __typename: 'ConfluenceSpace', id: 's', key: 'MAR', name: 'Marketing' } }] } }
      : { confluencePageLinkedConfluencePages: { edges: [] } }
});

const { handler } = await import('../src/resolvers/index.js');
const { onIssueUpdated } = await import('../src/resolvers/drift.js');
const ctx = { accountId: 'teammate', siteUrl: SITE, cloudId: 'cloud-1' };
const driftOn = (result: any) => result.candidates
  .flatMap((c: any) => [...c.affectedIssues.map((a: any) => a.drift ? { ...a.drift, via: c.source.via } : null), ...c.resolvedIssues.map((r: any) => ({ ...r, via: c.source.via }))])
  .find(Boolean);

test('Teamwork Graph decision → person edits the issue → trigger resolves → restore reopens', async () => {
  const before = await handler.getProjectRadar({ payload: { projectKey: 'MK' }, context: ctx });
  const opened = driftOn(before);
  assert.match(opened.via, /^Teamwork Graph: a Confluence space of team Marketing/);
  assert.equal(opened.status, 'open');
  assert.equal(opened.phrase, 'on the same day');
  assert.equal(before.radar.drifting, 1);

  description = ['Scheduling: social posts go live the day after the website update.'];
  assert.deepEqual(await onIssueUpdated({ issue: { key: 'MK-10', fields: { project: { key: 'MK' } } }, changelog: { items: [{ fieldId: 'description' }] } }), { checked: 1, resolved: 1 });

  const panel = await handler.getIssueDecisionContext({ payload: { issueKey: 'MK-10' }, context: ctx });
  const resolved = driftOn(panel);
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.resolvedBy, 'issue-update', 'shown as "noticed when the issue was edited"');
  assert.match(resolved.via, /^Teamwork Graph/);

  description = [ORIGINAL];
  const after = await handler.getProjectRadar({ payload: { projectKey: 'MK' }, context: ctx });
  const reopened = driftOn(after);
  assert.equal(reopened.status, 'open', 'the restored wording reopens the drift on rescan');
  assert.equal(reopened.firstSeenAt, opened.firstSeenAt);
  assert.deepEqual([after.radar.drifting, after.radar.resolved], [1, 0]);
});
