/**
 * The radar's memory: when each finding was first seen, and the state of each drift (an issue that
 * still uses wording a decision replaced). Kept as one record per project.
 *
 *   radar:<KEY>  { findings: { <findingId>: { firstSeenAt } },
 *                  drifts:   { <findingId>:<issueKey>: { findingId, issueKey, phrase, status,
 *                                                         firstSeenAt, resolvedAt?, resolvedBy?, reopenedAt? } } }
 *   visit:<sha256(accountId)>:<KEY>  { at }   when that person last opened the project's radar
 *
 * Scans update it with what the signed-in user can see. The Jira issue-update trigger can only
 * mark an open drift resolved; it never adds findings or shows anything to anyone.
 */
import { createHash } from 'node:crypto';
import api, { route } from '@forge/api';
import { Filter, FilterConditions, kvs } from '@forge/kvs';
import { issueStillMentions } from '../domain/matchIssues';
import { adfToText } from './normalize';

const MAX_FINDINGS = 300;
const MAX_DRIFTS = 300;

/** The pre-entity record: read once to seed the versioned state, then deleted. */
const legacyRadarKey = (projectKey) => `radar:${projectKey}`;
const visitKey = (accountId, projectKey) => `visit:${createHash('sha256').update(accountId).digest('hex')}:${projectKey}`;
const driftId = (findingId, issueKey) => `${findingId}:${issueKey}`;
const emptyRadar = () => ({ findings: {}, drifts: {} });

/**
 * The radar lives in one custom-entity record per project with a version number. Every change is
 * written with a conditional transaction that requires the version it read, so two invocations
 * (a scan and the issue-update trigger, or two scans) cannot overwrite each other: the one that
 * loses re-reads the latest record and applies its change again. `entity().get` is strongly
 * consistent, so the re-read sees the winner's write.
 */
const STATE_ENTITY = 'radar-state';
const stateKey = (projectKey) => `radar-state:${projectKey}`;
const MAX_WRITE_ATTEMPTS = 8;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Exponential backoff with full jitter: up to 50 ms, 100 ms, … capped at 1.6 s. */
const backoff = (attempt) => Math.floor(Math.random() * Math.min(1600, 50 * 2 ** (attempt - 1)));
/** Error name and code only, never the message, which could carry stored content. */
const errorLabel = (error) => `${error?.name ?? 'Error'}${error?.code ? ` ${error.code}` : ''}`;

const asRadar = (value) => ({ findings: value?.findings ?? {}, drifts: value?.drifts ?? {} });

async function readState(projectKey) {
  const stored = await kvs.entity(STATE_ENTITY).get(stateKey(projectKey));
  if (stored) return { exists: true, version: Number(stored.version) || 0, radar: asRadar(stored.radar) };
  const legacy = await kvs.get(legacyRadarKey(projectKey));
  const hasLegacy = Boolean(legacy && typeof legacy === 'object');
  return { exists: false, migrating: hasLegacy, version: 0, radar: hasLegacy ? asRadar(legacy) : emptyRadar() };
}

async function writeState(projectKey, state, radar) {
  const value = { projectKey, version: state.version + 1, radar, updatedAt: new Date().toISOString() };
  if (!state.exists) {
    // First write for this project. Another invocation creating it first makes this fail, and the retry reads theirs.
    await kvs.entity(STATE_ENTITY).set(stateKey(projectKey), value, { keyPolicy: 'FAIL_IF_EXISTS' });
    return;
  }
  await kvs.transact()
    .set(stateKey(projectKey), value, {
      entityName: STATE_ENTITY,
      conditions: new Filter().and('version', FilterConditions.equalTo(state.version))
    })
    .execute();
}

/** The project's radar as last stored (read-only). */
export async function loadRadar(projectKey) {
  return (await readState(projectKey)).radar;
}

/**
 * Applies `change(radar) -> { radar, changed }` to the latest stored radar and saves it, retrying
 * when another invocation saved in between. `change` must be a pure function of the radar it is
 * given, because it may run more than once. Returns the radar the caller's change was applied to.
 */
