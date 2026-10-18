import { useLayoutEffect, useRef } from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';

/**
 * One formula, typeset by KaTeX into its own element (no HTML string is injected). A formula KaTeX
 * can't read is shown as its TeX source in the error colour, never dropped.
 */
export function MathView({ tex, display }: { tex: string; display: boolean }) {
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    try {
      katex.render(tex, element, { displayMode: display, throwOnError: false, trust: false, strict: 'ignore', output: 'htmlAndMathml' });
    } catch {
      element.textContent = tex;
    }
  }, [tex, display]);
  return display
    ? <span ref={ref} className="kb-math kb-math--display" role="math" aria-label={tex} />
    : <span ref={ref} className="kb-math" role="math" aria-label={tex} />;
}
