/**
 * Turns a Markdown meeting-notes file into the plain-text layout the app gives the extractor for
 * a Confluence page (see src/domain/README.md): one line per paragraph, `## ` headings and `- `
 * list items. Hard-wrapped lines are joined, as a Confluence paragraph would be. Link targets,
 * bold markers, front matter, link definitions and fenced code blocks are dropped; all other
 * wording is kept as written.
 */
export function prepareMarkdown(markdown: string): string {
  let text = markdown.replace(/\r\n/g, '\n');
  text = text.replace(/^---\n[\s\S]*?\n---\n/, '');
  text = text.replace(/```[\s\S]*?```/g, '');
  text = text.replace(/^\s*\[[^\]\n]+\]:\s*\S+.*$/gm, '');
  text = text.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1');
  text = text.replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1');
  text = text.replace(/\\([[\]])/g, '$1');
  text = text.replace(/\*\*|__/g, '');

  const out: string[] = [];
  let current: string | null = null;
  const flush = () => {
    if (current !== null) out.push(current.replace(/\s+/g, ' ').trim());
    current = null;
  };
  for (const raw of text.split('\n')) {
    const line = raw.replace(/^(\s*>)+ ?/, '').trim();
    if (!line) {
      flush();
      continue;
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    const item = /^(?:[-*+]|\d+\.)\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      out.push(`## ${heading[1].trim()}`);
    } else if (item) {
      flush();
      current = `- ${item[1]}`;
    } else {
      current = current === null ? line : `${current} ${line}`;
    }
  }
  flush();
  return out.filter(Boolean).join('\n');
}

/** Lower case, straight quotes, single spaces: the form in which labels and quotes are compared. */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/…/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
