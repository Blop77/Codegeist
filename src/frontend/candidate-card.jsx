import React, { useState } from 'react';
import { Button, Em, Inline, Link, Lozenge, SectionMessage, Stack, Strong, Text, TextArea } from '@forge/react';

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

function sourceVia(source) {
  return source.via ? `Found through ${source.via}` : null;
}

export const MAX_NOTE_LENGTH = 2000;

/** Payload for the `applyDecisionNote` resolver. The source link is made absolute for the comment. */
export function notePayload(candidate, siteUrl, issueKey, note) {
  return {
    projectKey: candidate.source.projectKey,
    candidateId: candidate.id,
    issueKey,
    note,
    quote: candidate.evidence.quote,
    sourceTitle: candidate.source.title,
    sourceUrl: siteLink(siteUrl, candidate.source.url)
  };
}

/** Payload for the `draftDecisionNote` resolver. */
export function draftPayload(candidate, issueKey) {
  return { projectKey: candidate.source.projectKey, candidateId: candidate.id, issueKey };
}

/** Records a posted note on the matching candidate in a scan result. */
export function withNote(result, candidateId, issueKey, note) {
  return result && {
    ...result,
    candidates: result.candidates.map((item) => (
      item.id === candidateId ? { ...item, notes: { ...(item.notes ?? {}), [issueKey]: note } } : item
    ))
  };
}

/** The note offered for editing before it is posted. Uses only the finding's own words. */
export function defaultNote(candidate) {
  const where = SOURCE_LABEL[candidate.source.type]?.toLowerCase() ?? 'source';
  const label = candidate.kind === 'decision' ? 'A decision' : candidate.kind === 'open_question' ? 'An open question' : 'A proposal';
  return `${label} recorded in a ${where} may affect this issue: ${candidate.summary}\nPlease check whether this issue needs updating.`;
}

/**
 * Review, edit and confirm one note before it is posted as a Jira comment. Nothing is sent
 * until "Post comment" is selected.
 */
function NoteAction({ candidate, issueKey, siteUrl, onApplyNote, onDraftNote }) {
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [message, setMessage] = useState(null);
  const [draftInfo, setDraftInfo] = useState(null);
  const applied = candidate.notes?.[issueKey];

  if (applied) {
    const href = applied.commentId ? siteLink(siteUrl, `/browse/${issueKey}?focusedCommentId=${applied.commentId}`) : null;
    return (
      <Stack space="space.050">
        <Text>
          Note added to {issueKey}{applied.appliedAt ? ` on ${new Date(applied.appliedAt).toLocaleDateString()}` : ''}
          {href ? <>{' · '}<Link href={href}>View comment</Link></> : null}
        </Text>
        {message && <SectionMessage appearance="warning">{message}</SectionMessage>}
      </Stack>
    );
  }
  if (draft === null) {
    return (
      <Stack space="space.050">
        <Inline>
          <Button appearance="default" onClick={() => { setMessage(null); setDraft(defaultNote(candidate)); }}>
            Add note to {issueKey}
          </Button>
        </Inline>
        {message && <SectionMessage appearance="error">{message}</SectionMessage>}
      </Stack>
    );
  }

  const trimmed = draft.trim();
  const draftWithAi = async () => {
    setDrafting(true);
    setMessage(null);
    setDraftInfo(null);
    const result = await onDraftNote(issueKey);
    setDrafting(false);
    if (result?.ok) {
      setDraft(result.note);
      setDraftInfo(result.suggestion
        ? 'Drafted by AI. The suggested description change quotes the issue word for word. Check the note before posting.'
        : 'Drafted by AI from the finding and the issue. Check the note before posting.');
    } else {
      setMessage(result?.error ?? 'The AI could not draft a note. You can still write it yourself.');
    }
  };
  const post = async () => {
    setBusy(true);
    setMessage(null);
    const result = await onApplyNote(issueKey, trimmed);
    setBusy(false);
    if (result?.ok) {
      setDraft(null);
      setMessage(result.warning ?? null);
    } else {
      setMessage(result?.error ?? 'Could not add the note. Try again.');
    }
  };

  return (
    <Stack space="space.075">
      <Text>
        This posts one comment on {issueKey} in your name, with the note below, the quote and a link to the source.
        Edit the note first if needed.
      </Text>
      <TextArea
        name={`note-${candidate.id}-${issueKey}`}
        value={draft}
        minimumRows={6}
        resize="vertical"
        onChange={(event) => setDraft(event.target.value)}
        isDisabled={busy || drafting}
      />
      {draftInfo && <Text><Em>{draftInfo}</Em></Text>}
      {trimmed.length > MAX_NOTE_LENGTH && <Text>The note is too long ({trimmed.length} of {MAX_NOTE_LENGTH} characters).</Text>}
      {message && <SectionMessage appearance="error">{message}</SectionMessage>}
      <Inline space="space.100">
        <Button appearance="primary" isDisabled={busy || drafting || !trimmed || trimmed.length > MAX_NOTE_LENGTH} onClick={post}>
          {busy ? 'Posting…' : `Post comment to ${issueKey}`}
        </Button>
        {onDraftNote && (
          <Button appearance="default" isDisabled={busy || drafting} onClick={draftWithAi}>
            {drafting ? 'Drafting…' : 'Draft with AI'}
          </Button>
        )}
        <Button appearance="subtle" isDisabled={busy || drafting} onClick={() => { setDraft(null); setMessage(null); setDraftInfo(null); }}>
          Cancel
        </Button>
      </Inline>
    </Stack>
  );
}

