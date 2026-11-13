import React, { useEffect, useState } from 'react';
import ForgeReconciler, {
  Button,
  Heading,
  Inline,
  Link,
  SectionMessage,
  Spinner,
  Stack,
  Text,
  useProductContext
} from '@forge/react';
import { invoke } from '@forge/bridge';
import { CandidateCard, CommentPreview, draftPayload, notePayload, siteLink, withNote } from './candidate-card';

function IssuePanel() {
  const context = useProductContext();
  const issueKey = context?.extension?.issue?.key;
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [reviewBusyId, setReviewBusyId] = useState(null);
  const [draft, setDraft] = useState(null);
  const [draftBusy, setDraftBusy] = useState(false);
  const [draftMessage, setDraftMessage] = useState(null);
  const [draftReceipt, setDraftReceipt] = useState(null);

  useEffect(() => {
    if (!issueKey) return;

    setDraft(null);
    setDraftMessage(null);
    setDraftReceipt(null);
    let cancelled = false;
    const loadDecisionContext = async () => {
      try {
        const response = await invoke('getIssueDecisionContext', { issueKey });
        if (!cancelled) {
          if (response?.ok) setResult(response);
          else setError(response?.error ?? 'Could not load decision context for this issue.');
        }
      } catch {
        if (!cancelled) setError('Could not load decision context for this issue. Check your Jira access and try again.');
      }
    };

    loadDecisionContext();
    return () => { cancelled = true; };
  }, [issueKey]);

  const candidates = result?.candidates ?? [];

  const reviewCandidate = async (candidate, choice) => {
    setReviewBusyId(candidate.id);
    setError(null);
    try {
      const response = choice === 'reset'
        ? await invoke('clearDecisionReview', { projectKey: issueKey.split('-')[0], candidateId: candidate.id, issueKey })
        : await invoke('reviewDecision', { projectKey: issueKey.split('-')[0], candidateId: candidate.id, choice, issueKey });
      if (!response?.ok) {
        setError(response?.error ?? 'Could not save this review. Try again.');
        return;
      }
      setResult((current) => current && ({
        ...current,
        candidates: current.candidates.map((item) => (
          item.id === candidate.id ? { ...item, review: response.review ?? null } : item
        ))
      }));
    } catch {
      setError('Could not save this review. Check your connection and try again.');
    } finally {
      setReviewBusyId(null);
    }
  };

  const previewNote = async (candidate, noteIssueKey, note) => {
    try {
      return await invoke('previewDecisionNote', notePayload(candidate, noteIssueKey, note));
    } catch {
      return { ok: false, error: 'Could not prepare the comment preview. Try again.' };
    }
  };

  const applyNote = async (candidate, noteIssueKey, note, digest) => {
    try {
      const response = await invoke('applyDecisionNote', notePayload(candidate, noteIssueKey, note, digest));
      if (response?.ok) setResult((current) => withNote(current, candidate.id, noteIssueKey, response.note));
      return response;
    } catch {
      return { ok: false, error: 'Could not add the note. Check the comments on this issue before trying again.' };
    }
  };

  const loadDraft = async () => {
    setDraftBusy(true);
    setDraft(null);
    setDraftMessage(null);
    setDraftReceipt(null);
    try {
      const response = await invoke('getRovoDraft', { issueKey });
      if (response?.ok && response.draft) setDraft(response.draft);
      else setDraftMessage(response?.error ?? 'No draft for this issue. Ask Decision Drift Radar in Rovo to prepare a note.');
    } catch {
      setDraftMessage('Could not load your draft. Try again.');
    } finally {
      setDraftBusy(false);
    }
  };

  const postDraft = async () => {
    setDraftBusy(true);
    setDraftMessage(null);
    try {
      const response = await invoke('postRovoDraft', { issueKey, draftId: draft.id, digest: draft.digest });
      if (response?.ok) {
        setDraft(null);
        setDraftReceipt(response.note);
        setDraftMessage(response.warning ?? null);
        setResult((current) => withNote(current, response.candidateId, issueKey, response.note));
      } else {
        setDraftMessage(response?.error ?? 'The note could not be posted.');
      }
    } catch {
      setDraftMessage('Could not verify that the note posted. Check the issue before trying again.');
    } finally {
      setDraftBusy(false);
    }
  };

  const draftComment = draftReceipt?.commentId ? siteLink(context?.siteUrl, `/browse/${issueKey}?focusedCommentId=${draftReceipt.commentId}`) : null;

  return (
    <Stack space="space.200">
      <Heading size="medium">Decision Drift Radar</Heading>
      <Text>Decisions and open questions that point at {issueKey ?? 'this Jira issue'}.</Text>
      {issueKey && !result && !error && <Spinner />}
      {error && <SectionMessage appearance="error">{error}</SectionMessage>}
      {result?.warnings?.length > 0 && (
        <SectionMessage appearance="warning" title="Confluence project-key search unavailable">
          {result.warnings.join(' ')}
        </SectionMessage>
      )}
      {result?.graph?.note && <SectionMessage appearance="information">{result.graph.note}</SectionMessage>}
      {result && (
        <Stack space="space.100">
          <Inline>
            <Button onClick={loadDraft} isDisabled={draftBusy}>Load Rovo draft</Button>
          </Inline>
          {draftMessage && <SectionMessage appearance="information">{draftMessage}</SectionMessage>}
          {draftReceipt && <Text>Note added to {issueKey}.{draftComment && <> <Link href={draftComment}>View comment</Link></>}</Text>}
          {draft && (
            <Stack space="space.075">
              <CommentPreview preview={draft} title="Rovo draft: exactly what will be posted" />
              <Inline>
                <Button appearance="primary" onClick={postDraft} isDisabled={draftBusy}>{`Post Rovo draft to ${issueKey}`}</Button>
              </Inline>
            </Stack>
          )}
        </Stack>
      )}
      {result?.notice && <SectionMessage appearance="information">{result.notice}</SectionMessage>}
      {result?.reviewWarning && <SectionMessage appearance="warning" title="Review history unavailable">{result.reviewWarning}</SectionMessage>}
      {result?.radarWarning && <SectionMessage appearance="warning" title="Drift history unavailable">{result.radarWarning}</SectionMessage>}
      {candidates.length > 0 ? candidates.map((candidate) => (
        <CandidateCard
          key={candidate.id}
          candidate={candidate}
          siteUrl={context?.siteUrl}
          hideIssueKeys
          onReview={(choice) => reviewCandidate(candidate, choice)}
          reviewBusy={reviewBusyId === candidate.id}
          onApplyNote={(noteIssueKey, note, digest) => applyNote(candidate, noteIssueKey, note, digest)}
          onPreviewNote={(noteIssueKey, note) => previewNote(candidate, noteIssueKey, note)}
          onDraftNote={async (noteIssueKey) => {
            try {
              return await invoke('draftDecisionNote', draftPayload(candidate, noteIssueKey));
            } catch {
              return { ok: false, error: 'The AI could not draft a note. You can still write it yourself.' };
            }
          }}
        />
      )) : result ? (
        <SectionMessage appearance="information" title="No linked decisions found">
          Nothing in this issue's comments or the project's Confluence pages clearly points at this issue. Check the project
          radar for decisions from other issues in the project.
        </SectionMessage>
      ) : null}
    </Stack>
  );
}

ForgeReconciler.render(<IssuePanel />);
