import { useEffect } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { AuthScreen } from '../features/auth/AuthScreen';
import { useSession } from '../features/session/useSession';
import { queryClient } from '../app/query-client';
import { Workspace } from '../layout/Workspace';
import { useUiStore } from '../store/ui-store';

export function App(): React.JSX.Element {
  const session = useSession();
  const theme = useUiStore((s) => s.theme);

  useEffect(() => {
    document.body.setAttribute('data-theme', theme);
  }, [theme]);

  return (
    <QueryClientProvider client={queryClient}>
      {session ? <Workspace session={session} /> : <AuthScreen />}
    </QueryClientProvider>
  );
}
