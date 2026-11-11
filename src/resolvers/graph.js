/**
 * Finds extra Confluence sources for a Jira project through Atlassian's Teamwork Graph:
 *
 *   Jira project → teams linked to it → those teams' Confluence spaces → decision pages there
 *   decision pages → pages they link to (for example meeting notes linked from a decision log)
 *
 * These are pages a plain text search for the project key cannot find. Every call runs as the
 * signed-in user, so results only include what that person can see. The Teamwork Graph API is
 * in Preview: any error or empty answer means "no extra sources", never a failed scan.
 */
import api, { route } from '@forge/api';
import { pageSource } from './normalize';

const MAX_TEAMS = 5;
const MAX_SPACES = 8;
const MAX_SPACE_PAGES = 10;
const MAX_LINK_ORIGINS = 5;
const MAX_LINKED_PAGES = 10;

const TEAMS_BY_SPACE = `query ddrTeamsBySpace($spaceAri: ID!) {
  atlassianTeamsBySpace(spaceAri: $spaceAri, first: ${MAX_TEAMS}) {
    edges { node { __typename ... on AtlassianTeam { id displayName } } }
  }
}`;

const SPACES_BY_TEAM = `query ddrSpacesByTeam($teamAri: ID!) {
  spacesByAtlassianTeam(teamAri: $teamAri, first: 25) {
    edges { node { __typename ... on ConfluenceSpace { id key name } } }
  }
}`;

const LINKED_PAGES = `query ddrLinkedPages($pageAri: ID!) {
  confluencePageLinkedConfluencePages(id: $pageAri, first: ${MAX_LINKED_PAGES}) {
    edges { node { __typename ... on ConfluencePage { id pageId title } } }
  }
}`;

async function graph(query, variables) {
  const response = await api.asUser().requestTeamworkGraph(query, variables);
  if (!response.ok) throw new Error(`Teamwork Graph HTTP ${response.status}`);
  const body = await response.json();
  if (body?.errors?.length && !body?.data) throw new Error(body.errors.map((e) => e.message).join('; '));
  return body?.data ?? {};
}

const nodes = (connection) => (connection?.edges ?? []).map((edge) => edge?.node).filter(Boolean);

/** Numeric page id from a ConfluencePage node (its `pageId`, or the tail of its ARI). */
function pageIdOf(node) {
  const raw = String(node?.pageId ?? node?.id ?? '');
  const match = raw.match(/(\d+)$/);
  return match ? match[1] : null;
}

const quote = (value) => `"${String(value).replace(/["\\]/g, '')}"`;

async function confluencePages(cql, limit) {
  const response = await api.asUser().requestConfluence(
    route`/wiki/rest/api/content/search?cql=${cql}&limit=${limit}&expand=space,version,body.atlas_doc_format,body.storage`
  );
  if (!response.ok) throw new Error(`Confluence HTTP ${response.status}`);
  return (await response.json()).results ?? [];
}

/**
 * Extra page sources for a project found through the Teamwork Graph, plus a summary for the UI.
 * `knownPageIds` are pages the key search already found; they are not fetched again, but they
 * are used as starting points for linked pages.
 */
export async function discoverViaGraph({ projectKey, projectId, cloudId, knownPageIds = [] }) {
  const summary = { used: false, teams: [], spaces: [], pagesAdded: 0, linkedPagesAdded: 0, note: null };
  if (!cloudId || !projectId) {
    summary.note = 'Teamwork Graph was not queried: the site or project id was not available.';
    return { pages: [], summary };
  }
  const known = new Set(knownPageIds.map(String));
  const pages = [];

  try {
    // 1. Teams linked to the Jira project, and their Confluence spaces.
    const projectAri = `ari:cloud:jira:${cloudId}:project/${projectId}`;
    const teams = nodes((await graph(TEAMS_BY_SPACE, { spaceAri: projectAri })).atlassianTeamsBySpace)
      .filter((n) => n.__typename === 'AtlassianTeam')
      .slice(0, MAX_TEAMS);
    summary.used = true;
    summary.teams = teams.map((t) => t.displayName ?? 'Unnamed team');

    const spaceTeam = new Map();
    for (const team of teams) {
      const spaces = nodes((await graph(SPACES_BY_TEAM, { teamAri: team.id })).spacesByAtlassianTeam)
        .filter((n) => n.__typename === 'ConfluenceSpace' && n.key);
      for (const space of spaces) {
        if (!spaceTeam.has(space.key) && spaceTeam.size < MAX_SPACES) spaceTeam.set(space.key, { space, team });
      }
    }
    summary.spaces = [...spaceTeam.values()].map(({ space }) => space.name ?? space.key);

    // 2. Decision pages in those spaces, even when they never mention the project key.
    if (spaceTeam.size > 0) {
      const spaceList = [...spaceTeam.keys()].map(quote).join(',');
      const cql = `type = page AND space in (${spaceList}) AND (text ~ "decision" OR text ~ "decided" OR text ~ "agreed") ORDER BY lastmodified DESC`;
      for (const page of await confluencePages(cql, MAX_SPACE_PAGES)) {
        if (known.has(String(page.id))) continue;
        const entry = spaceTeam.get(page.space?.key) ?? [...spaceTeam.values()][0];
        const team = entry?.team?.displayName ?? 'a linked team';
        pages.push(pageSource(page, projectKey, `Teamwork Graph: a Confluence space of team ${team}, linked to ${projectKey}`));
        known.add(String(page.id));
        summary.pagesAdded++;
      }
    }

    // 3. Pages linked from the decision pages already found.
    const origins = [...knownPageIds.map(String), ...pages.map((p) => p.id.replace(/^page-/, ''))].slice(0, MAX_LINK_ORIGINS);
    const linkedIds = new Map();
    for (const originId of origins) {
      const pageAri = `ari:cloud:confluence:${cloudId}:page/${originId}`;
      for (const node of nodes((await graph(LINKED_PAGES, { pageAri })).confluencePageLinkedConfluencePages)) {
        const id = pageIdOf(node);
        if (id && !known.has(id) && !linkedIds.has(id) && linkedIds.size < MAX_LINKED_PAGES) linkedIds.set(id, originId);
      }
    }
    if (linkedIds.size > 0) {
      const cql = `type = page AND id in (${[...linkedIds.keys()].join(',')})`;
      for (const page of await confluencePages(cql, MAX_LINKED_PAGES)) {
        if (known.has(String(page.id))) continue;
        pages.push(pageSource(page, projectKey, 'Teamwork Graph: linked from a decision page found for this project'));
        known.add(String(page.id));
        summary.linkedPagesAdded++;
      }
    }
  } catch (error) {
    console.warn('Decision Drift Radar Teamwork Graph lookup failed', error);
    summary.note = 'Teamwork Graph could not be reached, so only pages mentioning the project key were scanned.';
  }

  if (summary.used && !summary.note && summary.teams.length === 0) {
    summary.note = 'No Atlassian team is linked to this project in Teamwork Graph, so only pages mentioning the project key were scanned.';
  }
  return { pages, summary };
}
