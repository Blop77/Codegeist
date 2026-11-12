/**
 * Teamwork Graph discovery: what each stage reports when it succeeds, finds nothing, gives no
 * usable answer, or fails. Uses the in-memory Forge mocks (test/mocks) and fictional fixtures.
 * Run with: node --import ./test/register.mjs --test test/graph.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const g = globalThis as any;
const SITE = 'https://example.atlassian.net';
const { discoverViaGraph } = await import('../src/resolvers/graph.js');

type Reply = (json: any) => any;
const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
const edges = (list: unknown[]) => ({ edges: list.map((node) => ({ node })) });
const team = (id: string, displayName: string) => ({ __typename: 'AtlassianTeam', id, displayName });
const space = (key: string, name: string) => ({ __typename: 'ConfluenceSpace', id: `ari:space/${key}`, key, name });
const linked = (pageId: string) => ({ __typename: 'ConfluencePage', id: `ari:cloud:confluence:c:page/${pageId}`, pageId, title: `Page ${pageId}` });

function page(id: string, title: string, spaceKey: string, text: string) {
  return {
    id, title, space: { key: spaceKey }, version: { when: '2026-11-10T09:00:00Z' },
    _links: { base: SITE, webui: `/spaces/${spaceKey}/pages/${id}` },
    body: { atlas_doc_format: { value: JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] }) } }
  };
}

/**
 * Installs Graph and Confluence mocks. `teams`, `spaces` and `links` are functions from the
 * query variables to a reply; `search` answers Confluence CQL searches. Records every call.
 */
function mock({ teams, spaces, links, search }: {
  teams?: (v: any) => Reply; spaces?: (v: any) => Reply; links?: (v: any) => Reply; search?: (cql: string) => Reply;
}) {
  const calls = { teams: 0, spaces: 0, links: [] as string[], search: [] as string[], operations: new Set<string>() };
  g.__twg = (query: string, variables: any, _json: unknown, operationName: string) => {
    calls.operations.add(operationName);
    if (query.includes('atlassianTeamsBySpace')) { calls.teams++; return (teams ?? (() => () => json({ data: { atlassianTeamsBySpace: edges([]) } })))(variables)(json); }
    if (query.includes('spacesByAtlassianTeam')) { calls.spaces++; return (spaces ?? (() => () => json({ data: { spacesByAtlassianTeam: edges([]) } })))(variables)(json); }
    calls.links.push(String(variables.pageAri).split('/').pop()!);
    return (links ?? (() => () => json({ data: { confluencePageLinkedConfluencePages: edges([]) } })))(variables)(json);
  };
  g.__confluence = (path: string) => {
    const cql = decodeURIComponent(path.split('cql=')[1].split('&')[0]);
    calls.search.push(cql);
    return (search ?? (() => () => json({ results: [] })))(cql)(json);
  };
  return calls;
}

const ok = (data: unknown) => () => json({ data });
const fail = (status: number) => () => json({ message: 'nope' }, status);
const base = { projectKey: 'KAN', projectId: '10001', cloudId: 'cloud-1' };

test('success: team, space, team-space page and linked page are all reported', async () => {
  const calls = mock({
    teams: () => ok({ atlassianTeamsBySpace: edges([team('ari:team/1', 'Launch team')]) }),
    spaces: () => ok({ spacesByAtlassianTeam: edges([space('LT', 'Launch')]) }),
    links: (v) => (String(v.pageAri).endsWith('/100') ? ok({ confluencePageLinkedConfluencePages: edges([linked('300')]) }) : ok({ confluencePageLinkedConfluencePages: edges([]) })),
    search: (cql) => (cql.includes('space in')
      ? () => json({ results: [page('200', 'Team decisions', 'LT', 'Decision: Status updates go out on Fridays instead of on Mondays.')] })
      : () => json({ results: [page('300', 'Meeting notes', 'LT', 'Notes.')] }))
  });
  const { pages, summary } = await discoverViaGraph({ ...base, knownPageIds: ['100'] });
  assert.deepEqual(summary.status, { teams: 'found', spaces: 'found', spacePages: 'ok', linkedPages: 'ok' });
  assert.equal(summary.used, true);
  assert.deepEqual(summary.teams, ['Launch team']);
  assert.deepEqual(summary.spaces, ['Launch']);
  assert.equal(summary.pagesAdded, 1);
  assert.equal(summary.linkedPagesAdded, 1);
  assert.equal(summary.note, null);
  assert.deepEqual(summary.notes, []);
  assert.equal(pages[0].via, 'Teamwork Graph: a Confluence space of team Launch team, linked to KAN');
  assert.equal(pages[1].via, 'Teamwork Graph: linked from a decision page found for this project');
  assert.ok([...calls.operations].every((name) => /^decisionradar_\w+$/.test(name)));
});

