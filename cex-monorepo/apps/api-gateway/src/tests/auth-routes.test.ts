import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import RedisMock from 'ioredis-mock';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '@cex/config';

process.env.NODE_ENV = 'test';
const { buildApp } = await import('../index.js');

type Role = 'USER' | 'ADMIN';
interface UserRow { id: string; email: string; passwordHash: string; isActive: boolean; role: Role; createdAt: Date }
interface TokenRow { id: string; userId: string; familyId: string; tokenHash: string; expiresAt: Date; revokedAt: Date | null }
interface AuditRow { actorId: string | null; action: string; meta: unknown }

function createFakePrisma() {
  const users: UserRow[] = [];
  const tokens: TokenRow[] = [];
  const audits: AuditRow[] = [];
  const matches = (token: TokenRow, where: Record<string, unknown>): boolean => {
    if (where.familyId !== undefined && token.familyId !== where.familyId) return false;
    if (where.userId !== undefined && token.userId !== where.userId) return false;
    if (where.revokedAt === null && token.revokedAt !== null) return false;
    const expires = where.expiresAt as { lt: Date } | undefined;
    if (expires && !(token.expiresAt < expires.lt)) return false;
    return true;
  };
  const prisma = {
    user: {
      findUnique: async ({ where }: { where: { id?: string; email?: string } }) =>
        users.find((user) => (where.id ? user.id === where.id : user.email === where.email)) ?? null,
      create: async ({ data }: { data: { email: string; passwordHash: string } }) => {
        const user: UserRow = { id: randomUUID(), isActive: true, role: 'USER', createdAt: new Date(), ...data };
        users.push(user);
        return user;
      },
    },
    refreshToken: {
      findUnique: async ({ where }: { where: { tokenHash: string } }) => {
        const token = tokens.find((entry) => entry.tokenHash === where.tokenHash);
        return token ? { ...token, user: users.find((user) => user.id === token.userId)! } : null;
      },
      create: async ({ data }: { data: Omit<TokenRow, 'id' | 'revokedAt'> }) => {
        const token: TokenRow = { id: randomUUID(), revokedAt: null, ...data };
        tokens.push(token);
        return token;
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<TokenRow> }) => Object.assign(tokens.find((t) => t.id === where.id)!, data),
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: { revokedAt: Date } }) => {
        const found = tokens.filter((token) => matches(token, where));
        found.forEach((token) => { token.revokedAt = data.revokedAt; });
        return { count: found.length };
      },
      deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
        const found = tokens.filter((token) => matches(token, where));
        found.forEach((token) => tokens.splice(tokens.indexOf(token), 1));
        return { count: found.length };
      },
    },
    auditLog: { create: async ({ data }: { data: AuditRow }) => { audits.push(data); return data; } },
    $transaction: async (operations: Promise<unknown>[]) => Promise.all(operations),
    $queryRawUnsafe: async () => 1,
  };
  return { prisma, users, tokens, audits };
}

const baseConfig = {
  NODE_ENV: 'test', DATABASE_URL: 'postgresql://x', REDIS_URL: 'redis://localhost:6379',
  JWT_ACCESS_SECRET: 'a'.repeat(64), JWT_REFRESH_SECRET: 'b'.repeat(64),
  ACCESS_TOKEN_TTL: '15m', REFRESH_TOKEN_TTL: '7d', CORS_ORIGINS: 'http://localhost:3000',
  API_PORT: 4000, WS_PORT: 8080, MAX_QUEUE_LEN: 1, ENGINE_DATA_DIR: '.', ENGINE_FSYNC_MS: 0, SNAPSHOT_EVERY_N: 1,
  SEED_FROM_DB: true, ENGINE_ASSERT: false, DEV_DEPOSIT_MAX: '1', SEED_ADMIN_PASSWORD: 'x',
  NEXT_PUBLIC_API_URL: 'http://localhost:4000', NEXT_PUBLIC_WS_URL: 'ws://localhost:8080', LOG_LEVEL: 'info',
} as Config;

const PASSWORD = 'correct-horse-battery';
let app: FastifyInstance;
let db: ReturnType<typeof createFakePrisma>;
let redis: InstanceType<typeof RedisMock>;

async function boot(config: Config = baseConfig): Promise<void> {
  db = createFakePrisma();
  redis = new RedisMock();
  await redis.flushall();
  app = await buildApp(config, { prisma: db.prisma as never, redis: redis as never });
}

async function addUser(email: string, role: Role = 'USER'): Promise<UserRow> {
  const user: UserRow = { id: randomUUID(), email, role, isActive: true, createdAt: new Date(), passwordHash: await argon2.hash(PASSWORD, { type: argon2.argon2id }) };
  db.users.push(user);
  return user;
}

