// 0.3.1 S3: "Make cards / a test from these" on wiki pages and materials — the request goes into the
// message field with the picked items as @-tokens; the user adds how many or what kind and sends.
// Nothing is sent by itself.

import { useCallback } from 'react';
import type { KbRef } from '../../api/kb/types.gen';
import { useServices } from '../state/context';

export type MakeWhat = 'cards' | 'test';

const ASK: Record<MakeWhat, string> = {
  cards: 'Make flashcards from ',
  test: 'Make a test from ',
};

export function useMakeStudy(): (what: MakeWhat, refs: ReadonlyArray<KbRef>) => void {
  const { ui, composer } = useServices();
  return useCallback((what, refs) => {
    if (!refs.length) return;
    const s = ui.getState();
    if (s.center !== 'chat') s.showCenter('chat');
    if (s.docExpanded) s.toggleDocExpanded();
    composer.getState().push([
      { kind: 'text', text: ASK[what] },
      ...refs.flatMap((ref, i) => [...(i ? [{ kind: 'text' as const, text: ', ' }] : []), { kind: 'mention' as const, ref }]),
      { kind: 'text', text: ' ' },
    ], { focus: true });
  }, [ui, composer]);
}
