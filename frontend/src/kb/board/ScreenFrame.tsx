import { useEffect, useState } from 'react';
import { KbApp } from '../KbApp';
import { boardWorld } from '../test/boardWorlds';
import { boardServices, lookPrefs, markReady, settle, useOnce } from './live';
import type { BoardLook } from './route';
import { screenById } from './screens';

/** How long the app gets to read its first data (library, chats, agents) before the screen is opened. */
const BOOT_MS = 400;

/**
 * Layer 4 frame: the whole app (KbApp — the same tree main.tsx mounts) on the browser fake, at the
 * iframe's own size (`#design-board/screen?id=…&w=…`). The frame's look goes in through the prefs,
 * so the app's own ThemeSync puts it on <html>.
 */
export function ScreenFrame({ id, look }: { id: string; look: BoardLook }) {
  const screen = screenById(id);
  const [live] = useState(() => (screen ? boardServices(boardWorld(screen.world), lookPrefs(look, screen.prefs)) : null));

  useOnce(Boolean(live && screen), async () => {
    await settle(BOOT_MS);
    await screen!.prepare?.(live!.services, live!.world);
    await settle(BOOT_MS);
  }, (error) => markReady(error ? [error] : []));

  useEffect(() => {
    if (!screen) markReady([`Unknown screen “${id}”`]);
    // Debug handle (dev only): the screen's stores and world.
    if (live) Object.assign(window, { __kbBoard: { services: live.services, world: live.world } });
  }, [screen, live, id]);

  if (!live) return <main className="kb-board"><p className="kb-board__warn">No screen “{id}”.</p></main>;
  return <KbApp services={live.services} />;
}