const post = (url: string, payload?: unknown, headers: Record<string, string> = {}, remoteAddress = '10.0.0.1') =>
  app.inject({ method: 'POST', url, payload: payload as never, headers, remoteAddress });

function sessionFrom(response: Awaited<ReturnType<typeof post>>) {
  const cookie = (name: string) => response.cookies.find((c) => c.name === name)!;
  const refresh = cookie('refreshToken');
  const csrf = cookie('csrfToken');
  return {
    accessToken: (response.json() as { accessToken: string }).accessToken,
    refresh, csrf,
    headers: { cookie: `refreshToken=${refresh.value}; csrfToken=${csrf.value}`, 'x-csrf-token': csrf.value },
  };
}

beforeEach(async () => { await boot(); });
afterEach(async () => { await app.close(); });

describe('POST /auth/signup', () => {
  it('creates the account without returning a password or token', async () => {
    const response = await post('/api/v1/auth/signup', { email: 'New@Example.test', password: PASSWORD });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ user: { id: expect.any(String), email: 'new@example.test' } });
    expect(response.body).not.toContain(PASSWORD);
    expect(db.users[0]!.passwordHash).not.toContain(PASSWORD);
    expect(db.audits).toContainEqual(expect.objectContaining({ action: 'AUTH_SIGNUP' }));
  });

  it('returns 409 for a duplicate email', async () => {
    await post('/api/v1/auth/signup', { email: 'dup@example.test', password: PASSWORD });
    const response = await post('/api/v1/auth/signup', { email: 'dup@example.test', password: PASSWORD });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('EMAIL_TAKEN');
  });

  it('rejects short passwords and a password equal to the email', async () => {
    expect((await post('/api/v1/auth/signup', { email: 'a@example.test', password: 'short' })).statusCode).toBe(400);
    expect((await post('/api/v1/auth/signup', { email: 'same-address@example.test', password: 'same-address@example.test' })).statusCode).toBe(400);
  });

  it('blocks the 6th signup from one IP within a minute', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 6; i += 1) codes.push((await post('/api/v1/auth/signup', { email: `u${i}@example.test`, password: PASSWORD })).statusCode);
    expect(codes.slice(0, 5)).toEqual([201, 201, 201, 201, 201]);
    expect(codes[5]).toBe(429);
  });
});

describe('POST /auth/signin', () => {
  it('returns the same generic 401 for a wrong password and an unknown email', async () => {
    await addUser('trader@example.test');
    const wrong = await post('/api/v1/auth/signin', { email: 'trader@example.test', password: 'wrong-password-1' });
    const unknown = await post('/api/v1/auth/signin', { email: 'nobody@example.test', password: 'wrong-password-1' });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json()).toEqual(unknown.json());
    expect(wrong.json().error.message).toBe('Invalid credentials.');
  });

  it('issues an access JWT with sub and role and sets hardened cookies', async () => {
    const user = await addUser('trader@example.test');
    const response = await post('/api/v1/auth/signin', { email: user.email, password: PASSWORD });
    expect(response.statusCode).toBe(200);
    const { refresh, csrf, accessToken } = sessionFrom(response);
    expect(app.jwt.decode<{ sub: string; role: string }>(accessToken)).toMatchObject({ sub: user.id, role: 'USER' });
    expect(refresh).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/api/v1/auth', maxAge: 7 * 86400 });
    expect(refresh.secure).toBeFalsy();
    expect(csrf).toMatchObject({ sameSite: 'Strict' });
    expect(csrf.httpOnly).toBeFalsy();
    expect(response.body).not.toContain(PASSWORD);
    expect(db.tokens[0]!.tokenHash).not.toBe(refresh.value);
  });

  it('marks cookies Secure in production', async () => {
    await app.close();
    await boot({ ...baseConfig, NODE_ENV: 'production' });
    const user = await addUser('trader@example.test');
    const { refresh } = sessionFrom(await post('/api/v1/auth/signin', { email: user.email, password: PASSWORD }));
    expect(refresh.secure).toBe(true);
    expect(refresh.httpOnly).toBe(true);
  });

  it('blocks the 6th attempt from one IP within a minute', async () => {
    await addUser('trader@example.test');
    const codes: number[] = [];
    for (let i = 0; i < 6; i += 1) codes.push((await post('/api/v1/auth/signin', { email: 'trader@example.test', password: 'wrong-password-1' })).statusCode);
    expect(codes.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(codes[5]).toBe(429);
  });

  it('limits attempts per email across IPs and audits the failure burst', async () => {
    await addUser('trader@example.test');
    const codes: number[] = [];
    for (let i = 0; i < 11; i += 1) {
      codes.push((await post('/api/v1/auth/signin', { email: 'trader@example.test', password: 'wrong-password-1' }, {}, `10.0.1.${i}`)).statusCode);
    }
    expect(codes.slice(0, 10).every((code) => code === 401)).toBe(true);
    expect(codes[10]).toBe(429);
    expect(db.audits).toContainEqual(expect.objectContaining({ action: 'AUTH_SIGNIN_FAILURE_BURST' }));
  });
});

