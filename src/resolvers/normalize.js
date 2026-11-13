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
    description: issue.fields?.description === undefined ? undefined : adfToText(issue.fields.description),
    projectKey,
    status: issue.fields?.status?.name ?? undefined,
    labels: issue.fields?.labels ?? [],
    updatedAt: issue.fields?.updated ?? ''
  };
}

function authorName(user) {
  return typeof user?.displayName === 'string' ? user.displayName : undefined;
}

/** First line of every comment the app posts. Used to keep those comments out of later scans. */
export const NOTE_MARKER = 'Decision Drift Radar note';

/**
 * The fixed follow-up posted when the app cannot establish that everyone who can see the Jira
 * issue may also see the decision's source. It contains nothing taken from the source.
 */
export const GENERIC_NOTE = 'A recorded decision may affect this issue. Its source may not be visible to everyone who can see this issue, so it is not quoted here. Ask the author of this comment for the details before relying on the current description.';

const bylineFor = (confirmedIn) => (confirmedIn === 'rovo'
  ? ' · drafted with the Rovo agent and approved in the Jira issue panel'
  : ' · reviewed by a teammate before posting');
const noteLines = (note) => String(note ?? '').split(/\n+/).map((line) => line.trim()).filter(Boolean);

/**
 * The comment the app posts, as Jira ADF and as the exact plain text shown in the preview.
 * `mode` is 'quoted' (the note, the quoted evidence and the source) or 'generic' (GENERIC_NOTE
 * only: no note text, quote, source title or link).
 */
export function noteComment({ mode, note, quote, sourceTitle, sourceUrl, confirmedIn }) {
  const text = (value, marks) => ({ type: 'text', text: value, ...(marks ? { marks } : {}) });
  const byline = bylineFor(confirmedIn);
  const header = { type: 'paragraph', content: [text(NOTE_MARKER, [{ type: 'strong' }]), text(byline)] };
  if (mode !== 'quoted') {
    return {
      body: { type: 'doc', version: 1, content: [header, { type: 'paragraph', content: [text(GENERIC_NOTE)] }] },
      text: `${NOTE_MARKER}${byline}\n${GENERIC_NOTE}`
    };
  }
  const title = sourceTitle || 'Source';
  const lines = noteLines(note);
  return {
    body: {
      type: 'doc',
      version: 1,
      content: [
        header,
        ...lines.map((line) => ({ type: 'paragraph', content: [text(line)] })),
        { type: 'blockquote', content: [{ type: 'paragraph', content: [text(quote)] }] },
        {
          type: 'paragraph',
          content: [text('Source: '), sourceUrl ? text(title, [{ type: 'link', attrs: { href: sourceUrl } }]) : text(title)]
        }
      ]
    },
    text: [`${NOTE_MARKER}${byline}`, ...lines, `“${quote}”`, `Source: ${title}${sourceUrl ? ` (${sourceUrl})` : ''}`].join('\n')
  };
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
    // Notes the app posted quote a decision; scanning them would report it a second time.
    if (!text || text.startsWith(NOTE_MARKER)) continue;
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

/**
 * Site-relative Confluence page link. Inside Forge, `_links.base` can be the bare site URL
 * without `/wiki`, so `base + webui` opened Jira's dead-link page (`/spaces/...`). Confluence
 * pages always live under `/wiki` on the site; the UI prefixes its own `siteUrl`.
 */
export function confluencePath(webui) {
  if (typeof webui !== 'string' || !webui.trim()) return '';
  if (/^https?:\/\//i.test(webui)) return '';
  const path = webui.startsWith('/') ? webui : `/${webui}`;
  return /^\/wiki(?:\/|$)/.test(path) ? path : `/wiki${path}`;
}

/** SourceRecord for a Confluence page found by the project-key search. */
export function pageSource(page, projectKey, via) {
  const adf = parseAdf(page.body?.atlas_doc_format?.value);
  const text = adf ? adfToText(adf) : storageToText(page.body?.storage?.value);
  return {
    id: `page-${page.id}`,
    type: 'confluence_page',
    title: page.title ?? 'Untitled page',
    url: confluencePath(page._links?.webui),
    text,
    projectKey,
    updatedAt: page.version?.when ?? '',
    ...(authorName(page.version?.by) ? { author: authorName(page.version.by) } : {}),
    ...(via ? { via } : {})
  };
}