test('actual absence: a well-formed empty answer on every attempt means no linked team', async () => {
  const calls = mock({ teams: () => ok({ atlassianTeamsBySpace: edges([]) }) });
  const { pages, summary } = await discoverViaGraph({ ...base, knownPageIds: ['100'] });
  assert.equal(calls.teams, 3, 'empty team answers are retried');
  assert.equal(summary.status.teams, 'none');
  assert.equal(summary.used, true);
  assert.equal(summary.status.spaces, 'skipped');
  assert.equal(summary.status.linkedPages, 'ok', 'linked pages of key-search pages are still read');
  assert.equal(pages.length, 0);
  assert.match(summary.note, /shows no Atlassian team linked to KAN/);
  assert.match(summary.note, /may not show yet/);
  assert.doesNotMatch(summary.note, /could not be reached/);
});

test('uncertain: a missing field, a partial-error answer or a failed attempt is not reported as absence', async () => {
  mock({ teams: () => ok({}) });
  let { summary } = await discoverViaGraph(base);
  assert.equal(summary.status.teams, 'uncertain');
  assert.equal(summary.used, false);
  assert.match(summary.note, /no usable answer about teams linked to KAN/);
  assert.doesNotMatch(summary.note, /shows no Atlassian team/);

  mock({ teams: () => () => json({ data: { atlassianTeamsBySpace: null }, errors: [{ message: 'internal field error' }] }) });
  ({ summary } = await discoverViaGraph(base));
  assert.equal(summary.status.teams, 'uncertain');
  assert.doesNotMatch(summary.note, /internal field error/, 'GraphQL error text is not shown');

  let attempt = 0;
  mock({ teams: () => (attempt++ === 0 ? fail(500) : ok({ atlassianTeamsBySpace: edges([]) })) });
  ({ summary } = await discoverViaGraph(base));
  assert.equal(summary.status.teams, 'uncertain', 'an error followed by empty answers stays uncertain');
});

test('unreachable: every team lookup failing reports the HTTP status and still reads linked pages', async () => {
  const calls = mock({
    teams: () => fail(500),
    links: () => ok({ confluencePageLinkedConfluencePages: edges([linked('300')]) }),
    search: () => () => json({ results: [page('300', 'Meeting notes', 'LT', 'Notes.')] })
  });
  const { pages, summary } = await discoverViaGraph({ ...base, knownPageIds: ['100'] });
  assert.equal(calls.teams, 3);
  assert.equal(summary.status.teams, 'error');
  assert.equal(summary.used, false);
  assert.match(summary.note, /Teamwork Graph could not be reached \(HTTP 500\), so no team spaces were searched/);
  assert.equal(summary.status.linkedPages, 'ok');
  assert.equal(summary.linkedPagesAdded, 1);
  assert.equal(pages.length, 1);
});

