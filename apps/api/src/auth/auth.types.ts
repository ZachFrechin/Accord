import type { Request } from 'express';
import type { AuthUser } from '@discord2/shared';

export interface AuthenticatedRequest extends Request {
  user: AuthUser;
  accessToken: string;
}
