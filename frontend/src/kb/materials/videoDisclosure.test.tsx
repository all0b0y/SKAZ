import { expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { docWorld } from '../test/fakeBridge';
import { renderKb } from '../test/renderKb';
import { LOCAL_VIDEO_AUDIO_ONLY_NOTICE } from './addItems';

it('describes Add and announces the native local video selection before import', async () => {
  const user = userEvent.setup();
  const importSelection = vi.fn(async () => ({
    ok: true as const, status: 201, data: { material_id: 'video', status: 'processing' },
  }));
  renderKb({
    world: docWorld(), prefs: { section: 'materials' },
    bridge: { nativeIntake: {
      chooseMaterialFiles: async () => ({ rejected: [], accepted: [{
        selectionId: 'video', path: '/fixture/clip.mp4', name: 'clip.mp4', size: 40, ext: 'mp4',
        category: 'speech', route: 'speech', formatId: 'mp4', mimeType: 'video/mp4',
        source: 'picker', nativePreviewable: false,
      }] }),
      droppedMaterialFiles: vi.fn(), validateClipboardImage: vi.fn(), imagePreview: vi.fn(), importSelection,
    } },
  });
  await waitFor(() => expect(screen.getByTestId('add-material')).not.toHaveAttribute('aria-disabled'));
  await user.click(screen.getByTestId('add-material'));
  const dialog = within(await screen.findByRole('dialog', { name: 'Add material' }));
  const add = dialog.getByRole('button', { name: 'Add' });
  const choose = dialog.getByRole('button', { name: 'choose on the computer' });
  expect(add).not.toHaveAccessibleDescription();
  await user.click(choose);
  const notice = await dialog.findByText(LOCAL_VIDEO_AUDIO_ONLY_NOTICE);
  expect(add).toHaveAccessibleDescription(LOCAL_VIDEO_AUDIO_ONLY_NOTICE);
  expect(notice.closest('[role="status"]')).not.toBeNull();
  expect(importSelection).not.toHaveBeenCalled();
  await user.click(dialog.getByRole('button', { name: 'Remove clip.mp4' }));
  expect(add).not.toHaveAccessibleDescription();
  expect(dialog.queryByText(LOCAL_VIDEO_AUDIO_ONLY_NOTICE)).toBeNull();
  await user.click(choose);
  await user.click(add);
  expect(importSelection).toHaveBeenCalledTimes(1);
  expect(importSelection).toHaveBeenCalledWith(expect.objectContaining({ selectionId: 'video' }));
});
