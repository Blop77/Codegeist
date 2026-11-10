import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adfToPlainText, analyzeDecisions, confluenceAdfToBlocks, type AdfNode } from '../src/index.ts';

const doc: AdfNode = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Decisions' }] },
    {
      type: 'decisionList',
      attrs: { localId: 'dl1' },
      content: [
        { type: 'decisionItem', attrs: { localId: 'di1', state: 'DECIDED' }, content: [{ type: 'text', text: 'Replace Jenkins with GitHub Actions.' }] },
        { type: 'decisionItem', attrs: { localId: 'di2', state: 'UNDECIDED' }, content: [{ type: 'text', text: 'Self-hosted runners?' }] },
      ],
    },
    {
      type: 'bulletList',
      content: [
        {
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'mention', attrs: { text: '@Lena' } },
                { type: 'text', text: ' owns ' },
                { type: 'inlineCard', attrs: { url: 'https://x/browse/CI-4' } },
              ],
            },
          ],
        },
      ],
    },
    { type: 'codeBlock', content: [{ type: 'text', text: 'we decided to ignore code blocks' }] },
  ],
};

test('confluenceAdfToBlocks keeps decision state, ids and inline content', () => {
  const blocks = confluenceAdfToBlocks(doc);
  assert.deepEqual(
    blocks.map((b) => [b.id, b.type, b.text, b.decisionState]),
    [
      ['b0', 'heading', 'Decisions', undefined],
      ['di1', 'decision-item', 'Replace Jenkins with GitHub Actions.', 'DECIDED'],
      ['di2', 'decision-item', 'Self-hosted runners?', 'UNDECIDED'],
      ['b3', 'list-item', '@Lena owns https://x/browse/CI-4', undefined],
    ],
  );
});

test('adfToPlainText flattens Jira ADF fields', () => {
  assert.match(adfToPlainText(doc), /^Decisions\nReplace Jenkins/);
  assert.equal(adfToPlainText(null), '');
});

test('a page built from ADF flows through the engine', async () => {
  const { candidates } = await analyzeDecisions({
    projectKey: 'CI',
    now: '2026-11-10T00:00:00Z',
    issues: [
      {
        kind: 'jira-issue',
        key: 'CI-4',
        projectKey: 'CI',
        summary: 'Add Jenkins pipeline for nightly builds',
        description: 'Configure a Jenkins job that runs the nightly build.',
        status: 'To Do',
        statusCategory: 'todo',
        labels: [],
        components: [],
        updatedAt: '2026-10-01T00:00:00Z',
        url: 'https://x/browse/CI-4',
      },
    ],
    sources: [
      {
        kind: 'confluence-page',
        id: '7',
        spaceKey: 'CI',
        title: 'CI migration',
        url: 'https://x/wiki/7',
        author: 'a',
        labels: [],
        updatedAt: '2026-11-08T00:00:00Z',
        blocks: confluenceAdfToBlocks(doc),
      },
    ],
  });
  const jenkins = candidates.find((c) => c.change?.from === 'Jenkins');
  assert.equal(jenkins?.affectedIssues[0]?.issueKey, 'CI-4');
  assert.equal(jenkins?.affectedIssues[0]?.drift, 'stale-reference');
  assert.equal(jenkins?.evidenceSpan.blockId, 'di1');
});
