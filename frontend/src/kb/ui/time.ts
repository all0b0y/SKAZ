/** Short times for lists: "now", "2 min", "1 h", "yesterday", "12 Oct". Local time, English. */
export function shortTime(iso: string, now: Date = new Date()): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return '';
  const minutes = Math.floor((now.getTime() - t.getTime()) / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes} min`;
  const day = dayKey(t);
  if (day === dayKey(now) && minutes < 24 * 60) return `${Math.floor(minutes / 60)} h`;
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (day === dayKey(y)) return 'yesterday';
  return t.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/** Clock time for "today" rows of the full chat list, a date otherwise. */
export function clockOrDate(iso: string, now: Date = new Date()): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return '';
  if (dayKey(t) === dayKey(now)) return t.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const days = Math.floor((startOfDay(now).getTime() - startOfDay(t).getTime()) / 86_400_000);
  if (days < 7) return t.toLocaleDateString('en-GB', { weekday: 'short' });
  return t.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

export type DayBucket = 'Today' | 'Yesterday' | 'This week' | 'Earlier';

/** Chat groups (v16): Today, Yesterday, This week, Earlier. */
export function dayBucket(iso: string, now: Date = new Date()): DayBucket {
  const t = new Date(iso);
  const days = Math.floor((startOfDay(now).getTime() - startOfDay(t).getTime()) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return 'This week';
  return 'Earlier';
}

/** Notification day headers (decision 17): Today, Yesterday, then the date. */
export function dayLabel(iso: string, now: Date = new Date()): string {
  const bucket = dayBucket(iso, now);
  if (bucket === 'Today' || bucket === 'Yesterday') return bucket;
  return new Date(iso).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

/** "08:12" / "1:02:03" for a source moment. */
export function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** Group items by a label, keeping the order in which labels first appear. */
export function groupBy<T>(items: readonly T[], label: (item: T) => string): Array<{ label: string; items: T[] }> {
  const out: Array<{ label: string; items: T[] }> = [];
  for (const item of items) {
    const key = label(item);
    const last = out.find((g) => g.label === key);
    if (last) last.items.push(item);
    else out.push({ label: key, items: [item] });
  }
  return out;
}
