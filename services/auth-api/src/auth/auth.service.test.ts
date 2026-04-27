import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const serviceRoot = path.resolve(__dirname, '..', '..');
const schema = fs.readFileSync(path.join(serviceRoot, 'prisma', 'schema.prisma'), 'utf8');
const initialMigration = fs.readFileSync(
  path.join(serviceRoot, 'prisma', 'migrations', '20260424141000_init_auth', 'migration.sql'),
  'utf8'
);
const followupMigration = fs.readFileSync(
  path.join(serviceRoot, 'prisma', 'migrations', '20260427153000_add_refresh_token_hash_unique', 'migration.sql'),
  'utf8'
);

assert.match(schema, /model User/);
assert.match(schema, /model RefreshToken/);
assert.match(schema, /@@map\("users"\)/);
assert.match(schema, /@@map\("refresh_tokens"\)/);
assert.match(schema, /username\s+String\s+@unique/);
assert.match(schema, /email\s+String\s+@unique/);
assert.match(schema, /tokenHash\s+String\s+@unique/);

assert.match(initialMigration, /CREATE TABLE `users`/);
assert.match(initialMigration, /CREATE TABLE `refresh_tokens`/);
assert.match(initialMigration, /UNIQUE INDEX `uq_users_username`/);
assert.match(initialMigration, /UNIQUE INDEX `uq_users_email`/);
assert.match(initialMigration, /CONSTRAINT `fk_refresh_tokens_user_id`/);
assert.match(followupMigration, /CREATE UNIQUE INDEX `uq_refresh_tokens_token_hash`/);

console.log('auth schema and migration define users and refresh_tokens');
