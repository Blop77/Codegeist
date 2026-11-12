/**
 * A small fictional project for the "Try with sample data" scan, so the app shows a full
 * result on a site that has no decision pages yet. Nothing here is read from or written to
 * the site. Records use the shapes in src/domain/decisionTypes.ts.
 *
 * The story: a payments team redesigned checkout. Decisions landed in two Confluence pages
 * and a Jira comment, but several issues still describe the old plan.
 */
export const SAMPLE_PROJECT_KEY = 'PAY';

const page = (id, title, updatedAt, author, lines) => ({
  id: `sample-page-${id}`,
  type: 'confluence_page',
  title,
  url: '',
  projectKey: SAMPLE_PROJECT_KEY,
  updatedAt,
  author,
  text: lines.join('\n')
});

export const sampleSources = [
  page(1, 'Checkout redesign: decision log', '2026-11-04T16:20:00Z', 'Priya (Product)', [
    'This page records what the team agreed in the November design review.',
    '## Decisions',
    '- Decision: Use the hosted payment form instead of the legacy card form for checkout.',
    '- Decision: Guest checkout is out of scope for v1.',
    '- Open question: Do we support wallet payments at launch?',
    '## Notes',
    'Design shared three layouts. Engineering estimated the payment form work at one sprint.',
    'We should probably add rate limiting to the payments API before launch.'
  ]),
  page(2, 'Payments sync notes', '2026-11-06T10:05:00Z', 'Marcus (Engineering)', [
    'Attendees: Priya, Marcus, Lena, Tom',
    'Lena walked through deliverability numbers. Agreed: move the order confirmation email from the old mail relay to the new email service.',
    'We have not decided whether refunds need a second approver.',
    'Marcus confirmed the team is locking in weekly payouts to merchants starting in January.',
    'Lunch orders for the offsite are due Friday.'
  ]),
  {
    id: 'sample-comment-1',
    type: 'jira_comment',
    title: 'Comment on PAY-107 by Tom (Engineering)',
    // Used only to tie the comment to its issue; sample links are not shown.
    url: '/browse/PAY-107?focusedCommentId=sample',
    projectKey: SAMPLE_PROJECT_KEY,
    updatedAt: '2026-11-07T15:30:00Z',
    author: 'Tom (Engineering)',
    text: 'Decided in standup: we will cap retries at 3 instead of 5. Anything beyond that goes to the dead letter queue.'
  }
];

const issue = (number, title, description, status, updatedAt) => ({
  id: `sample-issue-${number}`,
  key: `${SAMPLE_PROJECT_KEY}-${number}`,
  title,
  description,
  projectKey: SAMPLE_PROJECT_KEY,
  status,
  labels: [],
  updatedAt
});

export const sampleIssues = [
  issue(101, 'Build card form validation for checkout', 'Validate card number, expiry and CVC in the legacy card form before submit.', 'In Progress', '2026-10-28T09:00:00Z'),
  issue(102, 'Guest checkout flow', 'Let shoppers check out without an account: guest checkout email capture and order lookup.', 'To Do', '2026-10-20T09:00:00Z'),
  issue(103, 'Order confirmation email template', 'Build the template for the order confirmation email and send it through the old mail relay.', 'Blocked', '2026-10-30T09:00:00Z'),
  issue(104, 'Integrate the hosted payment form', 'Embed the hosted payment form in checkout.', 'In Progress', '2026-11-05T09:00:00Z'),
  issue(105, 'Update footer links on marketing site', 'Point the careers and press links at the new pages.', 'To Do', '2026-10-15T09:00:00Z'),
  issue(106, 'Merchant payout schedule', 'Starting in January, send merchant payouts every day from the nightly settlement job.', 'To Do', '2026-10-29T09:00:00Z'),
  issue(107, 'Retry failed payment webhooks', 'Retry failed webhook deliveries up to 5 times with exponential backoff.', 'To Do', '2026-10-25T09:00:00Z')
];
