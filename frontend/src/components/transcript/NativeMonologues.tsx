import { useEffect, useMemo, useRef } from 'react';
import type { NativeSnapshot, NativeTranscriptToken, NativeTranslationToken } from '../../api/nativeLive';
import type { Segment } from '../../api/types';
import './nativeMonologues.css';

interface Turn {
  id: string;
  connection: string;
  speaker: number | null;
  tokens: NativeTranscriptToken[];
  display?: NativeTranslationToken[];
}

function project(snapshot: NativeSnapshot, segments: Segment[]): Turn[] {
  const tokens = [...(snapshot.final_tokens ?? [])];
  const represented = new Set(tokens.map((token) => token.segment_id));
  // Pre-migration recordings have no token metadata; never invent their speakers.
  for (const segment of segments) {
    if (represented.has(segment.id)) continue;
    tokens.push({ id: segment.id, segment_id: segment.id, text: segment.text,
      connection_id: 'archive', speaker_number: null,
      start_sample: segment.start_ms * snapshot.sample_rate / 1000,
      end_sample: segment.end_ms * snapshot.sample_rate / 1000 });
  }
  for (const connection of snapshot.connections) {
    try {
      const tail: unknown = JSON.parse(connection.draft_json);
      if (!Array.isArray(tail)) continue;
      for (const [index, value] of tail.entries()) {
        if (typeof value !== 'object' || value === null || typeof value.text !== 'string'
          || !Number.isFinite(value.start_ms) || !Number.isFinite(value.end_ms)
          || value.start_ms < 0 || value.end_ms < value.start_ms) continue;
        const speaker = snapshot.speakers?.find((s) => s.connection_id === connection.id && s.provider_id === value.speaker);
        tokens.push({ id: `${connection.id}:tail:${index}`, segment_id: null, text: value.text,
          connection_id: connection.id, speaker_number: speaker?.number ?? null,
          start_sample: connection.start_sample + value.start_ms * snapshot.sample_rate / 1000,
          end_sample: connection.start_sample + value.end_ms * snapshot.sample_rate / 1000 });
      }
    } catch { /* Corrupt persisted metadata is reported by the diagnostics view. */ }
  }
  tokens.sort((a, b) => a.start_sample - b.start_sample);
  const turns: Turn[] = [];
  for (const token of tokens) {
    const previous = turns.at(-1);
    if (previous && previous.connection === token.connection_id && previous.speaker === token.speaker_number) {
      previous.tokens.push(token);
    } else {
      turns.push({ id: token.id, connection: token.connection_id, speaker: token.speaker_number, tokens: [token] });
    }
  }
  return turns.filter((turn) => turn.tokens.some((token) => token.text.trim()));
}

function translatedTurns(snapshot: NativeSnapshot, segments: Segment[]): Turn[] {
  const projection = snapshot.live_translation_projection;
  if (!projection) return project(snapshot, segments).map((turn) => ({ ...turn, display: [] }));
  const originals = new Map(projection.original_tokens.map((token) => [token.id, token]));
  const display = new Map<string, NativeTranslationToken>([
    ...projection.original_tokens.map((token) => [token.id, token] as const),
    ...projection.translation_tokens.map((token) => [token.id, token] as const),
  ]);
  const turns: Turn[] = projection.monologues.map((turn) => ({
    id: turn.id, connection: turn.connection_id, speaker: turn.speaker_number,
    tokens: turn.original_token_ids.flatMap((id) => originals.get(id) ? [originals.get(id)!] : []),
    display: turn.display_token_ids.flatMap((id) => display.get(id) ? [display.get(id)!] : []),
  }));
  // Preserve pre-token archive sources without inventing translation ownership.
  const represented = new Set(projection.original_tokens.map((token) => token.segment_id));
  const archive = segments.filter((segment) => !represented.has(segment.id));
  if (archive.length) turns.push(...project({ ...snapshot, final_tokens: [], connections: [] }, archive)
    .map((turn) => ({ ...turn, display: [] })));
  return turns.sort((a, b) => (a.tokens[0]?.start_sample ?? 0) - (b.tokens[0]?.start_sample ?? 0));
}

export function NativeMonologues({ snapshot, segments, focusSegmentId }: {
  snapshot: NativeSnapshot; segments: Segment[]; focusSegmentId: string | null;
}) {
  const translation = snapshot.recording_mode === 'translation';
  const turns = useMemo(() => translation ? translatedTurns(snapshot, segments) : project(snapshot, segments),
    [snapshot, segments, translation]);
  const projection = snapshot.live_translation_projection;
  const unassignedIds = new Set(projection?.unassigned_translation_token_ids);
  const unassigned = projection
    ? projection.translation_tokens.filter((token) => unassignedIds.has(token.id))
    : [...(snapshot.final_translation_tokens ?? []), ...(snapshot.partial_translation_tokens ?? [])
      .map((token, index) => ({ ...token, id: `unassigned-tail:${index}` }))];
  const list = useRef<HTMLOListElement>(null);
  const locatedSource = useRef<string | null>(null);
  useEffect(() => {
    if (!focusSegmentId) { locatedSource.current = null; return; }
    if (locatedSource.current === focusSegmentId) return;
    const target = Array.from(list.current?.querySelectorAll<HTMLElement>('[data-source-id]') ?? [])
      .find((element) => element.dataset.sourceId === focusSegmentId);
    if (target) {
      const original = target.closest('details');
      if (original) original.open = true;
      locatedSource.current = focusSegmentId;
      target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }, [focusSegmentId, turns]);
  return <ol ref={list} className="native-monologues" aria-label="Транскрипция">
    {turns.map((turn, index) => <li key={turn.id} className="native-monologue">
      <span className="native-monologue__speaker">
        {turn.speaker !== null ? `Спикер ${turn.speaker}` : index === 0 && turn.connection !== 'archive' ? 'Спикер 1' : 'Спикер'}
      </span>
      {translation && <p className="native-monologue__text">{turn.display?.map((token) =>
        <span key={token.id}>{token.text}</span>)}</p>}
      {translation ? <details className="native-monologue__original">
        <summary>Показать оригинал</summary>
        <p className="native-monologue__text">{turn.tokens.map((token) => <span key={token.id}
          data-source-id={token.segment_id ?? undefined}
          className={token.segment_id && token.segment_id === focusSegmentId ? 'segment--focused' : undefined}
        >{token.text}</span>)}</p>
      </details> : <p className="native-monologue__text">{turn.tokens.map((token) => <span key={token.id}
        data-source-id={token.segment_id ?? undefined}
        className={token.segment_id && token.segment_id === focusSegmentId ? 'segment--focused' : undefined}
      >{token.text}</span>)}</p>}
    </li>)}
    {translation && unassigned.length > 0 && <li className="native-monologue">
      <span className="native-monologue__speaker">Перевод без точной привязки к реплике</span>
      <p className="native-monologue__text">{unassigned.map((token) => <span key={token.id}>{token.text}</span>)}</p>
    </li>}
  </ol>;
}
