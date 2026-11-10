import type { ExtractionInput } from '../decisionTypes';

/** Malformed and boundary records. Every one must produce a warning, never an exception. */

const longSentence =
  'Decision: after reviewing the vendor comparison, the security questionnaire responses, the projected volume for the ' +
  'next four quarters, the migration effort estimated by each squad, and the feedback gathered from the pilot customers ' +
  'during the October beta, we will consolidate all transactional email onto Postmark and retire the remaining SendGrid ' +
  'templates by the end of the quarter 🚀 with no exceptions.';

export const malformedInput = {
  maxCandidates: -1,
  sources: [
    null,
    'not an object',
    { id: 'no-text', type: 'confluence_page', title: 'Missing text', url: '', projectKey: 'PAY', updatedAt: '2026-11-01T00:00:00Z' },
    { id: 'bad-type', type: 'slack_message', title: 'Wrong type', url: '', text: 'We decided to ship.', projectKey: 'PAY', updatedAt: '2026-11-01T00:00:00Z' },
    { id: 'no-project', type: 'jira_comment', title: 'No project', url: '', text: 'We decided to ship.', updatedAt: '2026-11-01T00:00:00Z' },
    { id: 'bad-time', type: 'jira_comment', title: 'Comment on PAY-1', url: 'https://x/browse/PAY-1', text: 'We decided to use feature flags for the rollout.', projectKey: 'PAY', updatedAt: 'last tuesday' },
    { id: 'bad-time', type: 'jira_comment', title: 'Duplicate id', url: '', text: 'We decided something else entirely.', projectKey: 'PAY', updatedAt: '2026-11-01T00:00:00Z' },
    { id: 'long', type: 'confluence_page', title: 'Email vendor', url: 'https://x/wiki/long', text: longSentence, projectKey: 'PAY', updatedAt: '2026-11-02T00:00:00Z' },
  ],
  issues: [
    { id: '1', key: 'PAY-1', title: 'Feature flag rollout', description: 'Roll out behind flags.', projectKey: 'PAY', updatedAt: '2026-10-01T00:00:00Z' },
    { id: '2', key: 'PAY-1', title: 'Duplicate key', projectKey: 'PAY', updatedAt: '2026-10-01T00:00:00Z' },
    { id: '3', title: 'No key', projectKey: 'PAY', updatedAt: '2026-10-01T00:00:00Z' },
    { id: '4', key: 'PAY-4', title: 'Bad timestamp', description: 42, labels: ['ok', 7], projectKey: 'PAY', updatedAt: 'soon' },
    42,
  ],
} as unknown as ExtractionInput;

export const emptyInput: ExtractionInput = { sources: [], issues: [] };

export { longSentence };
