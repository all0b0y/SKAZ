import { useEffect, useState } from 'react';
import type { KbDiscussFinding } from '../../api/kb/types.gen';
import { createExploreClient, type ExploreClient } from '../api/explore';
import { errorText } from '../api/client';
import { useOptionalServices } from '../state/context';
import { Button, Icon } from '../ui';

export interface DiscussPaperBarProps {
  finding: KbDiscussFinding;
  explore?: ExploreClient;
  onAdded?: (materialId: string | null) => void;
  onOpenMaterial?: (materialId: string) => void;
  onNotice?: (text: string) => void;
}

export function DiscussPaperBar({
  finding,
  explore: givenExplore,
  onAdded,
  onNotice,
}: DiscussPaperBarProps) {
  const services = useOptionalServices();
  const [materialId, setMaterialId] = useState<string | null>(finding.material_id ?? null);
  const [busy, setBusy] = useState<boolean>(Boolean(finding.importing));

  useEffect(() => {
    setMaterialId(finding.material_id ?? null);
    setBusy(Boolean(finding.importing));
  }, [finding.finding_id, finding.material_id, finding.importing]);

  if (materialId) return null;

  const add = async () => {
    const client = givenExplore ?? (services ? createExploreClient(services.client) : null);
    if (!client || busy) return;
    setBusy(true);
    try {
      const res = await client.add_to_materials(finding.finding_id);
      const nextId = res.material_id ?? null;
      setMaterialId(nextId);
      if (nextId && services) {
        services.composer.getState().push(
          [{ kind: 'mention', ref: { type: 'material', id: nextId, title: finding.title } }],
          { focus: true },
        );
      }
      onAdded?.(nextId);
    } catch (error) {
      onNotice?.(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="kb-discuss-bar" role="region" aria-label="Discussed paper">
      <Icon name="materials" size={14} className="kb-discuss-bar__icon" />
      <div className="kb-discuss-bar__text">
        <span className="kb-discuss-bar__label">
          Discussing card: <strong className="kb-discuss-bar__title">{finding.title}</strong>
        </span>
        <span className="kb-discuss-bar__note">
          (abstract only · add to materials for full text)
        </span>
      </div>
      <Button
        size="sm"
        variant="fill"
        icon="plus"
        busy={busy}
        disabled={busy}
        onClick={() => void add()}
      >
        {busy ? 'Importing…' : 'Add to materials'}
      </Button>
    </div>
  );
}
