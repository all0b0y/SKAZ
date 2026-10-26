import type { KbHierarchyBlock, KbHierarchyNode } from '../../../api/kb/types.gen';
import { BlockItem } from './hover';
import type { BlockItemData } from './sources';

interface TreeNode { node: KbHierarchyNode; children: TreeNode[] }

/** The flat list (reading order + depth) as a tree: each node goes under the last shallower one. */
export function hierarchyTree(nodes: readonly KbHierarchyNode[]): TreeNode[] {
  const roots: TreeNode[] = [];
  const path: TreeNode[] = [];
  for (const node of nodes) {
    const entry: TreeNode = { node, children: [] };
    path.length = Math.min(path.length, node.depth);
    (path.at(-1)?.children ?? roots).push(entry);
    path.push(entry);
  }
  return roots;
}

function Branch({ entries, top }: { entries: TreeNode[]; top: boolean }) {
  return (
    <ul className={top ? 'kb-blk-tree' : 'kb-blk-tree__sub'}>
      {entries.map(({ node, children }) => (
        <li key={node.id}>
          <BlockItem item={node} className={`kb-blk-tree__node${top ? ' kb-blk-tree__node--root' : ''}`}>
            {node.text}
            {node.note && <span className="kb-blk-tree__note"> — {node.note}</span>}
          </BlockItem>
          {children.length > 0 && <Branch entries={children} top={false} />}
        </li>
      ))}
    </ul>
  );
}

/** hierarchy: a tree; the top nodes and the lines take the accent (R3). */
export function HierarchyBlock({ block }: { block: KbHierarchyBlock }) {
  return <Branch entries={hierarchyTree(block.nodes)} top />;
}

export const hierarchyItems = (block: KbHierarchyBlock): BlockItemData[] => block.nodes;
