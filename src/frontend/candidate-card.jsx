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

/**
 * Payload for the preview and note resolvers. `digest` identifies the exact comment preview the
 * person confirmed; the server posts only if its rebuilt comment still matches it.
 */
export function notePayload(candidate, issueKey, note, digest) {
  return {
    projectKey: candidate.source.projectKey,
    candidateId: candidate.id,
    issueKey,
    note,
    ...(digest ? { digest } : {})
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

/** The exact comment text, line by line, as the server built it. */
export function CommentPreview({ preview, title = 'Comment preview: exactly what will be posted' }) {
  return (
    <SectionMessage appearance={preview.mode === 'quoted' ? 'information' : 'warning'} title={title}>
      <Stack space="space.050">
        {preview.explanation && <Text><Em>{preview.explanation}</Em></Text>}
        {preview.text.split('\n').map((line, index) => <Text key={index}>{index === 0 ? <Strong>{line}</Strong> : line}</Text>)}
      </Stack>
    </SectionMessage>
  );
}

/**
 * Review and confirm one comment before it is posted. The server builds the exact comment; nothing
 * is sent until "Post" is selected on that preview. When the source cannot be quoted to the
 * issue's audience, the comment is a fixed follow-up and there is no note to edit. In the sample,
 * the preview is built from bundled data and nothing can be posted.
 */
function NoteAction({ candidate, issueKey, siteUrl, onApplyNote, onPreviewNote, onDraftNote, sample = false }) {
  const [draft, setDraft] = useState(null);
  const [preview, setPreview] = useState(null);
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

  const showPreview = async (note) => {
    setBusy(true);
    setMessage(null);
    const result = await onPreviewNote(issueKey, note);
    setBusy(false);
    if (result?.ok) setPreview(result);
    else setMessage(result?.error ?? 'Could not prepare the comment preview. Try again.');
  };

  if (draft === null) {
    return (
      <Stack space="space.050">
        <Inline>
          <Button appearance="default" isDisabled={busy} onClick={async () => {
            const note = defaultNote(candidate);
            setDraft(note);
            await showPreview(note);
          }}>
            {sample ? `Preview a note for ${issueKey}` : `Add note to ${issueKey}`}
          </Button>
        </Inline>
        {message && <SectionMessage appearance="error">{message}</SectionMessage>}
      </Stack>
    );
  }

  const trimmed = draft.trim();
  const generic = preview?.mode === 'generic';
  const current = preview && (generic || preview.note === trimmed);
  const draftWithAi = async () => {
    setDrafting(true);
    setMessage(null);
    setDraftInfo(null);
    const result = await onDraftNote(issueKey);
    setDrafting(false);
    if (result?.ok) {
      setDraft(result.note);
      setPreview(null);
      setDraftInfo(result.suggestion
        ? 'Drafted by AI. The suggested description change quotes the issue word for word. Check the note, then preview the comment.'
        : 'Drafted by AI from the finding and the issue. Check the note, then preview the comment.');
    } else {
      setMessage(result?.error ?? 'The AI could not draft a note. You can still write it yourself.');
    }
  };
  const post = async () => {
    setBusy(true);
    setMessage(null);
    const result = await onApplyNote(issueKey, generic ? '' : trimmed, preview.digest);
    setBusy(false);
    if (result?.ok) {
      setDraft(null);
      setPreview(null);
      setMessage(result.warning ?? null);
    } else {
      if (result?.preview) setPreview(result.preview);
      setMessage(result?.error ?? 'Could not add the note. Try again.');
    }
  };
  const cancel = () => { setDraft(null); setPreview(null); setMessage(null); setDraftInfo(null); };

  return (
    <Stack space="space.075">
      {sample && (
        <SectionMessage appearance="information" title="Sample only">
          This shows what a teammate would see before posting. Nothing is saved, and nothing is posted to Jira.
        </SectionMessage>
      )}
      {!generic && (
        <>
          <Text>Edit the note, then preview the exact comment. It is posted on {issueKey} in your name.</Text>
          <TextArea
            name={`note-${candidate.id}-${issueKey}`}
            value={draft}
            minimumRows={5}
            resize="vertical"
            onChange={(event) => setDraft(event.target.value)}
            isDisabled={busy || drafting}
          />
          {draftInfo && <Text><Em>{draftInfo}</Em></Text>}
          {trimmed.length > MAX_NOTE_LENGTH && <Text>The note is too long ({trimmed.length} of {MAX_NOTE_LENGTH} characters).</Text>}
        </>
      )}
      {preview && current && <CommentPreview preview={preview} />}
      {message && <SectionMessage appearance="error">{message}</SectionMessage>}
      <Inline space="space.100">
        {!generic && !current && (
          <Button appearance="primary" isDisabled={busy || drafting || !trimmed || trimmed.length > MAX_NOTE_LENGTH} onClick={() => showPreview(trimmed)}>
            {busy ? 'Preparing…' : 'Preview comment'}
          </Button>
        )}
        {current && !sample && (
          <Button appearance="primary" isDisabled={busy || drafting} onClick={post}>
            {busy ? 'Posting…' : generic ? `Post follow-up to ${issueKey}` : `Post comment to ${issueKey}`}
          </Button>
        )}
        {onDraftNote && !generic && !sample && (
          <Button appearance="default" isDisabled={busy || drafting} onClick={draftWithAi}>
            {drafting ? 'Drafting…' : 'Draft with AI'}
          </Button>
        )}
        <Button appearance="subtle" isDisabled={busy || drafting} onClick={cancel}>{sample ? 'Close preview' : 'Cancel'}</Button>
      </Inline>
    </Stack>
  );
}

/** How strongly an issue is tied to the finding, in words, from the matcher's score. */
export function matchStrength(affected) {
  if (affected.wordingStatus === 'outdated') return 'Strong match: still uses the replaced wording';
  if (affected.relevance >= 0.75) return 'Strong match';
  if (affected.relevance >= 0.45) return 'Possible match';
  return 'Weak match';
}

/**
 * One extracted candidate with its evidence and the reasons behind every match.
 * `issueUrls` maps issue keys to links; `hideIssueKeys` skips the key on the issue panel.
 * `onApplyNote(issueKey, note)` posts a reviewed note; it is offered only once the finding
 * is marked relevant. `onDraftNote(issueKey)` asks the AI for a draft the person then edits. `sample` marks a finding from the bundled sample project: it has no
 * links on this site and cannot be reviewed.
 */
const shortDate = (value) => (value ? new Date(value).toLocaleDateString() : '');

/** One line on whether the issue still uses the replaced wording, from the radar's history. */
function DriftLine({ drift }) {
  if (!drift) return null;
  if (drift.status === 'resolved') {
    // Removing the old wording is all the app has verified; a replacement is shown only when the
    // decision names one and the issue's current text contains it.
    return (
      <Stack space="space.025">
        {/* The labels get their own row: sharing it with the sentence squeezed them to "Old wor…" in the narrow issue panel. */}
        <Inline space="space.100" alignBlock="center" shouldWrap>
          <Lozenge appearance="success">Old wording removed</Lozenge>
          {drift.replacementFound && <Lozenge appearance="success">Replacement wording found</Lozenge>}
        </Inline>
        <Text>
          No longer mentions “{drift.phrase}” · {shortDate(drift.resolvedAt)}
          {drift.resolvedBy === 'issue-update' ? ' · noticed when the issue was edited' : ' · found by a later scan'}
        </Text>
        {drift.replacement && (
          <Text>
            <Em>
              {drift.replacementFound
                ? `Now mentions “${drift.replacement}”, the wording the decision asks for.`
                : `The decision's wording (“${drift.replacement}”) is not in the issue yet. Check the issue says what was decided.`}
            </Em>
          </Text>
        )}
      </Stack>
    );
  }
  return <Text><Em>Drifting since {shortDate(drift.firstSeenAt)}: the issue still says “{drift.phrase}”.</Em></Text>;
}

export function CandidateCard({ candidate, siteUrl, issueUrls = {}, hideIssueKeys = false, onReview, reviewBusy = false, onApplyNote, onPreviewNote, onDraftNote, sample = false }) {
  const kind = KIND_LABEL[candidate.kind] ?? KIND_LABEL.proposal;
  const { source } = candidate;
  const sourceHref = siteLink(siteUrl, source.url);
  // Sample reviews live only in this page's memory: they are never saved.
  const [sampleReview, setSampleReview] = useState(null);
  const review = sample ? sampleReview : candidate.review;
  const canNote = (sample ? Boolean(onPreviewNote) : Boolean(onApplyNote)) && review?.status === 'relevant';
  const reviewWith = sample
    ? (choice) => setSampleReview(choice === 'reset' ? null : { status: choice, reviewedAt: null })
    : onReview;

  return (
    <Stack space="space.075">
      <Inline space="space.100" alignBlock="center">
        <Lozenge appearance={kind.appearance}>{kind.text}</Lozenge>
        {candidate.ai && <Lozenge appearance="new">Found by AI</Lozenge>}
        {candidate.isNew && <Lozenge appearance="inprogress">New since your last visit</Lozenge>}
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
        {candidate.ai && !review && (
          <Text><Em>Found by AI. The quote is checked word for word against the source; whether it records a real decision needs a teammate's review.</Em></Text>
        )}
        {review ? (
          <Inline space="space.100" alignBlock="center">
            <Lozenge appearance={review.status === 'relevant' ? 'success' : 'removed'}>
              {review.status === 'relevant' ? 'Marked relevant' : 'Dismissed'}
            </Lozenge>
            <Text>{sample ? 'Sample only: not saved' : `Reviewed ${review.reviewedAt ? new Date(review.reviewedAt).toLocaleDateString() : ''}`}</Text>
          </Inline>
        ) : <Text>{sample ? 'Sample: try the review a teammate would do. Nothing is saved.' : 'Needs teammate review'}</Text>}
        {reviewWith && (
          <Inline space="space.100">
            {!review && <>
              <Button appearance="primary" isDisabled={reviewBusy} onClick={() => reviewWith('relevant')}>
                {sample ? 'Mark relevant (sample)' : 'Mark relevant'}
              </Button>
              <Button appearance="subtle" isDisabled={reviewBusy} onClick={() => reviewWith('dismissed')}>
                {sample ? 'Dismiss (sample)' : 'Dismiss'}
              </Button>
            </>}
            {review && (
              <Button appearance="subtle" isDisabled={reviewBusy} onClick={() => reviewWith('reset')}>
                Undo review
              </Button>
            )}
            {canNote && candidate.affectedIssues.length > 0 && <Text>{sample ? 'You can now preview the note for an affected issue below.' : 'You can now add a note to an affected issue below.'}</Text>}
          </Inline>
        )}
      </Stack>

      {candidate.affectedIssues.length > 0 ? (
        <Stack space="space.050">
          {!hideIssueKeys && <Text><Strong>May affect</Strong></Text>}
          {candidate.affectedIssues.map((affected) => (
            <Stack key={affected.issueKey} space="space.025">
              <Inline space="space.100" alignBlock="center">
                <Text>
                  {hideIssueKeys ? 'Why this issue' : (() => {
                    const href = sample ? null : siteLink(siteUrl, issueUrls[affected.issueKey] ?? `/browse/${affected.issueKey}`);
                    return href ? <Link href={href}>{affected.issueKey}</Link> : affected.issueKey;
                  })()}
                  {` · ${matchStrength(affected)}`}
                </Text>
                {affected.wordingStatus === 'outdated' && <Lozenge appearance="moved">Outdated wording found</Lozenge>}
                {affected.wordingStatus === 'replacement-found' && <Lozenge appearance="success">Replacement wording found</Lozenge>}
              </Inline>
              {affected.reasons.map((reason) => <Text key={reason}>• {reason}</Text>)}
              <Text><Em>Match score {affected.relevance.toFixed(2)}: a signal strength from these reasons, not a probability.</Em></Text>
              <DriftLine drift={affected.drift} />
              {(canNote || candidate.notes?.[affected.issueKey]) && (
                <NoteAction
                  candidate={candidate}
                  issueKey={affected.issueKey}
                  siteUrl={siteUrl}
                  onApplyNote={onApplyNote}
                  onPreviewNote={onPreviewNote}
                  onDraftNote={onDraftNote}
                  sample={sample}
                />
              )}
            </Stack>
          ))}
        </Stack>
      ) : (
        <Text>No Jira issue in this project clearly points at this. Review it manually.</Text>
      )}
      {(candidate.resolvedIssues ?? []).length > 0 && (
        <Stack space="space.050">
          <Text><Strong>Resolved since it was found</Strong></Text>
          {candidate.resolvedIssues.map((resolved) => {
            const href = sample ? null : siteLink(siteUrl, issueUrls[resolved.issueKey] ?? `/browse/${resolved.issueKey}`);
            return (
              <Stack key={resolved.issueKey} space="space.025">
                <Text>{href ? <Link href={href}>{resolved.issueKey}</Link> : resolved.issueKey}</Text>
                <DriftLine drift={resolved} />
              </Stack>
            );
          })}
        </Stack>
      )}
    </Stack>
  );
}
