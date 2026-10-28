import { useEffect, useRef, useState } from 'react';
import type { KbMessage, KbMessagePart } from '../../api/kb/types.gen';
import { Icon, type IconName } from '../ui/Icon';
import { useMotionLevel } from '../ui/motionLevel';
import { ConnectIndicator } from '../fx/indicators/ConnectIndicator';
import { CallSweep } from '../fx/indicators/CallSweep';

/*
 * Stage 6 B3 — ThoughtLine + CallChip (DESIGN-SYSTEM.md decision 30; look and timings: the demo
 * .dev/ui-blocks/motion6 motion-v1 card B3). While the agent works: the thinking nodes and a live
 * timer for as long as the answer streams (FIX2 S-M1: also after text arrived, tool calls keep coming),
 * with «Writing an answer…» only while there is nothing to read yet, and one chip per tool call. After
 * the answer the block folds into the «Looked at N things» line, which unfolds it again.
 *
 * Data honesty: a tool part (`KbToolPart`: name + label) arrives when the agent CALLS the tool; the
 * backend sends no result or error for it. Parallel calls arrive back to back before any result
 * (Claude Code sends every tool_use of a turn first), so a call «runs» while it belongs to the trailing
 * group of tool parts of a streaming answer and is «done» only once a part that is the agent going on
 * follows it (or the answer finished) — FIX2 C-M3, a stop-gap until the backend sends ToolResult.
 * Timers only count what this window saw: the thinking timer from the answer's `created_at`, a chip's
 * timer only for a call seen both start (arrive running) and end on screen. No percentages anywhere.
 */

/** SKAZ's web search tool (backend `permissions/web_tool.py` WEB_TOOL): it has its own card (W-3b). */
const WEB_TOOL = 'skaz_web_search';

export type CallState = 'run' | 'done' | 'stopped' | 'error';

export interface ToolCall {
  /** Index of the part in the message (stable while it streams: parts are only appended). */
  index: number;
  name: string;
  label: string;
  state: CallState;
}

/**
 * Parts that are NOT evidence a call finished: another call (parallel calls come back to back), and a
 * permission or question — the running call (or the agent) waiting on the user.
 */
const NOT_A_RESULT: ReadonlySet<KbMessagePart['type']> = new Set(['tool', 'permission', 'question']);

/** Each tool call of a message and what it is doing, from the parts the message already has. */
export function callStates(parts: readonly KbMessagePart[], state: KbMessage['state']): ToolCall[] {
  // The agent went on past every call before the last part that is not a call (or a wait on the user).
  let wentOn = -1;
  parts.forEach((part, index) => { if (!NOT_A_RESULT.has(part.type)) wentOn = index; });
  const out: ToolCall[] = [];
  parts.forEach((part, index) => {
    if (part.type !== 'tool' || part.name.endsWith(WEB_TOOL)) return;
    const callState: CallState = index < wentOn || state === 'done' ? 'done' : state === 'streaming' ? 'run' : 'stopped';
    out.push({ index, name: part.name, label: part.label, state: callState });
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
function Elapsed({ from, to, className, role }: { from: number; to?: number | null; className: string; role?: 'timer' }) {
  const [, setTick] = useState(0);
  const frozen = to !== undefined && to !== null;
  useEffect(() => {
    if (frozen) return undefined;
    const id = setInterval(() => setTick((n) => n + 1), 100);
    return () => clearInterval(id);
  }, [frozen]);
  return <span className={className} role={role}>{formatSeconds(((frozen ? to : Date.now()) - from) / 1000)}</span>;
}

/**
 * One tool call: a pill with the tool's icon and label; Stippling while it runs, ✓ when done. `seenAt`
 * = it arrived on screen (it may fade/wipe in); `startedAt` = it was seen running, the only case with a
 * timer (FIX2 C-M3: no duration unless its start was seen; the end is `endedAt`, or now while it runs).
 */
export function CallChip({ call, seenAt, startedAt, endedAt }: { call: ToolCall; seenAt?: number; startedAt?: number; endedAt?: number }) {
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
      {startedAt !== undefined && call.state !== 'error' && (call.state === 'run' || endedAt !== undefined) && (
        <Elapsed className="kb-call__time" from={startedAt} to={call.state === 'run' ? null : endedAt} />
      )}
    </li>
  );
}

/** When the answer started: its `created_at`, unless the clock disagrees (then when this window first saw it). */
function startOf(message: KbMessage, firstSeen: number): number {
  const t = Date.parse(message.created_at);
  return Number.isFinite(t) && t <= firstSeen + 2000 ? Math.min(t, firstSeen) : firstSeen;
}

/**
 * Remembers, for this mounted answer, when each call was first seen, when it was seen running and when
 * it stopped running, and when the answer stopped working. Only things that happened on screen get a
 * time; calls that were already there when the answer was opened get none (no invented durations), and
 * neither does a call that arrived already finished (its start was never seen).
 */
function useLiveClock(message: KbMessage, calls: ToolCall[]) {
  const ref = useRef<{
    firstSeen: number; initial: Set<number>; seen: Map<number, number>; started: Map<number, number>;
    ended: Map<number, number>; wasWorking: boolean; endedAt: number | null;
  } | null>(null);
  const now = Date.now();
  const working = message.state === 'streaming';
  if (!ref.current) {
    ref.current = {
      firstSeen: now, initial: new Set(calls.map((c) => c.index)), seen: new Map(), started: new Map(), ended: new Map(),
      wasWorking: working, endedAt: null,
    };
  }
  const clock = ref.current;
  for (const c of calls) {
    if (!clock.initial.has(c.index) && !clock.seen.has(c.index)) {
      clock.seen.set(c.index, now);
      if (c.state === 'run') clock.started.set(c.index, now);
    }
    if (clock.started.has(c.index) && c.state !== 'run' && !clock.ended.has(c.index)) clock.ended.set(c.index, now);
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
  if (!working && calls.length === 0) return null;
  const arrived = !working && clock.endedAt !== null;
  const n = calls.length;
  return (
    <div className="kb-tools kb-thought" data-level={level} data-working={working ? 'true' : undefined}
      data-arrived={arrived ? 'true' : undefined}>
      {!working && (
        <button type="button" className="kb-tools__toggle kb-thought__sum" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <Icon name="tool" size={13} /><b>Looked at {n} {n === 1 ? 'thing' : 'things'}</b>
          {arrived && <span className="kb-thought__total"> · {formatSeconds((clock.endedAt! - start) / 1000)}</span>}
          <Icon name="chevronDown" size={12} className={`kb-thought__chev${open ? ' is-open' : ''}`} />
        </button>
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
          {n > 0 && (unfolded || (kept && level !== 'off')) && (
            <ul className="kb-thought__calls" aria-label="Tool calls">
              {calls.map((c) => <CallChip key={c.index} call={c} seenAt={remounted.current ? undefined : clock.seen.get(c.index)} startedAt={clock.started.get(c.index)}
                endedAt={clock.ended.get(c.index)} />)}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
