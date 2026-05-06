import { QueryClientProvider } from '@tanstack/react-query';
import { AuthScreen } from '../features/auth/AuthScreen';
import { useSession } from '../features/session/useSession';
import { queryClient } from '../app/query-client';
import { Workspace } from '../layout/Workspace';

export function App(): React.JSX.Element {
  const session = useSession();

  return (
    <QueryClientProvider client={queryClient}>
      {session ? <Workspace session={session} /> : <AuthScreen />}
    </QueryClientProvider>
  );
}
