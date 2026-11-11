// Spec 011 P1-B — tests for the ported markdown parser (src/ui/markdown/parse.ts).
//
// The parser is the only new code that touches untrusted host text, so these cases are the ones the
// port has to get right rather than decorative ones: the CommonMark rules Clarklevis's Markwon
// instance applies (`snake_case` is NOT italic), their code card's language label + line numbers,
// their table card's alignment, and the inputs that make a naive parser throw or spin.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MAX_LIST_DEPTH,
  blockText,
  codeLines,
  isSafeHref,
  parseInline,
  parseMarkdown,
  type Block,
  type CodeBlock,
  type HeadingBlock,
  type ListBlock,
  type ParagraphBlock,
  type TableBlock,
} from '../src/ui/markdown/parse';

/** Bounds-guarded read for the assertions below (`noUncheckedIndexedAccess` is on project-wide). */
function at<T>(items: readonly T[], index: number): T {
  return items[index] as T;
}

function blockOf<K extends Block['kind']>(blocks: Block[], kind: K, index = 0): Extract<Block, { kind: K }> {
  const found = blocks.filter((block) => block.kind === kind)[index];
  assert.ok(found, `expected a ${kind} at ${index}, got ${blocks.map((block) => block.kind).join(', ') || 'none'}`);
  return found as Extract<Block, { kind: K }>;
}

function textOf(inlines: ReturnType<typeof parseInline>): string {
  return inlines.map((inline) => inline.text).join('');
}

describe('markdown inline: CommonMark rules Markwon applies', () => {
  it('parses bold, italic, inline code and plain text in one line', () => {
    assert.deepEqual(
      parseInline('a **bold** b *em* c `code` d').map((inline) => [inline.kind, inline.text]),
      [
        ['text', 'a '],
        ['strong', 'bold'],
        ['text', ' b '],
        ['em', 'em'],
        ['text', ' c '],
        ['code', 'code'],
        ['text', ' d'],
      ],
    );
  });

  it('does NOT italicise an underscore inside a word (snake_case stays literal)', () => {
    assert.deepEqual(parseInline('snake_case_name and _emphasis_'), [
      { kind: 'text', text: 'snake_case_name and ' },
      { kind: 'em', text: 'emphasis' },
    ]);
  });

  it('still allows intraword emphasis with an asterisk', () => {
    assert.deepEqual(parseInline('a*b*c'), [
      { kind: 'text', text: 'a' },
      { kind: 'em', text: 'b' },
      { kind: 'text', text: 'c' },
    ]);
  });

  it('leaves unterminated or empty markers literal instead of swallowing the line', () => {
    assert.deepEqual(parseInline('a **unclosed b'), [{ kind: 'text', text: 'a **unclosed b' }]);
    assert.deepEqual(parseInline('a `unclosed'), [{ kind: 'text', text: 'a `unclosed' }]);
    assert.deepEqual(parseInline('a ** b'), [{ kind: 'text', text: 'a ** b' }]);
  });
});

describe('markdown blocks: headings, rules, paragraphs', () => {
  it('parses ATX heading levels 1-6', () => {
    const blocks = parseMarkdown('# One\n\n### Three\n\n###### Six');
    assert.deepEqual(
      blocks.map((block) => (block.kind === 'heading' ? (block as HeadingBlock).level : block.kind)),
      [1, 3, 6],
    );
  });

  it('needs a space after the hashes, like CommonMark', () => {
    assert.equal(at(parseMarkdown('#NotAHeading'), 0).kind, 'paragraph');
  });

  it('parses a thematic break', () => {
    assert.equal(at(parseMarkdown('---'), 0).kind, 'rule');
  });

  it('keeps a multi-line paragraph together and drops surrounding blank lines', () => {
    const blocks = parseMarkdown('\n\nChào.\nDòng hai.\n\n');
    assert.equal(blocks.length, 1);
    assert.equal(textOf((blockOf(blocks, 'paragraph') as ParagraphBlock).inlines), 'Chào.\nDòng hai.');
  });
});

