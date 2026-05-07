import { useState } from 'react';
import type { InstanceConfig } from '@discord2/shared';
import { Server, Plus } from 'lucide-react';
import { discoverInstance } from '../../lib/instances';

interface InstanceSetupProps {
  instances: InstanceConfig[];
  activeInstanceId: string | null;
  onAddInstance: (instance: InstanceConfig) => void;
  onSelectInstance: (instanceId: string) => void;
}

export function InstanceSetup({
  instances,
  activeInstanceId,
  onAddInstance,
  onSelectInstance,
}: InstanceSetupProps): React.JSX.Element {
  const [apiUrl, setApiUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);
    try {
      onAddInstance(await discoverInstance(apiUrl));
      setApiUrl('');
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Instance invalide.');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="auth-screen">
      <section className="auth-panel instance-panel">
        <div className="auth-mark">
          <Server size={24} />
        </div>
        <h1>Choisir une instance</h1>
        <p>Ajoute l’URL API publique de ton serveur Accord self-hosted.</p>
        {instances.length > 0 ? (
          <div className="instance-list">
            {instances.map((instance) => (
              <button
                className="instance-option"
                data-active={instance.instanceId === activeInstanceId}
                key={instance.instanceId}
                type="button"
                onClick={() => onSelectInstance(instance.instanceId)}
              >
                <strong>{instance.instanceName}</strong>
                <span>{instance.apiUrl}</span>
              </button>
            ))}
          </div>
        ) : null}
        <form className="auth-form" onSubmit={(event) => void submit(event)}>
          <label>
            URL API
            <input
              value={apiUrl}
              onChange={(event) => setApiUrl(event.target.value)}
              type="url"
              placeholder="https://api.example.com"
            />
          </label>
          {error ? <div className="form-error">{error}</div> : null}
          <button type="submit" disabled={isSubmitting || !apiUrl.trim()}>
            <Plus size={16} />
            {isSubmitting ? 'Vérification...' : 'Ajouter l’instance'}
          </button>
        </form>
      </section>
    </main>
  );
}
