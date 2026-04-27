import dotenv from 'dotenv';

dotenv.config();

const DEFAULT_PORT = 4001;
const DEFAULT_ACCESS_TOKEN_EXPIRES_IN = '15m';
const DEFAULT_REFRESH_TOKEN_EXPIRES_IN = '7d';
const DURATION_PATTERN = /^\d+[smhd]?$/;

function parsePort(rawPort: string | undefined): number {
  if (rawPort === undefined || rawPort === '') {
    return DEFAULT_PORT;
  }

  if (!/^\d+$/.test(rawPort)) {
    throw new Error('PORT must be a whole number between 1 and 65535.');
  }

  const parsedPort = Number.parseInt(rawPort, 10);

  if (parsedPort <= 0 || parsedPort > 65535) {
    throw new Error('PORT must be a whole number between 1 and 65535.');
  }

  return parsedPort;
}

function readString(rawValue: string | undefined, fallback: string): string {
  const normalizedValue = rawValue?.trim();

  return normalizedValue && normalizedValue.length > 0 ? normalizedValue : fallback;
}

function readRequiredString(rawValue: string | undefined, envName: string): string {
  const normalizedValue = rawValue?.trim();

  if (!normalizedValue) {
    throw new Error(`${envName} must be set.`);
  }

  return normalizedValue;
}

function readOptionalString(rawValue: string | undefined): string | undefined {
  const normalizedValue = rawValue?.trim();

  return normalizedValue && normalizedValue.length > 0 ? normalizedValue : undefined;
}

function readDurationString(rawValue: string | undefined, fallback: string, envName: string): string {
  const normalizedValue = readString(rawValue, fallback);

  if (!DURATION_PATTERN.test(normalizedValue)) {
    throw new Error(`${envName} must use an integer plus optional s, m, h, or d suffix.`);
  }

  return normalizedValue;
}

export type AuthConfig = {
  accessTokenSecret: string;
  refreshTokenSecret: string;
  accessTokenExpiresIn: string;
  refreshTokenExpiresIn: string;
  cookieDomain?: string;
  isProduction: boolean;
};

export const env = {
  port: parsePort(process.env.PORT),
  databaseUrl: readRequiredString(process.env.DATABASE_URL, 'DATABASE_URL'),
  auth: {
    accessTokenSecret: readRequiredString(process.env.JWT_ACCESS_SECRET, 'JWT_ACCESS_SECRET'),
    refreshTokenSecret: readRequiredString(process.env.JWT_REFRESH_SECRET, 'JWT_REFRESH_SECRET'),
    accessTokenExpiresIn: readDurationString(
      process.env.JWT_ACCESS_EXPIRES,
      DEFAULT_ACCESS_TOKEN_EXPIRES_IN,
      'JWT_ACCESS_EXPIRES'
    ),
    refreshTokenExpiresIn: readDurationString(
      process.env.JWT_REFRESH_EXPIRES,
      DEFAULT_REFRESH_TOKEN_EXPIRES_IN,
      'JWT_REFRESH_EXPIRES'
    ),
    cookieDomain: readOptionalString(process.env.COOKIE_DOMAIN),
    isProduction: process.env.NODE_ENV === 'production',
  } satisfies AuthConfig,
};