export async function updateRadar(projectKey, change) {
  for (let attempt = 1; ; attempt++) {
    const state = await readState(projectKey);
    const result = change(state.radar);
    // Save on the first read of an old single-key record even without a change, so it is read only once.
    if (!result.changed && !state.migrating) return result.radar;
    try {
      await writeState(projectKey, state, result.radar);
    } catch (error) {
      // The conflict error code is not documented, so every failed write is retried. Logs carry
      // the project key, the attempt and the error name/code only.
      if (attempt >= MAX_WRITE_ATTEMPTS) {
        console.warn(`Decision Drift Radar radar write failed: ${projectKey}, ${errorLabel(error)}, after ${attempt} attempts`);
        throw error;
      }
      console.info(`Decision Drift Radar radar write retry: ${projectKey}, attempt ${attempt} of ${MAX_WRITE_ATTEMPTS}, ${errorLabel(error)}`);
      await pause(backoff(attempt));
      continue;
    }
    if (state.migrating) {
      // The old single-key record has been copied into the entity; remove it so it isn't kept twice.
      await kvs.delete(legacyRadarKey(projectKey)).catch(() => {});
    }
    return result.radar;
  }
}

/** Keeps the record bounded: drops the oldest resolved drifts first, then the oldest entries. */
function prune(radar) {
  const drifts = Object.entries(radar.drifts);
  if (drifts.length > MAX_DRIFTS) {
    drifts.sort(([, a], [, b]) => (a.status === b.status ? 0 : a.status === 'resolved' ? -1 : 1)
      || String(a.resolvedAt ?? a.firstSeenAt).localeCompare(String(b.resolvedAt ?? b.firstSeenAt)));
    for (const [id] of drifts.slice(0, drifts.length - MAX_DRIFTS)) delete radar.drifts[id];
  }
  const findings = Object.entries(radar.findings);
  if (findings.length > MAX_FINDINGS) {
    findings.sort(([, a], [, b]) => String(a.firstSeenAt).localeCompare(String(b.firstSeenAt)));
    for (const [id] of findings.slice(0, findings.length - MAX_FINDINGS)) delete radar.findings[id];
  }
}

/** True when the drift's current state comes from an observation made after `observedAt`. */
const newerThan = (drift, observedAt) => Boolean(drift.observedAt) && drift.observedAt > observedAt;

/**
 * Pure: folds one scan into the radar. `candidates` are the findings the scan returned;
 * `issueRecords` contain the issue text read with the current user’s permissions.
 *
 * - A finding seen for the first time gets `firstSeenAt`.
 * - An affected issue with outdated wording opens a drift (or reopens a resolved one).
 * - An open drift is resolved only when its finding was found again AND its issue was read AND
 *   the issue no longer uses the outdated wording. A finding or issue missing from the scan
 *   (permissions, the 50-issue window, a truncated list) changes nothing.
 * - `observedAt` is when the scan read the issues. A drift whose state was set by a later
 *   observation (for example the issue-update trigger) is not changed by an older one, and a scan
 *   that confirms an open drift records its observation time.
 * - `skipReopen` lists issues whose direct re-read showed the old wording is gone, so a stale
 *   search result cannot reopen their drifts.
 */
export function applyScan(radar, { candidates, issueRecords, now = new Date().toISOString(), observedAt = now, skipReopen = new Set() }) {
  const next = structuredClone(radar);
  let changed = false;
  const present = new Set();
  const outdated = new Set();

  for (const candidate of candidates) {
    present.add(candidate.id);
    if (!next.findings[candidate.id]) {
      next.findings[candidate.id] = { firstSeenAt: now };
      changed = true;
    }
    for (const affected of candidate.affectedIssues ?? []) {
      if (affected.wordingStatus !== 'outdated' || !affected.outdatedWording) continue;
      const id = driftId(candidate.id, affected.issueKey);
      outdated.add(id);
      const drift = next.drifts[id];
      if (!drift) {
        next.drifts[id] = {
          findingId: candidate.id, issueKey: affected.issueKey, phrase: affected.outdatedWording,
          status: 'open', firstSeenAt: now, observedAt
        };
        changed = true;
      } else if (drift.status === 'open') {
        // A newer observation that confirms the drift moves its observation time forward, so an
        // older scan or trigger that saves later cannot resolve it.
        if (!drift.observedAt || drift.observedAt < observedAt) {
          next.drifts[id] = { ...drift, observedAt };
          changed = true;
        }
      } else if (drift.status === 'resolved' && !newerThan(drift, observedAt) && !skipReopen.has(affected.issueKey)) {
        next.drifts[id] = {
          findingId: candidate.id, issueKey: affected.issueKey, phrase: affected.outdatedWording,
          status: 'open', firstSeenAt: drift.firstSeenAt, reopenedAt: now, observedAt
        };
        changed = true;
      }
    }
  }

  const issues = new Map(issueRecords.map((issue) => [issue.key, issue]));
  for (const [id, drift] of Object.entries(next.drifts)) {
    if (drift.status !== 'open' || outdated.has(id)) continue;
    const issue = issues.get(drift.issueKey);
    if (!present.has(drift.findingId) || !issue?.title || issue.description === undefined) continue;
    if (newerThan(drift, observedAt) || issueStillMentions(issue, drift.phrase)) continue;
    next.drifts[id] = { ...drift, status: 'resolved', resolvedAt: now, resolvedBy: 'scan', observedAt };
    changed = true;
  }

  if (changed) prune(next);
  return { radar: next, changed };
}

