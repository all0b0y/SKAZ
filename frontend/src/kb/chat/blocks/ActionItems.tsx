import type { KbActionItem, KbActionItemsBlock } from '../../../api/kb/types.gen';
import { Calendar } from './glyphs';
import { BlockItem } from './hover';
import type { BlockItemData } from './sources';

/** Up to two initials of a name («Anna Kim» → «AK»). */
export function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((word) => Array.from(word)[0]!.toUpperCase()).join('');
}

function Owner({ task }: { task: KbActionItem }) {
  if (task.owner_is_you) {
    return <span className="kb-blk-ai__who"><span className="kb-blk-ai__ava kb-blk-ai__ava--you" aria-hidden="true" />You</span>;
  }
  if (!task.owner) {
    return <span className="kb-blk-ai__who kb-blk-ai__none"><span className="kb-blk-ai__ava kb-blk-ai__ava--none" aria-hidden="true" />Owner not named</span>;
  }
  return (
    <span className="kb-blk-ai__who">
      <span className="kb-blk-ai__ava" aria-hidden="true">{initials(task.owner)}</span>{task.owner}
    </span>
  );
}

/**
 * action_items: one column (R5) — the task, and under it a quiet line with who (an avatar; «You»
 * in the accent) and when. Where in the recording it was said is in the hover label (R2).
 */
export function ActionItemsBlock({ block }: { block: KbActionItemsBlock }) {
  return (
    <ul className="kb-blk-ai">
      {block.tasks.map((task) => (
        <BlockItem key={task.id} item={task} as="li">
          <span className="kb-blk-ai__box" aria-hidden="true" />
          <div className="kb-blk-ai__main">
            <div className="kb-blk-ai__task">{task.task}</div>
            <div className="kb-blk-ai__meta">
              <Owner task={task} />
              {task.due
                ? <span className="kb-blk-ai__due"><Calendar />{task.due}</span>
                : <span className="kb-blk-ai__due kb-blk-ai__none">No due date</span>}
            </div>
          </div>
        </BlockItem>
      ))}
    </ul>
  );
}

export const actionItemsItems = (block: KbActionItemsBlock): BlockItemData[] => block.tasks;
