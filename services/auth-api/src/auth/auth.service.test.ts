import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';

process.env.DATABASE_URL = 'mysql://ohif_user:StrongUserPass123!@192.168.150.101:3306/ohif_auth';
process.env.JWT_ACCESS_SECRET = 'access-secret-value-that-is-long-enough';
process.env.JWT_REFRESH_SECRET = 'refresh-secret-value-that-is-long-enough';
process.env.JWT_ACCESS_EXPIRES = '15m';
process.env.JWT_REFRESH_EXPIRES = '7d';

async function main(): Promise<void> {
  const { HttpError } = await import('../utils/http-error');
  const { prisma } = await import('../db/prisma');
  const { env } = await import('../config/env');
  const { createAuthService } = await import('./auth.service');
  const { REFRESH_COOKIE_NAME } = await import('./cookie');
  const { decodeAccessToken, decodeRefreshToken } = await import('./token.service');
  const { hashToken, verifyPassword } = await import('../utils/hash');
  const appModule = await import('../app');
  const app = appModule.default;

  const authService = createAuthService({ prisma });

  await prisma.refreshToken.deleteMany();
  await prisma.user.deleteMany();

  const uniqueSuffix = Date.now().toString();
  const registerInput = {
    username: `reader_${uniqueSuffix}`,
    email: `reader_${uniqueSuffix}@example.com`,
    password: 'S3cureP@ssword!',
    confirmPassword: 'S3cureP@ssword!',
  };

  const registeredUser = await authService.register(registerInput);

  assert.equal(registeredUser.username, registerInput.username);
  assert.equal(registeredUser.email, registerInput.email);
  assert.equal(registeredUser.status, 'active');
  assert.equal(typeof registeredUser.id, 'string');

  const storedUser = await prisma.user.findUniqueOrThrow({
    where: {
      username: registerInput.username,
    },
  });

  assert.ok(await verifyPassword(registerInput.password, storedUser.passwordHash));

  await assert.rejects(
    authService.register({
      ...registerInput,
      email: `other_${uniqueSuffix}@example.com`,
    }),
    (error: unknown) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.statusCode, 409);
      assert.equal(error.code, 'USERNAME_TAKEN');
      return true;
    }
  );

  await assert.rejects(
    authService.register({
      ...registerInput,
      username: `other_${uniqueSuffix}`,
    }),
    (error: unknown) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.statusCode, 409);
      assert.equal(error.code, 'EMAIL_TAKEN');
      return true;
    }
  );

  const loginResult = await authService.login({
    usernameOrEmail: registerInput.email,
    password: registerInput.password,
    userAgent: 'auth-api-test',
    ipAddress: '127.0.0.1',
  });

  assert.equal(loginResult.user.id, registeredUser.id);
  assert.equal(typeof loginResult.accessToken, 'string');
  assert.equal(typeof loginResult.refreshToken, 'string');

  const decodedAccessToken = decodeAccessToken(loginResult.accessToken, env.auth);
  const decodedRefreshToken = decodeRefreshToken(loginResult.refreshToken, env.auth);

  assert.equal(decodedAccessToken.sub, registeredUser.id);
  assert.equal(decodedAccessToken.username, registeredUser.username);
  assert.equal(decodedAccessToken.email, registeredUser.email);
  assert.equal(decodedRefreshToken.sub, registeredUser.id);
  assert.equal(typeof decodedRefreshToken.jti, 'string');
  assert.ok(decodedRefreshToken.jti.length > 0);

  const persistedRefreshToken = await prisma.refreshToken.findFirstOrThrow({
    where: {
      userId: BigInt(registeredUser.id),
      tokenHash: hashToken(loginResult.refreshToken),
    },
  });

  assert.equal(persistedRefreshToken.userAgent, 'auth-api-test');
  assert.equal(persistedRefreshToken.ipAddress, '127.0.0.1');
  assert.equal(persistedRefreshToken.revokedAt, null);
  assert.equal(
    persistedRefreshToken.expiresAt.toISOString(),
    new Date(decodedRefreshToken.exp! * 1000).toISOString()
  );

  const updatedUser = await prisma.user.findUniqueOrThrow({
    where: {
      id: BigInt(registeredUser.id),
    },
  });

  assert.ok(updatedUser.lastLoginAt instanceof Date);

  await assert.rejects(
    authService.login({
      usernameOrEmail: registerInput.username,
      password: 'wrong-password',
    }),
    (error: unknown) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.statusCode, 401);
      assert.equal(error.code, 'INVALID_CREDENTIALS');
      return true;
    }
  );

  const routeRegisterInput = {
    username: `route_${uniqueSuffix}`,
    email: `route_${uniqueSuffix}@example.com`,
    password: 'An0therS3curePass!',
    confirmPassword: 'An0therS3curePass!',
  };
  const server = app.listen(0);

  try {
    const { port } = server.address() as AddressInfo;
    const registerResponse = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(routeRegisterInput),
    });

    assert.equal(registerResponse.status, 201);
    const registerPayload = (await registerResponse.json()) as {
      user: { username: string; email: string };
    };

    assert.equal(registerPayload.user.username, routeRegisterInput.username);
    assert.equal(registerPayload.user.email, routeRegisterInput.email);

    const loginResponse = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'route-test-agent',
      },
      body: JSON.stringify({
        usernameOrEmail: routeRegisterInput.username,
        password: routeRegisterInput.password,
      }),
    });

    assert.equal(loginResponse.status, 200);
    assert.match(loginResponse.headers.get('set-cookie') ?? '', new RegExp(`^${REFRESH_COOKIE_NAME}=`));
    assert.match(loginResponse.headers.get('set-cookie') ?? '', /HttpOnly/i);
    assert.match(loginResponse.headers.get('set-cookie') ?? '', /Path=\/api\/auth/i);

    const loginPayload = (await loginResponse.json()) as {
      accessToken: string;
      user: { username: string; email: string };
    };

    assert.equal(typeof loginPayload.accessToken, 'string');
    assert.equal(loginPayload.user.username, routeRegisterInput.username);

    const refreshCookie = loginResponse.headers.get('set-cookie')?.split(';')[0];
    assert.ok(refreshCookie);

    const meResponse = await fetch(`http://127.0.0.1:${port}/api/auth/me`, {
      headers: {
        authorization: `Bearer ${loginPayload.accessToken}`,
      },
    });

    assert.equal(meResponse.status, 200);
    const mePayload = (await meResponse.json()) as {
      user: { username: string; email: string };
    };

    assert.equal(mePayload.user.username, routeRegisterInput.username);
    assert.equal(mePayload.user.email, routeRegisterInput.email);

    const unauthenticatedMeResponse = await fetch(`http://127.0.0.1:${port}/api/auth/me`);

    assert.equal(unauthenticatedMeResponse.status, 401);
    const unauthenticatedMePayload = (await unauthenticatedMeResponse.json()) as {
      error: { code: string };
    };

    assert.equal(unauthenticatedMePayload.error.code, 'UNAUTHENTICATED');

    const refreshResponse = await fetch(`http://127.0.0.1:${port}/api/auth/refresh`, {
      method: 'POST',
      headers: {
        cookie: refreshCookie,
        'user-agent': 'route-test-refresh-agent',
      },
    });

    assert.equal(refreshResponse.status, 200);
    assert.match(refreshResponse.headers.get('set-cookie') ?? '', new RegExp(`^${REFRESH_COOKIE_NAME}=`));
    const refreshPayload = (await refreshResponse.json()) as {
      accessToken: string;
      user: { username: string; email: string };
    };

    assert.equal(typeof refreshPayload.accessToken, 'string');
    assert.equal(refreshPayload.user.username, routeRegisterInput.username);

    const refreshedCookie = refreshResponse.headers.get('set-cookie')?.split(';')[0];
    assert.ok(refreshedCookie);

    const logoutResponse = await fetch(`http://127.0.0.1:${port}/api/auth/logout`, {
      method: 'POST',
      headers: {
        cookie: refreshedCookie,
      },
    });

    assert.equal(logoutResponse.status, 204);
    assert.match(logoutResponse.headers.get('set-cookie') ?? '', new RegExp(`^${REFRESH_COOKIE_NAME}=`));
    assert.match(logoutResponse.headers.get('set-cookie') ?? '', /Max-Age=0/i);

    const refreshAfterLogoutResponse = await fetch(`http://127.0.0.1:${port}/api/auth/refresh`, {
      method: 'POST',
      headers: {
        cookie: refreshedCookie,
      },
    });

    assert.equal(refreshAfterLogoutResponse.status, 401);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
    await prisma.refreshToken.deleteMany();
    await prisma.user.deleteMany();
    await prisma.$disconnect();
  }

  console.log('register/login service and routes work');
}

void main();
