import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BoardFrame } from './BoardFrame';
import { parseBoardRoute } from './mountBoard';
import { parseTokenBlocks, tokenGroups } from './tokens';

// Vitest does not process CSS (`?raw` is empty here): read the files.
const read = (file: string) => readFileSync(resolve(__dirname, '../styles', file), 'utf8');
const tokensCss = read('tokens.css');
const cssFiles = { 'styles/ui.css': read('ui.css'), 'styles/chat.css': read('chat.css') };

describe('design board frame', () => {
  it('shows every colour token of tokens.css and every token of the other groups', () => {
    const { container } = render(<BoardFrame theme="light" size="m" tokensCss={tokensCss} cssFiles={cssFiles} />);
    const groups = tokenGroups(parseTokenBlocks(tokensCss).light);
    const onBoard = new Set([...container.querySelectorAll('[data-token]')].map((el) => el.getAttribute('data-token')));
    for (const name of [...groups.color, ...groups.type, ...groups.space, ...groups.radius, ...groups.shadow]) {
      expect(onBoard, name).toContain(name);
    }
  });

  it('has the foundation and primitive sections in order', () => {
    const { container } = render(<BoardFrame theme="dark" size="l" tokensCss={tokensCss} cssFiles={cssFiles} />);
    const ids = [...container.querySelectorAll('[data-board-section]')].map((el) => el.getAttribute('data-board-section'));
    expect(ids).toEqual(['surfaces', 'colors', 'contrast', 'hues', 'type', 'space', 'icons', 'motion', 'drift',
      'buttons', 'chips', 'controls', 'fields', 'status', 'overlays']);
    expect(container.querySelector('[data-board-frame="dark-l"]')).not.toBeNull();
  });

  it('renders each button variant in every forced state plus disabled and busy', () => {
    const { container } = render(<BoardFrame theme="light" size="m" tokensCss={tokensCss} cssFiles={cssFiles} />);
    const row = container.querySelector('[data-board-row="Button fill · md"]') as HTMLElement;
    const forced = [...row.querySelectorAll('[data-force]')].map((el) => el.getAttribute('data-force'));
    expect(forced).toEqual(['hover', 'focus', 'pressed']);
    expect(within(row).getAllByRole('button')).toHaveLength(7);
    expect(within(row).getAllByRole('button').filter((b) => (b as HTMLButtonElement).disabled)).toHaveLength(1);
  });

  it('lists hand-written values from the CSS it is given (drift)', () => {
    render(<BoardFrame theme="light" size="m" tokensCss={tokensCss} cssFiles={cssFiles} />);
    expect(screen.getByText(/^Literal colours · \d+/)).toBeInTheDocument();
    expect(screen.getByText(/^font-size not from a token/)).toBeInTheDocument();
  });
});

describe('board route', () => {
  it('reads canvas and frame hashes, ignores the app', () => {
    expect(parseBoardRoute('')).toBeNull();
    expect(parseBoardRoute('#chats')).toBeNull();
    expect(parseBoardRoute('#design-board')).toMatchObject({ kind: 'canvas' });
    expect(parseBoardRoute('#design-board/frame?theme=dark&size=s&base=sand&accent=plum')).toEqual({ kind: 'frame', theme: 'dark', size: 's', base: 'sand', accent: 'plum' });
    expect(parseBoardRoute('#design-board/frame?theme=x&size=y&base=<b>')).toEqual({ kind: 'frame', theme: 'light', size: 'm', base: 'milk', accent: 'ink' });
  });
});
