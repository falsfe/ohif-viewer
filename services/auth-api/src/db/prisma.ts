import { PrismaClient } from '@prisma/client';

import { env } from '../config/env';

declare global {
  // Reuse the Prisma client during local reloads to avoid exhausting DB connections.
  var __authApiPrisma__: PrismaClient | undefined;
}

const prismaClient =
  globalThis.__authApiPrisma__ ??
  new PrismaClient({
    datasources: {
      db: {
        url: env.databaseUrl,
      },
    },
  });

if (process.env.NODE_ENV !== 'production') {
  globalThis.__authApiPrisma__ = prismaClient;
}

export const prisma = prismaClient;
