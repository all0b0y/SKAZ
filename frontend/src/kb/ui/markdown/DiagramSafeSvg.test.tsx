import { describe, expect, it } from 'vitest';
import { safeSvg } from './Diagram';

// Security review 0.3.1, S-06 (defence in depth; the renderer CSP already blocks remote loads):
// safeSvg also drops SMIL animation elements (they can set href/style later) and CSS image-set().
describe('safeSvg: animation elements and image-set()', () => {
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">',
    '<rect id="r" width="5" height="5" style="background-image:image-set(\'https://evil.example/a.png\' 1x)">',
    '<set attributeName="href" to="https://evil.example/set" />',
    '<animate attributeName="x" values="0;5" dur="1s" />',
    '<animateTransform attributeName="transform" type="rotate" from="0" to="90" dur="1s" />',
    '<animateMotion path="M0,0 L5,5" dur="1s" />',
    '</rect>',
    '<rect width="2" height="2" fill="-webkit-image-set(\'https://evil.example/b.png\' 1x)" />',
    '<rect width="1" height="1" style="fill: IMAGE-SET(&quot;https://evil.example/c.png&quot; 1x)" />',
    '<discard begin="1s" />',
    '<g><text x="1" y="9">Lecture</text></g>',
    '</svg>',
  ].join('');

  it('removes set, animate, animateTransform, animateMotion and discard', () => {
    const out = safeSvg(svg);
    expect(out).not.toBeNull();
    const names = Array.from(out!.querySelectorAll('*')).map((el) => el.localName.toLowerCase());
    for (const banned of ['set', 'animate', 'animatetransform', 'animatemotion', 'discard']) {
      expect(names).not.toContain(banned);
    }
    expect(out!.textContent).toContain('Lecture');
    expect(names).toContain('rect');
  });

  it('treats image-set( and -webkit-image-set( like url(', () => {
    const out = safeSvg(svg)!;
    for (const el of [out, ...Array.from(out.querySelectorAll('*'))]) {
      for (const attr of Array.from(el.attributes)) expect(attr.value).not.toMatch(/image-set\(|evil\.example/i);
    }
    expect(out.querySelector('#r')?.getAttribute('width')).toBe('5');
  });
});
