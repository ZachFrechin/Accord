import { useState } from 'react';
import { MessageSquare } from 'lucide-react';
import type { InstanceConfig } from '@discord2/shared';
import type { SupabaseBrowserClient } from '../../lib/supabase';

interface AuthScreenProps {
  instance: InstanceConfig;
  supabase: SupabaseBrowserClient;
  instances: InstanceConfig[];
  onChangeInstance: () => void;
  onSelectInstance: (instanceId: string) => void;
}

export function AuthScreen({
  instance,
  supabase,
  instances,
  onChangeInstance,
  onSelectInstance,
}: AuthScreenProps): React.JSX.Element {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function signIn(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    const { error: authError } = await supabase.auth.signInWithPassword({ email, password });
    if (authError) {
      setError(authError.message);
    }

    setIsSubmitting(false);
  }

  return (
    <main className="auth-screen">
      <section className="auth-panel">
        <div className="auth-mark">
          <MessageSquare size={24} />
        </div>
        <h1>Discord2</h1>
        <div className="auth-instance-line">
          <span>{instance.instanceName}</span>
          <button type="button" onClick={onChangeInstance}>
            Changer
          </button>
        </div>
        {instances.length > 1 ? (
          <select
            className="instance-select"
            value={instance.instanceId}
            onChange={(event) => onSelectInstance(event.target.value)}
          >
            {instances.map((candidate) => (
              <option key={candidate.instanceId} value={candidate.instanceId}>
                {candidate.instanceName}
              </option>
            ))}
          </select>
        ) : null}
        <p>Connecte-toi avec le compte créé dans Supabase pour accéder à ton espace.</p>
        <form className="auth-form" onSubmit={(event) => void signIn(event)}>
          <label>
            Email
            <input
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              type="email"
              autoComplete="email"
            />
          </label>
          <label>
            Mot de passe
            <input
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              type="password"
              autoComplete="current-password"
            />
          </label>
          {error ? <div className="form-error">{error}</div> : null}
          <button type="submit" disabled={isSubmitting}>
            {isSubmitting ? 'Connexion...' : 'Se connecter'}
          </button>
        </form>
      </section>
    </main>
  );
}
