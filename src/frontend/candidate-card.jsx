import React from 'react';
import { Button, Em, Inline, Link, Lozenge, Stack, Strong, Text } from '@forge/react';

/**
 * Absolute link for the current site. The resolver returns Jira links as site-relative paths
 * (`/browse/MC-1`); Confluence links are already absolute. Returns null when no valid link exists.
 */
export function siteLink(siteUrl, url) {
  if (!url) return null;
  if (/^https:\/\//i.test(url)) return url;
  if (url.startsWith('/') && siteUrl) return `${String(siteUrl).replace(/\/+$/, '')}${url}`;
  return null;
}

export const KIND_GROUPS = [
  { kind: 'decision', title: 'Decisions' },
  { kind: 'open_question', title: 'Open questions' },
  { kind: 'proposal', title: 'Proposals' }
];

const KIND_LABEL = {
  decision: { text: 'Decision', appearance: 'success' },
  open_question: { text: 'Open question', appearance: 'moved' },
  proposal: { text: 'Proposal', appearance: 'new' }
};

const SOURCE_LABEL = {
  confluence_page: 'Confluence page',
  jira_issue: 'Jira issue',
  jira_comment: 'Jira comment'
};

function sourceMeta(source) {
  const date = /^\d{4}-\d{2}-\d{2}/.test(source.updatedAt ?? '') ? source.updatedAt.slice(0, 10) : null;
  return [SOURCE_LABEL[source.type] ?? source.type, date, source.author].filter(Boolean).join(' · ');
}

/**
 * One extracted candidate with its evidence and the reasons behind every match.
 * `issueUrls` maps issue keys to links; `hideIssueKeys` skips the key on the issue panel.
 */
export function CandidateCard({ candidate, siteUrl, issueUrls = {}, hideIssueKeys = false, onReview, reviewBusy = false }) {
  const kind = KIND_LABEL[candidate.kind] ?? KIND_LABEL.proposal;
  const { source } = candidate;
  const sourceHref = siteLink(siteUrl, source.url);

  return (
    <Stack space="space.075">
      <Inline space="space.100" alignBlock="center">
        <Lozenge appearance={kind.appearance}>{kind.text}</Lozenge>
        <Text>{sourceHref ? <Link href={sourceHref}>{source.title || 'Source'}</Link> : source.title}</Text>
      </Inline>
      <Text><Strong>{candidate.summary}</Strong></Text>
      <Text><Em>“{candidate.evidence.quote}”</Em></Text>
      <Text>{sourceMeta(source)}</Text>
      <Text>
        Wording signals ({candidate.confidence.toFixed(2)}): {candidate.confidenceReasons.join('; ')}
      </Text>

      <Stack space="space.050">
        {candidate.review ? (
          <Inline space="space.100" alignBlock="center">
            <Lozenge appearance={candidate.review.status === 'relevant' ? 'success' : 'removed'}>
              {candidate.review.status === 'relevant' ? 'Marked relevant' : 'Dismissed'}
            </Lozenge>
            <Text>Reviewed {candidate.review.reviewedAt ? new Date(candidate.review.reviewedAt).toLocaleDateString() : ''}</Text>
          </Inline>
        ) : <Text>Needs teammate review</Text>}
        {onReview && (
          <Inline space="space.100">
            {!candidate.review && <>
              <Button appearance="primary" isDisabled={reviewBusy} onClick={() => onReview('relevant')}>
                Mark relevant
              </Button>
              <Button appearance="subtle" isDisabled={reviewBusy} onClick={() => onReview('dismissed')}>
                Dismiss
              </Button>
            </>}
            {candidate.review && (
              <Button appearance="subtle" isDisabled={reviewBusy} onClick={() => onReview('reset')}>
                Undo review
              </Button>
            )}
          </Inline>
        )}
      </Stack>

      {candidate.affectedIssues.length > 0 ? (
        <Stack space="space.050">
          {!hideIssueKeys && <Text><Strong>May affect</Strong></Text>}
          {candidate.affectedIssues.map((affected) => (
            <Stack key={affected.issueKey} space="space.025">
              <Text>
                {hideIssueKeys ? 'Why this issue' : (() => {
                  const href = siteLink(siteUrl, issueUrls[affected.issueKey] ?? `/browse/${affected.issueKey}`);
                  return href ? <Link href={href}>{affected.issueKey}</Link> : affected.issueKey;
                })()}
                {` · relevance ${affected.relevance.toFixed(2)}`}
              </Text>
              {affected.reasons.map((reason) => <Text key={reason}>• {reason}</Text>)}
            </Stack>
          ))}
        </Stack>
      ) : (
        <Text>No Jira issue in this project clearly points at this. Review it manually.</Text>
      )}
    </Stack>
  );
}
