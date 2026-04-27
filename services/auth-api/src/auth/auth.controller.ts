import type { NextFunction, Request, Response } from 'express';

import { env } from '../config/env';
import {
  buildClearRefreshTokenCookieOptions,
  buildRefreshTokenCookieOptions,
  REFRESH_COOKIE_NAME,
} from './cookie';
import { createAuthService } from './auth.service';
import type { AuthService } from './auth.types';
import { validateLoginInput, validateRegisterInput } from './auth.validators';
import { HttpError } from '../utils/http-error';

function getRequestIp(request: Request): string | undefined {
  const forwardedFor = request.headers['x-forwarded-for'];

  if (typeof forwardedFor === 'string') {
    return forwardedFor.split(',')[0]?.trim();
  }

  return request.ip || request.socket.remoteAddress || undefined;
}

function getBearerToken(request: Request): string {
  const authorization = request.get('authorization');

  if (!authorization?.startsWith('Bearer ')) {
    throw new HttpError(401, 'UNAUTHENTICATED', 'Authorization bearer token is required.');
  }

  const token = authorization.slice('Bearer '.length).trim();

  if (!token) {
    throw new HttpError(401, 'UNAUTHENTICATED', 'Authorization bearer token is required.');
  }

  return token;
}

function getCookieValue(request: Request, cookieName: string): string {
  const cookieHeader = request.get('cookie') ?? '';
  const cookieParts = cookieHeader.split(';').map(part => part.trim());
  const cookiePrefix = `${cookieName}=`;
  const cookie = cookieParts.find(part => part.startsWith(cookiePrefix));

  if (!cookie) {
    throw new HttpError(401, 'INVALID_REFRESH_TOKEN', 'Refresh token cookie is required.');
  }

  return decodeURIComponent(cookie.slice(cookiePrefix.length));
}

export function createAuthController(authService: AuthService = createAuthService()) {
  return {
    register: async (request: Request, response: Response, next: NextFunction) => {
      try {
        const input = validateRegisterInput(request.body);
        const user = await authService.register(input);

        response.status(201).json({ user });
      } catch (error) {
        next(error);
      }
    },

    login: async (request: Request, response: Response, next: NextFunction) => {
      try {
        const input = validateLoginInput(request.body);
        const result = await authService.login({
          ...input,
          userAgent: request.get('user-agent'),
          ipAddress: getRequestIp(request),
        });

        response.cookie(
          REFRESH_COOKIE_NAME,
          result.refreshToken,
          buildRefreshTokenCookieOptions(env.auth)
        );
        response.status(200).json({
          accessToken: result.accessToken,
          user: result.user,
        });
      } catch (error) {
        next(error);
      }
    },

    me: async (request: Request, response: Response, next: NextFunction) => {
      try {
        const user = await authService.getCurrentUser(getBearerToken(request));

        response.status(200).json({ user });
      } catch (error) {
        next(error);
      }
    },

    refresh: async (request: Request, response: Response, next: NextFunction) => {
      try {
        const result = await authService.refreshSession(getCookieValue(request, REFRESH_COOKIE_NAME), {
          userAgent: request.get('user-agent'),
          ipAddress: getRequestIp(request),
        });

        response.cookie(
          REFRESH_COOKIE_NAME,
          result.refreshToken,
          buildRefreshTokenCookieOptions(env.auth)
        );
        response.status(200).json({
          accessToken: result.accessToken,
          user: result.user,
        });
      } catch (error) {
        next(error);
      }
    },

    logout: async (request: Request, response: Response, next: NextFunction) => {
      try {
        const refreshToken = getCookieValue(request, REFRESH_COOKIE_NAME);

        await authService.logout(refreshToken);
        response.cookie(
          REFRESH_COOKIE_NAME,
          '',
          {
            ...buildClearRefreshTokenCookieOptions(env.auth),
            maxAge: 0,
          }
        );
        response.status(204).send();
      } catch (error) {
        next(error);
      }
    },
  };
}
