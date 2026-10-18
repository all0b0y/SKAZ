import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { MarkdownView } from './Markdown';
import { answerFootnotes } from '../../../lib/answerFootnotes';

const chip = (index: number, key: string) => <span key={key} data-testid={`chip-${index}`}>[{index}]</span>;

function view(pieces: ReadonlyArray<string | number>) {
  return render(<MarkdownView className="md" pieces={pieces} slot={chip} />).container;
}

describe('Shared Markdown renderer (H4)', () => {
  it('closes bold that ends in punctuation right before a source chip', () => {
    const root = view(['Для совпавшей части можно избежать обработки. **Но каждый новый токен всё равно нужно вычислять.**', 0, ' Дальше.']);
    const strong = root.querySelector('strong');
    expect(strong?.textContent).toBe('Но каждый новый токен всё равно нужно вычислять.');
    expect(root.textContent).not.toContain('**');
    // The chip stands after the bold text, not inside it.
    expect(strong?.nextSibling).toBe(root.querySelector('[data-testid="chip-0"]'));
  });

  it('places chips inside emphasis, at the end of a paragraph and between blocks', () => {
    const root = view(['*слово', 0, '* и конец.', 1, '\n\n', 2, '\n\nНовый абзац.']);
    expect(root.querySelector('em [data-testid="chip-0"]')).not.toBeNull();
    expect(root.querySelector('p')?.lastElementChild).toBe(root.querySelector('[data-testid="chip-1"]'));
    expect(root.querySelector('[data-testid="chip-2"]')).not.toBeNull();
    expect(root.querySelectorAll('[data-testid^="chip-"]')).toHaveLength(3);
  });

  it('typesets the four ways models write formulas', () => {
    const root = view([
      'Inline $a_{ij} = q_i \\cdot k_j$ and \\(o_i=\\sum_j a_{ij}v_j\\).\n\n',
      '\\[ \\operatorname{softmax}\\left(\\frac{QK^\\top}{\\sqrt{d_k}}\\right) \\]\n\n',
      '$$\nA = \\frac{1}{2}\n$$\n\nAfter.',
    ]);
    const math = root.querySelectorAll('.kb-math');
    expect(math).toHaveLength(4);
    expect(root.querySelectorAll('.kb-math--display')).toHaveLength(2);
    expect(math[0]?.getAttribute('aria-label')).toBe('a_{ij} = q_i \\cdot k_j');
    // KaTeX rendered it (no raw delimiters left, no emphasis from the underscores).
    expect(math[0]?.querySelector('.katex')).not.toBeNull();
    expect(root.textContent).not.toContain('\\[');
    expect(root.querySelector('em')).toBeNull();
    expect(root.textContent).toContain('After.');
  });

  it('keeps money as money', () => {
    const root = view(['It costs $5 and $10, or $ 3 $.']);
    expect(root.querySelector('.kb-math')).toBeNull();
    expect(root.textContent).toBe('It costs $5 and $10, or $ 3 $.');
  });

  it('a display formula interrupts a paragraph and may span lines', () => {
    const root = view(['Формула внимания:\n\\[\n\\text{Attention}(Q,K,V)\n\\]\nГде Q — запросы.']);
    expect(root.querySelectorAll('.kb-math--display')).toHaveLength(1);
    expect(root.textContent).toContain('Формула внимания:');
    expect(root.textContent).toContain('Где Q — запросы.');
  });
});

describe('Footnote labels in wiki text', () => {
  it('keeps a Markdown line break (two trailing spaces) and code spacing', () => {
    const { text } = answerFootnotes('First line  \nSecond line with `a  b` code [S9].');
    expect(text).toBe('First line  \nSecond line with `a  b` code.');
    const root = render(<MarkdownView className="md" pieces={[text]} />).container;
    expect(root.querySelector('br')).not.toBeNull();
    expect(root.querySelector('code')?.textContent).toBe('a  b');
  });

  it('still closes the gap a removed label leaves', () => {
    expect(answerFootnotes('word [S1] more and end [S2].').text).toBe('word more and end.');
  });
});
