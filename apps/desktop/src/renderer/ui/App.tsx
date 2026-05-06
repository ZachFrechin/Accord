import { useEffect, useMemo, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { generateConversationKey, encryptMessage, decryptMessage } from '@discord2/e2ee';
import { ApiClient } from '../lib/api';
import { isSecureStorageAvailable } from '../lib/desktop';
import { createRealtimeSocket } from '../lib/realtime';
import { supabase } from '../lib/supabase';

export function App(): React.JSX.Element {
  const [session, setSession] = useState<Session | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState('Disconnected');
  const [secureStorage, setSecureStorage] = useState<boolean | null>(null);
  const api = useMemo(() => (session ? new ApiClient(session) : null), [session]);

  useEffect(() => {
    void isSecureStorageAvailable().then(setSecureStorage);
    void supabase.auth.getSession().then(({ data }) => setSession(data.session));

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_, nextSession) => setSession(nextSession));

    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) {
      setStatus('Disconnected');
      return;
    }

    const socket = createRealtimeSocket(session.access_token);
    socket.on('connect', () => setStatus('Realtime connected'));
    socket.on('disconnect', () => setStatus('Realtime disconnected'));

    return () => {
      socket.disconnect();
    };
  }, [session]);

  async function signIn(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      setStatus(error.message);
    }
  }

  async function runE2eeSelfCheck(): Promise<void> {
    const key = await generateConversationKey();
    const encrypted = await encryptMessage('local only', key, 'desktop-device');
    const decrypted = await decryptMessage(encrypted, key);
    setStatus(`E2EE self-check: ${decrypted === 'local only' ? 'ok' : 'failed'}`);
  }

  return (
    <main className="app-shell">
      <aside className="server-rail" aria-label="Servers">
        <div className="server-dot active">D2</div>
      </aside>
      <section className="sidebar">
        <div>
          <p className="eyebrow">Self-hosted</p>
          <h1>Discord2</h1>
        </div>
        <nav className="channel-list" aria-label="Channels">
          <button className="channel active" type="button">
            # general
          </button>
          <button className="channel" type="button">
            # private-e2ee
          </button>
          <button className="channel" type="button">
            voice-room
          </button>
        </nav>
      </section>
      <section className="content">
        <header className="topbar">
          <strong># general</strong>
          <span>{status}</span>
        </header>
        <div className="message-pane">
          {session ? (
            <div className="panel">
              <h2>Session active</h2>
              <p>{session.user.email}</p>
              <div className="actions">
                <button
                  type="button"
                  onClick={() => void api?.me().then(() => setStatus('API ok'))}
                >
                  Check API
                </button>
                <button type="button" onClick={() => void runE2eeSelfCheck()}>
                  E2EE check
                </button>
                <button type="button" onClick={() => void supabase.auth.signOut()}>
                  Logout
                </button>
              </div>
            </div>
          ) : (
            <form className="panel auth-form" onSubmit={(event) => void signIn(event)}>
              <h2>Login</h2>
              <label>
                Email
                <input
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  type="email"
                />
              </label>
              <label>
                Password
                <input
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  type="password"
                />
              </label>
              <button type="submit">Sign in</button>
            </form>
          )}
        </div>
        <footer className="composer">
          <input disabled placeholder="Message composer scaffold" />
          <span>
            Secure storage: {secureStorage === null ? 'checking' : secureStorage ? 'yes' : 'no'}
          </span>
        </footer>
      </section>
    </main>
  );
}
