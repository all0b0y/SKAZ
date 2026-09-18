import { useEffect, useRef, useState } from 'react';
import { ApiClient } from '../../api/client';
import type { StorageRootView } from '../../api/types';
import { Button } from '../ui/Button';
import { PhysicalStoragePanel } from './PhysicalStoragePanel';
import './storageRootPanel.css';

const unknownOutcome = 'Сохранение не подтверждено. Проверьте текущий корень перед повтором.';

export function StorageRootPanel({ capturing }: { capturing: boolean }) {
  const [view, setView] = useState<StorageRootView | null>(null);
  const [candidate, setCandidate] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const lifecycle = useRef({ alive: true });
  const running = useRef(false);

  const read = async () => {
    const next = await new ApiClient(window.audiohelper).getStorageRoot();
    if (!next || next.mode !== 'markdown_projection' || typeof next.suggested_root !== 'string'
      || (next.root !== null && typeof next.root !== 'string')
      || typeof next.change_locked !== 'boolean' || typeof next.managed !== 'boolean') {
      throw new Error('Invalid storage status');
    }
    return next;
  };

  useEffect(() => {
    const scope = { alive: true };
    lifecycle.current = scope;
    void read().then((next) => { if (scope.alive) setView(next); }, () => {
      if (scope.alive) setError('Не удалось прочитать корень Markdown.');
    });
    return () => { scope.alive = false; };
  }, []);

  const run = async (operation: 'choose' | 'save' | 'read') => {
    if (running.current) return;
    const scope = lifecycle.current;
    running.current = true;
    setBusy(true); setError(''); setMessage('');
    try {
      if (operation === 'choose') {
        if (!window.audiohelper.chooseStorageRoot) throw new Error('Chooser unavailable');
        const selected = await window.audiohelper.chooseStorageRoot();
        if (scope.alive && selected !== null) setCandidate(selected);
      } else {
        if (operation === 'save') {
          if (!view || candidate === undefined || capturing || view.change_locked) return;
          // Never automatically retry a PUT, including when its response is lost.
          await new ApiClient(window.audiohelper).updateStorageRoot(candidate, view.root);
        }
        const next = await read();
        if (scope.alive) {
          setView(next); setCandidate(undefined);
          if (operation === 'save') {
            if (next.root === candidate) setMessage('Корень Markdown сохранён.');
            else setError('Корень изменился. Показана текущая настройка.');
          }
        }
        window.dispatchEvent(new Event('skaz-storage-root-changed'));
      }
    } catch {
      if (scope.alive) {
        if (operation !== 'choose') { setView(null); setCandidate(undefined); }
        setError(operation === 'choose' ? 'Не удалось открыть выбор папки.' : unknownOutcome);
      }
    } finally {
      running.current = false;
      if (scope.alive) setBusy(false);
    }
  };

  const disabled = busy || capturing || !view || view.change_locked;
  return <><section className="settings-section storage-root" aria-label="Корень Markdown">
    <h3 className="settings-section__title">Files</h3>
    <p>Корень файлов. До отдельного включения физического режима ниже сюда сохраняется только Markdown.
      База данных остаётся во внутреннем хранилище.</p>
    {view && <>
      <p>{view.root === null ? 'Markdown-проекция выключена.' : 'Текущий корень Markdown:'}</p>
      {view.root && <code className="storage-root__path">{view.root}</code>}
      <p>Предлагаемый корень: <code className="storage-root__path">{view.suggested_root}</code></p>
      {view.change_locked && <p role="status">{view.managed
        ? 'Корень задан при запуске приложения; здесь его изменить нельзя.'
        : 'Корень уже использован. Смена и отключение заблокированы до безопасного переноса.'}</p>}
    </>}
    {capturing && <p>Остановите запись перед изменением корня.</p>}
    <div className="storage-root__actions">
      <Button disabled={disabled} onClick={() => void run('choose')}>Выбрать папку…</Button>
      <Button disabled={disabled} onClick={() => { setCandidate(view!.suggested_root); setMessage(''); }}>
        Использовать Documents/SKAZ
      </Button>
      {view?.root && <Button disabled={disabled} onClick={() => setCandidate(null)}>Отключить проекцию</Button>}
    </div>
    {candidate !== undefined && <fieldset disabled={disabled}>
      <legend>{candidate === null ? 'Отключить Markdown-проекцию?' : 'Подтвердить выбранный корень?'}</legend>
      {candidate !== null && <code className="storage-root__path">{candidate}</code>}
      <p>Это отдельное сохранение настройки. Файлы не переносятся и не импортируются.
        После подтверждения Pause/Stop и правки Notes сохраняют Markdown в выбранный корень.
        Уже существующий текст появится при явном повторе сохранения файлов или следующей правке.</p>
      <div className="storage-root__actions">
        <Button onClick={() => void run('save')}>Подтвердить корень Markdown</Button>
        <Button onClick={() => setCandidate(undefined)}>Отмена</Button>
      </div>
    </fieldset>}
    {error && <p role="alert">{error}</p>}
    {message && <p role="status">{message}</p>}
    <Button disabled={busy} onClick={() => void run('read')}>Проверить текущий корень</Button>
  </section><PhysicalStoragePanel capturing={capturing} /></>;
}
