import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { kbBridgeHandlers } from '../../../../../electron/kbBridge';
import type { BridgeRequest, JsonResponse } from '../../../api/bridge';
import type { KbVisualPreflightRequest, KbVisualPreflightResponse } from '../../../api/kb/types.gen';
import { createFakeBridge } from '../../test/fakeBridge';
import { chatWorld } from '../../test/fixtures';
import { renderKb } from '../../test/renderKb';

const fileName = 'scan.pdf';
const filePath = '/fixture/downloads/scan.pdf';
const scanId = 'saved-scan';
const header = Buffer.from('%PDF-1.7\n');
const editor = () => screen.getByRole('textbox', { name: 'Message' });
const send = () => screen.getByRole('button', { name: 'Send' });

function renderScanHost(response: () => Response) {
  const fetchFixture = vi.fn<typeof fetch>(async () => response());
  const native = kbBridgeHandlers({
    handle: () => ({ port: 5432, token: 'fixture' }),
    fetch: fetchFixture,
    showOpenDialog: async () => ({ canceled: false, filePaths: [filePath] }),
    showSaveDialog: async () => ({ canceled: true }),
    writeTextFile: () => {},
    fileSize: (path) => path === filePath ? header.byteLength : null,
    realPath: (path) => path === filePath ? path : null,
    readHeader: (path) => path === filePath ? header : null,
    documentsDir: '/fixture/documents',
    downloadsDir: '/fixture/downloads',
    materialExtensions: ['pdf'],
    newId: () => 'scan-selection',
  });
  const world = chatWorld();
  const chatApi = createFakeBridge(world);
  const preflights: KbVisualPreflightRequest[] = [];
  const request = async <T = unknown>(req: BridgeRequest): Promise<JsonResponse<T>> => {
    if (req.path === '/kb/chats/visual-preflight') {
      const body = req.body as KbVisualPreflightRequest;
      preflights.push(body);
      const page = body.text?.includes('page 2') ? 2 : null;
      const result: KbVisualPreflightResponse = {
        requires_visual: true, supported: page !== null, engine: body.engine ?? 'codex',
        model_id: body.model ?? null, state: page ? 'supported' : 'unsupported',
        reason_code: page ? null : 'missing_payload', title: page ? null : 'Specify PDF pages',
        detail: page ? null : 'Specify a page number or a short page range (1–2).',
        text_only_available: false, draft_preserved: true, compatible_models: [],
        locator: { material_id: scanId, source_kind: 'pdf', page, timestamp_ms: null, label: 'Scan' },
      };
      return { ok: true, status: 200, data: result as T };
    }
    return chatApi.bridge.request<T>(req);
  };
  const host = renderKb({ world, bridge: { request, nativeIntake: {
    chooseMaterialFiles: native.chooseMaterialBatch,
    droppedMaterialFiles: async ([file]) => native.droppedMaterialFiles(file?.name === fileName ? [filePath] : []),
    importSelection: native.importSelection,
    validateClipboardImage: async (payload) => native.validateClipboardImage(payload),
    imagePreview: native.imagePreview,
  } } });
  return {
    ...host, fetchFixture, preflights, calls: chatApi.calls,
    sends: () => chatApi.calls.filter(({ method, path }) => method === 'POST' && path === '/kb/chats/c1/messages'),
    attachments: () => host.services.composer.getState().attachmentDrafts.getState().getDraft('c1').attachments,
  };
}

async function openChat(user: ReturnType<typeof userEvent.setup>) {
  const side = screen.getByRole('region', { name: 'Chats' });
  await user.click(await within(side).findByRole('button', { name: /Why is there a logarithm/ }));
}

async function attachScan(user: ReturnType<typeof userEvent.setup>, source: 'picker' | 'drop') {
  if (source === 'drop') {
    fireEvent.drop(screen.getByRole('log', { name: 'Conversation' }), {
      dataTransfer: { types: ['Files'], files: [new File([header], fileName)] },
    });
  } else {
    await user.click(screen.getByRole('button', { name: 'Add a file, link or text' }));
    const menu = await screen.findByRole('menu', { name: 'Add to the question' });
    await user.click(within(menu).getByRole('menuitem', { name: 'File…' }));
  }
}

