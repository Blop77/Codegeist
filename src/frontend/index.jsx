import React, { useState } from 'react';
import ForgeReconciler, {
  Button,
  Heading,
  Inline,
  Label,
  Link,
  SectionMessage,
  Spinner,
  Stack,
  Text,
  Textfield
} from '@forge/react';
import { invoke } from '@forge/bridge';
import { CandidateCard, KIND_GROUPS } from './candidate-card';

function App() {
  const [projectKey, setProjectKey] = useState('');
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [reviewBusyId, setReviewBusyId] = useState(null);
  const [reviewError, setReviewError] = useState(null);

  const scan = async () => {
    setLoading(true);
    setResult(null);
    try {
      setResult(await invoke('getProjectRadar', { projectKey }));
    } catch {
      setResult({ ok: false, error: 'The project scan failed. Refresh the page and try again.' });
    } finally {
      setLoading(false);
    }
  };

  const issueUrls = Object.fromEntries((result?.issues ?? []).filter((i) => i.url).map((i) => [i.key, i.url]));

  const reviewCandidate = async (candidate, choice) => {
    setReviewBusyId(candidate.id);
    setReviewError(null);
    try {
      const response = choice === 'reset'
        ? await invoke('clearDecisionReview', { projectKey: candidate.source.projectKey, candidateId: candidate.id })
        : await invoke('reviewDecision', { projectKey: candidate.source.projectKey, candidateId: candidate.id, choice });
      if (!response?.ok) {
        setReviewError(response?.error ?? 'Could not save the review. Try again.');
        return;
      }
      setResult((current) => current && ({
        ...current,
        candidates: current.candidates.map((item) => (
          item.id === candidate.id ? { ...item, review: response.review ?? null } : item
        ))
      }));
    } catch {
      setReviewError('Could not save the review. Check your connection and try again.');
    } finally {
      setReviewBusyId(null);
    }
  };

  return (
    <Stack space="space.300">
      <Stack space="space.100">
        <Heading size="large">Decision Drift Radar</Heading>
        <Text>Find decisions that may not have made it into the work they affect.</Text>
      </Stack>

      <SectionMessage appearance="information" title="Evidence first, read-only">
        Every finding quotes and links its source and explains why an issue may be affected. The app never changes
        Jira issues; teammates record a review instead.
      </SectionMessage>

      <Inline space="space.150" alignBlock="end">
        <Stack space="space.050">
          <Label labelFor="project-key">Jira project key</Label>
          <Textfield
            id="project-key"
            name="projectKey"
            value={projectKey}
            onChange={(event) => setProjectKey(event.target.value)}
            placeholder="For example, MC"
          />
        </Stack>
        <Button appearance="primary" onClick={scan} isDisabled={loading || !projectKey.trim()}>
          {loading ? 'Scanning…' : 'Scan project'}
        </Button>
      </Inline>

      {loading && <Inline space="space.100"><Spinner /><Text>Loading Jira work…</Text></Inline>}
      {result && !result.ok && <SectionMessage appearance="error" title="Could not scan project">{result.error}</SectionMessage>}
      {reviewError && <SectionMessage appearance="error" title="Review not saved">{reviewError}</SectionMessage>}

      {result?.ok && (
        <Stack space="space.200">
          <Text>
            Scanned {result.issues.length} recent {result.projectKey} issues and {result.pages?.length ?? 0} Confluence
            {result.pages?.length === 1 ? ' page' : ' pages'} mentioning {result.projectKey}.
          </Text>
          {result.issues.length === 0 && (
            <SectionMessage appearance="warning" title={`No issues found in ${result.projectKey}`}>
              Check the project key, or pick a project with issues. Findings can still come from Confluence pages, but no
              issue can be matched to them.
            </SectionMessage>
          )}
          {result.notice && <SectionMessage appearance="information">{result.notice}</SectionMessage>}
          {result.reviewWarning && <SectionMessage appearance="warning" title="Review history unavailable">{result.reviewWarning}</SectionMessage>}
          {(result.candidates ?? []).length === 0 ? (
            <SectionMessage appearance="information" title="No decisions detected">
              The scan reads issue descriptions, comments and Confluence pages mentioning {result.projectKey}, looking for
              wording such as “Decision:”, “we agreed”, “we decided to”, “open question” or “we should”.
            </SectionMessage>
          ) : KIND_GROUPS.map(({ kind, title }) => {
            const group = result.candidates.filter((candidate) => candidate.kind === kind);
            if (group.length === 0) return null;
            return (
              <Stack key={kind} space="space.200">
                <Heading size="medium">{title} · {group.length}</Heading>
                {group.map((candidate) => (
                  <CandidateCard
                    key={candidate.id}
                    candidate={candidate}
                    issueUrls={issueUrls}
                    onReview={(choice) => reviewCandidate(candidate, choice)}
                    reviewBusy={reviewBusyId === candidate.id}
                  />
                ))}
              </Stack>
            );
          })}
          {result.warnings?.length > 0 ? (
            <SectionMessage appearance="warning" title="Confluence source search unavailable">
              {result.warnings.join(' ')} Jira descriptions and comments were still scanned.
            </SectionMessage>
          ) : result.pages?.length > 0 ? (
            <Stack space="space.100">
              <Heading size="medium">Confluence pages mentioning {result.projectKey}</Heading>
              {result.pages.map((source) => (
                source.url
                  ? <Link key={source.id} href={source.url}>{source.title}</Link>
                  : <Text key={source.id}>{source.title}</Text>
              ))}
            </Stack>
          ) : (
            <SectionMessage appearance="information" title="No matching Confluence pages found">
              The scan currently looks for pages mentioning this project key. Add the key to a decision page to include it in this first pass.
            </SectionMessage>
          )}
          {result.issues.length > 0 && (
            <Stack space="space.100">
              <Heading size="medium">Recent {result.projectKey} issues scanned · {result.issues.length}</Heading>
              {result.issues.map((issue) => (
                <Text key={issue.key}>
                  {issue.url ? <Link href={issue.url}>{issue.key}</Link> : issue.key}
                  {` · ${issue.status} · ${issue.summary}`}
                  {issue.labels.length > 0 ? ` · Labels: ${issue.labels.join(', ')}` : ''}
                </Text>
              ))}
            </Stack>
          )}
          <SectionMessage appearance="information" title="How matching works">
            Each finding quotes its source and lists the signals behind it: decision wording, issue keys named in the
            quote or its paragraph, shared terms, and issues that still mention what a decision replaces. Signals are
            heuristics, not certainty. Mark a finding relevant or dismiss it to save the team's review for this project;
            reviews never change Jira issues.
          </SectionMessage>
        </Stack>
      )}
    </Stack>
  );
}

ForgeReconciler.render(<App />);