describe('markdown blocks: fenced code (their Bash card)', () => {
  it('keeps the fence body verbatim and exposes the language label', () => {
    const code = blockOf(
      parseMarkdown('```bash\n# comment\ndsh plugin --profile web remove x\n```'),
      'code',
    ) as CodeBlock;
    assert.equal(code.language, 'bash');
    assert.equal(code.text, '# comment\ndsh plugin --profile web remove x');
  });

  it('does not parse markdown inside a fence', () => {
    const code = blockOf(parseMarkdown('```ts\nconst a = "**bold**"\n# not a heading\n```'), 'code') as CodeBlock;
    assert.equal(code.text, 'const a = "**bold**"\n# not a heading');
  });

  it('runs an unterminated fence to the end (a streaming assistant)', () => {
    const blocks = parseMarkdown('text\n\n```bash\nls -la\nrm -rf build');
    const code = blockOf(blocks, 'code') as CodeBlock;
    assert.equal(code.language, 'bash');
    assert.equal(code.text, 'ls -la\nrm -rf build');
  });

  it('accepts ~~~ fences and longer backtick runs, and a shorter run does not close', () => {
    assert.equal((blockOf(parseMarkdown('~~~\nx\n~~~'), 'code') as CodeBlock).text, 'x');
    assert.equal((blockOf(parseMarkdown('````\n```\nstill code\n````'), 'code') as CodeBlock).text, '```\nstill code');
  });

  it('splits a fence into numbered lines for the code card, dropping trailing blanks', () => {
    assert.deepEqual(codeLines('a\nb\n\n'), ['a', 'b']);
    assert.deepEqual(codeLines(''), []);
  });
});

describe('markdown blocks: lists (their bullet/number rendering)', () => {
  it('parses bullets and numbers, keeping the ordered start', () => {
    const bullets = blockOf(parseMarkdown('- a\n- b'), 'list') as ListBlock;
    assert.equal(bullets.ordered, false);
    assert.deepEqual(bullets.items.map((item) => blockText(at(item.blocks, 0))), ['a', 'b']);

    const numbered = blockOf(parseMarkdown('3. three\n4. four'), 'list') as ListBlock;
    assert.equal(numbered.ordered, true);
    assert.equal(numbered.start, 3);
    assert.equal(numbered.items.length, 2);
  });

  it('nests a more-indented list inside its parent item', () => {
    const list = blockOf(parseMarkdown('- parent\n  - child\n  - child 2\n- sibling'), 'list') as ListBlock;
    assert.equal(list.items.length, 2);
    const first = at(list.items, 0);
    const nested = first.blocks.find((block) => block.kind === 'list') as ListBlock;
    assert.ok(nested, 'the first item must hold the nested list');
    assert.deepEqual(nested.items.map((item) => blockText(at(item.blocks, 0))), ['child', 'child 2']);
  });

  it('bounds nesting instead of recursing without limit', () => {
    const deep = Array.from({ length: 40 }, (_, level) => `${' '.repeat(level * 2)}- level ${level}`).join('\n');
    const depth = (list: ListBlock): number =>
      1 +
      Math.max(
        0,
        ...list.items
          .flatMap((item) => item.blocks)
          .filter((block): block is ListBlock => block.kind === 'list')
          .map(depth),
      );
    assert.ok(depth(blockOf(parseMarkdown(deep), 'list') as ListBlock) <= MAX_LIST_DEPTH);
  });

  it('keeps a fenced block inside its item, and separates a marker change into sibling lists', () => {
    const list = blockOf(parseMarkdown('- step\n```\ncode\n```'), 'list') as ListBlock;
    assert.equal(at(list.items, 0).blocks.some((block) => block.kind === 'code'), true);
    assert.equal(parseMarkdown('- bullet\n1. number').filter((block) => block.kind === 'list').length, 2);
  });
});

