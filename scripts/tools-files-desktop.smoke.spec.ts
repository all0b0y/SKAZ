import { expect, test } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchIsolatedSmoke } from './isolatedSmoke';
import type {} from '../frontend/src/api/bridge';

test('V1 desktop chat connects MCP, reviews a dropped SKILL.md and persists both settings on restart', async ({}, info) => {
  test.setTimeout(120_000);
  const profile = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'skaz-041-tools-')));
  const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'skaz-041-vendor-home-')));
  const methods: string[] = [];
  const fixture = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    methods.push(body.method);
    if (!('id' in body)) { res.writeHead(202).end(); return; }
    const result = body.method === 'initialize' ? { protocolVersion: body.params.protocolVersion,
      capabilities: { tools: {} }, serverInfo: { name: 'Desktop fixture', version: '1' } }
      : { tools: [{ name: 'create_note', description: 'Create a note', inputSchema: { type: 'object' } }] };
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ id: body.id, jsonrpc: '2.0', result }));
  });
  await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const address = fixture.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  const url = 'http://127.0.0.1:' + address.port + '/mcp';
  const bin = path.join(home, 'bin');
  mkdirSync(bin);
  const serverScript = path.resolve('backend/tests/knowledge/fixtures/codex_kb_server.py');
  const python = path.resolve('backend/.venv/bin/python');
  const log = path.join(home, 'wire.jsonl');
  writeFileSync(path.join(home, 'selected-tool.json'), JSON.stringify({ name: 'skaz_mcp_propose', arguments: { url } }));
  writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "codex-cli 0.160.0"; exit 0; fi\n'
    + 'exec "' + python + '" "' + serverScript + '" "' + log + '"\n', { mode: 0o700 });
  const launch = () => launchIsolatedSmoke('skaz-041-', { profile, keepProfile: true, env: {
    HOME: home, PATH: bin + ':/usr/bin:/bin', SHELL: '/usr/bin/false', SKAZ_ALLOW_MODEL_DOWNLOAD: '0', SKAZ_UPDATE_CHECK: '0',
  } });
  try {
    for (const first of [true, false]) {
      const run = await launch();
      try {
        const page = await run.app.firstWindow();
        await expect.poll(() => page.evaluate(async () => (await window.skaz.getBackendStatus()).phase),
          { timeout: 45_000 }).toBe('ready');
        if (first) {
          const welcome = page.getByRole('dialog', { name: 'Welcome to SKAZ' });
          for (const name of ['Next', 'Skip', 'Skip', 'Create library', 'Open SKAZ']) {
            await welcome.getByRole('button', { name, exact: true }).click();
          }
        }
        await expect(page.getByRole('navigation', { name: 'Sections' })).toBeVisible();
        await page.keyboard.press(process.platform === 'darwin' ? 'Meta+,' : 'Control+,');
        const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
        await expect(settings).toBeVisible();
        const tools = settings.getByRole('button', { name: 'Tools', exact: true });
        await page.screenshot({ path: info.outputPath('settings-before-tools.png') });
        await expect(tools).toBeVisible();
        await tools.click();
        const toggle = settings.getByRole('switch', { name: 'Desktop fixture' });
        if (first) {
          await settings.getByRole('button', { name: 'Add MCP' }).click();
          const dialog = page.getByRole('dialog', { name: 'Add MCP' });
          await dialog.getByRole('textbox').fill(url);
          await dialog.getByRole('button', { name: 'Send to chat' }).click();
          await expect(settings).toBeHidden();
          await expect(page.getByRole('article', { name: 'Your question' }).getByRole('link')).toHaveAttribute('href', url);
          await expect(page.getByText('Tool answered: True', { exact: true })).toBeVisible({ timeout: 15_000 });
          await page.screenshot({ path: info.outputPath('agent-connected.png') });
          const skill = path.join(profile, 'Documents', 'SKILL.md');
          writeFileSync(skill, '---\nname: Lecture brief\ndescription: Summarize a lecture.\n---\nUse short paragraphs.\n');
          for (const allow of [false, true]) {
            const conversation = page.getByRole('log', { name: 'Conversation' });
            const box = await conversation.boundingBox();
            if (!box) throw new Error('Chat is not visible');
            const drag = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 3),
              data: { items: [], files: [skill], dragOperationsMask: 1 } };
            const cdp = await page.context().newCDPSession(page);
            try {
              await cdp.send('Input.dispatchDragEvent', { type: 'dragEnter', ...drag });
              await cdp.send('Input.dispatchDragEvent', { type: 'dragOver', ...drag });
              await cdp.send('Input.dispatchDragEvent', { type: 'drop', ...drag });
            } finally { await cdp.detach(); }
            await expect(page.getByRole('list', { name: 'Draft attachments' }).locator('[data-state="ready"]')).toHaveCount(1);
            await page.getByRole('textbox', { name: 'Message' }).press('Enter');
            const decision = page.getByRole('group', { name: 'Decision', exact: true });
            await expect(decision).toBeVisible();
            await expect(decision.getByRole('button', { name: 'Allow in this chat' })).toHaveCount(0);
            const card = conversation.locator('section[data-kind="skill_install"]').filter({ has: decision });
            await card.scrollIntoViewIfNeeded();
            await expect(card).toHaveCSS('opacity', '1');
            await page.screenshot({ path: info.outputPath(allow ? 'install-allow.png' : 'install-deny.png') });
            await decision.getByRole('button', { name: allow ? 'Allow' : 'Deny', exact: true }).click();
            if (!allow) await conversation.getByRole('button', { name: 'Send', exact: true }).click();
            await expect(conversation.getByText(allow ? 'Installed Lecture brief.' : 'Skill installation skipped.', { exact: true })).toBeVisible();
          }
          await page.keyboard.press(process.platform === 'darwin' ? 'Meta+,' : 'Control+,');
          await tools.click();
          await expect(toggle).toBeChecked(); await toggle.click();
        }
        await expect(toggle).toHaveText(/Inactive/);
        await expect(toggle).not.toBeChecked();
        await settings.getByRole('tab', { name: /^Skills/ }).click();
        await expect(settings.getByRole('switch', { name: 'Lecture brief' })).toBeChecked();
      } finally { await run.close(); }
    }
    expect(methods).toContain('tools/list');
    expect(methods).not.toContain('tools/call');
  } finally {
    await new Promise<void>((resolve, reject) => fixture.close(err => err ? reject(err) : resolve()));
    rmSync(profile, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
