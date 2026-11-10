import type { BlockType, ContentBlock } from './types.ts';

/** Minimal shape of an Atlassian Document Format node. */
export interface AdfNode {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  content?: AdfNode[];
}

function inlineText(node: AdfNode): string {
  switch (node.type) {
    case 'text':
      return node.text ?? '';
    case 'hardBreak':
      return '\n';
    case 'mention':
      return String(node.attrs?.text ?? '');
    case 'emoji':
      return String(node.attrs?.text ?? node.attrs?.shortName ?? '');
    case 'inlineCard':
    case 'blockCard':
      return String(node.attrs?.url ?? '');
    case 'date': {
      const ts = Number(node.attrs?.timestamp);
      return Number.isFinite(ts) ? new Date(ts).toISOString().slice(0, 10) : '';
    }
    case 'status':
      return String(node.attrs?.text ?? '');
    default:
      return (node.content ?? []).map(inlineText).join('');
  }
}

const CONTAINERS = new Set(['doc', 'bulletList', 'orderedList', 'taskList', 'decisionList', 'panel', 'expand', 'nestedExpand', 'layoutSection', 'layoutColumn', 'table', 'tableRow', 'bodiedExtension']);

/**
 * Flattens a Confluence page body (request `body-format=atlas_doc_format`) into blocks.
 * Decision items keep their DECIDED/UNDECIDED state, the most reliable decision signal.
 */
export function confluenceAdfToBlocks(doc: AdfNode): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  const push = (type: BlockType, node: AdfNode, text: string, extra: Partial<ContentBlock> = {}) => {
    if (!text.trim()) return;
    const localId = typeof node.attrs?.localId === 'string' ? node.attrs.localId : undefined;
    blocks.push({ id: localId ?? `b${blocks.length}`, type, text, ...extra });
  };

  const walk = (node: AdfNode, inherited: BlockType = 'paragraph') => {
    switch (node.type) {
      case 'heading':
        push('heading', node, inlineText(node), { headingLevel: Number(node.attrs?.level ?? 1) });
        return;
      case 'paragraph':
        push(inherited, node, inlineText(node));
        return;
      case 'decisionItem':
        push('decision-item', node, inlineText(node), { decisionState: node.attrs?.state === 'UNDECIDED' ? 'UNDECIDED' : 'DECIDED' });
        return;
      case 'taskItem':
        push('task-item', node, inlineText(node));
        return;
      case 'listItem':
        for (const child of node.content ?? []) walk(child, 'list-item');
        return;
      case 'tableCell':
      case 'tableHeader':
        for (const child of node.content ?? []) walk(child, 'table-cell');
        return;
      case 'blockquote':
        for (const child of node.content ?? []) walk(child, 'quote');
        return;
      case 'codeBlock':
      case 'mediaSingle':
      case 'mediaGroup':
      case 'rule':
        return;
      default:
        if (CONTAINERS.has(node.type) || node.content) for (const child of node.content ?? []) walk(child, inherited);
    }
  };
  walk(doc);
  return blocks;
}

/** Plain text for Jira REST v3 ADF fields (issue descriptions, comment bodies). */
export function adfToPlainText(doc: AdfNode | null | undefined): string {
  if (!doc) return '';
  return confluenceAdfToBlocks(doc)
    .map((b) => (b.type === 'list-item' || b.type === 'task-item' ? `- ${b.text}` : b.text))
    .join('\n');
}
