import React, { useEffect, useState } from 'react';
import ForgeReconciler, {
  Heading,
  SectionMessage,
  Spinner,
  Stack,
  Text,
  useProductContext
} from '@forge/react';
import { invoke } from '@forge/bridge';
import { CandidateCard, draftPayload, notePayload, withNote } from './candidate-card';

function IssuePanel() {
  const context = useProductContext();
  const issueKey = context?.extension?.issue?.key;
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [reviewBusyId, setReviewBusyId] = useState(null);

  useEffect(() => {
    if (!issueKey) return;

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
        ? await invoke('clearDecisionReview', { projectKey: issueKey.split('-')[0], candidateId: candidate.id })
        : await invoke('reviewDecision', { projectKey: issueKey.split('-')[0], candidateId: candidate.id, choice });
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

  const applyNote = async (candidate, noteIssueKey, note) => {
    try {
      const response = await invoke('applyDecisionNote', notePayload(candidate, context?.siteUrl, noteIssueKey, note));
      if (response?.ok) setResult((current) => withNote(current, candidate.id, noteIssueKey, response.note));
      return response;
    } catch {
      return { ok: false, error: 'Could not add the note. Check the comments on this issue before trying again.' };
    }
  };

  return (
    <Stack space="space.200">
      <Heading size="medium">Decision Drift Radar</Heading>
      <Text>Decisions and open questions that point at {issueKey ?? 'this Jira issue'}.</Text>
      {issueKey && !result && !error && <Spinner />}
      {error && <SectionMessage appearance="error">{error}</SectionMessage>}
      {result?.warnings?.length > 0 && (
        <SectionMessage appearance="warning" title="Confluence is unavailable">
          Only this issue's description and comments were scanned. Enable Confluence on this site to include decision pages.
        </SectionMessage>
      )}
      {result?.notice && <SectionMessage appearance="information">{result.notice}</SectionMessage>}
      {result?.reviewWarning && <SectionMessage appearance="warning" title="Review history unavailable">{result.reviewWarning}</SectionMessage>}
      {candidates.length > 0 ? candidates.map((candidate) => (
        <CandidateCard
          key={candidate.id}
          candidate={candidate}
          siteUrl={context?.siteUrl}
          hideIssueKeys
          onReview={(choice) => reviewCandidate(candidate, choice)}
          reviewBusy={reviewBusyId === candidate.id}
          onApplyNote={(noteIssueKey, note) => applyNote(candidate, noteIssueKey, note)}
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
          radar for decisions that matched no issue.
        </SectionMessage>
      ) : null}
    </Stack>
  );
}

ForgeReconciler.render(<IssuePanel />);
