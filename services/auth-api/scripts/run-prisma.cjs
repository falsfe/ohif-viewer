const { spawnSync } = require('node:child_process');
const path = require('node:path');

const prismaEntrypoint = path.join(__dirname, '..', 'node_modules', 'prisma', 'build', 'index.js');
const fallbackDatabaseUrl = 'mysql://placeholder:placeholder@127.0.0.1:3306/ohif_auth';
const prismaArgs = process.argv.slice(2);
const commandSupportsFallback = prismaArgs[0] === 'validate' || prismaArgs[0] === 'generate';

if (!process.env.DATABASE_URL && !commandSupportsFallback) {
  console.error('DATABASE_URL must be set before running Prisma commands that talk to a database.');
  process.exit(1);
}

const result = spawnSync(process.execPath, [prismaEntrypoint, ...prismaArgs], {
  stdio: 'inherit',
  env: {
    ...process.env,
    DATABASE_URL: process.env.DATABASE_URL || fallbackDatabaseUrl,
  },
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
