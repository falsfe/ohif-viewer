import type { Prisma, PrismaClient, RefreshToken, User } from '@prisma/client';

import { env } from '../config/env';
import { prisma } from '../db/prisma';
import { hashPassword, hashToken, verifyPassword } from '../utils/hash';
import { HttpError } from '../utils/http-error';
import {
  createAccessToken,
  createRefreshToken,
  decodeAccessToken,
  decodeRefreshToken,
} from './token.service';
import type {
  AuthService,
  AuthServiceDependencies,
  AuthTransactionClient,
  AuthUser,
  LoginInput,
  LoginResult,
  RegisterInput,
} from './auth.types';

type AuthModelClient = Pick<PrismaClient, 'user' | 'refreshToken'> | AuthTransactionClient;
type AuthPrismaClient = Pick<PrismaClient, 'user' | 'refreshToken' | '$transaction'>;

type RegisterableUser = Pick<
  User,
  'id' | 'username' | 'email' | 'status' | 'lastLoginAt' | 'createdAt' | 'updatedAt'
>;

function toAuthUser(user: RegisterableUser): AuthUser {
  return {
    id: user.id.toString(),
    username: user.username,
    email: user.email,
    status: user.status,
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}

function normalizeLoginIdentity(usernameOrEmail: string): string {
  const normalized = usernameOrEmail.trim();

  return normalized.includes('@') ? normalized.toLowerCase() : normalized;
}

async function assertUniqueUser(prismaClient: AuthModelClient, input: RegisterInput): Promise<void> {
  const existingUser = await prismaClient.user.findFirst({
    where: {
      OR: [{ username: input.username }, { email: input.email }],
    },
  });

  if (!existingUser) {
    return;
  }

  if (existingUser.username === input.username) {
    throw new HttpError(409, 'USERNAME_TAKEN', 'Username is already in use.');
  }

  throw new HttpError(409, 'EMAIL_TAKEN', 'Email is already in use.');
}

async function createRefreshTokenRecord(
  prismaClient: AuthModelClient,
  userId: bigint,
  refreshToken: string,
  expiresAt: Date,
  metadata: Pick<LoginInput, 'ipAddress' | 'userAgent'>
): Promise<RefreshToken> {
  return prismaClient.refreshToken.create({
    data: {
      userId,
      tokenHash: hashToken(refreshToken),
      expiresAt,
      ipAddress: metadata.ipAddress,
      userAgent: metadata.userAgent,
    },
  });
}

async function createRegisterUser(prismaClient: AuthModelClient, input: RegisterInput): Promise<AuthUser> {
  await assertUniqueUser(prismaClient, input);

  const user = await prismaClient.user.create({
    data: {
      username: input.username,
      email: input.email,
      passwordHash: await hashPassword(input.password),
    },
  });

  return toAuthUser(user);
}

async function createLoginResult(
  prismaClient: AuthModelClient,
  input: LoginInput,
  authConfig: AuthServiceDependencies['authConfig']
) {
  const identity = normalizeLoginIdentity(input.usernameOrEmail);
  const user = await prismaClient.user.findFirst({
    where: {
      OR: [{ username: identity }, { email: identity }],
    },
  });

  if (!user || !(await verifyPassword(input.password, user.passwordHash))) {
    throw new HttpError(401, 'INVALID_CREDENTIALS', 'Invalid username/email or password.');
  }

  const userView = toAuthUser(user);
  const accessToken = createAccessToken(
    {
      sub: userView.id,
      username: userView.username,
      email: userView.email,
    },
    authConfig
  );
  const refreshToken = createRefreshToken(
    {
      sub: userView.id,
    },
    authConfig
  );
  const decodedRefreshToken = decodeRefreshToken(refreshToken, authConfig);

  if (!decodedRefreshToken.exp) {
    throw new HttpError(500, 'TOKEN_ISSUE_FAILED', 'Refresh token expiration was not generated.');
  }

  const lastLoginAt = new Date();

  await prismaClient.user.update({
    where: {
      id: user.id,
    },
    data: {
      lastLoginAt,
    },
  });

  await createRefreshTokenRecord(
    prismaClient,
    user.id,
    refreshToken,
    new Date(decodedRefreshToken.exp * 1000),
    input
  );

  return {
    user: {
      ...userView,
      lastLoginAt: lastLoginAt.toISOString(),
      updatedAt: lastLoginAt.toISOString(),
    },
    accessToken,
    refreshToken,
  };
}

function createTokensForUser(userView: AuthUser, authConfig: AuthServiceDependencies['authConfig']) {
  const accessToken = createAccessToken(
    {
      sub: userView.id,
      username: userView.username,
      email: userView.email,
    },
    authConfig
  );
  const refreshToken = createRefreshToken(
    {
      sub: userView.id,
    },
    authConfig
  );

  return {
    accessToken,
    refreshToken,
  };
}

function assertTokenCanBeUsed(errorCode: string, callback: () => void): void {
  try {
    callback();
  } catch (_error) {
    throw new HttpError(401, errorCode, 'Authentication token is invalid or expired.');
  }
}

async function findRefreshTokenRecord(
  prismaClient: AuthModelClient,
  refreshToken: string,
  authConfig: AuthServiceDependencies['authConfig']
) {
  let decodedRefreshToken: ReturnType<typeof decodeRefreshToken>;

  assertTokenCanBeUsed('INVALID_REFRESH_TOKEN', () => {
    decodedRefreshToken = decodeRefreshToken(refreshToken, authConfig);
  });

  const tokenRecord = await prismaClient.refreshToken.findUnique({
    where: {
      tokenHash: hashToken(refreshToken),
    },
    include: {
      user: true,
    },
  });

  if (
    !tokenRecord ||
    tokenRecord.revokedAt ||
    tokenRecord.expiresAt <= new Date() ||
    tokenRecord.user.id.toString() !== decodedRefreshToken!.sub
  ) {
    throw new HttpError(401, 'INVALID_REFRESH_TOKEN', 'Refresh token is invalid or expired.');
  }

  return tokenRecord;
}

async function createRefreshSessionResult(
  prismaClient: AuthModelClient,
  refreshToken: string,
  authConfig: AuthServiceDependencies['authConfig'],
  metadata: Pick<LoginInput, 'ipAddress' | 'userAgent'>
): Promise<LoginResult> {
  const tokenRecord = await findRefreshTokenRecord(prismaClient, refreshToken, authConfig);
  const userView = toAuthUser(tokenRecord.user);
  const tokens = createTokensForUser(userView, authConfig);
  const decodedRefreshToken = decodeRefreshToken(tokens.refreshToken, authConfig);

  if (!decodedRefreshToken.exp) {
    throw new HttpError(500, 'TOKEN_ISSUE_FAILED', 'Refresh token expiration was not generated.');
  }

  await prismaClient.refreshToken.update({
    where: {
      id: tokenRecord.id,
    },
    data: {
      revokedAt: new Date(),
    },
  });

  await createRefreshTokenRecord(
    prismaClient,
    tokenRecord.user.id,
    tokens.refreshToken,
    new Date(decodedRefreshToken.exp * 1000),
    metadata
  );

  return {
    user: userView,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
  };
}

function normalizePrismaError(error: unknown): never {
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: string }).code === 'P2002' &&
    'meta' in error
  ) {
    const target = (error as { meta?: { target?: string[] } }).meta?.target ?? [];

    if (target.includes('uq_users_username') || target.includes('username')) {
      throw new HttpError(409, 'USERNAME_TAKEN', 'Username is already in use.');
    }

    if (target.includes('uq_users_email') || target.includes('email')) {
      throw new HttpError(409, 'EMAIL_TAKEN', 'Email is already in use.');
    }
  }

  throw error;
}

