// UI ported from Clarklevis1995/dsh-mobile androidApp/src/main/kotlin/com/clarklevis/dsh/android/ui/DshMarkdownText.kt (MIT)
//
// The transcript's markdown parser.
//
// WHY our own parser: Clarklevis's `DshMarkdownText.kt` does not parse markdown itself — it
// delegates to Markwon (a CommonMark library) and then styles the resulting spans;
// `DshMarkdownCodeCard.kt` / `DshMarkdownTable.kt` supply the card and table *look*. Kotlin/Swift
// cannot be copied into RN, and a markdown dependency is exactly the kind of addition spec 011
// says needs the lead's approval. So this module reproduces the CommonMark behaviour those screens
// rely on, for the subset a DSH transcript actually produces, and the renderer (`Markdown.tsx`)
// applies Clarklevis's visual treatment on top.
//
// What is ported, deliberately:
//   * ATX headings, emphasis (`*` may emphasise intraword, `_` may not — so `snake_case` stays
//     literal; this is the CommonMark rule Markwon implements, and a naive parser gets it wrong),
//     inline code, and links;
//   * fenced code with an info string (their Bash card renders the language label and line
//     numbers — `codeLines` below is what the renderer numbers);
//   * bullet and ordered lists with nesting;
//   * GitHub tables with per-column alignment (reference: their table card);
//   * `---` thematic breaks;
//   * unterminated constructs degrade to literal text, never to a lost message.
//
// Safety (this parses untrusted text from a remote Host, so each property has a test):
//   * it is pure — no React, no react-native, no I/O, no clock — so it runs in plain Node tests;
//   * every loop advances, so no input can spin it;
//   * nesting (`MAX_LIST_DEPTH`) and allocation (`MAX_BLOCKS`, `MAX_INLINE_PARTS`) are bounded;
//   * a link is a link only when its target is `http:`/`https:`; `javascript:`, `file:`, `data:`
//     and garbage stay literal text, so the renderer is never handed a dangerous href.

/** Inline span: the formatted pieces of one run of prose. */
export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'strong'; text: string }
  | { kind: 'em'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'link'; text: string; href: string };

/** One table cell, and one table row (cells in source order). */
export type TableCell = Inline[];
export type TableRow = TableCell[];

/** Column alignment from the delimiter row; null means "no preference". */
export type Align = 'left' | 'center' | 'right' | null;

export interface HeadingBlock {
  kind: 'heading';
  level: 1 | 2 | 3 | 4 | 5 | 6;
  inlines: Inline[];
}

export interface ParagraphBlock {
  kind: 'paragraph';
  inlines: Inline[];
}

export interface CodeBlock {
  kind: 'code';
  /** Fence info string ("bash", "ts"), null when the fence carried none. */
  language: string | null;
  text: string;
}

export interface ListItem {
  /** The item's own prose first, then any nested lists or code it holds. */
  blocks: Block[];
}

export interface ListBlock {
  kind: 'list';
  ordered: boolean;
  /** First number of an ordered list (1 for bullets). */
  start: number;
  items: ListItem[];
}

export interface TableBlock {
  kind: 'table';
  align: Align[];
  header: TableRow;
  rows: TableRow[];
}

export interface RuleBlock {
  kind: 'rule';
}

export type Block = HeadingBlock | ParagraphBlock | CodeBlock | ListBlock | TableBlock | RuleBlock;

/** Bound on list nesting; deeper indentation folds into the level at the bound. */
export const MAX_LIST_DEPTH = 8;
/** Bound on emitted blocks; past it the rest of the message stays one readable paragraph. */
export const MAX_BLOCKS = 4000;
/** Bound on inline parts per line; past it the rest of the line stays one text run. */
export const MAX_INLINE_PARTS = 2000;

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)\s*$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*)$/;
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const BULLET = /^(\s*)([-*+])\s+(.*)$/;
const ORDERED = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const TABLE_DELIMITER = /^\s*\|?\s*:?-{1,}:?\s*(?:\|\s*:?-{1,}:?\s*)+\|?\s*$/;

/**
 * Indexed read for the parser's bounds-guarded loops.
 *
 * The project compiles with `noUncheckedIndexedAccess`, so `lines[i]` is `string | undefined` even
 * where the loop invariant (`i < lines.length`) proves it exists, and the same applies to regex
 * capture groups this module always tests before reading. Stating that invariant once here keeps
 * the parser free of dozens of `!` assertions, which would hide a real mistake instead of a
 * provable one.
 */
