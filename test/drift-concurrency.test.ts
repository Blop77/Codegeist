/**
 * The radar record is shared by scans and the issue-update trigger, which run in separate Forge
 * invocations. These tests force two invocations to read the same version before either writes
 * (the race that loses an update with a plain read-then-rewrite), and check ordering, repeated
 * events, migration from the old single-key record, and what a viewer may see.
 * Fictional fixtures; Forge is replaced by the in-memory mocks in test/mocks.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const g = globalThis as any;
const { applyScan, describeFindings, onIssueUpdated, radarSummary, trackScan, updateRadar } = await import('../src/resolvers/drift.js');
const { kvsMemory } = await import('./mocks/kvs.mjs');

const STATE = (projectKey: string) => `radar-state:${projectKey}`;
const stored = (projectKey = 'DD') => kvsMemory.get(STATE(projectKey))?.radar;
/** Fixed times well in the past, so real-clock observations made during the test are newer. */
const t = (minute: number) => `2026-01-01T10:${String(minute).padStart(2, '0')}:00.000Z`;

const open = (findingId: string, issueKey: string, phrase: string, observedAt = t(0)) =>
  ({ findingId, issueKey, phrase, status: 'open', firstSeenAt: t(0), observedAt });
const seed = (drifts: Record<string, unknown>, projectKey = 'DD') => {
  kvsMemory.clear();
  kvsMemory.set(STATE(projectKey), { projectKey, version: 1, radar: { findings: {}, drifts }, updatedAt: t(0) });
};

/** Holds the first `n` reads of `key` until all of them have read, then lets them continue. */
function interleaveReads(key: string, n = 2) {
  const waiting: Array<() => void> = [];
  let reads = 0;
  g.__kvsHook = async (op: string, k: string) => {
    if (op !== 'get' || k !== key || reads >= n) return;
    reads++;
    await new Promise<void>((resolve) => {
      waiting.push(resolve);
      if (waiting.length === n) waiting.forEach((release) => release());
    });
  };
  return () => {
    g.__kvsHook = undefined;
    return reads;
  };
}

// Jira, as read by the trigger (as the app).
const issueText: Record<string, { summary: string; description: unknown }> = {};
const adf = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
g.__jira = (path: string, json: any) => {
  const key = /\/issue\/([A-Z]+-\d+)\?/.exec(path)?.[1];
  return key && issueText[key] ? json({ fields: issueText[key] }) : json({}, 404);
};
const edit = (issueKey: string) => ({ issue: { key: issueKey, fields: { project: { key: 'DD' } } }, changelog: { items: [{ fieldId: 'description' }] } });
const finding = (id: string, affected: unknown[]) => ({ id, affectedIssues: affected });
const outdated = (issueKey: string, phrase: string) => ({ issueKey, relevance: 0.9, reasons: [], wordingStatus: 'outdated', outdatedWording: phrase });

test('concurrent updates to different issues both survive', async () => {
  seed({ 'dc_a:DD-1': open('dc_a', 'DD-1', 'on Mondays'), 'dc_b:DD-2': open('dc_b', 'DD-2', 'separate channel plans') });
  const done = interleaveReads(STATE('DD'));
  const resolve = (id: string) => (radar: any) => {
    const next = structuredClone(radar);
    next.drifts[id] = { ...next.drifts[id], status: 'resolved', resolvedAt: t(5), resolvedBy: 'issue-update' };
    return { radar: next, changed: true };
  };
  await Promise.all([updateRadar('DD', resolve('dc_a:DD-1')), updateRadar('DD', resolve('dc_b:DD-2'))]);
  assert.equal(done(), 2, 'both invocations read the same version before writing');
  assert.equal(stored().drifts['dc_a:DD-1'].status, 'resolved');
  assert.equal(stored().drifts['dc_b:DD-2'].status, 'resolved', 'the second writer re-read and kept the first writer’s change');
  assert.equal(kvsMemory.get(STATE('DD')).version, 3);
});

test('two triggers for different issues at once both resolve', async () => {
  seed({ 'dc_a:DD-1': open('dc_a', 'DD-1', 'on Mondays'), 'dc_b:DD-2': open('dc_b', 'DD-2', 'separate channel plans') });
  issueText['DD-1'] = { summary: 'Status updates', description: adf('Status updates go out on Fridays.') };
  issueText['DD-2'] = { summary: 'Launch plan', description: adf('Follows one shared launch plan.') };
  const results = await Promise.all([onIssueUpdated(edit('DD-1')), onIssueUpdated(edit('DD-2'))]);
  assert.deepEqual(results.map((r: any) => r.resolved), [1, 1]);
  assert.deepEqual(Object.values(stored().drifts).map((d: any) => d.status), ['resolved', 'resolved']);
});

