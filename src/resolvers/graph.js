/**
 * Finds extra Confluence sources for a Jira project through Atlassian's Teamwork Graph:
 *
 *   Jira project → teams linked to it → those teams' Confluence spaces → decision pages there
 *   decision pages → pages they link to (for example meeting notes linked from a decision log)
 *
 * These are pages a plain text search for the project key cannot find. Every call runs as the
 * signed-in user, so results only include what that person can see. The Teamwork Graph API is
 * in Preview: an error or empty answer never fails the scan. Each stage reports its own status,
 * so the summary says what was found and what could not be checked.
 */
import api, { route } from '@forge/api';
import { pageSource } from './normalize';

const MAX_TEAMS = 5;
const MAX_SPACES = 8;
const MAX_SPACE_PAGES = 10;
const MAX_LINK_ORIGINS = 5;
const MAX_LINKED_PAGES = 10;

const TEAMS_BY_SPACE = `query decisionradar_teamsBySpace($spaceAri: ID!) {
  atlassianTeamsBySpace(spaceAri: $spaceAri, first: ${MAX_TEAMS}) {
    edges { node { __typename ... on AtlassianTeam { id displayName } } }
  }
}`;

const SPACES_BY_TEAM = `query decisionradar_spacesByTeam($teamAri: ID!) {
  spacesByAtlassianTeam(teamAri: $teamAri, first: 25) {
    edges { node { __typename ... on ConfluenceSpace { id key name } } }
  }
}`;

const LINKED_PAGES = `query decisionradar_linkedPages($pageAri: ID!) {
  confluencePageLinkedConfluencePages(id: $pageAri, first: ${MAX_LINKED_PAGES}) {
    edges { node { __typename ... on ConfluencePage { id pageId title } } }
  }
}`;

/** An HTTP or GraphQL failure, with the HTTP status when there was one. */
class LookupError extends Error {
  constructor(message, status = null) {
    super(message);
    this.status = status;
  }
}

const httpNote = (error) => (error?.status ? ` (HTTP ${error.status})` : '');

/**
 * Runs one Teamwork Graph query. Teamwork Graph requires named operations shaped
 * `company_operation`. `partial` is true when the answer carries errors alongside data.
 */
async function graph(query, variables) {
  const operationName = query.match(/query (\w+)/)?.[1];
  const response = await api.asUser().requestTeamworkGraph(query, variables, operationName);
  if (!response.ok) throw new LookupError(`Teamwork Graph HTTP ${response.status}`, response.status);
  const body = await response.json();
  // GraphQL error text can name internal fields; it is logged, never shown to people.
  if (body?.errors?.length && !body?.data) throw new LookupError(`Teamwork Graph errors: ${body.errors.map((e) => e.message).join('; ')}`);
  return { data: body?.data ?? {}, partial: Boolean(body?.errors?.length) };
}

const nodes = (connection) => (connection?.edges ?? []).map((edge) => edge?.node).filter(Boolean);

const GRAPH_ATTEMPTS = 3;
const RETRY_DELAY_MS = 400;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Reads one connection, retrying failures (and, with `retryEmpty`, empty answers: the Teamwork
 * Graph Preview sometimes answers with no edges for a link that exists).
 *
 * Returns `{ nodes, answer }`, where `answer` says how much an empty result can be trusted:
 * - `found`: at least one node.
 * - `empty`: a well-formed connection with no edges, and no errors, on every attempt.
 * - `missing`: the field was absent or null, or the answer carried errors. Nothing can be
 *   concluded from it.
 * Throws a LookupError only when every attempt failed.
 */
async function readConnection(query, variables, field, { retryEmpty }) {
  let lastAnswer = null;
  let lastError = null;
  let uncertain = false;
  for (let attempt = 1; attempt <= GRAPH_ATTEMPTS; attempt++) {
    try {
      const { data, partial } = await graph(query, variables);
      const connection = data?.[field];
      const found = nodes(connection);
      if (found.length > 0) return { nodes: found, answer: 'found', partial };
      // One failed or malformed attempt makes an empty result uncertain.
      if (!(connection && Array.isArray(connection.edges)) || partial) uncertain = true;
      lastAnswer = { nodes: [], answer: uncertain ? 'missing' : 'empty' };
      if (!retryEmpty && lastAnswer.answer === 'empty') return lastAnswer;
    } catch (error) {
      lastError = error;
      uncertain = true;
      if (lastAnswer) lastAnswer = { nodes: [], answer: 'missing' };
    }
    if (attempt < GRAPH_ATTEMPTS) await pause(RETRY_DELAY_MS * attempt);
  }
  if (lastAnswer) return lastAnswer;
  throw lastError ?? new LookupError('Teamwork Graph lookup failed');
}

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
  if (!response.ok) throw new LookupError(`Confluence HTTP ${response.status}`, response.status);
  return (await response.json()).results ?? [];
}

