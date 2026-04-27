import { randomUUID } from 'node:crypto';

import jwt, { type JwtPayload, type SignOptions } from 'jsonwebtoken';

import type { AuthConfig } from '../config/env';

type TokenType = 'access' | 'refresh';

export type AccessTokenPayload = {
  sub: string;
  username: string;
  email: string;
};

export type RefreshTokenPayload = {
  sub: string;
  jti: string;
};

export type DecodedAccessToken = JwtPayload &
  AccessTokenPayload & {
    type: 'access';
  };

export type DecodedRefreshToken = JwtPayload &
  RefreshTokenPayload & {
    type: 'refresh';
  };

function signToken(
  payload: AccessTokenPayload | RefreshTokenPayload,
  secret: string,
  expiresIn: AuthConfig['accessTokenExpiresIn'],
  type: TokenType
): string {
  const signOptions: SignOptions = {
    algorithm: 'HS256',
    expiresIn: expiresIn as SignOptions['expiresIn'],
  };

  return jwt.sign({ ...payload, type }, secret, signOptions);
}

function verifyToken(
  token: string,
  secret: string,
  expectedType: TokenType
): DecodedAccessToken | DecodedRefreshToken {
  const decoded = jwt.verify(token, secret) as DecodedAccessToken | DecodedRefreshToken;

  if (decoded.type !== expectedType) {
    throw new Error(`Expected a ${expectedType} token.`);
  }

  return decoded;
}

export function createAccessToken(payload: AccessTokenPayload, authConfig: AuthConfig): string {
  return signToken(payload, authConfig.accessTokenSecret, authConfig.accessTokenExpiresIn, 'access');
}

export function createRefreshToken(
  payload: Pick<RefreshTokenPayload, 'sub'>,
  authConfig: AuthConfig
): string {
  return signToken(
    {
      ...payload,
      jti: randomUUID(),
    },
    authConfig.refreshTokenSecret,
    authConfig.refreshTokenExpiresIn,
    'refresh'
  );
}

export function decodeAccessToken(token: string, authConfig: AuthConfig): DecodedAccessToken {
  return verifyToken(token, authConfig.accessTokenSecret, 'access') as DecodedAccessToken;
}

export function decodeRefreshToken(token: string, authConfig: AuthConfig): DecodedRefreshToken {
  return verifyToken(token, authConfig.refreshTokenSecret, 'refresh') as DecodedRefreshToken;
}
