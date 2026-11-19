import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { launchIsolatedSmoke } from './isolatedSmoke';
import type {} from '../frontend/src/api/bridge';

// Narrow, offline, isolated V1 verification against the real context-isolated Electron
// window + preload + main + Python backend in a throwaway profile.
// - Never launches without launchIsolatedSmoke (no access to real library/Finder/clipboard/accounts).
// - Uses a main-process stub of dialog.showOpenDialog (explicitly distinguished from an actual Finder UI).

const root = path.resolve(__dirname, '..');
const FIXTURES_DIR = path.join(root, 'electron', 'nativeIntake041', 'fixtures');

let app: ElectronApplication;
let page: Page;
let close: (() => Promise<void>) | undefined;
let profileDir = '';
let docxFixture = '';
let heicFixture = '';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  ({ app, close, profile: profileDir } = await launchIsolatedSmoke('skaz-v1-native-'));
  // Copy authored fixtures into the isolated profile's Documents so no repo files are ever modified
  // and all tested disk paths live inside the throwaway profile.
  const fixtureCopyDir = path.join(profileDir, 'Documents', 'v1-fixtures');
  fs.mkdirSync(fixtureCopyDir, { recursive: true });
  docxFixture = path.join(fixtureCopyDir, 'sample-note.docx');
  heicFixture = path.join(fixtureCopyDir, 'sample-chart.heic');
  fs.copyFileSync(path.join(FIXTURES_DIR, 'sample-note.docx'), docxFixture);
  fs.copyFileSync(path.join(FIXTURES_DIR, 'sample-chart.heic'), heicFixture);

  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await expect.poll(() => page.evaluate(async () => (await window.skaz.getBackendStatus()).phase),
    { timeout: 60_000 }).toBe('ready');
  await expect(page.locator('html[data-kb-ui]')).toHaveCount(1, { timeout: 30_000 });

  // Complete first-launch onboarding into the isolated profile library.
  const dialog = page.getByRole('dialog', { name: 'Welcome to SKAZ' });
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await dialog.getByRole('button', { name: 'Next' }).click();
  await dialog.getByRole('button', { name: 'Skip' }).click();
  await dialog.getByRole('button', { name: 'Skip' }).click();
  await dialog.getByRole('button', { name: 'Create library' }).click();
  await expect(dialog.getByRole('heading', { name: 'Ready to start' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Open SKAZ' }).click();
  await expect(dialog).toHaveCount(0);
});

test.afterAll(async () => {
  await close?.();
});

function buildStoredZipDocx(text: string): Buffer {
  const files: Array<{ name: string; data: Buffer }> = [
    {
      name: '[Content_Types].xml',
      data: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
          + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
          + '<Default Extension="xml" ContentType="application/xml"/>'
          + '<Override PartName="/word/document.xml" '
          + 'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
          + '</Types>',
        'utf8',
      ),
    },
    {
      name: 'word/document.xml',
      data: Buffer.from(
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
          + `<w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
        'utf8',
      ),
    },
  ];
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const nameBuf = Buffer.from(file.name, 'utf8');
    const crc = zlib.crc32(file.data) >>> 0;
    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(file.data.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);
    locals.push(local, file.data);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(file.data.length, 20);
    central.writeUInt32LE(file.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);
    centrals.push(central);
    offset += local.length + file.data.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

function pngWithComment(basePng: Buffer, comment: string): Buffer {
  const body = Buffer.concat([Buffer.from('Comment\0', 'utf8'), Buffer.from(comment, 'utf8')]);
  const typeAndBody = Buffer.concat([Buffer.from('tEXt', 'ascii'), body]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(typeAndBody) >>> 0, 0);
  return Buffer.concat([basePng.subarray(0, -12), len, typeAndBody, crc, basePng.subarray(-12)]);
}

test('verifies context-isolated preload boundary, cancellation, stubbed OS pickup, drop path resolution, selection identity, HEIC preview, and MaterialView', async () => {
  // 1. Verify context-isolated preload boundary exposes nativeIntake without Node globals or token leaks.
  const surface = await page.evaluate(() => {
    const w = window as unknown as { skaz?: Record<string, unknown>; require?: unknown; process?: unknown };
    const intake = w.skaz?.nativeIntake as Record<string, unknown> | undefined;
    return {
      hasRequire: typeof w.require !== 'undefined',
      hasProcess: typeof w.process !== 'undefined',
      nativeIntakeMethods: intake ? Object.keys(intake).sort() : [],
    };
  });
  expect(surface.hasRequire).toBe(false);
  expect(surface.hasProcess).toBe(false);
  expect(surface.nativeIntakeMethods).toEqual([
    'chooseMaterialFiles',
    'droppedMaterialFiles',
    'imagePreview',
    'importSelection',
    'validateClipboardImage',
  ]);

  // 2. Stubbed OS picker cancellation returns empty batch without registering selections.
  await app.evaluate(({ dialog }) => {
    const g = globalThis as unknown as { __v1OrigOpen?: typeof dialog.showOpenDialog };
    g.__v1OrigOpen ??= dialog.showOpenDialog.bind(dialog);
    dialog.showOpenDialog = (async () => ({ canceled: true, filePaths: [] })) as typeof dialog.showOpenDialog;
  });
  const cancelledBatch = await page.evaluate(() => window.skaz.nativeIntake!.chooseMaterialFiles());
  expect(cancelledBatch).toEqual({ accepted: [], rejected: [] });

  // 3. Synthetic JS File objects have no OS path via webUtils.getPathForFile (cannot spoof drop paths).
  const spoofedDrop = await page.evaluate(async () => {
    const fakeFile = new File(['hello'], 'spoof.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    return window.skaz.nativeIntake!.droppedMaterialFiles([fakeFile]);
  });
  expect(spoofedDrop).toEqual({ accepted: [], rejected: [] });

  // 4. Real CDP file drop onto AddMaterialModal drop zone exercises Chromium File -> preload webUtils.getPathForFile -> main.
  await page.getByRole('button', { name: 'Materials' }).click();
  await page.getByRole('button', { name: 'Add material' }).click();
  const addDialog = page.getByTestId('add-material-dialog');
  await expect(addDialog).toBeVisible();
  const dropZone = addDialog.getByTestId('drop-zone');
  const box = (await dropZone.boundingBox())!;
  // Also capture a real Chromium OS-backed File from the same CDP drop to verify nativeIntake.droppedMaterialFiles.
  await page.evaluate(() => {
    const dz = document.querySelector('[data-testid="drop-zone"]')!;
    (window as unknown as { __v1DroppedPromise?: Promise<unknown> }).__v1DroppedPromise = new Promise((resolve) => {
      dz.addEventListener('drop', (ev) => {
        const files = Array.from((ev as DragEvent).dataTransfer?.files ?? []);
        void window.skaz.nativeIntake!.droppedMaterialFiles(files).then(resolve);
      }, { once: true });
    });
  });
  const cdp = await page.context().newCDPSession(page);
  try {
    const cx = Math.round(box.x + box.width / 2);
    const cy = Math.round(box.y + box.height / 2);
    const dragData = { items: [], files: [heicFixture], dragOperationsMask: 1 };
    await cdp.send('Input.dispatchDragEvent', { type: 'dragEnter', x: cx, y: cy, data: dragData });
    await cdp.send('Input.dispatchDragEvent', { type: 'dragOver', x: cx, y: cy, data: dragData });
    await cdp.send('Input.dispatchDragEvent', { type: 'drop', x: cx, y: cy, data: dragData });
  } finally {
    await cdp.detach();
  }
  const droppedBatch = await page.evaluate(() => (window as unknown as { __v1DroppedPromise: Promise<{ accepted: Array<{ selectionId: string; name: string; source: string; formatId: string }>; rejected: unknown[] }> }).__v1DroppedPromise);
  expect(droppedBatch.rejected).toEqual([]);
  expect(droppedBatch.accepted).toHaveLength(1);
  expect(droppedBatch.accepted[0]!.selectionId).toMatch(/^sel-/);
  expect(droppedBatch.accepted[0]).toMatchObject({ name: 'sample-chart.heic', source: 'drop', formatId: 'heic' });

  const queued = addDialog.getByRole('list', { name: 'To add' });
  await expect(queued).toBeVisible();
  await expect(queued).toContainText('sample-chart.heic');
  expect(await queued.locator('[data-icon]').first().getAttribute('data-icon')).toBe('image');
  await addDialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(addDialog).toHaveCount(0);

  // 5. Stubbed OS picker pickup on real disk-backed DOCX + HEIC fixtures registers opaque selection IDs.
  await app.evaluate(({ dialog }, paths) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: paths })) as typeof dialog.showOpenDialog;
  }, [docxFixture, heicFixture]);

  const pickedBatch = await page.evaluate(() => window.skaz.nativeIntake!.chooseMaterialFiles());
  expect(pickedBatch.rejected).toEqual([]);
  expect(pickedBatch.accepted).toHaveLength(2);
  const [docxSel, heicSel] = pickedBatch.accepted;
  expect(docxSel!.selectionId).toMatch(/^sel-/);
  expect(docxSel!.selectionId).not.toContain(docxFixture);
  expect(docxSel).toMatchObject({
    name: 'sample-note.docx',
    formatId: 'docx',
    category: 'docx',
    route: 'document',
    source: 'picker',
    nativePreviewable: false,
  });
  expect(heicSel!.selectionId).toMatch(/^sel-/);
  expect(heicSel!.selectionId).not.toContain(heicFixture);
  expect(heicSel).toMatchObject({
    name: 'sample-chart.heic',
    formatId: 'heic',
    category: 'image',
    route: 'image',
    source: 'picker',
    nativePreviewable: false,
  });

  // 6. Registered selection identity enforcement + real HEIC preview decode via Electron main -> Python backend.
  const previewResult = await page.evaluate(async ({ docxId, heicId }) => {
    const heicPrev = await window.skaz.nativeIntake!.imagePreview(heicId);
    const docxPrev = await window.skaz.nativeIntake!.imagePreview(docxId);
    const spoofPrev = await window.skaz.nativeIntake!.imagePreview('/etc/passwd');
    const spoofImport = await window.skaz.nativeIntake!.importSelection({ selectionId: '/etc/passwd', folderId: 'fld-inbox' });
    return {
      heicOk: heicPrev.ok,
      heicStatus: heicPrev.status,
      heicMime: heicPrev.ok ? heicPrev.data.mimeType : null,
      heicPngMagic: heicPrev.ok ? Array.from(heicPrev.data.bytes.slice(0, 4)) : [],
      docxPrev,
      spoofPrev,
      spoofImport,
    };
  }, { docxId: docxSel!.selectionId, heicId: heicSel!.selectionId });

  expect(previewResult.heicOk).toBe(true);
  expect(previewResult.heicStatus).toBe(200);
  expect(previewResult.heicMime).toBe('image/png');
  expect(previewResult.heicPngMagic).toEqual([0x89, 0x50, 0x4e, 0x47]);
  expect(previewResult.docxPrev).toMatchObject({ ok: false, status: 403 });
  expect(previewResult.spoofPrev).toMatchObject({ ok: false, status: 403 });
  expect(previewResult.spoofImport).toMatchObject({ ok: false, status: 403 });

  // 7. Import both registered selections through Electron main -> real Python backend.
  const importResult = await page.evaluate(async ({ docxId, heicId }) => {
    const docxRes = await window.skaz.nativeIntake!.importSelection({ selectionId: docxId, folderId: 'fld-inbox', toWiki: false });
    const heicRes = await window.skaz.nativeIntake!.importSelection({ selectionId: heicId, folderId: 'fld-inbox', toWiki: true });
    return { docxRes, heicRes };
  }, { docxId: docxSel!.selectionId, heicId: heicSel!.selectionId });

  expect(importResult.docxRes).toMatchObject({
    ok: true,
    status: 201,
    data: { material: { kind: 'docx', status: 'ready', wiki_state: 'not_in_wiki' }, already_in_library: false },
  });
  expect(importResult.heicRes).toMatchObject({
    ok: true,
    status: 201,
    data: { material: { kind: 'image', status: 'ready', wiki_state: 'not_in_wiki' }, already_in_library: false },
  });

  // 8. Verify AllMaterials filters + MaterialView rendering for both imported DOCX and HEIC in the real window.
  await page.getByTestId('all-materials').click();
  const center = page.getByRole('region', { name: 'All materials' });
  await expect(center).toBeVisible();
  await expect(center.getByRole('button', { name: 'Lecture Notes - KV Cache' })).toBeVisible({ timeout: 15_000 });
  await expect(center.getByRole('button', { name: 'sample-chart' })).toBeVisible();

  await center.getByRole('radio', { name: 'Documents' }).click();
  await expect(center.getByRole('button', { name: 'Lecture Notes - KV Cache' })).toBeVisible();
  await expect(center.getByRole('button', { name: 'sample-chart' })).toHaveCount(0);

  await center.getByRole('radio', { name: 'Images' }).click();
  await expect(center.getByRole('button', { name: 'sample-chart' })).toBeVisible();
  await expect(center.getByRole('button', { name: 'Lecture Notes - KV Cache' })).toHaveCount(0);

  // Open HEIC image material in MaterialView
  await center.getByRole('button', { name: 'sample-chart' }).click();
  const docPanel = page.getByRole('complementary', { name: 'Document' });
  await expect(docPanel.getByRole('heading', { level: 2, name: 'sample-chart' })).toBeVisible();
  await expect(docPanel.getByText('Image saved')).toBeVisible();
  await expect(docPanel.getByText('Images are stored without OCR, so there is no text to add.')).toBeVisible();
  await expect(docPanel.getByRole('button', { name: 'Add to wiki' })).toBeDisabled();
  const details = docPanel.getByRole('note', { name: 'Image details' });
  await expect(details).toContainText('sample-chart.heic');
  await expect(details).toContainText('HEIC · 64 × 48');
  await expect(details).toContainText('Stored locally as an image without OCR or text extraction.');

  // Open DOCX material in MaterialView
  await center.getByRole('radio', { name: 'Documents' }).click();
  await center.getByRole('button', { name: 'Lecture Notes - KV Cache' }).click();
  await expect(docPanel.getByRole('heading', { level: 2, name: 'Lecture Notes - KV Cache' })).toBeVisible();
  await expect(docPanel.getByText('Text extracted')).toBeVisible();
  await expect(docPanel.getByRole('button', { name: 'Add to wiki' })).toBeEnabled();
  await expect(docPanel).toContainText('Key and value tensors');

  // 9. Version binding under ordinary same-length edits in the real Electron UI + nativeIntake boundary
  const fixtureDir = path.dirname(docxFixture);
  const editableDocx = path.join(fixtureDir, 'editable-v1.docx');
  const editablePng = path.join(fixtureDir, 'editable-v1.png');
  const basePng = fs.readFileSync(path.join(FIXTURES_DIR, 'sample-chart.png'));
  const docxV1 = buildStoredZipDocx('Alpha version');
  const docxV2 = buildStoredZipDocx('Bravo version');
  const pngV1 = pngWithComment(basePng, 'v1');
  const pngV2 = pngWithComment(basePng, 'v2');
  expect(docxV2.length).toBe(docxV1.length);
  expect(pngV2.length).toBe(pngV1.length);
  fs.writeFileSync(editableDocx, docxV1);
  fs.writeFileSync(editablePng, pngV1);

  await app.evaluate(({ dialog }, paths) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: paths })) as typeof dialog.showOpenDialog;
  }, [editableDocx, editablePng]);

  const directBatch = await page.evaluate(() => window.skaz.nativeIntake!.chooseMaterialFiles());
  expect(directBatch.accepted).toHaveLength(2);
  const directPngId = directBatch.accepted[1]!.selectionId;
  expect((await page.evaluate((id) => window.skaz.nativeIntake!.imagePreview(id), directPngId)).ok).toBe(true);

  await page.getByRole('button', { name: 'Add material' }).click();
  const editDialog = page.getByTestId('add-material-dialog');
  await expect(editDialog).toBeVisible();
  await editDialog.getByRole('button', { name: 'choose on the computer' }).click();
  const editQueue = editDialog.getByRole('list', { name: 'To add' });
  await expect(editQueue).toContainText('editable-v1.docx');
  await expect(editQueue).toContainText('editable-v1.png');

  // Perform ordinary same-length edits on disk before preview/Add
  fs.writeFileSync(editableDocx, docxV2);
  fs.writeFileSync(editablePng, pngV2);

  // Stale image preview is refused clearly without refreshing the old token
  const stalePreview = await page.evaluate((id) => window.skaz.nativeIntake!.imagePreview(id), directPngId);
  expect(stalePreview).toMatchObject({
    ok: false,
    status: 422,
    code: 'file_changed',
  });
  if (!stalePreview.ok) {
    expect(stalePreview.detail).toContain('Choose the file again');
  }

  // Submitting in AddMaterialModal shows the changed-file alert asking for reselection and refuses retry
  await editDialog.getByRole('button', { name: 'Add 2' }).click();
  await expect(editDialog.getByRole('alert').first()).toContainText('changed after it was chosen');
  await expect(editDialog).toBeVisible();
  await editDialog.getByRole('button', { name: 'Add 2' }).click();
  await expect(editDialog.getByRole('alert').first()).toContainText('Choose the file again');

  // Deliberate fresh selection issues new version-pinned tokens and imports the updated files cleanly
  await editDialog.getByRole('button', { name: 'choose on the computer' }).click();
  await expect(editDialog.getByRole('alert')).toHaveCount(0);
  await editDialog.getByRole('button', { name: 'Add 2' }).click();
  await expect(editDialog).toHaveCount(0);

  await center.getByRole('radio', { name: 'Documents' }).click();
  await expect(center.getByRole('button', { name: 'editable-v1' })).toBeVisible({ timeout: 15_000 });
  await center.getByRole('button', { name: 'editable-v1' }).click();
  await expect(docPanel).toContainText('Bravo version');
});
