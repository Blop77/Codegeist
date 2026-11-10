import type { DecisionDraft } from './extract.ts';
import { daysBetween } from './text.ts';
import type { IssueMatch, JiraIssueRecord, PrioritySignal, PriorityTier } from './types.ts';

const BLOCKED = /\bblock(?:ed|er)?\b|\bimpeded\b|\bon hold\b/i;

/**
 * Orders candidates with visible signals. Weights only decide order; the reviewer sees
 * the tier and the signal labels, never a number presented as certainty.
 */
export function prioritize(
  draft: DecisionDraft,
  matches: IssueMatch[],
  issuesByKey: Map<string, JiraIssueRecord>,
  now: string,
): { tier: PriorityTier; signals: PrioritySignal[]; points: number } {
  const signals: PrioritySignal[] = [];
  const add = (code: string, label: string, weight: number) => signals.push({ code, label, weight });

  if (draft.kind === 'explicit') add('explicit-decision', 'Stated as a decision', 3);
  else if (draft.kind === 'possible') add('possible-decision', 'A proposal, not yet a decision', 1);
  else add('open-question', 'An open question that may block work', 1);

  if (draft.flags.markedDecision) add('confluence-decision', 'Marked as a decision item in Confluence', 2);
  if (draft.flags.decisionSection) add('decision-section', 'Listed under a decisions heading', 1);
  if (draft.flags.authoritativeSource) add('authoritative-source', 'From a decision record or design doc', 1);

  const age = daysBetween(draft.sourceUpdatedAt, now);
  if (age <= 14) add('recent', `Recorded ${Math.max(0, Math.round(age))} days ago`, 2);
  else if (age <= 45) add('recent', `Recorded ${Math.round(age)} days ago`, 1);

  if (matches.length === 0) {
    add('no-affected-work', 'No affected Jira issue found in scope', -3);
  } else {
    const stale = matches.filter((m) => m.drift === 'stale-reference');
    const open = matches.filter((m) => m.drift !== 'possibly-reflected');
    if (stale.length > 0) add('stale-reference', `${stale.length} issue(s) still describe the old plan`, 3);
    else if (open.length > 0) add('not-reflected', `${open.length} issue(s) show no sign of the decision`, 1);
    else add('possibly-reflected', 'Every matched issue may already reflect it', -2);

    if (matches.some((m) => m.strength === 'strong')) add('strong-match', 'Strongly linked to affected work', 2);
    else add('moderate-match', 'Moderately linked to affected work', 1);

    const affected = open.map((m) => issuesByKey.get(m.issueKey)).filter((i): i is JiraIssueRecord => Boolean(i));
    if (affected.some((i) => i.flagged || BLOCKED.test(i.status))) add('blocked-work', 'Affects blocked work', 2);
    else if (affected.some((i) => i.statusCategory === 'in-progress')) add('active-work', 'Affects work in progress', 1);
    else if (affected.length > 0 && affected.every((i) => i.statusCategory === 'done')) add('done-work', 'Affected work is already done', -2);
  }

  const points = signals.reduce((sum, s) => sum + s.weight, 0);
  const tier: PriorityTier = points >= 9 ? 'high' : points >= 5 ? 'medium' : 'low';
  return { tier, signals, points };
}
