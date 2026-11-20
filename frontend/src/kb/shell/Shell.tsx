import { useEffect, useRef, useState } from 'react';
import { usePrefs, useServices, useUi } from '../state/context';
import { RIGHT_MIN, SIDE_MIN } from '../state/prefs';
import { AllMaterials } from '../materials/AllMaterials';
import { ExploreSection } from '../explore';
import { ChatCenter } from './ChatCenter';
import { DocPanel } from './DocPanel';
import { computeLayout, resizeLimits } from './layout';
import { Rail } from './Rail';
import { Resizer } from './Resizer';
import { SidePanel } from './SidePanel';
import { TitleBar } from './TitleBar';
import { useStartList } from '../fx/listEntrance';
import { useReaderCloseFocus } from '../document/readerSurface041/useReaderFocus';
import '../document/readerSurface041/readerOverlays.css';

function useWindowWidth(): number {
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const on = () => setWidth(window.innerWidth);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return width;
}

/** Preferred width of the graph panel. */
const GRAPH_W = 560;

/**
 * Window shell (decision 13): title bar, icon rail, collapsible left panel, chat in the centre,
 * document panel on the right only when something is open. Title bar, rail and side panel are one
 * ground; the centre and the document panel are inset sheets with gutters between them, where the
 * resizers live (DESIGN-SYSTEM.md decision 24 «Windows»). Header heights are fixed; the rail
 * and the composer do not move when sections or panels change. "All materials" takes the centre
 * instead of the chat (decision 25); the right panel shows a page, a material, the graph or the
 * live recording (see state/document.ts).
 */
export function Shell() {
  const { prefs } = useServices();
  const sideOpen = usePrefs((s) => s.sideOpen);
  const section = usePrefs((s) => s.section);
  const sideWidth = usePrefs((s) => s.sideWidth);
  const rightWidth = usePrefs((s) => s.rightWidth);
  const right = useUi((s) => s.right);
  const center = useUi((s) => s.center);
  const docExpanded = useUi((s) => s.docExpanded);
  const windowWidth = useWindowWidth();
  const compact = windowWidth <= 680;
  const [navigationOpen, setNavigationOpen] = useState(false);
  useEffect(() => { setNavigationOpen(false); }, [compact, right, center]);
  const mobileSide = compact && navigationOpen;
  const appRef = useRef<HTMLDivElement>(null);
  useReaderCloseFocus(appRef, right);

  const isExplore = section === 'explore';
  // The graph asks for a wide panel (v4/v5); it still yields to the centre minimum.
  const wanted = right?.kind === 'graph' ? Math.max(rightWidth, GRAPH_W) : rightWidth;
  const layout = computeLayout({
    windowWidth, sideOpen: !compact && sideOpen, sideWidth, docOpen: right !== null, docExpanded: docExpanded || compact, rightWidth: wanted,
  });
  const { sideMax, rightMax } = resizeLimits(windowWidth, layout);
  // AnimatedList (FIX2 S-H1): only the side list shown when the app opens may stagger in.
  useStartList(layout.side > 0 ? section : null);

  return (
    <div className="kb-app kb-reader-finish" ref={appRef}>
      <TitleBar compactSide={compact ? { open: mobileSide, toggle: () => setNavigationOpen(!mobileSide) } : undefined}
        materialActionsInSidebar={(layout.side > 0 || mobileSide) && section === 'materials'} />
      <div className="kb-body">
        <Rail sideVisible={compact ? mobileSide : undefined} onSection={compact ? () => setNavigationOpen(true) : undefined} />
        {mobileSide && <SidePanel width={windowWidth - 68} onNavigate={() => setNavigationOpen(false)} />}
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
        <ChatCenter hidden={mobileSide || !layout.centerVisible || center === 'materials' || isExplore} />
        {!isExplore && center === 'materials' && <AllMaterials hidden={mobileSide || !layout.centerVisible} />}
        {isExplore && <ExploreSection hidden={mobileSide || !layout.centerVisible} />}
        {right !== null && !mobileSide && (
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
            <DocPanel view={right} expanded={docExpanded || compact} width={layout.right ?? 0} />
          </>
        )}
      </div>
    </div>
  );
}