test('a scan that read the issue before the trigger cannot reopen what the trigger resolved', async () => {
  seed({ 'dc_a:DD-1': open('dc_a', 'DD-1', 'on Mondays') });
  // The scan reads DD-1 while it still says "on Mondays". Then someone edits it, the trigger
  // resolves the drift, and only after that does the slow scan save what it saw.
  const scanReadAt = new Date(Date.now() - 60_000).toISOString();
  issueText['DD-1'] = { summary: 'Status updates', description: adf('Status updates go out on Fridays.') };
  assert.deepEqual(await onIssueUpdated(edit('DD-1')), { checked: 1, resolved: 1 });
  const tracked = await trackScan('DD', {
    candidates: [finding('dc_a', [outdated('DD-1', 'on Mondays')])],
    issueRecords: [{ key: 'DD-1', title: 'Status updates', description: 'Status updates go out on Mondays.' }],
    observedAt: scanReadAt
  });
  const drift = stored().drifts['dc_a:DD-1'];
  assert.equal(drift.status, 'resolved', 'the older observation did not overwrite the newer one');
  assert.equal(drift.resolvedBy, 'issue-update');
  assert.equal(tracked.candidates[0].affectedIssues[0].drift.status, 'resolved', 'the slow scan reports the newer state');

  // The scan and the trigger reading the same version at the same time also end resolved.
  seed({ 'dc_a:DD-1': open('dc_a', 'DD-1', 'on Mondays') });
  const done = interleaveReads(STATE('DD'));
  await Promise.all([
    onIssueUpdated(edit('DD-1')),
    trackScan('DD', {
      candidates: [finding('dc_a', [outdated('DD-1', 'on Mondays')])],
      issueRecords: [{ key: 'DD-1', title: 'Status updates', description: 'Status updates go out on Mondays.' }],
      observedAt: scanReadAt
    })
  ]);
  done();
  assert.equal(stored().drifts['dc_a:DD-1'].status, 'resolved');
});

test('an older trigger observation cannot resolve a drift a newer scan confirmed', () => {
  const radar = { findings: { dc_a: { firstSeenAt: t(0) } }, drifts: { 'dc_a:DD-1': open('dc_a', 'DD-1', 'on Mondays', t(8)) } };
  const issue = { key: 'DD-1', title: 'Status updates', description: 'Status updates go out on Fridays.' };
  const stale = applyScan(radar, { candidates: [finding('dc_a', [])], issueRecords: [issue], now: t(9), observedAt: t(7) });
  assert.equal(stale.radar.drifts['dc_a:DD-1'].status, 'open');
  assert.equal(stale.changed, false);
  const fresh = applyScan(radar, { candidates: [finding('dc_a', [])], issueRecords: [issue], now: t(9), observedAt: t(9) });
  assert.equal(fresh.radar.drifts['dc_a:DD-1'].status, 'resolved');
});

test('older evidence of the old wording does not reopen a newer resolution; newer evidence does', () => {
  const resolvedDrift = { ...open('dc_a', 'DD-1', 'on Mondays'), status: 'resolved', resolvedAt: t(5), resolvedBy: 'issue-update', observedAt: t(5) };
  const radar = { findings: {}, drifts: { 'dc_a:DD-1': resolvedDrift } };
  const scan = (observedAt: string) => applyScan(radar, {
    candidates: [finding('dc_a', [outdated('DD-1', 'on Mondays')])],
    issueRecords: [{ key: 'DD-1', title: 'Status updates', description: 'Status updates go out on Mondays.' }],
    now: t(9), observedAt
  });
  assert.equal(scan(t(4)).radar.drifts['dc_a:DD-1'].status, 'resolved');
  const reopened = scan(t(6)).radar.drifts['dc_a:DD-1'];
  assert.equal(reopened.status, 'open');
  assert.equal(reopened.reopenedAt, t(9));
  assert.equal(reopened.firstSeenAt, t(0));
});

test('a repeated delivery of the same event changes nothing the second time', async () => {
  seed({ 'dc_a:DD-1': open('dc_a', 'DD-1', 'on Mondays') });
  issueText['DD-1'] = { summary: 'Status updates', description: adf('Status updates go out on Fridays.') };
  const first = await onIssueUpdated(edit('DD-1'));
  const after = structuredClone(kvsMemory.get(STATE('DD')));
  const again = await onIssueUpdated(edit('DD-1'));
  assert.deepEqual(first, { checked: 1, resolved: 1 });
  assert.deepEqual(again, { checked: 0, resolved: 0 });
  assert.deepEqual(kvsMemory.get(STATE('DD')), after, 'no second write');

  // The same event delivered twice at once: one resolves, the other re-reads and finds nothing left.
  seed({ 'dc_a:DD-1': open('dc_a', 'DD-1', 'on Mondays') });
  // Both deliveries read the open drift before either has written.
  const done = interleaveReads(STATE('DD'), 2);
  const both = await Promise.all([onIssueUpdated(edit('DD-1')), onIssueUpdated(edit('DD-1'))]);
  done();
  assert.equal(both.reduce((sum: number, r: any) => sum + r.resolved, 0), 1);
  assert.equal(stored().drifts['dc_a:DD-1'].status, 'resolved');
});

