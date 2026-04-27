import assert from 'node:assert/strict';

import { buildRefreshTokenCookieOptions } from './cookie';
import {
  createAccessToken,
  createRefreshToken,
  decodeAccessToken,
  decodeRefreshToken,
} from './token.service';
import { hashPassword, hashToken, verifyPassword } from '../utils/hash';

async function main(): Promise<void> {
  const plainPassword = 'S3cureP@ssword!';
  const passwordHash = await hashPassword(plainPassword);

  assert.notEqual(passwordHash, plainPassword);
  assert.ok(await verifyPassword(plainPassword, passwordHash));
  assert.equal(await verifyPassword('wrong-password', passwordHash), false);

  const tokenHash = hashToken('refresh-token-value');
  assert.equal(tokenHash.length, 64);
  assert.match(tokenHash, /^[a-f0-9]{64}$/);
  assert.equal(tokenHash, hashToken('refresh-token-value'));

  const authConfig = {
    accessTokenSecret: 'access-secret-value-that-is-long-enough',
    refreshTokenSecret: 'refresh-secret-value-that-is-long-enough',
    accessTokenExpiresIn: '15m',
    refreshTokenExpiresIn: '7d',
    cookieDomain: undefined,
    isProduction: false,
  };
  const payload = {
    sub: '42',
    username: 'reader',
    email: 'reader@example.com',
  };

  const accessToken = createAccessToken(payload, authConfig);
  const refreshToken = createRefreshToken({ sub: payload.sub }, authConfig);
  const decodedAccessToken = decodeAccessToken(accessToken, authConfig);
  const decodedRefreshToken = decodeRefreshToken(refreshToken, authConfig);

  assert.equal(decodedAccessToken.sub, payload.sub);
  assert.equal(decodedAccessToken.username, payload.username);
  assert.equal(decodedAccessToken.email, payload.email);
  assert.equal(decodedAccessToken.type, 'access');
  assert.equal(decodedRefreshToken.sub, payload.sub);
  assert.equal(typeof decodedRefreshToken.jti, 'string');
  assert.ok(decodedRefreshToken.jti.length > 0);
  assert.equal(decodedRefreshToken.type, 'refresh');
  assert.throws(() => decodeAccessToken(refreshToken, authConfig));
  assert.throws(() =>
    decodeRefreshToken(refreshToken, {
      ...authConfig,
      refreshTokenSecret: 'different-refresh-secret-value-that-is-long-enough',
    })
  );

  const refreshCookie = buildRefreshTokenCookieOptions(authConfig);

  assert.equal(refreshCookie.httpOnly, true);
  assert.equal(refreshCookie.sameSite, 'lax');
  assert.equal(refreshCookie.secure, false);
  assert.equal(refreshCookie.path, '/api/auth');
  assert.equal(refreshCookie.domain, undefined);
  assert.equal(refreshCookie.maxAge, 7 * 24 * 60 * 60 * 1000);

  const secureRefreshCookie = buildRefreshTokenCookieOptions({
    ...authConfig,
    isProduction: true,
  });

  assert.equal(secureRefreshCookie.secure, true);
  assert.throws(() =>
    buildRefreshTokenCookieOptions({
      ...authConfig,
      refreshTokenExpiresIn: '1 week',
    })
  );

  process.env.DATABASE_URL = 'mysql://ohif_user:CHANGE_ME@127.0.0.1:3306/ohif_auth';
  process.env.JWT_ACCESS_SECRET = authConfig.accessTokenSecret;
  process.env.JWT_REFRESH_SECRET = authConfig.refreshTokenSecret;
  process.env.JWT_ACCESS_EXPIRES = authConfig.accessTokenExpiresIn;
  process.env.JWT_REFRESH_EXPIRES = authConfig.refreshTokenExpiresIn;
  const { env } = await import('../config/env');
  const { prisma } = await import('../db/prisma');

  assert.equal(env.databaseUrl, process.env.DATABASE_URL);
  assert.equal(env.auth.accessTokenExpiresIn, authConfig.accessTokenExpiresIn);
  assert.equal(typeof prisma.$disconnect, 'function');

  console.log('auth hashing, token, and cookie utilities work');
}

void main();
