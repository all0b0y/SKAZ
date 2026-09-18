import { useEffect, useState } from 'react';
import { ApiClient, type StorageLayout } from '../../api/client';
import { Button } from '../ui/Button';

export function PhysicalStoragePanel({ capturing }: { capturing: boolean }) {
  const [view, setView] = useState<StorageLayout | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [move, setMove] = useState<{ root: string; previous: string } | null>(null);
  useEffect(() => {
    let alive = true;
    void new ApiClient(window.audiohelper).getStorageLayout().then((next) => {
      if (alive) setView(next);
    }, () => { if (alive) setError('Не удалось прочитать файловый режим.'); });
    return () => { alive = false; };
  }, []);
  const run = async (action: 'read' | 'enable' | 'recover' | 'choose' | 'move') => {
    if (busy) return;
    setBusy(true); setError('');
    const api = new ApiClient(window.audiohelper);
    try {
      if (action === 'choose') {
        const root = await api.getStorageRoot();
        if (root.managed || !root.root || !window.audiohelper.chooseStorageRoot) throw new Error('Managed root');
        const selected = await window.audiohelper.chooseStorageRoot();
        if (selected) setMove({ root: selected, previous: root.root });
        return;
      }
      if (action === 'move' && move) await api.moveStorageRoot(move.root, move.previous);
      if (action === 'enable') await api.enableStorageLayout();
      if (action === 'recover') await api.recoverStorage();
      setView(await api.getStorageLayout()); setConfirm(false); setMove(null);
      window.dispatchEvent(new Event('skaz-storage-root-changed'));
    } catch {
      setView(null); setMove(null);
      setError('Операция не подтверждена. Проверьте состояние. Для включения нужен выбранный корень и пустой список сессий; существующие записи не удаляются автоматически.');
    } finally { setBusy(false); }
  };
  return <section className="settings-section storage-root" aria-label="Физическое хранилище">
    <h3 className="settings-section__title">Физические папки сессий</h3>
    <p>Группы и сессии хранятся в выбранном корне. Оригинальное аудио — в audio/ внутри сессии.
      База данных остаётся во внутреннем хранилище. «Все» — виртуальный список, Ungrouped — папка.</p>
    {view?.enabled ? <p role="status">Файловый режим включён. Группы сохраняются в базе, а не в браузере.</p>
      : <Button disabled={!view || busy || capturing} onClick={() => setConfirm(true)}>Включить файловый режим…</Button>}
    {confirm && <fieldset disabled={busy || capturing}>
      <legend>Перейти на физические папки?</legend>
      <p>Сначала выберите корень и явно удалите прежние сессии, если они больше не нужны.
        Автоматической миграции и удаления нет. Отключение после перехода недоступно.</p>
      <Button onClick={() => void run('enable')}>Подтвердить файловый режим</Button>
      <Button onClick={() => setConfirm(false)}>Отмена</Button>
    </fieldset>}
    {view?.pending && <>
      <p role="alert">Операция с файлами не завершена ({view.pending.kind}, {view.pending.phase}).
        Запись и следующие перемещения заблокированы. Восстановление продолжает операцию,
        а не отменяет удаление. При внешних изменениях файлы сохраняются для ручного разбора.</p>
      <Button disabled={busy || capturing} onClick={() => void run('recover')}>Продолжить восстановление</Button>
    </>}
    {view?.enabled && !view.pending && <Button disabled={busy || capturing} onClick={() => void run('choose')}>
      Перенести сессии в другой корень…
    </Button>}
    {move && <fieldset disabled={busy || capturing}>
      <legend>Подтвердить перенос сессий?</legend>
      <code className="storage-root__path">{move.root}</code>
      <p>Переносится аудио, транскрипции и заметки всех сессий. Внешние файлы корня и сохранённые архивы
        остаются на прежнем месте. Перенос между дисками недоступен; занятые папки не заменяются.</p>
      <Button onClick={() => void run('move')}>Подтвердить перенос</Button>
      <Button onClick={() => setMove(null)}>Отмена</Button>
    </fieldset>}
    {error && <p role="alert">{error}</p>}
    <Button disabled={busy} onClick={() => void run('read')}>Проверить файловый режим</Button>
  </section>;
}