describe('markdown blocks: tables (their table card)', () => {
  const table = [
    '| Phương án | Chỗ chứa | Dụng Windows |',
    '| --- | --- | :---: |',
    '| 8 GB | Đủ | Không |',
    '| Phân vùng EFI | Vừa (88,9 MB) | Có |',
  ].join('\n');

  it('parses header, alignment and rows', () => {
    const parsed = blockOf(parseMarkdown(table), 'table') as TableBlock;
    assert.equal(parsed.header.length, 3);
    assert.equal(textOf(at(parsed.header, 0)), 'Phương án');
    assert.equal(parsed.rows.length, 2);
    assert.equal(textOf(at(at(parsed.rows, 1), 1)), 'Vừa (88,9 MB)');
    assert.deepEqual(parsed.align, [null, null, 'center']);
  });

  it('keeps inline formatting inside a cell', () => {
    const parsed = blockOf(parseMarkdown('| a | b |\n| --- | --- |\n| **bold** | `code` |'), 'table') as TableBlock;
    const row = at(parsed.rows, 0);
    assert.deepEqual(at(row, 0).map((inline) => inline.kind), ['strong']);
    assert.deepEqual(at(row, 1).map((inline) => inline.kind), ['code']);
  });

  it('honours an escaped pipe and pads short rows so the grid stays rectangular', () => {
    const escaped = blockOf(parseMarkdown('| a \\| b | c |\n| --- | --- |\n| 1 | 2 |'), 'table') as TableBlock;
    assert.equal(textOf(at(escaped.header, 0)), 'a | b');
    const padded = blockOf(parseMarkdown('| a | b | c |\n| --- | --- | --- |\n| 1 |'), 'table') as TableBlock;
    assert.equal(at(padded.rows, 0).length, 3);
    assert.equal(textOf(at(at(padded.rows, 0), 1)), '');
  });

  it('does not turn prose with a pipe, or a lone delimiter row, into a table', () => {
    assert.equal(at(parseMarkdown('a | b without delimiter'), 0).kind, 'paragraph');
    const lone = parseMarkdown('| --- | --- |');
    assert.equal(lone.length, 1);
    assert.equal(blockText(at(lone, 0)).includes('---'), true);
  });

  it('ends at a blank line so the rest of the message is not swallowed', () => {
    const blocks = parseMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |\n\nSau bảng.');
    assert.ok(blocks.some((block) => block.kind === 'table'));
    assert.equal(blockText(blockOf(blocks, 'paragraph')).startsWith('Sau bảng.'), true);
  });
});

describe('markdown links: safe targets only', () => {
  it('parses an http(s) target', () => {
    assert.deepEqual(parseInline('[docs](https://example.com/a?b=1)'), [
      { kind: 'link', text: 'docs', href: 'https://example.com/a?b=1' },
    ]);
  });

  it('keeps a dangerous or malformed target literal (the renderer never sees it)', () => {
    for (const href of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', 'not a url', '']) {
      assert.deepEqual(parseInline(`[x](${href})`), [{ kind: 'text', text: `[x](${href})` }], href);
      assert.equal(isSafeHref(href), false, href);
    }
    assert.equal(isSafeHref('HTTPS://EXAMPLE.COM'), true);
  });

  it('keeps an unterminated link literal', () => {
    assert.deepEqual(parseInline('[docs](https://example.com'), [{ kind: 'text', text: '[docs](https://example.com' }]);
    assert.deepEqual(parseInline('[docs]'), [{ kind: 'text', text: '[docs]' }]);
  });
});

describe('markdown: never throws, never hangs', () => {
  it('returns nothing for empty or non-string input (untrusted frame)', () => {
    assert.deepEqual(parseMarkdown(''), []);
    assert.deepEqual(parseMarkdown('\n\n'), []);
    assert.deepEqual(parseMarkdown(undefined as unknown as string), []);
    assert.deepEqual(parseMarkdown(null as unknown as string), []);
  });

  it('parses a very long single line in linear time', () => {
    const started = Date.now();
    const blocks = parseMarkdown('word '.repeat(40_000));
    assert.equal(blocks.length, 1);
    assert.ok(Date.now() - started < 2_000, `took ${Date.now() - started}ms`);
    assert.ok(blockText(at(blocks, 0)).length >= 40_000);
  });

  it('survives 200k runs of the characters that drive the inline scanner', () => {
    for (const char of ['`', '*', '|', '[', ']', '#', '-', '>', '_']) {
      const started = Date.now();
      assert.ok(Array.isArray(parseMarkdown(char.repeat(200_000))));
      assert.ok(Date.now() - started < 5_000, `${char} took ${Date.now() - started}ms`);
    }
  });

  it('handles CRLF from a Windows host and a lone CR', () => {
    const blocks = parseMarkdown('- a\r\n- b\r\n\r\npara\rline');
    assert.equal(at(blocks, 0).kind, 'list');
    assert.equal(at(blocks, 1).kind, 'paragraph');
  });

  it('is deterministic', () => {
    const source = '# H\n\n- a\n  - b\n\n| x | y |\n| --- | --- |\n| 1 | 2 |\n\n```js\nx\n```';
    assert.deepEqual(parseMarkdown(source), parseMarkdown(source));
  });
});
