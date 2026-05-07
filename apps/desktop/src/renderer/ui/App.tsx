import { useEffect, useMemo, useState } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { AuthScreen } from '../features/auth/AuthScreen';
import { InstanceSetup } from '../features/instances/InstanceSetup';
import { useSession } from '../features/session/useSession';
import { queryClient } from '../app/query-client';
import { Workspace } from '../layout/Workspace';
import { createSupabaseClient } from '../lib/supabase';
import { loadSavedInstances, saveInstance, setActiveInstance } from '../lib/instances';
import { ApiClient } from '../lib/api-client';
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
  const [validatedSession, setValidatedSession] = useState<typeof session>(null);
  const [authError, setAuthError] = useState<string | null>(null);

  useEffect(() => {
    document.body.setAttribute('data-theme', theme);
  }, [theme]);

  useEffect(() => {
    let cancelled = false;
    setValidatedSession(null);
    setAuthError(null);

    if (!session || !activeInstance || !supabase) {
      return;
    }

    const api = new ApiClient(session, activeInstance);
    api.users
      .me()
      .then(() => {
        if (!cancelled) setValidatedSession(session);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setValidatedSession(null);
        setAuthError(
          error instanceof Error
            ? error.message
            : 'Session refusée par cette instance. Reconnecte-toi.',
        );
        void supabase.auth.signOut();
      });

    return () => {
      cancelled = true;
    };
  }, [activeInstance, session, supabase]);

  return (
    <QueryClientProvider client={queryClient}>
      {!activeInstance || isSelectingInstance ? (
        <InstanceSetup
          instances={instancesState.instances}
          activeInstanceId={instancesState.activeInstanceId}
          onAddInstance={(instance) => {
            queryClient.clear();
            setAuthError(null);
            setInstancesState(saveInstance(instance));
            setIsSelectingInstance(false);
          }}
          onSelectInstance={(instanceId) => {
            queryClient.clear();
            setAuthError(null);
            setInstancesState(setActiveInstance(instanceId));
            setIsSelectingInstance(false);
          }}
        />
      ) : validatedSession && supabase ? (
        <Workspace session={validatedSession} instance={activeInstance} supabase={supabase} />
      ) : supabase ? (
        <AuthScreen
          instance={activeInstance}
          supabase={supabase}
          instances={instancesState.instances}
          onChangeInstance={() => setIsSelectingInstance(true)}
          onSelectInstance={(instanceId) => {
            queryClient.clear();
            setAuthError(null);
            setInstancesState(setActiveInstance(instanceId));
          }}
          externalError={authError}
        />
      ) : null}
    </QueryClientProvider>
  );
}
