import { useCallback, useEffect, useRef, useState } from 'react';
import type { KbExploring, KbFunnelRun, KbRepeatCheck, KbWeeklyCheck } from '../../api/kb/types.gen';
import type { ExploreClients, ExploreInitialState } from './types';
import { exploreIssue, type ExploreIssue } from './errors';

const active = (job: { state: string } | null) => job && ['queued', 'running', 'paused'].includes(job.state);

/** Reattach persisted jobs, including the final read after they leave the active list. */
export function useExploreJobs(clients: ExploreClients, hidden: boolean, initial: ExploreInitialState | undefined,
  checkId: string | null, refresh: () => Promise<void>) {
  const [run, rawSetRun] = useState<KbFunnelRun | null>(initial?.run ?? null);
  const [repeatCheck, rawSetRepeat] = useState<KbRepeatCheck | null>(initial?.repeatCheck ?? null);
  const [weeklyCheck, rawSetWeekly] = useState<KbWeeklyCheck | null>(null);
  const [exploringItems, setExploringItems] = useState<KbExploring[]>([]);
  const [weeklyDay, setWeeklyDay] = useState<string | null>(null);
  const [waiting, setWaiting] = useState<{ checkId: string; count: number } | null>(null);
  const [issue, setIssue] = useState<ExploreIssue | null>(null);
  const version = useRef(0);
  const latest = useRef({ run, repeatCheck, weeklyCheck });
  latest.current = { run, repeatCheck, weeklyCheck };
  const signature = useRef<string | null>(null);
  const invalidate = useCallback(() => { version.current++; }, []);
  const setRun = useCallback((job: KbFunnelRun) => {
    version.current++; latest.current.run = job; rawSetRun(job);
    void refresh();
  }, [refresh]);
  const setRepeatCheck = useCallback((job: KbRepeatCheck) => {
    version.current++; latest.current.repeatCheck = job; rawSetRepeat(job);
    void refresh();
  }, [refresh]);
  const setWeeklyCheck = useCallback((job: KbWeeklyCheck) => {
    version.current++; latest.current.weeklyCheck = job; rawSetWeekly(job);
    setWaiting(job.candidates_waiting > 0 ? { checkId: job.id, count: job.candidates_waiting } : null);
    void refresh();
  }, [refresh]);

  const refreshRun = useCallback(async (runId: string) => {
    const generation = version.current;
    const next = await clients.explore.run(runId);
    if (generation !== version.current || latest.current.run?.id !== runId) return;
    version.current++; latest.current.run = next; rawSetRun(next);
    await refresh();
  }, [clients, refresh]);

  useEffect(() => {
    if (hidden) return;
    let live = true;
    let polling = false;
    let extrasNeeded = true;
    const poll = async () => {
      if (polling) return;
      polling = true;
      const generation = version.current;
      try {
        const jobs = await clients.explore.jobs({ active: true });
        const previous = latest.current;
        const runId = active(previous.run) ? previous.run!.id : jobs.jobs.find((j) => j.owner === 'explore')?.id;
        const repeatId = active(previous.repeatCheck) ? previous.repeatCheck!.id : jobs.jobs.find((j) => j.owner === 'repeats')?.id;
        const weeklyId = checkId ?? (active(previous.weeklyCheck) ? previous.weeklyCheck!.id : jobs.jobs.find((j) => j.owner === 'weekly')?.id);
        const [nextRun, nextRepeat, nextWeekly] = await Promise.all([
          runId ? clients.explore.run(runId) : null,
          repeatId ? clients.repeats.check(repeatId) : null,
          weeklyId ? clients.maintenance.check(weeklyId) : null,
        ]);
        if (!live || generation !== version.current) return;
        const nextSignature = JSON.stringify([jobs.jobs, nextRun, nextRepeat, nextWeekly]);
        const changed = signature.current !== null && signature.current !== nextSignature;
        signature.current = nextSignature;
        if (nextRun) rawSetRun(nextRun);
        if (nextRepeat) rawSetRepeat(nextRepeat);
        if (nextWeekly) {
          rawSetWeekly(nextWeekly);
          setWaiting(nextWeekly.candidates_waiting > 0 ? { checkId: nextWeekly.id, count: nextWeekly.candidates_waiting } : null);
        }
        setIssue(null);
        if (changed) await refresh();
        if (extrasNeeded) {
          const [settings, exploring, history] = await Promise.all([clients.maintenance.settings(), clients.explore.exploring(),
            !nextRun && !previous.run ? clients.explore.jobs({ active: false }) : null]);
          if (!live || generation !== version.current) return;
          const completed = history?.jobs.filter((job) => job.owner === 'explore' && ['done', 'cancelled', 'error'].includes(job.state))
            .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
          if (completed) {
            const restored = await clients.explore.run(completed.id);
            if (!live || generation !== version.current) return;
            rawSetRun(restored);
          }
          setWeeklyDay(settings.enabled ? settings.next_due_at : null);
          setExploringItems(exploring.items);
          if (!nextWeekly) setWaiting(settings.latest_check_id && settings.candidates_waiting > 0
            ? { checkId: settings.latest_check_id, count: settings.candidates_waiting } : null);
          extrasNeeded = false;
        }
      } catch (error) { if (live && generation === version.current) setIssue(exploreIssue(error)); }
      finally { polling = false; }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 1000);
    return () => { live = false; window.clearInterval(timer); };
  }, [clients, hidden, checkId, refresh]);

  return { run, repeatCheck, weeklyCheck, exploringItems, setExploringItems, weeklyDay, waiting, setWaiting,
    issue, invalidate, setRun, refreshRun, setRepeatCheck, setWeeklyCheck };
}
