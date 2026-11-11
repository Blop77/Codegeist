import React, { useEffect, useState } from 'react';
import ForgeReconciler, {
  Button,
  Heading,
  Inline,
  Label,
  Link,
  SectionMessage,
  Select,
  Spinner,
  Stack,
  Text,
  Textfield,
  useProductContext
} from '@forge/react';
import { invoke } from '@forge/bridge';
import { CandidateCard, KIND_GROUPS, notePayload, siteLink, withNote } from './candidate-card';

function App() {
  const context = useProductContext();
  const siteUrl = context?.siteUrl;
  // Set when the app is opened from a Jira project's own page.
  const contextProjectKey = context?.extension?.project?.key;
  const [projectKey, setProjectKey] = useState('');
  const [projects, setProjects] = useState(null);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [reviewBusyId, setReviewBusyId] = useState(null);
  const [reviewError, setReviewError] = useState(null);
  const [aiResult, setAiResult] = useState(null);
  const [aiLoading, setAiLoading] = useState(false);

  const scan = async (key = projectKey) => {
    setLoading(true);
    setResult(null);
    setAiResult(null);
    setReviewError(null);
    try {
      setResult(await invoke('getProjectRadar', { projectKey: key }));
    } catch {
      setResult({ ok: false, error: 'The project scan failed. Refresh the page and try again.' });
    } finally {
      setLoading(false);
    }
  };

  // Runs the same analysis on a small bundled project. Touches nothing on the site.
  const scanSample = async () => {
    setLoading(true);
    setResult(null);
    setAiResult(null);
    setReviewError(null);
    try {
      setResult(await invoke('getSampleRadar'));
    } catch {
      setResult({ ok: false, error: 'The sample scan failed. Refresh the page and try again.' });
    } finally {
      setLoading(false);
    }
  };

  // Asks the AI for decisions the wording rules missed. Only on request: usage is billed per call.
  const findWithAi = async () => {
    if (!result?.ok) return;
    setAiLoading(true);
    setAiResult(null);
    try {
      setAiResult(result.sample
        ? await invoke('getSampleAiFindings')
        : await invoke('getAiFindings', { projectKey: result.projectKey }));
    } catch {
      setAiResult({ ok: false, error: 'The AI pass could not complete. The findings above are unaffected.' });
    } finally {
      setAiLoading(false);
    }
  };

  const sampleButton = (
    <Button appearance="default" onClick={scanSample} isDisabled={loading}>
      Try with sample data
    </Button>
  );

  // On a project page, scan that project straight away.
  useEffect(() => {
    if (!contextProjectKey) return;
    setProjectKey(contextProjectKey);
    scan(contextProjectKey);
  }, [contextProjectKey]);

  // Elsewhere, offer the projects the user can see. If the list fails, a key can still be typed.
  useEffect(() => {
    if (!context || contextProjectKey) return undefined;
    let cancelled = false;
    invoke('listProjects')
      .then((response) => { if (!cancelled) setProjects(response?.ok ? response : { projects: [] }); })
      .catch(() => { if (!cancelled) setProjects({ projects: [] }); });
    return () => { cancelled = true; };
  }, [Boolean(context), contextProjectKey]);

  const projectOptions = (projects?.projects ?? []).map((project) => ({ label: `${project.name} (${project.key})`, value: project.key }));

  const applyNote = async (candidate, issueKey, note) => {
    try {
      const response = await invoke('applyDecisionNote', notePayload(candidate, siteUrl, issueKey, note));
      if (response?.ok) {
        setResult((current) => withNote(current, candidate.id, issueKey, response.note));
        setAiResult((current) => current?.ok ? withNote(current, candidate.id, issueKey, response.note) : current);
      }
      return response;
    } catch {
      return { ok: false, error: `Could not add the note. Open ${issueKey} to check whether the comment was posted before trying again.` };
    }
  };

  const issueUrls = Object.fromEntries((result?.issues ?? []).filter((i) => i.url).map((i) => [i.key, i.url]));

  // A finding can appear in the scan or in the AI pass; keep both lists in step.
  const updateCandidate = (id, change) => {
    const apply = (current) => current?.candidates
      ? { ...current, candidates: current.candidates.map((item) => (item.id === id ? change(item) : item)) }
      : current;
    setResult(apply);
    setAiResult(apply);
  };

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
      updateCandidate(candidate.id, (item) => ({ ...item, review: response.review ?? null }));
    } catch {
      setReviewError('Could not save the review. Check your connection and try again.');
    } finally {
      setReviewBusyId(null);
    }
  };

  return (
    <Stack space="space.300">
      <Text>Find decisions that may not have made it into the work they affect.</Text>

      <SectionMessage appearance="information" title="Evidence first, nothing changes without you">
        Every finding quotes and links its source and explains why an issue may be affected. The app changes Jira
        only when you mark a finding relevant, review a note and choose to post it as a comment.
      </SectionMessage>

      {contextProjectKey ? (
        <Inline space="space.150" alignBlock="center">
          <Text>Project {contextProjectKey}</Text>
          <Button appearance="default" onClick={() => scan(contextProjectKey)} isDisabled={loading}>
            {loading ? 'Scanning…' : 'Scan again'}
          </Button>
          {sampleButton}
        </Inline>
      ) : (
        <Inline space="space.150" alignBlock="end">
          {projectOptions.length > 0 ? (
            <Stack space="space.050">
              <Label labelFor="project-select">Jira project</Label>
              <Select
                inputId="project-select"
                options={projectOptions}
                value={projectOptions.find((option) => option.value === projectKey) ?? null}
                onChange={(option) => setProjectKey(option?.value ?? '')}
                placeholder="Choose a project"
              />
              {projects?.more && <Text>Showing the first 50 projects.</Text>}
            </Stack>
          ) : (
            <Stack space="space.050">
              <Label labelFor="project-key">Jira project key</Label>
              <Textfield
                id="project-key"
                name="projectKey"
                value={projectKey}
                onChange={(event) => setProjectKey(event.target.value)}
                placeholder={projects ? 'For example, MC' : 'Loading projects…'}
              />
            </Stack>
          )}
          <Button appearance="primary" onClick={() => scan()} isDisabled={loading || !projectKey.trim()}>
            {loading ? 'Scanning…' : 'Scan project'}
          </Button>
          {sampleButton}
        </Inline>
      )}

      {loading && <Inline space="space.100"><Spinner /><Text>Scanning…</Text></Inline>}
      {result && !result.ok && <SectionMessage appearance="error" title="Could not scan project">{result.error}</SectionMessage>}
      {reviewError && <SectionMessage appearance="error" title="Review not saved">{reviewError}</SectionMessage>}

      {result?.ok && (
        <Stack space="space.200">
          {result.sample && (
            <SectionMessage appearance="discovery" title="Sample data: a fictional payments team">
              These findings come from a small project bundled with the app, not from your site. They show what a scan
              looks like when decisions in Confluence pages and Jira comments have not reached the issues they affect.
              Nothing was read from or written to your site. Choose a project above to scan your own work.
            </SectionMessage>
          )}
          <Text>
            Scanned {result.issues.length} {result.sample ? 'sample' : `recent ${result.projectKey}`} issues and {result.pages?.length ?? 0}
            {result.sample ? ' sample' : ''} Confluence{result.pages?.length === 1 ? ' page' : ' pages'}{result.sample ? '.' : ` mentioning ${result.projectKey}.`}
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
              wording such as “Decision:”, “we agreed”, “we decided to”, “open question” or “we should”. To see what
              findings look like, select Try with sample data.
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
                    siteUrl={siteUrl}
                    issueUrls={issueUrls}
                    sample={Boolean(result.sample)}
                    onReview={result.sample ? undefined : (choice) => reviewCandidate(candidate, choice)}
                    reviewBusy={reviewBusyId === candidate.id}
                    onApplyNote={result.sample ? undefined : (issueKey, note) => applyNote(candidate, issueKey, note)}
                  />
                ))}
              </Stack>
            );
          })}
          <Stack space="space.150">
            <Heading size="medium">AI pass</Heading>
            <Text>
              The findings above come from explicit wording rules. The AI pass asks an Atlassian-hosted model for
              decisions phrased indirectly, then keeps only those whose quote is found word for word in the source.
              It runs only when you ask{result.sample ? ', and reads nothing from your site' : ''}.
            </Text>
            <Inline>
              <Button appearance="default" onClick={findWithAi} isDisabled={aiLoading || loading}>
                {aiLoading ? 'Asking the AI…' : 'Find more with AI'}
              </Button>
            </Inline>
            {aiLoading && <Inline space="space.100"><Spinner /><Text>Reading {result.sample ? 'the sample' : 'your'} pages and issues…</Text></Inline>}
            {aiResult && !aiResult.ok && <SectionMessage appearance="warning" title="AI pass not run">{aiResult.error}</SectionMessage>}
            {aiResult?.ok && aiResult.candidates.length === 0 && (
              <SectionMessage appearance="information" title="Nothing more found">
                The AI found no further decisions with a quote it could match to the source.
              </SectionMessage>
            )}
            {aiResult?.ok && aiResult.candidates.length > 0 && (
              <Stack space="space.200">
                <Text>
                  {aiResult.candidates.length} more {aiResult.candidates.length === 1 ? 'finding' : 'findings'}, each with a
                  quote checked against its source.{aiResult.rejected > 0 ? ` ${aiResult.rejected} AI suggestions were dropped because their quote did not match the source.` : ''}
                </Text>
                {aiResult.candidates.map((candidate) => (
                  <CandidateCard
                    key={candidate.id}
                    candidate={candidate}
                    siteUrl={siteUrl}
                    issueUrls={issueUrls}
                    sample={Boolean(result.sample)}
                    onReview={result.sample ? undefined : (choice) => reviewCandidate(candidate, choice)}
                    reviewBusy={reviewBusyId === candidate.id}
                    onApplyNote={result.sample ? undefined : (issueKey, note) => applyNote(candidate, issueKey, note)}
                  />
                ))}
              </Stack>
            )}
          </Stack>
          {result.warnings?.length > 0 ? (
            <SectionMessage appearance="warning" title="Confluence source search unavailable">
              {result.warnings.join(' ')} Jira descriptions and comments were still scanned.
            </SectionMessage>
          ) : result.pages?.length > 0 ? (
            <Stack space="space.100">
              <Heading size="medium">{result.sample ? 'Sample Confluence pages' : `Confluence pages mentioning ${result.projectKey}`}</Heading>
              {result.pages.map((source) => {
                const href = siteLink(siteUrl, source.url);
                return href
                  ? <Link key={source.id} href={href}>{source.title}</Link>
                  : <Text key={source.id}>{source.title}</Text>;
              })}
            </Stack>
          ) : (
            <SectionMessage appearance="information" title="No matching Confluence pages found">
              The scan currently looks for pages mentioning this project key. Add the key to a decision page to include it in this first pass.
            </SectionMessage>
          )}
          {result.issues.length > 0 && (
            <Stack space="space.100">
              <Heading size="medium">{result.sample ? 'Sample issues scanned' : `Recent ${result.projectKey} issues scanned`} · {result.issues.length}</Heading>
              {result.issues.map((issue) => (
                <Text key={issue.key}>
                  {siteLink(siteUrl, issue.url) ? <Link href={siteLink(siteUrl, issue.url)}>{issue.key}</Link> : issue.key}
                  {` · ${issue.status} · ${issue.summary}`}
                  {issue.labels.length > 0 ? ` · Labels: ${issue.labels.join(', ')}` : ''}
                </Text>
              ))}
            </Stack>
          )}
          <SectionMessage appearance="information" title="How matching works">
            Each finding quotes its source and lists the signals behind it: decision wording, issue keys named in the
            quote or its paragraph, shared terms, and issues that still mention what a decision replaces. Signals are
            heuristics, not certainty. Mark a finding relevant or dismiss it to save the team's review for this project.
            A review alone never changes Jira; a relevant finding can then be posted as a comment you edit and confirm.
          </SectionMessage>
        </Stack>
      )}
    </Stack>
  );
}

ForgeReconciler.render(<App />);