describe('POST /auth/refresh', () => {
  async function signedIn() {
    const user = await addUser('trader@example.test');
    return { user, session: sessionFrom(await post('/api/v1/auth/signin', { email: user.email, password: PASSWORD })) };
  }

  it('rotates the refresh token and issues a new access token', async () => {
    const { session } = await signedIn();
    const response = await post('/api/v1/auth/refresh', undefined, session.headers);
    expect(response.statusCode).toBe(200);
    expect(sessionFrom(response).refresh.value).not.toBe(session.refresh.value);
  });

  it('requires a matching CSRF header', async () => {
    const { session } = await signedIn();
    const response = await post('/api/v1/auth/refresh', undefined, { cookie: session.headers.cookie });
    expect(response.statusCode).toBe(401);
  });

  it('revokes the whole family when a rotated token is reused', async () => {
    const { session } = await signedIn();
    const rotated = sessionFrom(await post('/api/v1/auth/refresh', undefined, session.headers));
    const reuse = await post('/api/v1/auth/refresh', undefined, session.headers);
    expect(reuse.statusCode).toBe(401);
    expect(db.tokens.every((token) => token.revokedAt !== null)).toBe(true);
    expect(db.audits).toContainEqual(expect.objectContaining({ action: 'AUTH_REFRESH_REUSE' }));
    expect((await post('/api/v1/auth/refresh', undefined, rotated.headers)).statusCode).toBe(401);
  });

  it('rejects an expired refresh token without logging it as reuse', async () => {
    const { session } = await signedIn();
    db.tokens[0]!.expiresAt = new Date(Date.now() - 1000);
    const response = await post('/api/v1/auth/refresh', undefined, session.headers);
    expect(response.statusCode).toBe(401);
    expect(db.audits.some((audit) => audit.action === 'AUTH_REFRESH_REUSE')).toBe(false);
  });
});

describe('sign out and protected routes', () => {
  it('signout revokes the family and clears cookies', async () => {
    await addUser('trader@example.test');
    const session = sessionFrom(await post('/api/v1/auth/signin', { email: 'trader@example.test', password: PASSWORD }));
    const response = await post('/api/v1/auth/signout', undefined, session.headers);
    expect(response.statusCode).toBe(204);
    expect(db.tokens.every((token) => token.revokedAt !== null)).toBe(true);
    expect(response.cookies.map((c) => c.name).sort()).toEqual(['csrfToken', 'refreshToken']);
  });

  it('rejects a missing, malformed or expired access token with 401', async () => {
    const user = await addUser('trader@example.test');
    const expired = app.jwt.sign({ sub: user.id, role: 'USER', exp: Math.floor(Date.now() / 1000) - 60 } as never);
    for (const authorization of [undefined, 'Bearer garbage', `Bearer ${expired}`]) {
      const response = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: authorization ? { authorization } : {} });
      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe('UNAUTHORIZED');
    }
  });

  it('GET /me returns the profile for a valid token', async () => {
    const user = await addUser('trader@example.test');
    const accessToken = app.jwt.sign({ sub: user.id, role: 'USER' });
    const response = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { authorization: `Bearer ${accessToken}` } });
    expect(response.statusCode).toBe(200);
    expect(response.json().user).toMatchObject({ id: user.id, email: user.email, role: 'USER' });
    expect(response.body).not.toContain('passwordHash');
  });

  it('role guard returns 403 for USER and 200 for ADMIN', async () => {
    const user = await addUser('user@example.test');
    const admin = await addUser('admin@example.test', 'ADMIN');
    const asUser = await app.inject({ method: 'GET', url: '/api/v1/admin/test', headers: { authorization: `Bearer ${app.jwt.sign({ sub: user.id, role: 'USER' })}` } });
    const asAdmin = await app.inject({ method: 'GET', url: '/api/v1/admin/test', headers: { authorization: `Bearer ${app.jwt.sign({ sub: admin.id, role: 'ADMIN' })}` } });
    expect(asUser.statusCode).toBe(403);
    expect(asAdmin.statusCode).toBe(200);
  });

  it('signout-all revokes every session of the user', async () => {
    const user = await addUser('trader@example.test');
    const a = sessionFrom(await post('/api/v1/auth/signin', { email: user.email, password: PASSWORD }));
    await post('/api/v1/auth/signin', { email: user.email, password: PASSWORD });
    const response = await post('/api/v1/auth/signout-all', undefined, { authorization: `Bearer ${a.accessToken}` });
    expect(response.statusCode).toBe(204);
    expect(db.tokens).toHaveLength(2);
    expect(db.tokens.every((token) => token.revokedAt !== null)).toBe(true);
  });
});