test('Confluence 403 after teams and spaces succeed keeps what Graph found and names the failure', async () => {
  const calls = mock({
    teams: () => ok({ atlassianTeamsBySpace: edges([team('ari:team/1', 'Launch team')]) }),
    spaces: () => ok({ spacesByAtlassianTeam: edges([space('LT', 'Launch')]) }),
    links: () => ok({ confluencePageLinkedConfluencePages: edges([]) }),
    search: () => () => json({ message: 'forbidden' }, 403)
  });
  const { pages, summary } = await discoverViaGraph({ ...base, knownPageIds: ['100'] });
  assert.deepEqual(summary.status, { teams: 'found', spaces: 'found', spacePages: 'error', linkedPages: 'ok' });
  assert.equal(summary.used, true);
  assert.deepEqual(summary.teams, ['Launch team']);
  assert.deepEqual(summary.spaces, ['Launch']);
  assert.equal(pages.length, 0);
  assert.equal(summary.note, 'Teamwork Graph found Launch, but Confluence could not search it (HTTP 403), so no decision pages were added from team spaces.');
  assert.doesNotMatch(summary.note, /could not be reached/);
  assert.deepEqual(calls.links, ['100'], 'the linked-page stage still runs');
});

test('one failing linked origin does not stop the others', async () => {
  const calls = mock({
    teams: () => ok({ atlassianTeamsBySpace: edges([]) }),
    links: (v) => {
      const origin = String(v.pageAri).split('/').pop();
      if (origin === '102') return fail(500);
      return ok({ confluencePageLinkedConfluencePages: edges([linked(origin === '101' ? '201' : '203')]) });
    },
    search: () => () => json({ results: [page('201', 'Linked A', 'LT', 'A.'), page('203', 'Linked C', 'LT', 'C.')] })
  });
  const { pages, summary } = await discoverViaGraph({ ...base, knownPageIds: ['101', '102', '103'] });
  assert.equal(calls.links.filter((o) => o === '102').length, 3, 'a failing origin is retried');
  assert.deepEqual([...new Set(calls.links)], ['101', '102', '103']);
  assert.equal(summary.status.linkedPages, 'partial');
  assert.equal(summary.linkedPagesAdded, 2);
  assert.deepEqual(pages.map((p: any) => p.id), ['page-201', 'page-203']);
  assert.match(summary.note, /Could not read Teamwork Graph links from 1 of 3 decision pages \(HTTP 500\)\./);
});

test('empty linked-page answers are not retried', async () => {
  const calls = mock({ teams: () => ok({ atlassianTeamsBySpace: edges([team('ari:team/1', 'Launch team')]) }), spaces: () => ok({ spacesByAtlassianTeam: edges([]) }) });
  const { summary } = await discoverViaGraph({ ...base, knownPageIds: ['101', '102'] });
  assert.deepEqual(calls.links, ['101', '102']);
  assert.equal(summary.status.linkedPages, 'ok');
  assert.equal(summary.status.spaces, 'none');
  assert.match(summary.note, /Launch team has no Confluence space linked in Teamwork Graph/);
});

test('one team failing still uses the other team\'s spaces', async () => {
  mock({
    teams: () => ok({ atlassianTeamsBySpace: edges([team('ari:team/1', 'Launch team'), team('ari:team/2', 'Ops team')]) }),
    spaces: (v) => (v.teamAri === 'ari:team/2' ? fail(502) : ok({ spacesByAtlassianTeam: edges([space('LT', 'Launch')]) })),
    search: (cql) => () => json({ results: cql.includes('space in') ? [page('200', 'Team decisions', 'LT', 'Decision: We agreed to ship weekly.')] : [] })
  });
  const { pages, summary } = await discoverViaGraph(base);
  assert.equal(summary.status.spaces, 'partial');
  assert.deepEqual(summary.spaces, ['Launch']);
  assert.equal(summary.pagesAdded, 1);
  assert.equal(pages.length, 1);
  assert.match(summary.note, /Could not read the Confluence spaces of 1 of 2 linked teams \(HTTP 502\)\./);
});

test('no site or project id: nothing is queried', async () => {
  const calls = mock({});
  const { pages, summary } = await discoverViaGraph({ projectKey: 'KAN', projectId: null, cloudId: 'cloud-1' });
  assert.equal(calls.teams, 0);
  assert.equal(pages.length, 0);
  assert.deepEqual(summary.status, { teams: 'skipped', spaces: 'skipped', spacePages: 'skipped', linkedPages: 'skipped' });
  assert.match(summary.note, /was not queried/);
});