/**
 * Adds radar state to findings for display: `isNew` (first seen after `previousVisitAt`),
 * `drift` on each affected issue, and `resolvedIssues` for issues that no longer match at all.
 * Only findings already in `candidates` (what this user's scan returned) are described.
 */
export function describeFindings(radar, { candidates, issueRecords, previousVisitAt = null }) {
  const readable = new Set(issueRecords.map((issue) => issue.key));
  const drifts = Object.values(radar.drifts).filter((drift) => readable.has(drift.issueKey));
  return candidates.map((candidate) => {
    const firstSeenAt = radar.findings[candidate.id]?.firstSeenAt ?? null;
    const mine = drifts.filter((d) => d.findingId === candidate.id);
    const byIssue = new Map(mine.map((d) => [d.issueKey, d]));
    const listed = new Set((candidate.affectedIssues ?? []).map((a) => a.issueKey));
    const view = (d) => ({
      status: d.status, phrase: d.phrase, firstSeenAt: d.firstSeenAt,
      ...(d.resolvedAt ? { resolvedAt: d.resolvedAt, resolvedBy: d.resolvedBy } : {})
    });
    return {
      ...candidate,
      firstSeenAt,
      isNew: Boolean(previousVisitAt && firstSeenAt && firstSeenAt > previousVisitAt),
      affectedIssues: (candidate.affectedIssues ?? []).map((affected) => (
        byIssue.has(affected.issueKey) ? { ...affected, drift: view(byIssue.get(affected.issueKey)) } : affected
      )),
      resolvedIssues: mine
        .filter((d) => d.status === 'resolved' && !listed.has(d.issueKey))
        .map((d) => ({ issueKey: d.issueKey, ...view(d) }))
    };
  });
}

/** Counts for the summary line, over the findings this user can see. */
export function radarSummary(described) {
  let drifting = 0;
  let resolved = 0;
  for (const candidate of described) {
    for (const affected of candidate.affectedIssues) {
      if (affected.drift?.status === 'open') drifting++;
      if (affected.drift?.status === 'resolved') resolved++;
    }
    resolved += candidate.resolvedIssues.length;
  }
  return { findings: described.length, newSinceLastVisit: described.filter((c) => c.isNew).length, drifting, resolved };
}

/**
 * Records a scan and returns the findings with radar state. Never fails the scan: if the radar
 * cannot be read or saved, findings are returned without it and `radarWarning` says so.
 */
export async function trackScan(projectKey, { candidates, issueRecords, previousVisitAt = null, observedAt, confirmIssue }) {
  try {
    const now = new Date().toISOString();
    const skipReopen = confirmIssue ? await staleReopens(projectKey, candidates, confirmIssue) : new Set();
    const radar = await updateRadar(projectKey, (current) => applyScan(current, { candidates, issueRecords, now, observedAt: observedAt ?? now, skipReopen }));
    const described = describeFindings(radar, { candidates, issueRecords, previousVisitAt });
    return { candidates: described, summary: radarSummary(described), radarWarning: null };
  } catch (error) {
    console.warn(`Decision Drift Radar could not update its drift record: ${projectKey}, ${errorLabel(error)}`);
    return { candidates, summary: null, radarWarning: 'Drift history is unavailable right now. The findings below are current.' };
  }
}

/**
 * Issues this scan would reopen a resolved drift on, but whose current text, read directly with
 * `confirmIssue(issueKey)`, no longer uses the old wording. Project scans read issues through JQL
 * search, which can lag behind an edit; a direct read does not. Only issues about to be reopened
 * are read, so this is usually no extra requests at all.
 */
