import type { CookieOptions } from 'express';

import type { AuthConfig } from '../config/env';

export const REFRESH_COOKIE_NAME = 'ohif_refresh_token';
const REFRESH_COOKIE_PATH = '/api/auth';
const DURATION_PATTERN = /^(\d+)([smhd])?$/;
const DURATION_MULTIPLIERS = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
} as const;

function parseDurationToMs(duration: string): number {
  const normalizedDuration = duration.trim().toLowerCase();
  const match = DURATION_PATTERN.exec(normalizedDuration);

  if (!match) {
    throw new Error(
      'Token expiration must be an integer number of seconds or use one of: s, m, h, d.'
    );
  }

  const amount = Number.parseInt(match[1], 10);
  const unit = (match[2] ?? 's') as keyof typeof DURATION_MULTIPLIERS;

  return amount * DURATION_MULTIPLIERS[unit];
}

export function buildRefreshTokenCookieOptions(authConfig: AuthConfig): CookieOptions {
  return {
    httpOnly: true,
    secure: authConfig.isProduction,
    sameSite: 'lax',
    domain: authConfig.cookieDomain,
    path: REFRESH_COOKIE_PATH,
    maxAge: parseDurationToMs(authConfig.refreshTokenExpiresIn),
  };
}
