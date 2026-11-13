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
  constructor(message, status = null, code = null) {
    super(message);
    this.status = status;
    this.code = code ?? (status ? `http_${status}` : 'error');
    this.attempts = 1;
  }
}

/**
 * Diagnostic log line. Carries only the stage, an HTTP status or error code, and attempt counts:
 * never an error message or object (GraphQL messages can quote data), page text, titles or names.
 */
function logFailure(stage, error, attempts = error?.attempts ?? null) {
  const code = error instanceof LookupError ? error.code : typeof error?.code === 'string' ? error.code.slice(0, 40) : 'error';
  console.warn(`Decision Drift Radar Teamwork Graph stage=${stage} status=${error?.status ?? 'none'} code=${code} attempts=${attempts ?? 'n/a'}`);
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
  // GraphQL error text can name internal fields or data, so it is never kept: only a code.
  if (body?.errors?.length && !body?.data) throw new LookupError('Teamwork Graph returned errors', null, 'graphql_errors');
  return { data: body?.data ?? {}, partial: Boolean(body?.errors?.length) };
}

const nodes = (connection) => (connection?.edges ?? []).map((edge) => edge?.node).filter(Boolean);

const GRAPH_ATTEMPTS = 3;
const RETRY_DELAY_MS = 400;
const PATIENT_DELAY_MS = 1500;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Reads one connection, retrying failures (and, with `retryEmpty`, empty answers: the Teamwork
 * Graph Preview sometimes answers with no edges for a link that exists).
 *
 * Returns `{ nodes, answer }`, where `answer` says how much an empty result can be trusted:
 * - `found`: at least one node.
 * - `empty`: a well-formed connection with no edges, and no errors, on every attempt.
 * - `missing`: the field was absent or null, or the answer carried errors. Nothing can be
 *   concluded from it. With `patient`, one extra, longer-spaced attempt is made first.
 * A `found` answer that carried errors alongside it is retried and returned `partial` only if
 * no clean answer comes. Throws a LookupError only when every attempt failed.
 */
