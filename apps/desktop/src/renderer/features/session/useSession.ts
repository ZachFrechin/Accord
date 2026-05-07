import { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import type { SupabaseBrowserClient } from '../../lib/supabase';

export function useSession(supabase: SupabaseBrowserClient | null): Session | null {
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    setSession(null);
    if (!supabase) {
      return;
    }

    void supabase.auth.getSession().then(({ data }) => setSession(data.session));

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_, nextSession) => setSession(nextSession));

    return () => subscription.unsubscribe();
  }, [supabase]);

  return session;
}
