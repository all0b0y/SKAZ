export interface InlineLink { label: string; url: string }

const services: Record<string, string[]> = {
  YouTube: ['youtube.com', 'youtu.be', 'youtube-nocookie.com'],
  Vimeo: ['vimeo.com'], Dailymotion: ['dailymotion.com', 'dai.ly'],
  TikTok: ['tiktok.com'], VK: ['vk.com', 'vkvideo.ru'], RUTUBE: ['rutube.ru'],
};

export function webAddress(text: string): URL | null {
  if (!/^https?:\/\//i.test(text) || /[\s<>\\]/.test(text)) return null;
  try {
    const url = new URL(text);
    return url.username || url.password ? null : url;
  } catch { return null; }
}

export function platform(url: URL) {
  return Object.keys(services).find((name) => services[name]!.some((host) =>
    url.hostname === host || url.hostname.endsWith(`.${host}`)));
}

export function linkLabel(url: URL): string {
  const service = platform(url);
  if (service) return service;
  const leaf = url.pathname.split('/').filter(Boolean).pop();
  if (!leaf || /^(?:watch|video|embed|home|index(?:\.html?)?)$/i.test(leaf)) return url.hostname;
  try { return decodeURIComponent(leaf); } catch { return leaf; }
}

export function linkMarkdown({ label, url }: InlineLink): string {
  return `[${label.replace(/[\\[\]]/g, '\\$&')}](<${url}>)`;
}

/** Keep prose and punctuation around pasted addresses as ordinary editable text. */
export function addressRuns(text: string): Array<string | InlineLink> {
  const runs: Array<string | InlineLink> = [];
  let start = 0;
  for (const match of text.matchAll(/https?:\/\/[^\s<>"“”«»]+/gi)) {
    let raw = match[0].replace(/[.,;:!?]+$/, '');
    let extra = (raw.match(/\)/g)?.length ?? 0) - (raw.match(/\(/g)?.length ?? 0);
    while (extra-- > 0 && raw.endsWith(')')) raw = raw.slice(0, -1);
    const url = webAddress(raw);
    if (!url) continue;
    if (match.index > start) runs.push(text.slice(start, match.index));
    runs.push({ label: linkLabel(url), url: raw });
    start = match.index + raw.length;
  }
  if (start < text.length) runs.push(text.slice(start));
  return runs;
}

export function* inlineLinkMatches(text: string) {
  for (const match of text.matchAll(/\[((?:\\.|[^\[\]\\])*)\]\(<(https?:\/\/[^\s<>]+)>\)/gi)) {
    if (webAddress(match[2]!)) yield {
      start: match.index, end: match.index + match[0].length,
      link: { label: match[1]!.replace(/\\(.)/g, '$1'), url: match[2]! },
    };
  }
}

export function splitLinks(text: string): Array<string | InlineLink> {
  const pieces: Array<string | InlineLink> = [];
  let start = 0;
  for (const match of inlineLinkMatches(text)) {
    pieces.push(...addressRuns(text.slice(start, match.start)), match.link);
    start = match.end;
  }
  pieces.push(...addressRuns(text.slice(start)));
  return pieces;
}

export function draftLink({ label, url }: InlineLink): HTMLButtonElement {
  const el = document.createElement('button');
  el.type = 'button';
  el.contentEditable = 'false';
  el.className = 'kb-prose-link';
  el.dataset.url = url;
  el.dataset.platform = platform(new URL(url)) ?? '';
  el.title = url;
  el.textContent = label;
  el.setAttribute('aria-label', `Edit link: ${label}`);
  return el;
}