describe('scans on the production chat attachment host', () => {
  it.each(['picker', 'drop'] as const)('%s can attach a scan, ask for pages, and send after explicit selection', async (source) => {
    const existing = source === 'drop';
    const host = renderScanHost(() => Response.json({
      material: { id: scanId, kind: 'pdf', status: 'failed', fragment_count: 0 },
      failure_reason: 'The scan has no searchable text.',
      already_in_library: existing, saved_pdf_page_count: 2,
    }, { status: existing ? 200 : 201 }));
    const user = userEvent.setup();
    await openChat(user);
    fireEvent.input(editor(), { target: { innerHTML: 'Describe this' } });
    await attachScan(user, source);
    await waitFor(() => expect(host.attachments()).toMatchObject([{
      name: fileName, state: 'ready', materialId: scanId, materialReady: false,
      alreadyInLibrary: existing, inWiki: false,
    }]));
    expect(host.fetchFixture).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(host.fetchFixture.mock.calls[0]![1]!.body))).toMatchObject({
      path: filePath, selection_source: source, expected_size: header.byteLength, to_wiki: false,
    });
    const attachment = screen.getByRole('button', { name: 'View scan.pdf' });
    await user.click(attachment);
    const details = screen.getByRole('dialog', { name: fileName });
    expect(within(details).queryByRole('checkbox', { name: 'In wiki' })).toBeNull();
    await user.keyboard('{Escape}');
    expect(await screen.findByText('Specify PDF pages')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Continue with text only' })).toBeNull();
    await user.click(send());
    expect(host.sends()).toEqual([]);
    expect(host.preflights).toContainEqual(expect.objectContaining({
      attachments: [scanId], text: 'Describe this',
    }));

    fireEvent.input(editor(), { target: { innerHTML: 'Describe page 2' } });
    await waitFor(() => expect(screen.queryByText('Specify PDF pages')).toBeNull());
    expect(host.sends()).toEqual([]);
    await user.click(send());
    await waitFor(() => expect(host.attachments()).toEqual([]));
    expect(host.sends()).toEqual([expect.objectContaining({
      body: expect.objectContaining({ attachments: [scanId], text: 'Describe page 2' }),
    })]);
    expect(host.sends()[0]?.body).not.toHaveProperty('text_only');
    expect(host.calls.some(({ path }) => path.endsWith('/ingest') || path === `/kb/materials/${scanId}`)).toBe(false);
  });

  it.each([
    ['a failed PDF without the capability', 201, { material: { id: scanId, status: 'failed', kind: 'pdf' } }],
    ['a failed non-PDF', 201, { material: { id: scanId, status: 'failed', kind: 'text' }, saved_pdf_page_count: 2 }],
    ['a failed PDF with an invalid count', 201, { material: { id: scanId, status: 'failed', kind: 'pdf' }, saved_pdf_page_count: 0 }],
    ['an unsaved unreadable file', 422, { detail: 'The file could not be opened.' }],
  ])('keeps %s as a failed attachment', async (_case, status, body) => {
    const host = renderScanHost(() => Response.json(body, { status }));
    const user = userEvent.setup();
    await openChat(user);
    fireEvent.input(editor(), { target: { innerHTML: 'Describe page 2' } });
    await attachScan(user, 'drop');
    await waitFor(() => expect(host.attachments()).toMatchObject([{ state: 'failed', materialId: null }]));
    expect(screen.getByRole('alert')).toHaveTextContent('Remove or replace before sending.');
    expect(send()).toHaveAttribute('aria-disabled', 'true');
    await user.click(send());
    expect(host.preflights).toEqual([]);
    expect(host.sends()).toEqual([]);
  });
});
