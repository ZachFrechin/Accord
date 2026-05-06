import type { Session } from '@supabase/supabase-js';
import type { MessageRecord } from '@discord2/shared';
import { env } from './env';

export class ApiClient {
  constructor(private readonly session: Session) {}

  async me(): Promise<{ id: string; email: string | null }> {
    return this.request('/users/me');
  }

  async listMessages(channelId: string): Promise<MessageRecord[]> {
    return this.request(`/channels/${channelId}/messages`);
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${env.VITE_API_URL}${path}`, {
      ...init,
      headers: {
        ...init.headers,
        Authorization: `Bearer ${this.session.access_token}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`API request failed with ${response.status}`);
    }

    return (await response.json()) as T;
  }
}
