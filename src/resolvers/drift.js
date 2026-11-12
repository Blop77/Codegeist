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
import { kvs } from '@forge/kvs';
import { issueStillMentions } from '../domain/matchIssues';
import { adfToText } from './normalize';

const MAX_FINDINGS = 300;
const MAX_DRIFTS = 300;

const radarKey = (projectKey) => `radar:${projectKey}`;
const visitKey = (accountId, projectKey) => `visit:${createHash('sha256').update(accountId).digest('hex')}:${projectKey}`;
const driftId = (findingId, issueKey) => `${findingId}:${issueKey}`;
const emptyRadar = () => ({ findings: {}, drifts: {} });

export async function loadRadar(projectKey) {
  const stored = await kvs.get(radarKey(projectKey));
  return stored && typeof stored === 'object'
    ? { findings: stored.findings ?? {}, drifts: stored.drifts ?? {} }
    : emptyRadar();
}

async function saveRadar(projectKey, radar) {
  await kvs.set(radarKey(projectKey), { ...radar, updatedAt: new Date().toISOString() });
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

/**
 * Pure: folds one scan into the radar. `candidates` are the findings the scan returned;
 * `scannedIssueKeys` are the issues whose current text the scan read.
 *
 * - A finding seen for the first time gets `firstSeenAt`.
 * - An affected issue with outdated wording opens a drift (or reopens a resolved one).
 * - An open drift is resolved only when its finding was found again AND its issue was read AND
 *   the issue no longer uses the outdated wording. A finding or issue missing from the scan
 *   (permissions, the 50-issue window, a truncated list) changes nothing.
 */
export function applyScan(radar, { candidates, scannedIssueKeys, now = new Date().toISOString() }) {
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
          status: 'open', firstSeenAt: now
        };
        changed = true;
      } else if (drift.status === 'resolved') {
        next.drifts[id] = {
          findingId: candidate.id, issueKey: affected.issueKey, phrase: affected.outdatedWording,
          status: 'open', firstSeenAt: drift.firstSeenAt, reopenedAt: now
        };
        changed = true;
      }
    }
  }

  const issues = new Set(scannedIssueKeys);
  for (const [id, drift] of Object.entries(next.drifts)) {
    if (drift.status !== 'open' || outdated.has(id)) continue;
    if (!present.has(drift.findingId) || !issues.has(drift.issueKey)) continue;
    next.drifts[id] = { ...drift, status: 'resolved', resolvedAt: now, resolvedBy: 'scan' };
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
export function describeFindings(radar, candidates, previousVisitAt = null) {
  const drifts = Object.values(radar.drifts);
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
export async function trackScan(projectKey, { candidates, scannedIssueKeys, previousVisitAt = null }) {
  try {
    const { radar, changed } = applyScan(await loadRadar(projectKey), { candidates, scannedIssueKeys });
    if (changed) await saveRadar(projectKey, radar);
    const described = describeFindings(radar, candidates, previousVisitAt);
    return { candidates: described, summary: radarSummary(described), radarWarning: null };
  } catch (error) {
    console.warn('Decision Drift Radar could not update its drift record', error);
    return { candidates, summary: null, radarWarning: 'Drift history is unavailable right now. The findings below are current.' };
  }
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
  const radar = await loadRadar(projectKey);
  const open = Object.entries(radar.drifts).filter(([, d]) => d.issueKey === issueKey && d.status === 'open');
  if (open.length === 0) return { checked: 0, resolved: 0 };

  const response = await api.asApp().requestJira(route`/rest/api/3/issue/${issueKey}?fields=summary,description`);
  if (!response.ok) {
    console.warn(`Decision Drift Radar could not read ${issueKey} after an update (HTTP ${response.status})`);
    return { checked: open.length, resolved: 0 };
  }
  const fields = (await response.json())?.fields ?? {};
  const issue = { title: fields.summary ?? '', description: adfToText(fields.description) };

  const now = new Date().toISOString();
  let resolved = 0;
  for (const [id, drift] of open) {
    if (issueStillMentions(issue, drift.phrase)) continue;
    radar.drifts[id] = { ...drift, status: 'resolved', resolvedAt: now, resolvedBy: 'issue-update' };
    resolved++;
  }
  if (resolved > 0) await saveRadar(projectKey, radar);
  // Issue key and counts only, so the trigger can be checked in `forge logs` without content.
  console.info(`Decision Drift Radar issue-update check: ${issueKey}, ${open.length} open, ${resolved} resolved`);
  return { checked: open.length, resolved };
}
