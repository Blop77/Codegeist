/**
 * Turns raw Jira and Confluence REST payloads into the records `extractDecisions` expects
 * (see src/domain/decisionTypes.ts). Pure: no Forge calls, so it can be checked locally.
 *
 * Text follows the conventions in src/domain/README.md: `## ` headings, `- ` list items,
 * and Confluence decision items rendered as `Decision: …` / `Open question: …`.
 */

const MAX_SOURCE_TEXT = 20000;

// ---------------------------------------------------------------------------
// Atlassian Document Format (Jira descriptions/comments, Confluence atlas_doc_format)
// ---------------------------------------------------------------------------

function inlineText(node) {
  if (!node || typeof node !== 'object') return '';
  switch (node.type) {
    case 'text':
      return node.text ?? '';
    case 'hardBreak':
      return ' ';
    case 'mention':
    case 'status':
      return String(node.attrs?.text ?? '');
    case 'emoji':
      return String(node.attrs?.text ?? node.attrs?.shortName ?? '');
    case 'inlineCard':
      return String(node.attrs?.url ?? '');
    case 'date': {
      const ts = Number(node.attrs?.timestamp);
      return Number.isFinite(ts) ? new Date(ts).toISOString().slice(0, 10) : '';
    }
    default:
      return (node.content ?? []).map(inlineText).join('');
  }
}

const SKIPPED_BLOCKS = new Set(['codeBlock', 'mediaSingle', 'mediaGroup', 'media', 'rule', 'extension']);

/** Plain text, one block per line. Unknown or malformed input gives an empty string. */
export function adfToText(doc) {
  const lines = [];
  const push = (prefix, node) => {
    const text = inlineText(node).replace(/\s+/g, ' ').trim();
    if (text) lines.push(prefix + text);
  };

  const walk = (node, listPrefix = '') => {
    if (!node || typeof node !== 'object' || SKIPPED_BLOCKS.has(node.type)) return;
    switch (node.type) {
      case 'heading':
        push('## ', node);
        return;
      case 'paragraph':
        push(listPrefix, node);
        return;
      case 'decisionItem':
        push(node.attrs?.state === 'UNDECIDED' ? 'Open question: ' : 'Decision: ', node);
        return;
      case 'taskItem':
        push('- ', node);
        return;
      case 'listItem':
        for (const child of node.content ?? []) walk(child, '- ');
        return;
      default:
        for (const child of node.content ?? []) walk(child, listPrefix);
    }
  };

  walk(doc);
  return lines.join('\n').slice(0, MAX_SOURCE_TEXT);
}

function parseAdf(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Confluence storage format (fallback when atlas_doc_format is unavailable)
// ---------------------------------------------------------------------------

function decodeEntities(value) {
  return value
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

export function storageToText(html) {
  const text = String(html ?? '')
    .replace(/<ac:structured-macro[^>]*ac:name="code"[\s\S]*?<\/ac:structured-macro>/g, '\n')
    .replace(/<h[1-6][^>]*>/gi, '\n## ')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/(?:p|h[1-6]|li|tr|div|blockquote)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, ' ');
  return decodeEntities(text)
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line && line !== '##' && line !== '-')
    .join('\n')
    .slice(0, MAX_SOURCE_TEXT);
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/**
 * Site-relative Jira issue link. Inside Forge, `issue.self` points at the API gateway
 * (https://api.atlassian.com/ex/jira/<cloudId>/…), not the site, so links are emitted as
 * `/browse/KEY` and the UI prefixes its own `siteUrl`.
 */
export function browsePath(issueKey) {
  return `/browse/${issueKey}`;
}

/** Display record for the UI. */
export function toIssueSummary(issue) {
  return {
    key: issue.key,
    summary: issue.fields?.summary ?? 'Untitled issue',
    status: issue.fields?.status?.name ?? 'Unknown',
    labels: issue.fields?.labels ?? [],
    url: browsePath(issue.key),
    updated: issue.fields?.updated ?? null
  };
}

/** IssueRecord for extractDecisions. */
export function toIssueRecord(issue, projectKey) {
  return {
    id: String(issue.id ?? issue.key),
    key: issue.key,
    title: issue.fields?.summary ?? '',
    description: adfToText(issue.fields?.description),
    projectKey,
    status: issue.fields?.status?.name ?? undefined,
    labels: issue.fields?.labels ?? [],
    updatedAt: issue.fields?.updated ?? ''
  };
}

function authorName(user) {
  return typeof user?.displayName === 'string' ? user.displayName : undefined;
}

/** SourceRecords for an issue's description and its comments. */
export function issueSources(issue, projectKey) {
  const browse = browsePath(issue.key);
  const out = [];

  const description = adfToText(issue.fields?.description);
  if (description) {
    out.push({
      id: `issue-${issue.id ?? issue.key}`,
      type: 'jira_issue',
      title: `${issue.key}: ${issue.fields?.summary ?? 'Untitled issue'}`,
      url: browse,
      text: description,
      projectKey,
      updatedAt: issue.fields?.updated ?? '',
      ...(authorName(issue.fields?.reporter) ? { author: authorName(issue.fields.reporter) } : {})
    });
  }

  for (const comment of issue.fields?.comment?.comments ?? []) {
    const text = adfToText(comment.body);
    if (!text) continue;
    const author = authorName(comment.author);
    out.push({
      id: `comment-${comment.id}`,
      type: 'jira_comment',
      title: `Comment on ${issue.key}${author ? ` by ${author}` : ''}`,
      url: `${browse}?focusedCommentId=${comment.id}`,
      text,
      projectKey,
      updatedAt: comment.updated ?? comment.created ?? '',
      ...(author ? { author } : {})
    });
  }
  return out;
}

/** SourceRecord for a Confluence page found by the project-key search. */
export function pageSource(page, projectKey) {
  const adf = parseAdf(page.body?.atlas_doc_format?.value);
  const text = adf ? adfToText(adf) : storageToText(page.body?.storage?.value);
  const base = page._links?.base ?? '';
  const webui = page._links?.webui ?? '';
  return {
    id: `page-${page.id}`,
    type: 'confluence_page',
    title: page.title ?? 'Untitled page',
    url: webui ? `${base}${webui}` : '',
    text,
    projectKey,
    updatedAt: page.version?.when ?? '',
    ...(authorName(page.version?.by) ? { author: authorName(page.version.by) } : {})
  };
}
