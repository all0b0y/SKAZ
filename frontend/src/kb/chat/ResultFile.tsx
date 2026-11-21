import { useEffect, useRef, useState } from 'react';
import type { KbFilePart } from '../../api/kb/types.gen';
import { errorText } from '../api/client';
import { useServices } from '../state/context';
import { Button, Icon } from '../ui';
import { FileToolDialog } from '../ui/FileToolDialog';

export function ResultFile({ chatId, messageId, file }: { chatId: string; messageId: string; file: KbFilePart }) {
  const { client } = useServices();
  const [preview, setPreview] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState('');
  const url = useRef('');
  const current = useRef(true);
  const mime = file.mime_type.split(';')[0]!.trim().toLowerCase();
  const image = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mime);
  const plain = mime.startsWith('text/') || mime === 'application/json';
  useEffect(() => {
    current.current = true;
    return () => { current.current = false; if (url.current) URL.revokeObjectURL(url.current); url.current = ''; };
  }, [file.id, messageId, chatId]);

  async function open(download: boolean) {
    setBusy(true); setError('');
    try {
      if (!url.current) {
        const result = await client.call('GET /kb/chats/{chat_id}/messages/{message_id}/files/{file_id}', {
          path: { chat_id: chatId, message_id: messageId, file_id: file.id },
        });
        if (!current.current) return;
        const bytes = Uint8Array.from(atob(result.data), char => char.charCodeAt(0));
        if (result.id !== file.id || result.name !== file.name || result.mime_type !== file.mime_type ||
            bytes.length !== file.size || result.size !== bytes.length) throw new Error('The original file is unavailable.');
        if (plain) setText(new TextDecoder().decode(bytes));
        url.current = URL.createObjectURL(new Blob([bytes], { type: image ? mime : 'application/octet-stream' }));
      }
      if (download) {
        const link = document.createElement('a');
        link.href = url.current; link.download = file.name; link.click();
      } else setPreview(true);
    } catch (e) { if (current.current) setError(errorText(e)); }
    finally { if (current.current) setBusy(false); }
  }
  return <div className="kb-result-file" role="group" aria-label="Result file">
    <Icon name="attach" size={20} /><div><strong>{file.name}</strong><small>{mime} · {file.size} B</small></div>
    <div className="kb-result-actions">
      {(plain || image) && <Button size="sm" disabled={busy} onClick={() => void open(false)}>Preview</Button>}
      <Button size="sm" disabled={busy} onClick={() => void open(true)}>Download</Button>
    </div>
    {error && <p role="alert">{error}</p>}
    {preview && <FileToolDialog preview title={file.name} close={() => setPreview(false)}>
      {plain ? <pre>{text}</pre> : <img src={url.current} alt={file.name} />}
      <footer><Button size="sm" onClick={() => void open(true)}>Download</Button></footer>
    </FileToolDialog>}
  </div>;
}
