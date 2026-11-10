import type { ExtractionInput, IssueRecord, SourceRecord } from '../decisionTypes';

/**
 * Demo story: the PAY team redesigned checkout. Decisions landed in Confluence, a Jira
 * issue and a Jira comment, but several issues still describe the old plan.
 *
 * Fixture coverage (see checkFixtures.ts for the assertions):
 * - clear decisions ........ "Decision:" lines, "Agreed:", "we agreed to", "Decided in standup:"
 * - proposals .............. "We should probably add rate limiting..."
 * - open questions ......... "Open question: Do we support Apple Pay...", "We have not decided..."
 * - irrelevant discussion .. lunch orders, layout opinions, attendee lists, "this page records..."
 * - explicit issue keys .... PAY-106 named in a quote; PAY-107 via its own comment; PAY-108 via its own description
 * - lexical matches ........ Postmark → PAY-103, Google Analytics → PAY-109, card form → PAY-101
 * - duplicate mentions ..... the Postmark decision appears twice in the meeting notes
 * - cross-project data ..... OPS-9 named on a PAY page must not match; OPS sources match OPS issues only
 */
const SITE = 'https://demo-team.atlassian.net';

export const demoSources: SourceRecord[] = [
  {
    id: 'page-98301',
    type: 'confluence_page',
    title: 'Checkout redesign: decision log',
    url: `${SITE}/wiki/spaces/PAY/pages/98301`,
    projectKey: 'PAY',
    updatedAt: '2026-11-04T16:20:00Z',
    author: 'Priya (PM)',
    text: [
      'Checkout redesign',
      '',
      'This page records what the team agreed in the November design review. Tracked in PAY-104.',
      '',
      '## Decisions',
      '- Decision: Use Stripe Payment Element instead of the legacy card form for checkout.',
      '- Decision: Guest checkout is out of scope for v1.',
      '- Open question: Do we support Apple Pay at launch?',
      '',
      '## Notes',
      'Design shared three layouts. Engineering estimated the Payment Element work at one sprint.',
      'We should probably add rate limiting to the payments API before launch.',
    ].join('\n'),
  },
  {
    id: 'page-98422',
    type: 'confluence_page',
    title: '2026-11-06 Payments sync',
    url: `${SITE}/wiki/spaces/PAY/pages/98422`,
    projectKey: 'PAY',
    updatedAt: '2026-11-06T10:05:00Z',
    author: 'Marcus (EM)',
    text: [
      'Attendees: Priya, Marcus, Lena, Tom',
      '',
      'Discussion',
      'Lena walked through deliverability numbers. Agreed: move the order confirmation email from SendGrid to Postmark. Tom asked about cost.',
      'We have not decided whether refunds need a second approver.',
      'Tom thinks the new checkout layout looks cleaner.',
      'Lunch orders for the offsite are due Friday.',
      '',
      'Action items',
      '- We agreed to move the order confirmation email from SendGrid to Postmark.',
      '- Lena to share the deliverability report.',
    ].join('\n'),
  },
  {
    id: 'page-98510',
    type: 'confluence_page',
    title: 'Release 2.3 plan',
    url: `${SITE}/wiki/spaces/PAY/pages/98510`,
    projectKey: 'PAY',
    updatedAt: '2026-11-08T09:00:00Z',
    text: [
      'Decision: PAY-106 ships in the 2.3 release.',
      'Decision: OPS-9 certificate rotation is handled by the platform team.',
    ].join('\n'),
  },
  {
    id: 'comment-20001',
    type: 'jira_comment',
    title: 'Comment on PAY-107',
    url: `${SITE}/browse/PAY-107?focusedCommentId=20001`,
    projectKey: 'PAY',
    updatedAt: '2026-11-07T15:30:00Z',
    author: 'Tom (Eng)',
    text: 'Decided in standup: we will cap retries at 3 instead of 5. Anything beyond that goes to the dead letter queue.',
  },
  {
    id: '10108',
    type: 'jira_issue',
    title: 'PAY-108 Checkout analytics events',
    url: `${SITE}/browse/PAY-108`,
    projectKey: 'PAY',
    updatedAt: '2026-11-05T12:00:00Z',
    text: 'Emit events for each checkout step. Decision: track checkout events with Segment instead of Google Analytics.',
  },
  {
    id: 'page-77001',
    type: 'confluence_page',
    title: 'Ops weekly',
    url: `${SITE}/wiki/spaces/OPS/pages/77001`,
    projectKey: 'OPS',
    updatedAt: '2026-11-02T11:00:00Z',
    text: 'We decided to rotate staging certificates monthly.',
  },
];

const issue = (id: string, key: string, title: string, description: string, status: string, updatedAt: string, projectKey = 'PAY'): IssueRecord => ({
  id,
  key,
  title,
  description,
  projectKey,
  status,
  labels: [],
  updatedAt,
});

export const demoIssues: IssueRecord[] = [
  issue('10101', 'PAY-101', 'Build card form validation for checkout', 'Validate card number, expiry and CVC in the legacy card form before submit.', 'In Progress', '2026-10-28T09:00:00Z'),
  issue('10102', 'PAY-102', 'Guest checkout flow', 'Let shoppers check out without an account: guest checkout email capture and order lookup.', 'To Do', '2026-10-20T09:00:00Z'),
  issue('10103', 'PAY-103', 'Order confirmation email template', 'Build the HTML template for the order confirmation email and send it through SendGrid.', 'Blocked', '2026-10-30T09:00:00Z'),
  issue('10104', 'PAY-104', 'Integrate Stripe Payment Element', `Embed Stripe Payment Element in checkout. See ${SITE}/wiki/spaces/PAY/pages/98301`, 'In Progress', '2026-11-05T09:00:00Z'),
  issue('10105', 'PAY-105', 'Update footer links on marketing site', 'Point the careers and press links at the new pages.', 'To Do', '2026-10-15T09:00:00Z'),
  issue('10106', 'PAY-106', 'Payments API pagination', 'Add cursor pagination to the list payments endpoint.', 'Done', '2026-09-30T09:00:00Z'),
  issue('10107', 'PAY-107', 'Retry failed payment webhooks', 'Retry failed webhook deliveries up to 5 times with exponential backoff.', 'To Do', '2026-10-25T09:00:00Z'),
  issue('10108', 'PAY-108', 'Checkout analytics events', 'Emit events for each checkout step.', 'In Progress', '2026-11-05T12:00:00Z'),
  issue('10109', 'PAY-109', 'Checkout funnel dashboard', 'Build the checkout funnel dashboard in Google Analytics.', 'To Do', '2026-10-22T09:00:00Z'),
  issue('20009', 'OPS-9', 'Rotate staging certificates', 'Automate certificate rotation for staging.', 'To Do', '2026-11-01T09:00:00Z', 'OPS'),
];

export const demoInput: ExtractionInput = { sources: demoSources, issues: demoIssues };