test('the trigger treats a null description as empty and still checks the summary', async () => {
  seed({ 'dc_a:DD-1': open('dc_a', 'DD-1', 'on Mondays') });
  issueText['DD-1'] = { summary: 'Status updates go out on Mondays', description: null };
  assert.deepEqual(await onIssueUpdated(edit('DD-1')), { checked: 1, resolved: 0 }, 'the summary still uses the old wording');
  issueText['DD-1'] = { summary: 'Status updates', description: null };
  assert.deepEqual(await onIssueUpdated(edit('DD-1')), { checked: 1, resolved: 1 });
});

test('history in the old single-key record is carried over, and can still reopen', async () => {
  kvsMemory.clear();
  kvsMemory.set('radar:DD', {
    findings: { dc_a: { firstSeenAt: t(0) } },
    drifts: { 'dc_a:DD-1': { findingId: 'dc_a', issueKey: 'DD-1', phrase: 'on Mondays', status: 'resolved', firstSeenAt: t(0), resolvedAt: t(3), resolvedBy: 'issue-update' } }
  });
  const issue = { key: 'DD-1', title: 'Status updates', description: 'Status updates go out on Mondays.' };
  const tracked = await trackScan('DD', { candidates: [finding('dc_a', [outdated('DD-1', 'on Mondays')])], issueRecords: [issue] });
  const drift = stored().drifts['dc_a:DD-1'];
  assert.equal(drift.status, 'open', 'the old wording came back, so the carried-over drift reopened');
  assert.equal(drift.firstSeenAt, t(0), 'its history was kept');
  assert.equal(stored().findings.dc_a.firstSeenAt, t(0));
  assert.equal(kvsMemory.get(STATE('DD')).version, 1);
  assert.equal(tracked.summary.drifting, 1);
});

test('an old single-key record is copied across on first read even when nothing changed', async () => {
  kvsMemory.clear();
  kvsMemory.set('radar:DD', { findings: { dc_a: { firstSeenAt: t(0) } }, drifts: { 'dc_a:DD-1': open('dc_a', 'DD-1', 'on Mondays') } });
  const issue = { key: 'DD-1', title: 'Status updates', description: 'Status updates go out on Mondays.' };
  await trackScan('DD', { candidates: [finding('dc_a', [outdated('DD-1', 'on Mondays')])], issueRecords: [issue] });
  assert.equal(kvsMemory.get(STATE('DD'))?.version, 1, 'the new record exists after one read');
  assert.equal(stored().drifts['dc_a:DD-1'].status, 'open');
  const writes: string[] = [];
  g.__kvsHook = async (op: string, key: string) => { if (op !== 'get') writes.push(key); };
  await trackScan('DD', { candidates: [finding('dc_a', [outdated('DD-1', 'on Mondays')])], issueRecords: [issue] });
  g.__kvsHook = undefined;
  assert.deepEqual(writes, [], 'later scans with nothing new write nothing');
});

test('a viewer sees drift history only for findings and issues their own scan read', () => {
  const radar = {
    findings: { dc_a: { firstSeenAt: t(0) }, dc_hidden: { firstSeenAt: t(0) } },
    drifts: {
      'dc_a:DD-1': open('dc_a', 'DD-1', 'on Mondays'),
      'dc_a:DD-9': { ...open('dc_a', 'DD-9', 'secret phrase'), status: 'resolved', resolvedAt: t(2), resolvedBy: 'scan' },
      'dc_hidden:DD-1': open('dc_hidden', 'DD-1', 'restricted page phrase')
    }
  };
  // The viewer's scan returned only finding dc_a (dc_hidden's source is unreadable) and only DD-1 (DD-9 is restricted).
  const described = describeFindings(radar, {
    candidates: [finding('dc_a', [outdated('DD-1', 'on Mondays')])],
    issueRecords: [{ key: 'DD-1', title: 'Status updates', description: 'on Mondays' }]
  });
  const shown = JSON.stringify(described);
  assert.ok(!shown.includes('DD-9') && !shown.includes('secret phrase'), 'an unreadable issue’s key and phrase are not shown');
  assert.ok(!shown.includes('restricted page phrase'), 'a finding the viewer cannot read is not shown');
  assert.deepEqual(radarSummary(described), { findings: 1, newSinceLastVisit: 0, drifting: 1, resolved: 0 }, 'counts cover only what the viewer can read');
});
