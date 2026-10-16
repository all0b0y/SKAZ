import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../state/store';
import { useReducedMotion } from '../../hooks/useReducedMotion';
import { SAP } from '../../brand/treeGeometry';
import { canAnimate } from '../../lib/webAnimations';
import { TreeMark } from '../brand/TreeMark';
import { claimTreeIntro, playTreeIntro, treeIntroPending } from '../brand/treeIntro';

type Intro = 'still' | 'pending' | 'playing' | 'done';

/**
 * The SKAZ tree shown when a session has no transcript yet and nothing is
 * recording. The first one of an app run plays the tree's intro once the
 * startup screen is gone, then the SKAZ wordmark appears; every later one is
 * still. Decorative only: nothing waits for it.
 */
export function TranscriptEmptyLogo() {
  const ready = useStore((s) => s.ready);
  const reduced = useReducedMotion();
  const treeRef = useRef<SVGSVGElement>(null);
  const [intro, setIntro] = useState<Intro>(() => (!reduced && canAnimate() && treeIntroPending() ? 'pending' : 'still'));
  // Refs, not state: a StrictMode re-run or a backend restart resumes the same intro.
  const wanted = useRef(intro === 'pending');
  const claimed = useRef(false);

  useEffect(() => {
    const svg = treeRef.current;
    if (!wanted.current || !ready || !svg) return undefined;
    if (!claimed.current && !claimTreeIntro()) {
      wanted.current = false;
      setIntro('still');
      return undefined;
    }
    claimed.current = true;
    setIntro('playing');
    return playTreeIntro(svg, () => {
      wanted.current = false;
      setIntro('done');
    });
  }, [ready]);

  const growing = intro === 'pending' || intro === 'playing';
  return (
    <div className="transcript-logo" data-intro={intro === 'still' ? undefined : intro}>
      <TreeMark ref={treeRef} className="transcript-logo__tree">
        {growing && (
          <>
            <g className="tree-intro__sap">
              {SAP.trunk.map((cell, index) => (
                <rect key={`trunk-${index}`} data-part="trunk" x={cell.x - cell.size / 2} y={cell.y - cell.size / 2}
                  width={cell.size} height={cell.size} rx={2} />
              ))}
              {SAP.branches.map((cell, index) => (
                <rect key={`branch-${index}`} data-part="branch" x={cell.x - cell.size / 2} y={cell.y - cell.size / 2}
                  width={cell.size} height={cell.size} rx={2} />
              ))}
            </g>
            <g className="tree-intro__sparks" />
          </>
        )}
      </TreeMark>
      <p className="transcript-logo__word" aria-hidden="true">SKAZ</p>
      <p className="transcript-logo__hint">Record or open a session to see its transcript here.</p>
    </div>
  );
}
