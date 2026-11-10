import type { ConfluencePageRecord, JiraCommentRecord, JiraIssueRecord } from '../src/types.ts';

/**
 * Demo story: the PAY team redesigned checkout. Decisions landed in Confluence and in a
 * Jira comment, but several tickets still describe the old plan.
 */
export const NOW = '2026-11-10T12:00:00Z';
const SITE = 'https://demo-team.atlassian.net';

const issue = (key: string, summary: string, description: string, status: string, statusCategory: JiraIssueRecord['statusCategory'], updatedAt: string, extra: Partial<JiraIssueRecord> = {}): JiraIssueRecord => ({
  kind: 'jira-issue',
  key,
  projectKey: 'PAY',
  summary,
  description,
  status,
  statusCategory,
  labels: [],
  components: ['checkout'],
  updatedAt,
  url: `${SITE}/browse/${key}`,
  ...extra,
});

export const decisionLog: ConfluencePageRecord = {
  kind: 'confluence-page',
  id: '98301',
  spaceKey: 'PAY',
  title: 'Checkout redesign: decision log',
  url: `${SITE}/wiki/spaces/PAY/pages/98301`,
  author: 'Priya (PM)',
  labels: ['decision-log', 'checkout'],
  updatedAt: '2026-11-04T16:20:00Z',
  blocks: [
    { id: 'h1', type: 'heading', headingLevel: 1, text: 'Checkout redesign' },
    { id: 'p1', type: 'paragraph', text: 'This page records what the team agreed in the November design review. Tracked in PAY-104.' },
    { id: 'h2', type: 'heading', headingLevel: 2, text: 'Decisions' },
    { id: 'd1', type: 'decision-item', decisionState: 'DECIDED', text: 'Use Stripe Payment Element instead of the legacy card form for checkout.' },
    { id: 'd2', type: 'decision-item', decisionState: 'DECIDED', text: 'Guest checkout is out of scope for v1.' },
    { id: 'd3', type: 'decision-item', decisionState: 'UNDECIDED', text: 'Do we support Apple Pay at launch?' },
    { id: 'h3', type: 'heading', headingLevel: 2, text: 'Notes' },
    { id: 'p2', type: 'paragraph', text: 'Design shared three layouts. Engineering estimated the Payment Element work at one sprint.' },
    { id: 'p3', type: 'paragraph', text: 'We should probably add rate limiting to the payments API before launch.' },
  ],
};

export const meetingNotes: ConfluencePageRecord = {
  kind: 'confluence-page',
  id: '98422',
  spaceKey: 'PAY',
  title: '2026-11-06 Payments sync',
  url: `${SITE}/wiki/spaces/PAY/pages/98422`,
  author: 'Marcus (EM)',
  labels: ['meeting-notes'],
  updatedAt: '2026-11-06T10:05:00Z',
  blocks: [
    { id: 'h1', type: 'heading', headingLevel: 1, text: 'Attendees' },
    { id: 'p1', type: 'paragraph', text: 'Priya, Marcus, Lena, Tom' },
    { id: 'h2', type: 'heading', headingLevel: 1, text: 'Discussion' },
    {
      id: 'p2',
      type: 'paragraph',
      text: 'Lena walked through deliverability numbers. Agreed: move the order confirmation email from SendGrid to Postmark. Tom asked about cost.',
    },
    { id: 'p3', type: 'paragraph', text: 'We have not decided whether refunds need a second approver.' },
    { id: 'p4', type: 'paragraph', text: 'We agreed that guest checkout is out of scope for v1.' },
  ],
};

export const issues: JiraIssueRecord[] = [
  issue('PAY-101', 'Build card form validation for checkout', 'Validate card number, expiry and CVC in the legacy card form before submit.', 'In Progress', 'in-progress', '2026-10-28T09:00:00Z'),
  issue('PAY-102', 'Guest checkout flow', 'Let shoppers check out without an account: guest checkout email capture and order lookup.', 'To Do', 'todo', '2026-10-20T09:00:00Z'),
  issue('PAY-103', 'Order confirmation email template', 'Build the HTML template for the order confirmation email and send it through SendGrid.', 'Blocked', 'in-progress', '2026-10-30T09:00:00Z', { flagged: true, components: ['notifications'] }),
  issue('PAY-104', 'Integrate Stripe Payment Element', `Embed Stripe Payment Element in checkout. See decision log ${SITE}/wiki/spaces/PAY/pages/98301`, 'In Progress', 'in-progress', '2026-11-05T09:00:00Z', {
    linkedSourceIds: ['98301'],
  }),
  issue('PAY-105', 'Update footer links on marketing site', 'Point the careers and press links at the new pages.', 'To Do', 'todo', '2026-10-15T09:00:00Z', { components: ['marketing'] }),
  issue('PAY-106', 'Payments API pagination', 'Add cursor pagination to the list payments endpoint.', 'Done', 'done', '2026-09-30T09:00:00Z', { components: ['api'] }),
  issue('PAY-107', 'Retry failed payment webhooks', 'Retry failed webhook deliveries up to 5 times with exponential backoff.', 'To Do', 'todo', '2026-10-25T09:00:00Z', { components: ['api'] }),
  issue('OPS-9', 'Rotate staging certificates', 'Unrelated project; must be ignored by a PAY analysis.', 'To Do', 'todo', '2026-11-01T09:00:00Z', { projectKey: 'OPS' }),
];

export const comments: JiraCommentRecord[] = [
  {
    kind: 'jira-comment',
    id: '20001',
    issueKey: 'PAY-107',
    author: 'Tom (Eng)',
    body: 'Decided in standup: we will cap retries at 3 instead of 5. Anything beyond that goes to the dead letter queue.',
    createdAt: '2026-11-07T15:30:00Z',
    url: `${SITE}/browse/PAY-107?focusedCommentId=20001`,
  },
  {
    kind: 'jira-comment',
    id: '20002',
    issueKey: 'PAY-101',
    author: 'Lena (Eng)',
    body: 'Starting on the expiry field validation today.',
    createdAt: '2026-10-29T11:00:00Z',
    url: `${SITE}/browse/PAY-101?focusedCommentId=20002`,
  },
  {
    kind: 'jira-comment',
    id: '20003',
    issueKey: 'OPS-9',
    author: 'Sam (Ops)',
    body: 'We decided to rotate certificates monthly.',
    createdAt: '2026-11-02T11:00:00Z',
    url: `${SITE}/browse/OPS-9?focusedCommentId=20003`,
  },
];

export const demoInput = {
  projectKey: 'PAY',
  issues,
  sources: [decisionLog, meetingNotes, ...comments],
  now: NOW,
};
