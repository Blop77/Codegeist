import type { ExtractionInput, IssueRecord, SourceRecord } from '../decisionTypes';

/**
 * The live demo on the Forge demo site (one-atlas-pxox.atlassian.net, Jira project MC).
 *
 * - The Confluence page text is what "Demo Decision — MC Campaign Coordination" contains, as
 *   the resolver renders it: one line per paragraph.
 * - The issues are the 25 most recently updated MC issues as the live scan listed them. Only
 *   keys, titles, statuses and labels were captured, plus MC-9's description. The other
 *   descriptions are left empty, so lexical matching here is weaker than on the live site
 *   (live, MC-10 also shares terms with the decision).
 * - MC-9's description is Atlassian's seeded text plus two demo lines that still describe the
 *   plan the decision replaces. That is the drift the demo shows. As in the resolver, the
 *   description is both part of the issue record and a `jira_issue` source.
 */
const SITE = 'https://one-atlas-pxox.atlassian.net';

export const mcDemoPage: SourceRecord = {
  id: 'page-mc-demo',
  type: 'confluence_page',
  title: 'Demo Decision — MC Campaign Coordination',
  url: `${SITE}/wiki/spaces/MAR/pages/mc-demo`,
  projectKey: 'MC',
  updatedAt: '2026-11-11T08:02:00Z',
  author: 'Ishaan Singh',
  text: [
    'DEMO DATA — created for testing Decision Drift Radar. This is a sample decision, not an approved Marketing team decision.',
    'Decision: We agreed to use one shared launch plan instead of separate channel plans for the MC website, email, and social campaign. Related Jira issues: MC-1, MC-5, MC-9, MC-10.',
    'Status: Demo example only.',
  ].join('\n'),
};

export const mc9Description = [
  'Create and deliver an email marketing campaign to announce the launch of our new product. The campaign aims to generate excitement and awareness among our target audience, driving traffic to our website and increasing pre-orders. Key components include:',
  '- Target Audience Identification: Segmenting our email list to tailor messages for different customer groups.',
  "- Email Design and Content Creation: Developing visually appealing emails with compelling copy that highlights the product's features and benefits.",
  '- Campaign Schedule: Planning a timeline for email sends, including teasers leading up to the launch date.',
  "- Performance Metrics: Establishing KPIs to measure the campaign's success, such as open rates, click-through rates, and conversion rates.",
  'Send the launch announcement to the customer mailing list.',
  'Scheduling: the email campaign keeps separate channel plans, so email goes out on its own timeline before the website and social posts.',
].join('\n');

const issue = (key: string, title: string, status: string, labels: string[] = [], description = ''): IssueRecord => ({
  id: `id-${key}`,
  key,
  title,
  description,
  projectKey: 'MC',
  status,
  labels,
  updatedAt: '2026-11-01T00:00:00Z',
});

export const mcIssues: IssueRecord[] = [
  issue('MC-10', 'Campaign - Social media posting(s)', 'To Do'),
  issue('MC-9', 'Campaign - Email campaign', 'To Do', [], mc9Description),
  issue('MC-8', 'Campaign - Product documentation', 'To Do'),
  issue('MC-7', 'Campaign - Messaging', 'Ready for review'),
  issue('MC-42', 'Marketing Campaign Launch', 'Planning', ['campaign']),
  issue('MC-41', 'Marketing Campaign Launch', 'To Do'),
  issue('MC-44', 'Identify Key Business Functions for Automation', 'To Do'),
  issue('MC-43', 'Automation Revolution: Efficiency Unleashed', 'Ready for review', ['one-atlassian']),
  issue('MC-45', 'Research Advanced AI Technologies', 'Planning'),
  issue('MC-47', 'Develop Automation Integration Plan', 'Complete'),
  issue('MC-53', 'Host Webinars on AI and Automation Innovations', 'Accepted'),
  issue('MC-52', 'Organize Workshops on AI and Automation', 'To Do'),
  issue('MC-51', 'Develop Social Media Campaign for AI and Automation', 'Ready for review'),
  issue('MC-50', 'Design Email Campaign for AI and Automation Awareness', 'Accepted'),
  issue('MC-49', 'Create AI and Automation Content Strategy', 'In Review'),
  issue('MC-48', 'Design AI Integration Framework', 'To Do'),
  issue('MC-46', 'Foster Innovation and Continuous Improvement Culture', 'Complete'),
  issue('MC-5', 'Campaign - Community posting', 'Ready for review'),
  issue('MC-1', 'Campaign - Website updates', 'Ready for review'),
  issue('MC-11', 'In-product updates', 'Planning'),
  issue('MC-3', 'Launch Enablement', 'Planning'),
  issue('MC-6', 'Develop FAQs', 'Planning'),
  issue('MC-4', 'Produce a marketing video showcasing product improvements', 'Planning'),
  issue('MC-2', 'Analyst Relations Assets', 'Planning'),
  issue('MC-61', 'Review and Feedback Session', 'To Do'),
];

export const mc9Source: SourceRecord = {
  id: 'issue-id-MC-9',
  type: 'jira_issue',
  title: 'MC-9: Campaign - Email campaign',
  url: '/browse/MC-9',
  projectKey: 'MC',
  updatedAt: '2026-11-11T09:36:00Z',
  text: mc9Description,
};

export const mcDemoInput: ExtractionInput = { sources: [mcDemoPage, mc9Source], issues: mcIssues };
