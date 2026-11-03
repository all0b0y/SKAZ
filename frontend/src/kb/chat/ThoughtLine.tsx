import { useEffect, useRef, useState } from 'react';
import type { KbMessage, KbMessagePart, KbWebSearchPart } from '../../api/kb/types.gen';
import { Icon, type IconName } from '../ui/Icon';
import { useMotionLevel } from '../ui/motionLevel';
import { ConnectIndicator } from '../fx/indicators/ConnectIndicator';
import { CallSweep } from '../fx/indicators/CallSweep';

/*
 * Stage 6 B3 — ThoughtLine + CallChip (DESIGN-SYSTEM.md decision 30; look and timings: the demo
 * .dev/ui-blocks/motion6 motion-v1 card B3). While the agent works: the thinking nodes and a live
 * timer for as long as the answer streams (FIX2 S-M1: also after text arrived, tool calls keep coming),
 * with «Writing an answer…» only while there is nothing to read yet, and one chip per tool call. After
 * the answer the block folds into its factual call/error count, which unfolds it again.
 *
 * Tool outcomes and times come only from persisted backend events. Text, permissions, questions and
 * the end of an answer cannot prove a call succeeded. Old calls without metadata stay unknown.
 */

/** SKAZ's web search tool (backend `permissions/web_tool.py` WEB_TOOL): it has its own card (W-3b). */
const WEB_TOOL = 'skaz_web_search';

export type CallState = 'run' | 'done' | 'stopped' | 'error' | 'unknown';

export interface ToolCall {
  /** Index of the part in the message (stable while it streams: parts are only appended). */
  index: number;
  name: string;
  label: string;
  state: CallState;
  startedAt?: number;
  durationMs?: number;
}

const nativeWebCards = (parts: readonly KbMessagePart[]): KbWebSearchPart[] =>
  parts.filter((p): p is KbWebSearchPart => p.type === 'web_search' && p.engine === 'claude_code' && !p.searcher);