function at<T>(items: readonly T[], index: number): T {
  return items[index] as T;
}

/** Parse markdown into blocks. Total: any input yields blocks, never an exception. */
export function parseMarkdown(source: string): Block[] {
  if (typeof source !== 'string' || source === '') return [];
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = at(lines, i);
    if (line.trim() === '') {
      i += 1;
      continue;
    }

    if (blocks.length >= MAX_BLOCKS) {
      blocks.push({ kind: 'paragraph', inlines: [{ kind: 'text', text: lines.slice(i).join('\n') }] });
      return blocks;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = at(fence, 1);
      const info = at(fence, 2);
      const body: string[] = [];
      i += 1;
      // An unterminated fence runs to the end of the message: that is what a streaming
      // assistant's half-arrived block actually is.
      while (i < lines.length && !isFenceClose(at(lines, i), marker)) {
        body.push(at(lines, i));
        i += 1;
      }
      if (i < lines.length) i += 1;
      blocks.push({ kind: 'code', language: info === '' ? null : info, text: body.join('\n') });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({
        kind: 'heading',
        level: at(heading, 1).length as HeadingBlock['level'],
        inlines: parseInline(at(heading, 2).trim()),
      });
      i += 1;
      continue;
    }

    if (RULE.test(line)) {
      blocks.push({ kind: 'rule' });
      i += 1;
      continue;
    }

    if (isTableStart(lines, i)) {
      i += parseTable(lines, i, blocks);
      continue;
    }

    if (BULLET.test(line) || ORDERED.test(line)) {
      i += parseList(lines, i, blocks);
      continue;
    }

    const paragraph: string[] = [];
    while (i < lines.length && at(lines, i).trim() !== '' && !startsBlock(lines, i)) {
      paragraph.push(at(lines, i).trim());
      i += 1;
    }
    if (paragraph.length === 0) {
      // A construct that starts but could not be consumed still becomes text, so the loop
      // always advances and no character is ever dropped.
      paragraph.push(at(lines, i));
      i += 1;
    }
    blocks.push({ kind: 'paragraph', inlines: parseInline(paragraph.join('\n')) });
  }

  return blocks;
}

