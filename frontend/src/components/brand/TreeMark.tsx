import { forwardRef, type ReactNode, type SVGAttributes } from 'react';
import { clsx } from 'clsx';
import { CROWN_CIRCLES, ROOT_CELLS, TREE_VIEWBOX, TRUNK_PATH } from '../../brand/treeGeometry';

type TreeMarkProps = Omit<SVGAttributes<SVGSVGElement>, 'viewBox' | 'role'> & {
  /** Accessible name; the mark stands in for the SKAZ wordmark. */
  label?: string;
  /** Drawn above crown and roots (the startup screen adds its sap here). */
  children?: ReactNode;
};

/** The SKAZ tree: one-tone crown and trunk, roots of fading pixels. Colours come from --tree-* tokens. */
export const TreeMark = forwardRef<SVGSVGElement, TreeMarkProps>(function TreeMark(
  { label = 'SKAZ', className, children, ...rest },
  ref,
) {
  return (
    <svg ref={ref} viewBox={TREE_VIEWBOX} role="img" aria-label={label} className={clsx('tree-mark', className)} {...rest}>
      <g className="tree-mark__crown">
        {CROWN_CIRCLES.map(([cx, cy, r]) => <circle key={`${cx},${cy}`} cx={cx} cy={cy} r={r} />)}
        <path d={TRUNK_PATH} />
      </g>
      <g className="tree-mark__roots">
        {ROOT_CELLS.map((cell, index) => (
          <rect key={index} className="tree-mark__pixel" data-index={index} x={cell.x} y={cell.y}
            width={cell.size} height={cell.size} rx={2} opacity={cell.opacity} />
        ))}
      </g>
      {children}
    </svg>
  );
});