/** Native cards from before tool events still count; match new cards only by real message-local IDs. */
function activityCounts(parts: readonly KbMessagePart[]) {
  const tools = parts.filter((p) => p.type === 'tool');
  const byId = new Map(tools.flatMap((p) => p.call_id ? [[p.call_id, p] as const] : []));
  const seen = new Set<string>();
  let n = tools.length;
  let failed = tools.filter((p) => p.status === 'error').length;
  for (const card of nativeWebCards(parts)) {
    const key = card.call_id ? `call:${card.call_id}` : `request:${card.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const tool = card.call_id ? byId.get(card.call_id) : undefined;
    if (!tool) n++;
    if (card.execution === 'error' && tool?.status !== 'error') failed++;
  }
  return { n, failed };
}

/** Each outcome is explicit; a stale running checkpoint in a finished answer is unknown. */
export function callStates(parts: readonly KbMessagePart[], state: KbMessage['state']): ToolCall[] {
  const out: ToolCall[] = [];
  const nativeIds = new Set(nativeWebCards(parts).flatMap((p) => p.call_id ? [p.call_id] : []));
  parts.forEach((part, index) => {
    if (part.type !== 'tool' || part.name.endsWith(WEB_TOOL)
      || (part.call_id && nativeIds.has(part.call_id))) return;
    const callState: CallState = part.status === 'running' ? (state === 'streaming' ? 'run' : 'unknown') : part.status ?? 'unknown';
    const startedAt = Date.parse(part.started_at ?? '');
    out.push({ index, name: part.name, label: part.label, state: callState,
      ...(Number.isFinite(startedAt) ? { startedAt } : {}),
      ...(part.duration_ms != null && Number.isFinite(part.duration_ms) && part.duration_ms >= 0
        ? { durationMs: part.duration_ms } : {}) });
  });
  return out;
}

/** Seconds in 0.1 s steps (floored, so a timer never runs ahead); past a minute m:ss. */
export function formatSeconds(seconds: number): string {
  const tenths = Math.max(0, Math.floor(Math.round(seconds * 1000) / 100));
  if (tenths < 600) return `${Math.floor(tenths / 10)}.${tenths % 10} s`;
  const whole = Math.floor(tenths / 10);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

/** The icon of a SKAZ tool (backend chats/resolve.py _TOOL_LABELS); anything else is the generic tool. */
const TOOL_ICON: ReadonlyArray<[string, IconName]> = [
  ['skaz_wiki_index', 'wiki'],
  ['skaz_read_page', 'concept'],
  ['skaz_search', 'search'],
  ['skaz_read_material', 'materials'],
  ['skaz_list_materials', 'materials'],
  ['skaz_list_folders', 'folder'],
  ['skaz_recent_speech', 'waveform'],
  ['skaz_get_fragment', 'quote'],
  ['skaz_answer_blocks', 'cards'],
];
export function toolIcon(name: string): IconName {
  return TOOL_ICON.find(([tool]) => name.endsWith(tool))?.[1] ?? 'tool';
}

/** A ticking (or, with `to`, frozen) time since `from`, in 0.1 s steps. */
export function Elapsed({ from, to, className, role }: { from: number; to?: number | null; className: string; role?: 'timer' }) {
  const [, setTick] = useState(0);
  const frozen = to !== undefined && to !== null;
  useEffect(() => {
    if (frozen) return undefined;
    const id = setInterval(() => setTick((n) => n + 1), 100);
    return () => clearInterval(id);
  }, [frozen]);
  return <span className={className} role={role}>{formatSeconds(((frozen ? to : Date.now()) - from) / 1000)}</span>;
}

/** A call's arrival may animate; its times are backend facts, not the component's mount clock. */
export function CallChip({ call, seenAt }: { call: ToolCall; seenAt?: number }) {
  const live = seenAt !== undefined;
  const icon = call.state === 'done' ? <Icon name="check" size={14} label="Done" />
    : call.state === 'error' ? <Icon name="warning" size={14} label="Failed" />
      : <Icon name={toolIcon(call.name)} size={14} />;
  return (
    <li className="kb-call" data-state={call.state} data-live={live ? 'true' : undefined}>
      {call.state === 'run' && <CallSweep className="kb-call__fx" />}
      <i className="kb-call__wipe" aria-hidden="true" />
      <span className="kb-call__icon">{icon}</span>
      <span className="kb-call__label">{call.label}</span>
      {/* FIX2 C-L5: the sweep (run) and the dashed border (stopped) are visual only; done and error speak
          through the icon's label and the visible «failed». */}
      {(call.state === 'run' || call.state === 'stopped') && (
        <span className="kb-visually-hidden">{call.state === 'run' ? 'running' : 'stopped'}</span>
      )}
      {call.state === 'error' && <span className="kb-call__err">failed</span>}
      {call.state === 'unknown' && <span className="kb-call__unknown">result unknown</span>}
      {call.state === 'run' && call.startedAt !== undefined && <Elapsed className="kb-call__time" from={call.startedAt} />}
      {(call.state === 'done' || call.state === 'stopped') && call.durationMs !== undefined && (
        <span className="kb-call__time">{formatSeconds(call.durationMs / 1000)}</span>
      )}
    </li>
  );
}

/** When the answer started: its `created_at`, unless the clock disagrees (then when this window first saw it). */
function startOf(message: KbMessage, firstSeen: number): number {
  const t = Date.parse(message.created_at);
  return Number.isFinite(t) && t <= firstSeen + 2000 ? Math.min(t, firstSeen) : firstSeen;
}

/** Arrival/fold timing is local UI state only; no tool outcome or duration is inferred here. */
function useLiveClock(message: KbMessage, calls: ToolCall[]) {
  const ref = useRef<{
    firstSeen: number; initial: Set<number>; seen: Map<number, number>;
    wasWorking: boolean; endedAt: number | null;
  } | null>(null);
  const now = Date.now();
  const working = message.state === 'streaming';
  if (!ref.current) {
    ref.current = {
      firstSeen: now, initial: new Set(calls.map((c) => c.index)), seen: new Map(),
      wasWorking: working, endedAt: null,
    };
  }
  const clock = ref.current;
  for (const c of calls) {
    if (!clock.initial.has(c.index) && !clock.seen.has(c.index)) {
      clock.seen.set(c.index, now);
    }
  }
  if (working) clock.wasWorking = true;
  else if (clock.wasWorking && clock.endedAt === null) clock.endedAt = now;
  return { clock, start: startOf(message, clock.firstSeen) };
}

/** React 18 has no boolean `inert` prop: the attribute itself (folded calls are out of tab/click reach). */
const INERT = { inert: '' } as object;

/**
 * FIX2 C-L6: a folded answer keeps its chips only for the fold motion (0.26 s at full, 0.16 s at calm),
 * then unmounts them (long chats would otherwise keep every chip of every answer). They go on the fold's
 * own transitionend, or after this time when none comes (motion off, a hidden pane).
 */
export const FOLD_UNMOUNT_MS = 400;

/**
 * The agent's work above an answer. `head` is the thinking line's words (shown while the answer has
 * nothing to read yet), or null; the row itself (nodes + live timer) stays while the answer streams.
 */
export function ThoughtLine({ message, head }: { message: KbMessage; head: string | null }) {
  const calls = callStates(message.parts, message.state);
  const { n, failed } = activityCounts(message.parts);
  const { clock, start } = useLiveClock(message, calls);
  const [open, setOpen] = useState(false);
  const level = useMotionLevel();
  const working = message.state === 'streaming';
  const unfolded = working || open;
  // Chips are mounted while unfolded and, after folding, until the fold motion ended (C-L6).
  const [kept, setKept] = useState(unfolded);
  if (unfolded && !kept) setKept(true);
  // Chips mounted again by an unfold are not arrivals: no fade-in or wipe replay (only their frozen times).
  const remounted = useRef(false);
  const foldAway = () => { remounted.current = true; setKept(false); };
  useEffect(() => {
    if (unfolded || !kept) return undefined;
    if (level === 'off') { foldAway(); return undefined; }
    const id = setTimeout(foldAway, FOLD_UNMOUNT_MS);
    return () => clearTimeout(id);
  }, [unfolded, kept, level]);
  if (!working && n === 0) return null;
  const arrived = !working && clock.endedAt !== null;
  const Summary = calls.length ? 'button' : 'div';
  return (
    <div className="kb-tools kb-thought" data-level={level} data-working={working ? 'true' : undefined}
      data-arrived={arrived ? 'true' : undefined}>
      {!working && (
        <Summary type={calls.length ? 'button' : undefined} className="kb-tools__toggle kb-thought__sum"
          aria-expanded={calls.length ? open : undefined} onClick={calls.length ? () => setOpen((v) => !v) : undefined}>
          <Icon name="tool" size={13} /><b>{n} {n === 1 ? 'tool call' : 'tool calls'}{failed > 0 ? ` · ${failed} failed` : ''}</b>
          {arrived && <span className="kb-thought__total"> · {formatSeconds((clock.endedAt! - start) / 1000)}</span>}
          {calls.length > 0 && <Icon name="chevronDown" size={12} className={`kb-thought__chev${open ? ' is-open' : ''}`} />}
        </Summary>
      )}
      <div className="kb-thought__fold" data-open={unfolded ? 'true' : 'false'} {...(unfolded ? {} : INERT)}
        onTransitionEnd={(e) => { if (e.target === e.currentTarget && !unfolded) foldAway(); }}>
        <div className="kb-thought__inner">
          {working && (
            <div className="kb-thought__head">
              {/* FX §7: «Connecting nodes» beside the words; the canvas is decorative, the text is the status.
                  One live region for the whole stream, so the words can go without remounting it. */}
              <p className="kb-msg__wait" role="status"><ConnectIndicator className="kb-msg__think" />{head}</p>
              <Elapsed className="kb-thought__time" role="timer" from={start} />
            </div>
          )}
          {calls.length > 0 && (unfolded || (kept && level !== 'off')) && (
            <ul className="kb-thought__calls" aria-label="Tool calls">
              {calls.map((c) => <CallChip key={c.index} call={c} seenAt={remounted.current ? undefined : clock.seen.get(c.index)} />)}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
