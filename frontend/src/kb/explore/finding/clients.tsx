// The API clients of the finding view. In the app they come from the services' client; a test (or a
// preview) may pass its own, e.g. `createFakeKb(scene)`, through FindingClientsProvider.
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { createAreasClient, type AreasClient } from '../../api/areas';
import { createExploreClient, type ExploreClient } from '../../api/explore';
import { createScienceClient, type ScienceClient } from '../../api/science';
import { useServices } from '../../state/context';

export interface FindingClients {
  explore: ExploreClient;
  areas: AreasClient;
  science: ScienceClient;
}

const Override = createContext<Partial<FindingClients> | null>(null);

export function FindingClientsProvider({ clients, children }: { clients: Partial<FindingClients>; children: ReactNode }) {
  return <Override.Provider value={clients}>{children}</Override.Provider>;
}

export function useFindingClients(): FindingClients {
  const override = useContext(Override);
  const { client } = useServices();
  return useMemo(() => ({
    explore: override?.explore ?? createExploreClient(client),
    areas: override?.areas ?? createAreasClient(client),
    science: override?.science ?? createScienceClient(client),
  }), [override, client]);
}
