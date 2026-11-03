import { createContext, useCallback, useContext, useMemo, useState, type ComponentPropsWithoutRef, type ReactNode } from 'react';

interface HeaderTarget {
  host: HTMLDivElement | null;
  setHost: (element: HTMLDivElement | null) => void;
  active: boolean;
  setActive: (owner: string, active: boolean) => void;
}
const Context = createContext<HeaderTarget | null>(null);

/** One header target per surface; selection never reparents or remounts the list itself. */
export function SelectionHeaderProvider({ children }: { children: ReactNode }) {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const [owners, setOwners] = useState<ReadonlySet<string>>(new Set());
  const setActive = useCallback((owner: string, active: boolean) => {
    setOwners((old) => {
      if (old.has(owner) === active) return old;
      const next = new Set(old);
      if (active) next.add(owner); else next.delete(owner);
      return next;
    });
  }, []);
  const active = owners.size > 0;
  const value = useMemo(() => ({ host, setHost, active, setActive }), [host, active, setActive]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function SelectionHeader({ children, ...props }: ComponentPropsWithoutRef<'header'>) {
  const target = useContext(Context);
  const active = target?.active ?? false;
  return (
    <header {...props} data-selection-active={active ? 'true' : undefined}>
      <div className="kb-selection-header__normal" hidden={active} {...(active ? { inert: '' } : {})}>{children}</div>
      <div className="kb-selection-header__slot" ref={target?.setHost} />
    </header>
  );
}

export const useSelectionHeader = () => useContext(Context);