async function readConnection(query, variables, field, { retryEmpty, late = () => false, patient = false }) {
  let lastAnswer = null;
  let lastError = null;
  let uncertain = false;
  let bestPartial = null;
  let limit = GRAPH_ATTEMPTS;
  let attempt = 0;
  while (attempt < limit) {
    attempt++;
    try {
      const { data, partial } = await graph(query, variables);
      const connection = data?.[field];
      const found = nodes(connection);
      if (found.length > 0) {
        if (!partial) return { nodes: found, answer: 'found', partial: false, attempts: attempt };
        // Errors came alongside some nodes: keep them, but try again for a clean answer.
        bestPartial = { nodes: found, answer: 'found', partial: true, attempts: attempt };
      } else {
        // One failed or malformed attempt makes an empty result uncertain.
        if (!(connection && Array.isArray(connection.edges)) || partial) uncertain = true;
        lastAnswer = { nodes: [], answer: uncertain ? 'missing' : 'empty', attempts: attempt };
        if (!retryEmpty && lastAnswer.answer === 'empty' && !bestPartial) return lastAnswer;
      }
    } catch (error) {
      lastError = error;
      uncertain = true;
      if (lastAnswer) lastAnswer = { nodes: [], answer: 'missing', attempts: attempt };
    }
    // The team lookup gets one more, longer-spaced attempt when no attempt has been conclusive.
    if (patient && uncertain && !bestPartial && limit === GRAPH_ATTEMPTS && attempt === limit) limit++;
    // Out of time: settle for what this attempt gave rather than wait to retry.
    if (attempt < limit && late()) break;
    if (attempt < limit) await pause(patient && attempt >= GRAPH_ATTEMPTS ? PATIENT_DELAY_MS : RETRY_DELAY_MS * attempt);
  }
  if (bestPartial) return { ...bestPartial, attempts: attempt };
  if (lastAnswer) return { ...lastAnswer, attempts: attempt };
  const failure = lastError ?? new LookupError('Teamwork Graph lookup failed');
  failure.attempts = attempt;
  throw failure;
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
 * status.overall:     ok | no_team | unavailable | partial (what to tell the user; see `finish`)
 *
 * After `deadline` (a Date.now() value), no new lookup starts and failed ones are not retried, so
 * the scan finishes within Forge's time limit. The summary then says the lookups stopped early.
 */
export async function discoverViaGraph({ projectKey, projectId, cloudId, knownPageIds = [], deadline = null }) {
  const status = { teams: 'skipped', spaces: 'skipped', spacePages: 'skipped', linkedPages: 'skipped' };
  const notes = [];
  const late = () => deadline !== null && Date.now() > deadline;
  let stoppedEarly = false;
  const outOfTime = () => {
    if (!late()) return false;
    if (!stoppedEarly) notes.push('Teamwork Graph lookups stopped early to keep the scan within Jira\'s time limit, so some team pages may be missing (partial results). Scan again to retry.');
    stoppedEarly = true;
    return true;
  };
  const summary = { used: false, teams: [], spaces: [], pagesAdded: 0, linkedPagesAdded: 0, note: null, notes, status };
  const finish = () => {
    // Overall state: unavailable (Graph gave no usable team answer) > partial (a stage or origin
    // failed, or lookups stopped early) > no_team (Graph clearly says no team) > ok.
    const failedStage = status.spaces === 'error' || status.spaces === 'partial' || status.spacePages === 'error' || status.linkedPages === 'error' || status.linkedPages === 'partial' || notes.some((n) => n.startsWith('Partial results'));
    status.overall = status.teams !== 'found' && status.teams !== 'none' ? 'unavailable'
      : failedStage || stoppedEarly ? 'partial'
      : status.teams === 'none' ? 'no_team'
      : 'ok';
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
  let teamAttempts = 0;
  try {
    const projectAri = `ari:cloud:jira:${cloudId}:project/${projectId}`;
    const answer = await readConnection(TEAMS_BY_SPACE, { spaceAri: projectAri }, 'atlassianTeamsBySpace', { retryEmpty: true, late, patient: true });
    teamAttempts = answer.attempts;
    teams = answer.nodes.filter((n) => n.__typename === 'AtlassianTeam').slice(0, MAX_TEAMS);
    if (teams.length > 0) {
      status.teams = 'found';
      if (answer.partial) notes.push('Partial results: Teamwork Graph returned some linked teams but could not complete the team lookup. Scan again in a minute for the full list.');
    } else if (answer.answer === 'empty') {
      status.teams = 'none';
      notes.push(`No team linked: Teamwork Graph answered clearly that no Atlassian team is linked to ${projectKey}, so no team spaces were searched. Link a team to the project to include its Confluence spaces; a link made in the last few minutes may take a moment to show.`);
    } else {
      status.teams = 'uncertain';
      logFailure('teams', { code: 'no_usable_answer' }, teamAttempts);
      notes.push(`Teamwork Graph temporarily unavailable: it gave no usable answer about teams linked to ${projectKey} after ${teamAttempts} tries, so no team spaces were searched. Scan again in a minute.`);
    }
  } catch (error) {
    logFailure('teams', error);
    status.teams = 'error';
    notes.push(`Teamwork Graph temporarily unavailable${httpNote(error)}: the team lookup failed after ${error?.attempts ?? 1} tries, so no team spaces were searched. Scan again in a minute.`);
  }
  summary.used = status.teams === 'found' || status.teams === 'none';
  summary.teams = teams.map((t) => t.displayName ?? 'Unnamed team');

  // 2. Those teams' Confluence spaces. One team failing does not hide the others' spaces.
  const spaceTeam = new Map();
  if (teams.length > 0) {
    let failedTeams = 0;
    let lastError = null;
    for (const team of teams) {
      if (outOfTime()) break;
      try {
        const answer = await readConnection(SPACES_BY_TEAM, { teamAri: team.id }, 'spacesByAtlassianTeam', { retryEmpty: true, late });
        if (answer.answer === 'missing' || answer.partial) failedTeams++;
        for (const space of answer.nodes.filter((n) => n.__typename === 'ConfluenceSpace' && n.key)) {
          if (!spaceTeam.has(space.key) && spaceTeam.size < MAX_SPACES) spaceTeam.set(space.key, { space, team });
        }
      } catch (error) {
        logFailure('spaces', error);
        failedTeams++;
        lastError = error;
      }
    }
    summary.spaces = [...spaceTeam.values()].map(({ space }) => space.name ?? space.key);
    const teamNames = listOf(summary.teams);
    if (spaceTeam.size === 0 && failedTeams > 0) {
      status.spaces = 'error';
      notes.push(`Partial results: found ${teamNames} in Teamwork Graph, but could not read ${teams.length === 1 ? 'its' : 'their'} Confluence spaces${httpNote(lastError)}, so no team spaces were searched. Scan again in a minute.`);
    } else if (spaceTeam.size === 0) {
      status.spaces = 'none';
      notes.push(`${teamNames} ${teams.length === 1 ? 'has' : 'have'} no Confluence space linked in Teamwork Graph, so no team spaces were searched.`);
    } else if (failedTeams > 0) {
      status.spaces = 'partial';
      notes.push(`Partial results: could not read the Confluence spaces of ${failedTeams} of ${teams.length} linked teams${httpNote(lastError)}. Scan again in a minute.`);
    } else {
      status.spaces = 'found';
    }
  }

  // 3. Decision pages in those spaces, even when they never mention the project key.
  if (spaceTeam.size > 0 && !outOfTime()) {
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
      logFailure('space_pages', error, 1);
      status.spacePages = 'error';
      const spaceNames = listOf(summary.spaces);
      notes.push(`Partial results: Teamwork Graph found ${spaceNames}, but Confluence could not search ${spaceTeam.size === 1 ? 'it' : 'them'}${httpNote(error)}, so no decision pages were added from team spaces. Scan again in a minute.`);
    }
  }

  // 4. Pages linked from the decision pages found so far. Runs whatever happened above, since
  //    key-search pages are origins too. Each origin is read on its own.
  const origins = [...knownPageIds.map(String), ...pages.map((p) => p.id.replace(/^page-/, ''))].slice(0, MAX_LINK_ORIGINS);
  if (origins.length > 0 && !outOfTime()) {
    const linkedIds = new Map();
    let failedOrigins = 0;
    let lastError = null;
    for (const originId of origins) {
      if (outOfTime()) break;
      try {
        const pageAri = `ari:cloud:confluence:${cloudId}:page/${originId}`;
        // Most pages link to nothing, so an empty answer is not retried.
        const answer = await readConnection(LINKED_PAGES, { pageAri }, 'confluencePageLinkedConfluencePages', { retryEmpty: false, late });
        if (answer.answer === 'missing' || answer.partial) failedOrigins++;
        for (const node of answer.nodes) {
          const id = pageIdOf(node);
          if (id && !known.has(id) && !linkedIds.has(id) && linkedIds.size < MAX_LINKED_PAGES) linkedIds.set(id, originId);
        }
      } catch (error) {
        logFailure('linked_pages', error);
        failedOrigins++;
        lastError = error;
      }
    }
    status.linkedPages = failedOrigins === 0 ? 'ok' : failedOrigins === origins.length ? 'error' : 'partial';
    if (failedOrigins > 0) {
      notes.push(`Partial results: could not read Teamwork Graph links from ${failedOrigins} of ${origins.length} decision ${origins.length === 1 ? 'page' : 'pages'}${httpNote(lastError)}. Scan again in a minute.`);
    }
    if (linkedIds.size > 0 && !outOfTime()) {
      const cql = `type = page AND id in (${[...linkedIds.keys()].join(',')})`;
      try {
        for (const page of await confluencePages(cql, MAX_LINKED_PAGES)) {
          if (known.has(String(page.id))) continue;
          pages.push(pageSource(page, projectKey, 'Teamwork Graph: linked from a decision page found for this project'));
          known.add(String(page.id));
          summary.linkedPagesAdded++;
        }
      } catch (error) {
        logFailure('linked_page_fetch', error, 1);
        status.linkedPages = 'error';
        notes.push(`Partial results: Teamwork Graph found ${linkedIds.size} linked ${linkedIds.size === 1 ? 'page' : 'pages'}, but Confluence could not return ${linkedIds.size === 1 ? 'it' : 'them'}${httpNote(error)}. Scan again in a minute.`);
      }
    }
  }

  return finish();
}
