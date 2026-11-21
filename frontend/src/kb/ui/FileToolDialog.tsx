import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { IconButton } from './Button';
import './fileToolDialog.css';

export function FileToolDialog({ title, close, children, preview = false }: {
  title: string; close: () => void; children: ReactNode; preview?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const el = dialog.current!;
    el.showModal();
    return () => el.close();
  }, []);
  return <dialog ref={dialog} className={'kb-filetool-dialog' + (preview ? ' kb-filetool-preview' : '')}
    aria-label={title} onCancel={event => { event.preventDefault(); close(); }}
    onKeyDown={event => event.stopPropagation()}>
    <header><h3>{title}</h3><IconButton icon="close" label="Close" onClick={close} /></header>
    {children}
  </dialog>;
}
