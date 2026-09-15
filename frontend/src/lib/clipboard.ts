// Copies text to the system clipboard. Tries the modern async Clipboard API
// first; some Electron/Chromium combinations gate `clipboard-write` behind a
// permission handler that only this app's renderer window may not have
// explicitly granted, so a legacy execCommand('copy') fallback keeps the
// "Copy" action working even when the modern API silently rejects. Never
// throws — callers get a plain boolean and decide how to surface failure.

async function copyViaClipboardApi(text: string): Promise<boolean> {
  try {
    if (!navigator.clipboard?.writeText) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function copyViaExecCommand(text: string): boolean {
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

export async function copyToClipboard(text: string): Promise<boolean> {
  if (await copyViaClipboardApi(text)) return true;
  return copyViaExecCommand(text);
}