async function staleReopens(projectKey, candidates, confirmIssue) {
  const radar = await loadRadar(projectKey);
  const phrases = new Map();
  for (const candidate of candidates) {
    for (const affected of candidate.affectedIssues ?? []) {
      if (affected.wordingStatus !== 'outdated' || !affected.outdatedWording) continue;
      if (radar.drifts[driftId(candidate.id, affected.issueKey)]?.status !== 'resolved') continue;
      phrases.set(affected.issueKey, [...(phrases.get(affected.issueKey) ?? []), affected.outdatedWording]);
    }
  }
  const stale = new Set();
  for (const [issueKey, issuePhrases] of phrases) {
    const current = await confirmIssue(issueKey);
    if (current?.title && current.description !== undefined && !issuePhrases.some((phrase) => issueStillMentions(current, phrase))) {
      stale.add(issueKey);
    }
  }
  return stale;
}

/** When this person last opened the project's radar, or null. */
export async function lastVisit(accountId, projectKey) {
  if (!accountId) return null;
  try {
    return (await kvs.get(visitKey(accountId, projectKey)))?.at ?? null;
  } catch (error) {
    console.warn('Decision Drift Radar could not read the last visit', error);
    return null;
  }
}

/**
 * Records a visit. Call it after the scan has been tracked, so every finding first seen during
 * this visit is older than the visit and does not count as new next time.
 */
export async function saveVisit(accountId, projectKey) {
  if (!accountId) return;
  try {
    await kvs.set(visitKey(accountId, projectKey), { at: new Date().toISOString() });
  } catch (error) {
    console.warn('Decision Drift Radar could not record the visit', error);
  }
}

/**
 * Jira trigger (avi:jira:updated:issue). When an issue's summary or description changes, any open
 * drift for that issue whose outdated wording is gone is marked resolved. Reads only that issue,
 * as the app, and stores only the resolution time.
 */
export async function onIssueUpdated(event) {
  const issueKey = String(event?.issue?.key ?? '');
  if (!/^[A-Z][A-Z0-9_]{1,9}-\d+$/.test(issueKey)) return { checked: 0, resolved: 0 };
  const changedText = (event?.changelog?.items ?? []).some((item) => ['description', 'summary'].includes(item?.fieldId ?? item?.field));
  if (!changedText) return { checked: 0, resolved: 0 };

  const projectKey = String(event?.issue?.fields?.project?.key ?? issueKey.split('-')[0]);
  if (!/^[A-Z][A-Z0-9_]{1,9}$/.test(projectKey)) return { checked: 0, resolved: 0 };
  const openFor = (radar) => Object.entries(radar.drifts).filter(([, d]) => d.issueKey === issueKey && d.status === 'open');
  const open = openFor(await loadRadar(projectKey));
  if (open.length === 0) return { checked: 0, resolved: 0 };

  // Taken before the read, so this observation is never treated as newer than what it saw.
  const observedAt = new Date().toISOString();
  const response = await api.asApp().requestJira(route`/rest/api/3/issue/${issueKey}?fields=summary,description`);
  if (!response.ok) {
    console.warn(`Decision Drift Radar could not read ${issueKey} after an update (HTTP ${response.status})`);
    return { checked: open.length, resolved: 0 };
  }
  const fields = (await response.json())?.fields;
  if (!fields?.summary || !Object.hasOwn(fields, 'description')) {
    return { checked: open.length, resolved: 0 };
  }
  const issue = { title: fields.summary, description: adfToText(fields.description) };

  // Re-applied to the latest stored radar if a scan saved in between; repeated events find nothing open.
  let resolved = 0;
  await updateRadar(projectKey, (current) => {
    const next = structuredClone(current);
    resolved = 0;
    const now = new Date().toISOString();
    for (const [id, drift] of openFor(next)) {
      if (newerThan(drift, observedAt) || issueStillMentions(issue, drift.phrase)) continue;
      next.drifts[id] = { ...drift, status: 'resolved', resolvedAt: now, resolvedBy: 'issue-update', observedAt };
      resolved++;
    }
    return { radar: next, changed: resolved > 0 };
  });
  // Issue key and counts only, so the trigger can be checked in `forge logs` without content.
  console.info(`Decision Drift Radar issue-update check: ${issueKey}, ${open.length} open, ${resolved} resolved`);
  return { checked: open.length, resolved };
}
