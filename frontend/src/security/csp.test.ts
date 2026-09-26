import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
// Kept byte-for-byte with the preamble injected by @vitejs/plugin-react v5.
// A dependency upgrade that changes it must also update the CSP hash.
const devPreamble = `import { injectIntoGlobalHook } from "/@react-refresh";
injectIntoGlobalHook(window);
window.$RefreshReg$ = () => {};
window.$RefreshSig$ = () => (type) => type;`;
const devPreambleHash = `sha256-${createHash('sha256').update(devPreamble).digest('base64')}`;

describe('renderer Content Security Policy', () => {
  it('allows the exact React development preamble in both CSP declarations', () => {
    const mainSource = readFileSync(`${repoRoot}/electron/main.ts`, 'utf8');
    const rendererHtml = readFileSync(`${repoRoot}/frontend/index.html`, 'utf8');

    expect(mainSource).toContain(`'${devPreambleHash}'`);
    expect(rendererHtml).toContain(`'${devPreambleHash}'`);
  });

  it('keeps frame-ancestors only in the response header, where browsers honour it', () => {
    // In a <meta> CSP the directive is ignored and logs an error on every load.
    const mainSource = readFileSync(`${repoRoot}/electron/main.ts`, 'utf8');
    const rendererHtml = readFileSync(`${repoRoot}/frontend/index.html`, 'utf8');

    expect(mainSource).toContain("frame-ancestors 'none'");
    expect(rendererHtml).not.toContain('frame-ancestors');
  });
});
