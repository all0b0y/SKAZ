import { describe, expect, it } from 'vitest';
import { act, render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ArrowUpIcon } from '@animateicons/react/lucide/arrow-up-icon';
import { Button, Icon, IconButton } from './index';

// The real icons, in jsdom: Motion runs, so «did it move» is read from the svg's transform (the ↑ of Send
// is translated while it plays and rests at none). Hover must never start anything; only `play` changes do.

const wait = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
const svgOf = (el: Element) => el.querySelector('svg')!;
const rest = (svg: SVGElement) => ['', 'none', 'translateY(0px)'].includes(svg.style.transform);

describe('Icon motion is feedback only', () => {
  it('control: the library icon on its own does move on hover (so the checks below can fail)', async () => {
    const { container } = render(<ArrowUpIcon />);
    await userEvent.setup().hover(container.firstElementChild!);
    await wait(250);
    expect(rest(svgOf(container))).toBe(false);
  });

  it('SKAZ’s icon does not move on hover, focus or click without play', async () => {
    const user = userEvent.setup();
    const { container } = render(<IconButton icon="send" label="Send" />);
    const button = container.querySelector('button')!;
    await user.hover(button);
    await user.hover(container.querySelector('[data-icon="send"]')!);
    await user.click(button);
    await wait(250);
    expect(rest(svgOf(container))).toBe(true);
  });

  it('a change of `play` moves it once; the same value again does not; the next value does', async () => {
    const { container, rerender } = render(<Icon name="send" play={0} />);
    await wait(100);
    expect(rest(svgOf(container))).toBe(true);
    rerender(<Icon name="send" play={1} />);
    await wait(250);
    expect(rest(svgOf(container))).toBe(false);
    await wait(900); // it ends where it began
    expect(rest(svgOf(container))).toBe(true);
    rerender(<Icon name="send" play={1} className="other" />);
    await wait(250);
    expect(rest(svgOf(container))).toBe(true);
    rerender(<Icon name="send" play={2} />);
    await wait(250);
    expect(rest(svgOf(container))).toBe(false);
  });

  it('the value an icon is mounted with is not a change', async () => {
    const { container } = render(<Icon name="send" play={5} />);
    await wait(250);
    expect(rest(svgOf(container))).toBe(true);
  });

  it('Button and IconButton hand `iconPlay` to the icon', async () => {
    const a = render(<Button icon="send" iconPlay={0}>Go</Button>);
    a.rerender(<Button icon="send" iconPlay={1}>Go</Button>);
    await wait(250);
    expect(rest(svgOf(a.container))).toBe(false);
    a.unmount();
    const b = render(<IconButton icon="send" label="Send" iconPlay={0} />);
    b.rerender(<IconButton icon="send" label="Send" iconPlay={1} />);
    await wait(250);
    expect(rest(svgOf(b.container))).toBe(false);
  });
});
