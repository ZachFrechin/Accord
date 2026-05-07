import { useEffect, useMemo, useState } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { AuthScreen } from '../features/auth/AuthScreen';
import { InstanceSetup } from '../features/instances/InstanceSetup';
import { useSession } from '../features/session/useSession';
import { queryClient } from '../app/query-client';
import { Workspace } from '../layout/Workspace';
import { createSupabaseClient } from '../lib/supabase';
import { loadSavedInstances, saveInstance, setActiveInstance } from '../lib/instances';
import { useUiStore } from '../store/ui-store';

export function App(): React.JSX.Element {
  const theme = useUiStore((s) => s.theme);
  const [instancesState, setInstancesState] = useState(loadSavedInstances);
  const [isSelectingInstance, setIsSelectingInstance] = useState(
    () => instancesState.activeInstanceId === null,
  );
  const activeInstance =
    instancesState.instances.find(
      (instance) => instance.instanceId === instancesState.activeInstanceId,
    ) ?? null;
  const supabase = useMemo(
    () => (activeInstance ? createSupabaseClient(activeInstance) : null),
    [activeInstance],
  );
  const session = useSession(supabase);

  useEffect(() => {
    document.body.setAttribute('data-theme', theme);
  }, [theme]);

  return (
    <QueryClientProvider client={queryClient}>
      {!activeInstance || isSelectingInstance ? (
        <InstanceSetup
          instances={instancesState.instances}
          activeInstanceId={instancesState.activeInstanceId}
          onAddInstance={(instance) => {
            queryClient.clear();
            setInstancesState(saveInstance(instance));
            setIsSelectingInstance(false);
          }}
          onSelectInstance={(instanceId) => {
            queryClient.clear();
            setInstancesState(setActiveInstance(instanceId));
            setIsSelectingInstance(false);
          }}
        />
      ) : session && supabase ? (
        <Workspace session={session} instance={activeInstance} supabase={supabase} />
      ) : supabase ? (
        <AuthScreen
          instance={activeInstance}
          supabase={supabase}
          instances={instancesState.instances}
          onChangeInstance={() => setIsSelectingInstance(true)}
          onSelectInstance={(instanceId) => {
            queryClient.clear();
            setInstancesState(setActiveInstance(instanceId));
          }}
        />
      ) : null}
    </QueryClientProvider>
  );
}
