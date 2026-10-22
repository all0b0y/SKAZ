import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MarkdownView } from './Markdown';
import { DiagramFixProvider, DiagramPreviews, mermaidSources } from './Diagram';

const md = (text: string) => render(<MarkdownView className="kb-md" pieces={[text]} />).container;

const FLOW = 'flowchart LR\n  A[Lecture] --> B[Wiki]';
const fence = (code: string) => `Before.\n\n\`\`\`mermaid\n${code}\n\`\`\`\n\nAfter.`;

// jsdom has no canvas: Pele measures text by its own metrics then (quietly).
beforeAll(() => { vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null); });

describe('D: Mermaid diagrams through Pele', () => {
  it('renders a closed ```mermaid fence as an SVG diagram, not as code', async () => {
    const root = md(fence(FLOW));
    const figure = await screen.findByRole('figure', { name: 'Diagram' });
    await waitFor(() => expect(figure.querySelector('svg.pele')).not.toBeNull());
    expect(root.querySelector('pre.md__code')).toBeNull();
    expect(figure.textContent).toContain('Lecture');
    // Pele's own SVG only: no zoom/pan widget, no interactive links.
    expect(figure.querySelector('a')).toBeNull();
  });

  it('keeps untrusted diagram text inert: no HTML elements, handlers, scripts or javascript: links', async () => {
    md(fence('flowchart LR\n  A["<img src=x onerror=alert(1)><script>alert(2)</script>"] --> B\n  click A "javascript:alert(3)"\n  click B href "https://example.org"'));
    const figure = await screen.findByRole('figure', { name: 'Diagram' });
    await waitFor(() => expect(figure.querySelector('svg')).not.toBeNull());
    expect(figure.querySelector('img, script, foreignObject, iframe, a')).toBeNull();
    for (const el of Array.from(figure.querySelectorAll('*'))) {
      for (const attr of Array.from(el.attributes)) {
        expect(attr.name.startsWith('on')).toBe(false);
        expect(attr.value).not.toMatch(/javascript:/i);
        if (/href$|^src$/i.test(attr.name)) expect(attr.value.startsWith('#')).toBe(true);
      }
    }
  });

  it('shows a fence that is still streaming (not closed) as plain code', () => {
    const root = md('Here:\n\n```mermaid\nflowchart LR\n  A --> B');
    expect(screen.queryByRole('figure', { name: 'Diagram' })).toBeNull();
    expect(root.querySelector('pre')?.textContent).toContain('A --> B');
  });

  it('a render error shows the Mermaid text and a short error as text; no fix button without a chat', async () => {
    md(fence('flowchart LR\n  A["<b>bold</b>"] --> '));
    const figure = await screen.findByRole('figure', { name: 'Diagram' });
    const alert = await within(figure).findByRole('alert');
    expect(alert.textContent).toMatch(/Couldn’t draw this diagram/);
    expect(alert.querySelector('b')).toBeNull();
    expect(within(figure).getByLabelText('Diagram source').textContent).toContain('A["<b>bold</b>"] -->');
    expect(within(figure).queryByRole('button', { name: 'Ask the agent to fix' })).toBeNull();
  });

  it('“Ask the agent to fix” asks only when pressed, once, with the source and the error', async () => {
    const user = userEvent.setup();
    const fix = vi.fn(async () => null);
    render(
      <DiagramFixProvider value={fix}>
        <MarkdownView className="kb-md" pieces={[fence('flowchart LR\n  A --> ')]} />
      </DiagramFixProvider>,
    );
    const button = await screen.findByRole('button', { name: 'Ask the agent to fix' });
    expect(fix).not.toHaveBeenCalled();
    await user.click(button);
    expect(fix).toHaveBeenCalledTimes(1);
    const [source, error] = fix.mock.calls[0] as unknown as [string, string];
    expect(source).toBe('flowchart LR\n  A --> ');
    expect(error).toMatch(/line 3|Expecting|Parse error/i);
    // Asked: the button can't send the same request again.
    expect(await screen.findByRole('button', { name: /Asked the agent/ })).toBeDisabled();
  });

  it('an unknown diagram type is an error, not a crash', async () => {
    md(fence('notadiagram\n  x'));
    const figure = await screen.findByRole('figure', { name: 'Diagram' });
    expect((await within(figure).findByRole('alert')).textContent).toMatch(/Couldn’t draw this diagram/);
  });

  it('finds the closed mermaid fences of a text (for the live preview of the wiki editor)', () => {
    expect(mermaidSources(`a\n\n\`\`\`mermaid\n${FLOW}\n\`\`\`\n\n\`\`\`js\nx\n\`\`\`\n\n\`\`\`mermaid\nflowchart TD`)).toEqual([FLOW]);
  });

  it('live preview: follows the text being edited', async () => {
    const { rerender } = render(<DiagramPreviews text={fence(FLOW)} />);
    const figure = await screen.findByRole('figure', { name: 'Diagram preview' });
    await waitFor(() => expect(figure.textContent).toContain('Lecture'));
    rerender(<DiagramPreviews text={fence('flowchart LR\n  A[Notes] --> B[Wiki]')} />);
    await waitFor(() => expect(screen.getByRole('figure', { name: 'Diagram preview' }).textContent).toContain('Notes'));
    rerender(<DiagramPreviews text="no diagram here" />);
    expect(screen.queryByRole('figure', { name: 'Diagram preview' })).toBeNull();
  });
});
