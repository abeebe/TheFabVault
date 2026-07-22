import type { ReactNode } from 'react';

// Minimal, dependency-free Markdown renderer for model descriptions (A4,
// #2157). Model descriptions can originate from imported third-party
// sources (Phase C's zip import pipeline pulls README-derived text from
// MakerWorld/Printables/Thingiverse zips), so this deliberately never
// uses dangerouslySetInnerHTML -- every block below builds a real React
// element tree, so there's no HTML/script injection surface to reason
// about, and link hrefs are scheme-checked before being rendered as a
// real anchor. Supports the handful of constructs a print-model
// description actually uses: headings, paragraphs, bold/italic/code,
// links, and lists. This is deliberately not a CommonMark implementation
// -- if richer formatting is ever needed, that's the point to reach for
// a real library instead of growing this by hand.

// Exported (not just used internally by renderInline below) because it's
// the same scheme guard any other raw-href-from-a-user-controlled-field
// spot needs -- e.g. ModelPage.tsx's "Source attribution" block renders
// model.sourceUrl (free text in the Edit Details modal, populated from
// third-party metadata once Phase C's zip import lands) as a real anchor,
// and needs this exact check, not a second copy of it. Kit's review of
// #2157 caught that spot rendering unchecked -- see ModelPage.tsx for the
// fix and the regression test pinning it.
export function isSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url, 'https://placeholder.invalid');
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'mailto:';
  } catch {
    return false;
  }
}

// Tokenizes a single line/item of inline markdown: `code`, **bold**,
// *italic*, [text](url). Code spans are matched first so backticked text
// isn't misread as containing bold/italic markers.
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let remaining = text;
  let key = 0;

  const matchers: [RegExp, (m: RegExpMatchArray) => ReactNode][] = [
    [/^`([^`]+)`/, (m) => (
      <code key={`${keyPrefix}-${key}`} className="px-1 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-[0.9em] font-mono">
        {m[1]}
      </code>
    )],
    [/^\*\*([^*]+)\*\*/, (m) => <strong key={`${keyPrefix}-${key}`}>{m[1]}</strong>],
    [/^\*([^*]+)\*/, (m) => <em key={`${keyPrefix}-${key}`}>{m[1]}</em>],
    [/^\[([^\]]+)\]\(([^)]+)\)/, (m) => (
      isSafeUrl(m[2])
        ? <a key={`${keyPrefix}-${key}`} href={m[2]} target="_blank" rel="noopener noreferrer" className="text-accent underline">{m[1]}</a>
        : <span key={`${keyPrefix}-${key}`}>{m[1]}</span>
    )],
  ];

  while (remaining.length > 0) {
    let matched = false;
    for (const [re, render] of matchers) {
      const m = remaining.match(re);
      if (m) {
        nodes.push(render(m));
        remaining = remaining.slice(m[0].length);
        key++;
        matched = true;
        break;
      }
    }
    if (!matched) {
      // Consume plain text up to (not including) the next special
      // character in one chunk, rather than one character at a time.
      const next = remaining.slice(1).search(/[`*[]/);
      const chunkLen = next === -1 ? remaining.length : next + 1;
      nodes.push(remaining.slice(0, chunkLen));
      remaining = remaining.slice(chunkLen);
    }
  }

  return nodes;
}

type Block =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'list'; ordered: boolean; items: string[] };

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const LIST_ITEM_RE = /^\s*([-*]|\d+\.)\s+(.*)$/;

function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i++; continue; }

    const heading = line.match(HEADING_RE);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] });
      i++;
      continue;
    }

    const listItem = line.match(LIST_ITEM_RE);
    if (listItem) {
      const ordered = /^\d+\./.test(listItem[1]);
      const items: string[] = [];
      while (i < lines.length) {
        const m = lines[i].match(LIST_ITEM_RE);
        if (!m) break;
        items.push(m[2]);
        i++;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }

    // Paragraph: consume consecutive non-blank lines that don't start a
    // new heading/list block, joining them with a space (soft-wrap).
    const paraLines: string[] = [];
    while (i < lines.length && lines[i].trim() && !HEADING_RE.test(lines[i]) && !LIST_ITEM_RE.test(lines[i])) {
      paraLines.push(lines[i]);
      i++;
    }
    blocks.push({ type: 'paragraph', text: paraLines.join(' ') });
  }

  return blocks;
}

const HEADING_CLASSES: Record<1 | 2 | 3, string> = {
  1: 'text-xl font-bold mt-4 mb-2',
  2: 'text-lg font-bold mt-3 mb-1.5',
  3: 'text-base font-semibold mt-2 mb-1',
};

export function renderMarkdown(source: string): ReactNode {
  const blocks = parseBlocks(source);
  if (blocks.length === 0) return null;

  return (
    <div className="space-y-2 text-sm text-gray-700 dark:text-gray-300">
      {blocks.map((block, i) => {
        if (block.type === 'heading') {
          const level = Math.min(block.level, 3) as 1 | 2 | 3;
          return (
            <p key={i} className={`${HEADING_CLASSES[level]} text-gray-900 dark:text-gray-100`}>
              {renderInline(block.text, `h${i}`)}
            </p>
          );
        }
        if (block.type === 'list') {
          const items = block.items.map((item, j) => <li key={j}>{renderInline(item, `l${i}-${j}`)}</li>);
          return block.ordered
            ? <ol key={i} className="list-decimal pl-5 space-y-0.5">{items}</ol>
            : <ul key={i} className="list-disc pl-5 space-y-0.5">{items}</ul>;
        }
        return <p key={i}>{renderInline(block.text, `p${i}`)}</p>;
      })}
    </div>
  );
}