/** Parse one run of prose's inline formatting. Never throws. */
export function parseInline(source: string): Inline[] {
  const parts: Inline[] = [];
  let text = '';
  let i = 0;

  const flush = (): void => {
    if (text !== '') {
      parts.push({ kind: 'text', text });
      text = '';
    }
  };

  while (i < source.length) {
    if (parts.length >= MAX_INLINE_PARTS) return [...parts, { kind: 'text', text: source.slice(i) }];

    const char = source.charAt(i);

    if (char === '`') {
      const end = source.indexOf('`', i + 1);
      if (end > i + 1) {
        flush();
        parts.push({ kind: 'code', text: source.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }

    if (char === '*' && source[i + 1] === '*') {
      const end = source.indexOf('**', i + 2);
      if (end > i + 2) {
        flush();
        parts.push({ kind: 'strong', text: source.slice(i + 2, end) });
        i = end + 2;
        continue;
      }
    }

    if (char === '*' || char === '_') {
      // CommonMark: `_` inside a word is literal, so `snake_case_name` is not emphasis. `*` may
      // emphasise intraword (`a*b*c` is valid), so only `_` carries the word-boundary rule.
      const end = source.indexOf(char, i + 1);
      const opens = char !== '_' || i === 0 || !isWordChar(source.charAt(i - 1));
      const closes = char !== '_' || end < 0 || end + 1 >= source.length || !isWordChar(source.charAt(end + 1));
      if (end > i + 1 && opens && closes) {
        flush();
        parts.push({ kind: 'em', text: source.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }

    if (char === '[') {
      const link = matchLink(source, i);
      if (link) {
        flush();
        parts.push({ kind: 'link', text: link.text, href: link.href });
        i = link.end;
        continue;
      }
    }

    text += char;
    i += 1;
  }

  flush();
  return parts;
}

/** Only http(s) links ever reach `Linking.openURL`; anything else stays literal text. */
export function isSafeHref(href: string): boolean {
  return /^https?:\/\/\S+$/i.test(href);
}

/**
 * Split a fenced block for the code card: Clarklevis's `DshMarkdownCodeCard` shows the language
 * label in the card header and numbers every line, so the renderer needs the lines, not the blob.
 * Trailing empty lines (a fence that ends with a blank line) are dropped: they would render as
 * numbered empty rows.
 */
export function codeLines(text: string): string[] {
  const lines = text.split('\n');
  while (lines.length > 0 && at(lines, lines.length - 1) === '') lines.pop();
  return lines;
}

/** Plain text of an inline span (link text, not its target). */
export function inlineText(inline: Inline): string {
  return inline.text;
}

/** Plain text of a block, for accessibility labels and collapsed one-line tool summaries. */
export function blockText(block: Block): string {
  switch (block.kind) {
    case 'paragraph':
    case 'heading':
      return block.inlines.map(inlineText).join('');
    case 'code':
      return block.text;
    case 'list':
      return block.items.map((item) => item.blocks.map((child) => blockText(child)).join(' ')).join(' ');
    case 'table': {
      const rowText = (row: TableRow): string => row.map((cell) => cell.map(inlineText).join('')).join(' ');
      return [rowText(block.header), ...block.rows.map(rowText)].join(' ');
    }
    case 'rule':
      return '';
  }
}

function isWordChar(char: string): boolean {
  return /[0-9A-Za-z]/.test(char);
}

function matchLink(source: string, start: number): { text: string; href: string; end: number } | null {
  const labelEnd = source.indexOf(']', start + 1);
  if (labelEnd <= start + 1 || source[labelEnd + 1] !== '(') return null;
  const hrefEnd = source.indexOf(')', labelEnd + 2);
  if (hrefEnd <= labelEnd + 2) return null;
  const href = source.slice(labelEnd + 2, hrefEnd).trim();
  if (!isSafeHref(href)) return null;
  return { text: source.slice(start + 1, labelEnd), href, end: hrefEnd + 1 };
}

function isFenceClose(line: string, marker: string): boolean {
  const trimmed = line.trim();
  if (trimmed === '') return false;
  const char = marker.charAt(0);
  let count = 0;
  while (trimmed[count] === char) count += 1;
  return count >= marker.length && trimmed.slice(count).trim() === '';
}

function startsBlock(lines: string[], i: number): boolean {
  const line = at(lines, i);
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    RULE.test(line) ||
    BULLET.test(line) ||
    ORDERED.test(line) ||
    isTableStart(lines, i)
  );
}

function isTableStart(lines: string[], i: number): boolean {
  if (i + 1 >= lines.length) return false;
  if (!at(lines, i).includes('|')) return false;
  return TABLE_DELIMITER.test(at(lines, i + 1));
}

/** Consume a table at `i`; returns the number of lines consumed. */
function parseTable(lines: string[], start: number, blocks: Block[]): number {
  const header = splitCells(at(lines, start));
  const align = splitCells(at(lines, start + 1)).map(cellAlign);
  let i = start + 2;
  const rows: TableRow[] = [];
  while (i < lines.length && at(lines, i).trim() !== '' && at(lines, i).includes('|') && !FENCE.test(at(lines, i))) {
    rows.push(splitCells(at(lines, i)));
    i += 1;
  }
  // Keep the grid rectangular: short rows are padded, so the table card can size columns.
  const width = Math.max(header.length, align.length, ...rows.map((row) => row.length));
  const pad = (row: TableRow): TableRow => {
    const cells = row.slice(0, width);
    while (cells.length < width) cells.push([]);
    return cells;
  };
  blocks.push({
    kind: 'table',
    align: Array.from({ length: width }, (_, index) => at(align, index) ?? null),
    header: pad(header),
    rows: rows.map(pad),
  });
  return i - start;
}

/** Split one table line into cells, honouring `\|` escapes. */
function splitCells(line: string): TableCell[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells: string[] = [];
  let current = '';
  for (let i = 0; i < trimmed.length; i += 1) {
    const char = trimmed.charAt(i);
    if (char === '\\' && trimmed[i + 1] === '|') {
      current += '|';
      i += 1;
      continue;
    }
    if (char === '|') {
      cells.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  cells.push(current);
  return cells.map((cell) => parseInline(cell.trim()));
}

function cellAlign(cell: Inline[]): Align {
  const text = cell.map((part) => part.text).join('').trim();
  if (text.startsWith(':') && text.endsWith(':')) return 'center';
  if (text.endsWith(':')) return 'right';
  if (text.startsWith(':')) return 'left';
  return null;
}

/**
 * Consume a list at `i`; returns the number of lines consumed.
 *
 * Indentation drives nesting: a more-indented item opens a child list inside the item above it, a
 * less-indented one closes levels back to its own, and a marker change (`-` to `1.`) opens a
 * sibling list instead of gluing two different lists together.
 */
function parseList(lines: string[], start: number, blocks: Block[]): number {
  const first = matchItem(at(lines, start));
  if (!first) return 0;
  const root: ListBlock = { kind: 'list', ordered: first.ordered, start: first.number, items: [] };
  blocks.push(root);

  const stack: Array<{ indent: number; list: ListBlock }> = [{ indent: first.indent, list: root }];
  let i = start;
  let lastItem: ListItem | null = null;

  while (i < lines.length) {
    const line = at(lines, i);
    if (line.trim() === '') break;

    const item = matchItem(line);
    if (item) {
      const current = at(stack, stack.length - 1);
      if (item.indent > current.indent) {
        const nested: ListBlock = { kind: 'list', ordered: item.ordered, start: item.number, items: [] };
        if (stack.length < MAX_LIST_DEPTH) {
          stack.push({ indent: item.indent, list: nested });
          if (lastItem) lastItem.blocks.push(nested);
          else current.list.items.push({ blocks: [nested] });
        } else {
          // At the depth bound: the item folds into the current level instead of recursing.
          current.list.items.push({ blocks: [{ kind: 'paragraph', inlines: parseInline(item.text) }] });
          i += 1;
          continue;
        }
        lastItem = { blocks: [{ kind: 'paragraph', inlines: parseInline(item.text) }] };
        nested.items.push(lastItem);
        i += 1;
        continue;
      }

      while (stack.length > 1 && item.indent < at(stack, stack.length - 1).indent) stack.pop();
      const level = at(stack, stack.length - 1);
      if (level.list.ordered !== item.ordered) {
        const sibling: ListBlock = { kind: 'list', ordered: item.ordered, start: item.number, items: [] };
        const parentItem = findParentItem(stack);
        if (parentItem) parentItem.blocks.push(sibling);
        else blocks.push(sibling);
        stack[stack.length - 1] = { indent: level.indent, list: sibling };
      }
      lastItem = { blocks: [{ kind: 'paragraph', inlines: parseInline(item.text) }] };
      at(stack, stack.length - 1).list.items.push(lastItem);
      i += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = at(fence, 1);
      const info = at(fence, 2);
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !isFenceClose(at(lines, i), marker)) {
        body.push(at(lines, i));
        i += 1;
      }
      if (i < lines.length) i += 1;
      const code: CodeBlock = { kind: 'code', language: info === '' ? null : info, text: body.join('\n') };
      if (lastItem) lastItem.blocks.push(code);
      else break;
      continue;
    }

    if (lastItem && /^\s{2,}\S/.test(line) && !HEADING.test(line)) {
      const paragraph = at(lastItem.blocks, 0);
      if (paragraph.kind === 'paragraph') {
        paragraph.inlines = parseInline(`${paragraph.inlines.map(inlineText).join('')} ${line.trim()}`);
      } else {
        lastItem.blocks.push({ kind: 'paragraph', inlines: parseInline(line.trim()) });
      }
      i += 1;
      continue;
    }

    break;
  }

  return i - start;
}

function findParentItem(stack: Array<{ indent: number; list: ListBlock }>): ListItem | null {
  for (let index = stack.length - 2; index >= 0; index -= 1) {
    const list = at(stack, index).list;
    const item = list.items[list.items.length - 1];
    if (item) return item;
  }
  return null;
}

function matchItem(line: string): { indent: number; ordered: boolean; number: number; text: string } | null {
  const bullet = BULLET.exec(line);
  if (bullet) {
    return { indent: at(bullet, 1).length, ordered: false, number: 1, text: at(bullet, 3) };
  }
  const ordered = ORDERED.exec(line);
  if (ordered) {
    const number = Number.parseInt(at(ordered, 2), 10);
    return {
      indent: at(ordered, 1).length,
      ordered: true,
      number: Number.isFinite(number) ? number : 1,
      text: at(ordered, 3),
    };
  }
  return null;
}