export function createAuthService(
  dependencies: Partial<AuthServiceDependencies> = {}
): AuthService {
  const prismaClient = (dependencies.prisma as AuthPrismaClient | undefined) ?? prisma;
  const authConfig = dependencies.authConfig ?? env.auth;

  return {
    async register(input) {
      try {
        return await createRegisterUser(prismaClient, input);
      } catch (error) {
        normalizePrismaError(error);
      }
    },

    async login(input) {
      return prismaClient.$transaction(async (transactionClient: AuthTransactionClient) => {
        return createLoginResult(transactionClient, input, authConfig);
      });
    },

    async getCurrentUser(accessToken) {
      let decodedAccessToken: ReturnType<typeof decodeAccessToken>;

      assertTokenCanBeUsed('UNAUTHENTICATED', () => {
        decodedAccessToken = decodeAccessToken(accessToken, authConfig);
      });

      const user = await prismaClient.user.findUnique({
        where: {
          id: BigInt(decodedAccessToken!.sub),
        },
      });

      if (!user) {
        throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication token is invalid or expired.');
      }

      return toAuthUser(user);
    },

    async refreshSession(refreshToken, metadata) {
      return prismaClient.$transaction(async (transactionClient: AuthTransactionClient) => {
        return createRefreshSessionResult(transactionClient, refreshToken, authConfig, metadata);
      });
    },

    async logout(refreshToken) {
      await prismaClient.refreshToken.updateMany({
        where: {
          tokenHash: hashToken(refreshToken),
          revokedAt: null,
        },
        data: {
          revokedAt: new Date(),
        },
      });
    },
  };
}
