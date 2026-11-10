// The API clients of the 0.4.0 marks on a material and in the library (F5). In the app they come from the
// services' client; a test (or a preview) may pass its own, e.g. `createFakeKb(scene)`, through
// MarksClientsProvider. Same pattern as FindingClientsProvider.
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { createAreasClient, type AreasClient } from '../api/areas';
import { createFreshnessClient, type FreshnessClient } from '../api/freshness';
import { createMaintenanceClient, type MaintenanceClient } from '../api/maintenance';
import { createRepeatsClient, type RepeatsClient } from '../api/repeats';
import { useServices } from '../state/context';

export interface MarksClients {
  repeats: RepeatsClient;
  areas: AreasClient;
  maintenance: MaintenanceClient;
  freshness: FreshnessClient;
}

const Override = createContext<Partial<MarksClients> | null>(null);

export function MarksClientsProvider({ clients, children }: { clients: Partial<MarksClients>; children: ReactNode }) {
  return <Override.Provider value={clients}>{children}</Override.Provider>;
}

export function useMarksClients(): MarksClients {
  const override = useContext(Override);
  const { client } = useServices();
  return useMemo(() => ({
    repeats: override?.repeats ?? createRepeatsClient(client),
    areas: override?.areas ?? createAreasClient(client),
    maintenance: override?.maintenance ?? createMaintenanceClient(client),
    freshness: override?.freshness ?? createFreshnessClient(client),
  }), [override, client]);
}
