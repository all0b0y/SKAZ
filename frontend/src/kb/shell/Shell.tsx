import { useEffect, useState } from 'react';
import { usePrefs, useServices, useUi } from '../state/context';
import { RIGHT_MAX, RIGHT_MIN, SIDE_MAX, SIDE_MIN } from '../state/prefs';
import { ChatCenter } from './ChatCenter';
import { DocPanel } from './DocPanel';
import { CENTER_MIN, RAIL_W, computeLayout } from './layout';
import { Rail } from './Rail';
import { Resizer } from './Resizer';
import { SidePanel } from './SidePanel';
import { TitleBar } from './TitleBar';

function useWindowWidth(): number {
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const on = () => setWidth(window.innerWidth);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return width;
}

/**
 * Window shell (decision 13): title bar, icon rail, collapsible left panel, chat in the centre,
 * document panel on the right only when something is open. Header heights are fixed; the rail
 * and the composer do not move when sections or panels change.
 */
export function Shell() {
  const { prefs } = useServices();
  const sideOpen = usePrefs((s) => s.sideOpen);
  const sideWidth = usePrefs((s) => s.sideWidth);
  const rightWidth = usePrefs((s) => s.rightWidth);
  const doc = useUi((s) => s.doc);
  const docExpanded = useUi((s) => s.docExpanded);
  const windowWidth = useWindowWidth();

  const layout = computeLayout({
    windowWidth, sideOpen, sideWidth, docOpen: doc !== null, docExpanded, rightWidth,
  });
  const available = windowWidth - RAIL_W;
  const sideMax = Math.max(SIDE_MIN, Math.min(SIDE_MAX, available - CENTER_MIN - (layout.right ?? 0)));
  const rightMax = Math.max(RIGHT_MIN, Math.min(RIGHT_MAX, available - CENTER_MIN - layout.side));

  return (
    <div className="kb-app">
      <TitleBar />
      <div className="kb-body">
        <Rail />
        {layout.side > 0 && (
          <>
            <SidePanel width={layout.side} />
            <Resizer
              label="Resize side panel"
              controls="kb-side"
              value={layout.side}
              min={SIDE_MIN}
              max={sideMax}
              direction={1}
              onChange={(px) => prefs.getState().setSideWidth(px)}
            />
          </>
        )}
        <ChatCenter hidden={!layout.centerVisible} />
        {doc !== null && (
          <>
            {layout.right !== null && (
              <Resizer
                label="Resize document panel"
                controls="kb-doc"
                value={layout.right}
                min={RIGHT_MIN}
                max={rightMax}
                direction={-1}
                onChange={(px) => prefs.getState().setRightWidth(px)}
              />
            )}
            <DocPanel doc={doc} expanded={docExpanded} width={layout.right ?? 0} />
          </>
        )}
      </div>
    </div>
  );
}
