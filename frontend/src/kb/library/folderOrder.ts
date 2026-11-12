import type { KbFolder } from '../../api/kb/types.gen';

export function orderedFolders(folders: readonly KbFolder[]): KbFolder[] {
  const rank = (folder: KbFolder) => folder.id === 'fld-inbox' ? 0 : folder.id === 'fld-explore' ? 1 : folder.system ? 2 : 3;
  return [...folders].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}
