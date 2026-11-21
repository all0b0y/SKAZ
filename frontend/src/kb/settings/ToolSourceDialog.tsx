import { useRef, useState, type FormEvent } from 'react';
import { errorText } from '../api/client';
import { useServices } from '../state/context';
import { Button } from '../ui';
import { FileToolDialog } from '../ui/FileToolDialog';
import type { ToolKind } from './ToolTabs';

export function ToolSourceDialog({ kind, close }: { kind: ToolKind; close: () => void }) {
  const { chats, prefs, ui } = useServices();
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const setupChat = useRef<string | undefined>(undefined);
  const mcp = kind === 'mcp';
  async function submit(event: FormEvent) {
    event.preventDefault();
    const source = url.trim();
    if (!source || sending.current) return;
    try {
      const parsed = new URL(source);
      if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname ||
          parsed.username || parsed.password || parsed.hash || /\s/.test(source)) throw new Error();
    } catch {
      setError('Enter a server or skill URL without credentials.');
      return;
    }
    sending.current = true;
    setBusy(true);
    setError('');
    try {
      const text = (mcp ? 'Connect this MCP server: ' : 'Install this skill: ') + source;
      const result = await chats.getState().send({ text, mentions: [], quotes: [], attachments: [] }, {}, {
        newChat: true,
        draftChatId: setupChat.current,
        onDraftChatCreated: id => { setupChat.current = id; },
      });
      if (!result.ok) { setError(result.error); return; }
      prefs.getState().set({ section: 'chats' });
      const state = ui.getState();
      if (state.docExpanded) state.toggleDocExpanded();
      state.showCenter('chat');
      state.closeSettings();
    } catch (e) { setError(errorText(e)); }
    finally { sending.current = false; setBusy(false); }
  }
  return <FileToolDialog title={mcp ? 'Add MCP' : 'Add skill'} close={() => { if (!sending.current) close(); }}>
    <form onSubmit={submit}>
      <label>{mcp ? 'MCP server URL' : 'Skill source URL'}<input autoFocus type="text" value={url} disabled={busy}
        aria-invalid={!!error} onChange={e => { setUrl(e.target.value); setError(''); }} /></label>
      {error && <p role="alert">{error}</p>}
      <footer><Button onClick={close} disabled={busy}>Cancel</Button>
        <Button type="submit" variant="fill" busy={busy} disabled={busy || !url.trim()}>Send to chat</Button></footer>
    </form>
  </FileToolDialog>;
}
