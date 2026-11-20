import { useState } from 'react';
import { Modal, Button } from '../ui';
import { webAddress, type InlineLink } from './inlineLinks';

export function EditLink({ link, close, apply }: {
  link: InlineLink; close: () => void; apply: (label: string, url: string | null) => void;
}) {
  const [label, setLabel] = useState(link.label);
  const [url, setUrl] = useState(link.url);
  return <Modal open title="Edit link" onClose={close}>
    <form className="kb-attachform" onSubmit={(event) => {
      event.preventDefault();
      if (label.trim() && webAddress(url)) apply(label, url);
    }}>
      <label>Text<input className="kb-attachform__input" value={label} onChange={(event) => setLabel(event.target.value)} /></label>
      <label>Address<input className="kb-attachform__input" type="url" value={url} onChange={(event) => setUrl(event.target.value)} /></label>
      <div className="kb-attachform__foot">
        <Button onClick={() => apply(label || link.label, null)}>Remove link</Button>
        <Button onClick={close}>Cancel</Button>
        <Button variant="fill" type="submit" disabled={!label.trim() || !webAddress(url)}>Apply</Button>
      </div>
    </form>
  </Modal>;
}
