import { useEffect, useRef, useState } from 'react';
import type { KbSearchPlan, KbSearchPlanItem, KbSearchPlanRequest } from '../../api/kb/types.gen';
import { KbApiError } from '../api/client';
import { exploreIssue } from './errors';
import type { DiscoveryClient } from './clients';

export function useSearchPlan(client: DiscoveryClient | undefined, request: KbSearchPlanRequest, hidden: boolean, source = '') {
  const key = JSON.stringify(request);
  const [snapshot, setSnapshot] = useState<{ key: string; source: string; attempt: number; edited: boolean; plan: KbSearchPlan } | null>(null);
  const [issue, setIssue] = useState<{ key: string; message: string } | null>(null);
  const [retry, setRetry] = useState(0);
  const sequence = useRef(0);
  const saved = useRef(snapshot); saved.current = snapshot;
  useEffect(() => {
    const generation = ++sequence.current;
    if (hidden) return;
    const previous = saved.current;
    if (previous?.key === key && previous.attempt === retry && (previous.edited || previous.source === source)) return;
    setIssue(null);
    // Oversized text stays visible, and can never be silently cut before sending it.
    if ([...(request.query ?? '')].length > 72) return;
    if (!client) { setIssue({ key, message: 'Search planning is not ready. Try again after setup.' }); return; }
    const timer = window.setTimeout(() => {
      void client.plan(request).then((plan) => {
        if (sequence.current === generation) setSnapshot({ key, source, attempt: retry, edited: false, plan });
      }).catch((error) => {
        if (sequence.current !== generation) return;
        setIssue({ key, message: error instanceof KbApiError && error.code === 'not_ready'
          ? 'Search planning is not ready. Check Settings and try again.' : exploreIssue(error).message });
      });
    }, 200);
    return () => { sequence.current++; window.clearTimeout(timer); };
  }, [client, key, hidden, retry, source]);
  const plan = snapshot?.key === key && snapshot.attempt === retry && (snapshot.edited || snapshot.source === source) ? snapshot.plan : null;
  const items = plan?.items ?? [];
  const valid = items.length > 0 && items.length <= 8 && items.every((item) => item.terms.length > 0 && item.terms.length <= 6
    && item.terms.every((term) => term.trim().length > 0 && [...term].length <= 72));
  const message = [...(request.query ?? '')].length > 72 ? 'Use at most 72 characters for a precise query.'
    : issue?.key === key ? issue.message : !plan ? 'Preparing search preview…'
      : !plan.ready ? plan.reason ?? 'Choose a topic or enter a query.' : !valid ? 'Keep at least one search item with a nonempty term (up to 72 characters).' : null;
  const edit = (items: KbSearchPlanItem[]) => setSnapshot((old) => old?.key === key ? { ...old, edited: true, plan: { ...old.plan, items } } : old);
  return { items, ready: Boolean(plan?.ready && valid && !message && !hidden), message, failed: issue?.key === key,
    retry: () => setRetry((n) => n + 1), edit };
}
