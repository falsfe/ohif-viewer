import type { Prisma, PrismaClient } from '@prisma/client';

import type { AuthConfig } from '../config/env';

export type RegisterInput = {
  username: string;
  email: string;
  password: string;
  confirmPassword: string;
};

export type LoginInput = {
  usernameOrEmail: string;
  password: string;
  userAgent?: string;
  ipAddress?: string;
};

export type AuthUser = {
  id: string;
  username: string;
  email: string;
  status: string;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type LoginResult = {
  user: AuthUser;
  accessToken: string;
  refreshToken: string;
};

export type AuthService = {
  register(input: RegisterInput): Promise<AuthUser>;
  login(input: LoginInput): Promise<LoginResult>;
  getCurrentUser(accessToken: string): Promise<AuthUser>;
  refreshSession(refreshToken: string, metadata: Pick<LoginInput, 'ipAddress' | 'userAgent'>): Promise<LoginResult>;
  logout(refreshToken: string): Promise<void>;
};

export type AuthTransactionClient = Pick<Prisma.TransactionClient, 'user' | 'refreshToken'>;

export type AuthServiceDependencies = {
  authConfig: AuthConfig;
  prisma: Pick<PrismaClient, 'user' | 'refreshToken' | '$transaction'>;
};
