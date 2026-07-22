// Tests for the dependency-free markdown renderer (A4, #2157). The link
// scheme guard is the one piece here with real security consequences
// (model descriptions can come from imported third-party zips down the
// line) so it gets its own explicit case, not just incidental coverage.
import { describe, expect, it, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { renderMarkdown } from '../lib/markdown.js';

afterEach(cleanup);

function Sample({ source }: { source: string }) {
  return <>{renderMarkdown(source)}</>;
}

describe('renderMarkdown', () => {
  it('renders headings, paragraphs, and unordered lists as their own block elements', () => {
    const { container } = render(<Sample source={'# Title\n\nSome text.\n\n- one\n- two'} />);
    expect(screen.getByText('Title')).toBeTruthy();
    expect(screen.getByText('Some text.')).toBeTruthy();
    const items = container.querySelectorAll('ul li');
    expect(items.length).toBe(2);
    expect(items[0].textContent).toBe('one');
    expect(items[1].textContent).toBe('two');
  });

  it('renders ordered lists as <ol>', () => {
    const { container } = render(<Sample source={'1. first\n2. second'} />);
    expect(container.querySelector('ol')).toBeTruthy();
    expect(container.querySelectorAll('ol li').length).toBe(2);
  });

  it('renders inline bold, italic, and code spans as their respective tags', () => {
    render(<Sample source={'**bold** and *italic* and `code`'} />);
    expect(screen.getByText('bold').tagName).toBe('STRONG');
    expect(screen.getByText('italic').tagName).toBe('EM');
    expect(screen.getByText('code').tagName).toBe('CODE');
  });

  it('renders a safe http(s) link as a real anchor with target/rel set', () => {
    render(<Sample source={'[docs](https://example.com/page)'} />);
    const link = screen.getByText('docs') as HTMLAnchorElement;
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('href')).toBe('https://example.com/page');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(link.getAttribute('target')).toBe('_blank');
  });

  it('does not render a javascript: URL as a clickable link (XSS guard)', () => {
    render(<Sample source={'[click me](javascript:alert(1))'} />);
    const el = screen.getByText('click me');
    expect(el.tagName).not.toBe('A');
  });

  it('returns nothing (null) for empty/whitespace-only source', () => {
    const { container } = render(<Sample source={'   \n\n  '} />);
    expect(container.textContent).toBe('');
  });
});
