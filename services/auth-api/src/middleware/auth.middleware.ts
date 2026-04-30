import type { NextFunction, Request, Response } from 'express';

import { env } from '../config/env';
import { decodeAccessToken } from '../auth/token.service';
import { HttpError } from '../utils/http-error';

export function requireAuth(request: Request, _response: Response, next: NextFunction): void {
  const authorization = request.get('authorization');

  if (!authorization?.startsWith('Bearer ')) {
    throw new HttpError(401, 'UNAUTHENTICATED', 'Authorization header required.');
  }

  try {
    const token = authorization.slice('Bearer '.length).trim();
    const decoded = decodeAccessToken(token, env.auth);
    (request as any).user = { id: decoded.sub, username: decoded.username, email: decoded.email };
    next();
  } catch {
    throw new HttpError(401, 'UNAUTHENTICATED', 'Invalid or expired token.');
  }
}
