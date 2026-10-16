/**
 * One menu at a time, across the whole window.
 *
 * Menus close themselves when a mouse button goes down outside them — but not on
 * the RIGHT button, because the browser sends that button-down before the
 * `contextmenu` that opens the next menu, and letting it dismiss meant the user's
 * click was spent closing the old menu instead of opening the one they asked for.
 *
 * With that guard in place nothing else would close the old menu, so a second
 * right click could leave two menus on screen. This register is that missing
 * piece: opening any menu closes whichever was open, no matter which component
 * owns it — the tab strip, the document, or the session rail.
 */

type Dismiss = () => void;

let open: Dismiss | null = null;

/**
 * Announce a menu as the one on screen, closing any other, and return the
 * cleanup that releases it. A menu already gone releases nothing: its own
 * dismissal is what mounted the next one.
 */
export function claimOpenMenu(dismiss: Dismiss): () => void {
  const previous = open;
  open = dismiss;
  if (previous && previous !== dismiss) previous();
  return () => {
    if (open === dismiss) open = null;
  };
}