const listOf = (names) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

/**
 * Extra page sources for a project found through the Teamwork Graph, plus a summary for the UI.
 * `knownPageIds` are pages the key search already found; they are not fetched again, but they
 * are used as starting points for linked pages.
 *
 * The summary keeps the fields callers already use (`used`, `teams`, `spaces`, `pagesAdded`,
 * `linkedPagesAdded`, `note`) and adds `status`, one entry per stage, and `notes`, one sentence
 * per problem. `note` joins `notes`. Each stage fails on its own: a later failure never hides
 * what an earlier stage found, and a failing linked-page origin does not stop the others.
 *
 * status.teams:       found | none (Graph answered: no team) | uncertain (no usable answer) | error | skipped
 * status.spaces:      found | partial | none | error | skipped
 * status.spacePages:  ok | error | skipped
 * status.linkedPages: ok | partial | error | skipped
 */
export async function discoverViaGraph({ projectKey, projectId, cloudId, knownPageIds = [] }) {
  const status = { teams: 'skipped', spaces: 'skipped', spacePages: 'skipped', linkedPages: 'skipped' };
  const notes = [];
  const summary = { used: false, teams: [], spaces: [], pagesAdded: 0, linkedPagesAdded: 0, note: null, notes, status };
  const finish = () => {
    summary.note = notes.length > 0 ? notes.join(' ') : null;
    return { pages, summary };
  };
  const pages = [];
  if (!cloudId || !projectId) {
    notes.push('Teamwork Graph was not queried: the site or project id was not available.');
    return finish();
  }
  const known = new Set(knownPageIds.map(String));

  // 1. Teams linked to the Jira project.
  let teams = [];
  try {
    const projectAri = `ari:cloud:jira:${cloudId}:project/${projectId}`;
    const answer = await readConnection(TEAMS_BY_SPACE, { spaceAri: projectAri }, 'atlassianTeamsBySpace', { retryEmpty: true });
    teams = answer.nodes.filter((n) => n.__typename === 'AtlassianTeam').slice(0, MAX_TEAMS);
    if (teams.length > 0) {
      status.teams = 'found';
      if (answer.partial) notes.push('Teamwork Graph returned some linked teams but could not complete the team lookup.');
    } else if (answer.answer === 'empty') {
      status.teams = 'none';
      notes.push(`Teamwork Graph shows no Atlassian team linked to ${projectKey}, so no team spaces were searched. A team linked in the last few minutes may not show yet; scan again shortly.`);
    } else {
      status.teams = 'uncertain';
      notes.push(`Teamwork Graph gave no usable answer about teams linked to ${projectKey}, so no team spaces were searched. Scan again in a minute.`);
    }
  } catch (error) {
    console.warn('Decision Drift Radar Teamwork Graph team lookup failed', error);
    status.teams = 'error';
    notes.push(`Teamwork Graph could not be reached${httpNote(error)}, so no team spaces were searched.`);
  }
  summary.used = status.teams === 'found' || status.teams === 'none';
  summary.teams = teams.map((t) => t.displayName ?? 'Unnamed team');

  // 2. Those teams' Confluence spaces. One team failing does not hide the others' spaces.
  const spaceTeam = new Map();
  if (teams.length > 0) {
    let failedTeams = 0;
    let lastError = null;
    for (const team of teams) {
      try {
        const answer = await readConnection(SPACES_BY_TEAM, { teamAri: team.id }, 'spacesByAtlassianTeam', { retryEmpty: true });
        if (answer.answer === 'missing' || answer.partial) failedTeams++;
        for (const space of answer.nodes.filter((n) => n.__typename === 'ConfluenceSpace' && n.key)) {
          if (!spaceTeam.has(space.key) && spaceTeam.size < MAX_SPACES) spaceTeam.set(space.key, { space, team });
        }
      } catch (error) {
        console.warn('Decision Drift Radar Teamwork Graph space lookup failed', error);
        failedTeams++;
        lastError = error;
      }
    }
    summary.spaces = [...spaceTeam.values()].map(({ space }) => space.name ?? space.key);
    const teamNames = listOf(summary.teams);
    if (spaceTeam.size === 0 && failedTeams > 0) {
      status.spaces = 'error';
      notes.push(`Found ${teamNames} in Teamwork Graph, but could not read ${teams.length === 1 ? 'its' : 'their'} Confluence spaces${httpNote(lastError)}, so no team spaces were searched.`);
    } else if (spaceTeam.size === 0) {
      status.spaces = 'none';
      notes.push(`${teamNames} ${teams.length === 1 ? 'has' : 'have'} no Confluence space linked in Teamwork Graph, so no team spaces were searched.`);
    } else if (failedTeams > 0) {
      status.spaces = 'partial';
      notes.push(`Could not read the Confluence spaces of ${failedTeams} of ${teams.length} linked teams${httpNote(lastError)}.`);
    } else {
      status.spaces = 'found';
    }
  }

  // 3. Decision pages in those spaces, even when they never mention the project key.
  if (spaceTeam.size > 0) {
    const spaceList = [...spaceTeam.keys()].map(quote).join(',');
    // Pages titled as decision records. Matching body text instead pulls in templates whose
    // instructions mention decisions (DACI, premortems, meeting-note templates).
    const cql = `type = page AND space in (${spaceList}) AND (title ~ "decision" OR title ~ "decisions" OR title ~ "decided" OR title ~ "agreed" OR title ~ "ADR") AND NOT title ~ "template" ORDER BY lastmodified DESC`;
    try {
      for (const page of await confluencePages(cql, MAX_SPACE_PAGES)) {
        if (known.has(String(page.id))) continue;
        const spaceKey = page.space?.key;
        if (spaceKey && !spaceTeam.has(spaceKey)) continue;
        const entry = spaceKey ? spaceTeam.get(spaceKey) : spaceTeam.size === 1 ? spaceTeam.values().next().value : null;
        const team = entry?.team?.displayName;
        const via = team
          ? `Teamwork Graph: a Confluence space of team ${team}, linked to ${projectKey}`
          : `Teamwork Graph: a Confluence space of a team linked to ${projectKey}`;
        pages.push(pageSource(page, projectKey, via));
        known.add(String(page.id));
        summary.pagesAdded++;
      }
      status.spacePages = 'ok';
    } catch (error) {
      console.warn('Decision Drift Radar team space search failed', error);
      status.spacePages = 'error';
      const spaceNames = listOf(summary.spaces);
      notes.push(`Teamwork Graph found ${spaceNames}, but Confluence could not search ${spaceTeam.size === 1 ? 'it' : 'them'}${httpNote(error)}, so no decision pages were added from team spaces.`);
    }
  }

  // 4. Pages linked from the decision pages found so far. Runs whatever happened above, since
  //    key-search pages are origins too. Each origin is read on its own.
  const origins = [...knownPageIds.map(String), ...pages.map((p) => p.id.replace(/^page-/, ''))].slice(0, MAX_LINK_ORIGINS);
  if (origins.length > 0) {
    const linkedIds = new Map();
    let failedOrigins = 0;
    let lastError = null;
    for (const originId of origins) {
      try {
        const pageAri = `ari:cloud:confluence:${cloudId}:page/${originId}`;
        // Most pages link to nothing, so an empty answer is not retried.
        const answer = await readConnection(LINKED_PAGES, { pageAri }, 'confluencePageLinkedConfluencePages', { retryEmpty: false });
        if (answer.answer === 'missing' || answer.partial) failedOrigins++;
        for (const node of answer.nodes) {
          const id = pageIdOf(node);
          if (id && !known.has(id) && !linkedIds.has(id) && linkedIds.size < MAX_LINKED_PAGES) linkedIds.set(id, originId);
        }
      } catch (error) {
        console.warn('Decision Drift Radar Teamwork Graph link lookup failed', error);
        failedOrigins++;
        lastError = error;
      }
    }
    status.linkedPages = failedOrigins === 0 ? 'ok' : failedOrigins === origins.length ? 'error' : 'partial';
    if (failedOrigins > 0) {
      notes.push(`Could not read Teamwork Graph links from ${failedOrigins} of ${origins.length} decision ${origins.length === 1 ? 'page' : 'pages'}${httpNote(lastError)}.`);
    }
    if (linkedIds.size > 0) {
      const cql = `type = page AND id in (${[...linkedIds.keys()].join(',')})`;
      try {
        for (const page of await confluencePages(cql, MAX_LINKED_PAGES)) {
          if (known.has(String(page.id))) continue;
          pages.push(pageSource(page, projectKey, 'Teamwork Graph: linked from a decision page found for this project'));
          known.add(String(page.id));
          summary.linkedPagesAdded++;
        }
      } catch (error) {
        console.warn('Decision Drift Radar linked page fetch failed', error);
        status.linkedPages = 'error';
        notes.push(`Teamwork Graph found ${linkedIds.size} linked ${linkedIds.size === 1 ? 'page' : 'pages'}, but Confluence could not return ${linkedIds.size === 1 ? 'it' : 'them'}${httpNote(error)}.`);
      }
    }
  }

  return finish();
}