/**
 * One extracted candidate with its evidence and the reasons behind every match.
 * `issueUrls` maps issue keys to links; `hideIssueKeys` skips the key on the issue panel.
 * `onApplyNote(issueKey, note)` posts a reviewed note; it is offered only once the finding
 * is marked relevant. `onDraftNote(issueKey)` asks the AI for a draft the person then edits. `sample` marks a finding from the bundled sample project: it has no
 * links on this site and cannot be reviewed.
 */
export function CandidateCard({ candidate, siteUrl, issueUrls = {}, hideIssueKeys = false, onReview, reviewBusy = false, onApplyNote, onDraftNote, sample = false }) {
  const kind = KIND_LABEL[candidate.kind] ?? KIND_LABEL.proposal;
  const { source } = candidate;
  const sourceHref = siteLink(siteUrl, source.url);
  const canNote = Boolean(onApplyNote) && candidate.review?.status === 'relevant';

  return (
    <Stack space="space.075">
      <Inline space="space.100" alignBlock="center">
        <Lozenge appearance={kind.appearance}>{kind.text}</Lozenge>
        {candidate.ai && <Lozenge appearance="new">Found by AI</Lozenge>}
        <Text>{sourceHref ? <Link href={sourceHref}>{source.title || 'Source'}</Link> : source.title}</Text>
      </Inline>
      <Text><Strong>{candidate.summary}</Strong></Text>
      <Text><Em>“{candidate.evidence.quote}”</Em></Text>
      <Text>{sourceMeta(source)}</Text>
      {sourceVia(source) && <Text><Em>{sourceVia(source)}</Em></Text>}
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
        ) : <Text>{sample ? 'On a real project scan, teammates review each finding here and can post a note to the issue.' : 'Needs teammate review'}</Text>}
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
            {canNote && candidate.affectedIssues.length > 0 && <Text>You can now add a note to an affected issue below.</Text>}
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
                  const href = sample ? null : siteLink(siteUrl, issueUrls[affected.issueKey] ?? `/browse/${affected.issueKey}`);
                  return href ? <Link href={href}>{affected.issueKey}</Link> : affected.issueKey;
                })()}
                {` · relevance ${affected.relevance.toFixed(2)}`}
              </Text>
              {affected.reasons.map((reason) => <Text key={reason}>• {reason}</Text>)}
              {(canNote || candidate.notes?.[affected.issueKey]) && (
                <NoteAction candidate={candidate} issueKey={affected.issueKey} siteUrl={siteUrl} onApplyNote={onApplyNote} onDraftNote={onDraftNote} />
              )}
            </Stack>
          ))}
        </Stack>
      ) : (
        <Text>No Jira issue in this project clearly points at this. Review it manually.</Text>
      )}
    </Stack>
  );
}
