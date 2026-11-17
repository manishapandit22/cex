import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../errors/app-error.js';
import { AuthService, hashRefreshToken } from './auth-service.js';

type User = {
  id: string;
  email: string;
  passwordHash: string;
  isActive: boolean;
  role: 'USER' | 'ADMIN';
};

type StoredToken = {
  id: string;
  userId: string;
  familyId: string;
  tokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
};

function createDatabase(users: User[] = []) {
  const tokens: StoredToken[] = [];
  const audits: Array<{ actorId: string | null; action: string; meta: unknown }> = [];
  const db = {
    user: {
      findUnique: vi.fn(async ({ where: { email } }: { where: { email: string } }) => users.find((user) => user.email === email) ?? null),
      create: vi.fn(async ({ data }: { data: Omit<User, 'id' | 'isActive' | 'role'> }) => {
        const user: User = { id: randomUUID(), isActive: true, role: 'USER', ...data };
        users.push(user);
        return user;
      }),
    },
    refreshToken: {
      findUnique: vi.fn(async ({ where: { tokenHash } }: { where: { tokenHash: string } }) => {
        const token = tokens.find((entry) => entry.tokenHash === tokenHash);
        if (!token) return null;
        return { ...token, user: users.find((user) => user.id === token.userId)! };
      }),
      create: vi.fn(async ({ data }: { data: Omit<StoredToken, 'id' | 'revokedAt'> }) => {
        const token: StoredToken = { id: randomUUID(), revokedAt: null, ...data };
        tokens.push(token);
        return token;
      }),
      update: vi.fn(async ({ where: { id }, data }: { where: { id: string }; data: Partial<StoredToken> }) => {
        const token = tokens.find((entry) => entry.id === id)!;
        Object.assign(token, data);
        return token;
      }),
      updateMany: vi.fn(async ({ where, data }: { where: { familyId: string; revokedAt: null }; data: { revokedAt: Date } }) => {
        const matching = tokens.filter((token) => token.familyId === where.familyId && token.revokedAt === null);
        matching.forEach((token) => { token.revokedAt = data.revokedAt; });
        return { count: matching.length };
      }),
    },
    auditLog: {
      create: vi.fn(async ({ data }: { data: { actorId: string | null; action: string; meta: unknown } }) => {
        audits.push(data);
        return data;
      }),
    },
    $transaction: vi.fn(async (operations: Promise<unknown>[]) => Promise.all(operations)),
  };
  return { db, tokens, audits };
}

describe('AuthService', () => {
  it('rejects a duplicate email and never stores the plaintext password', async () => {
    const { db } = createDatabase();
    const service = new AuthService(db as never);
    await service.signUp({ email: 'trader@example.test', password: 'secure-password' });

    await expect(service.signUp({ email: 'trader@example.test', password: 'secure-password' })).rejects.toMatchObject({
      code: 'EMAIL_TAKEN', statusCode: 409,
    } satisfies Partial<AppError>);
    expect(db.user.create.mock.calls[0]?.[0].data.passwordHash).not.toBe('secure-password');
  });

  it('returns a generic 401 for a wrong password', async () => {
    const passwordHash = await argon2.hash('correct-password', { type: argon2.argon2id });
    const { db } = createDatabase([{ id: 'user-1', email: 'trader@example.test', passwordHash, isActive: true, role: 'USER' }]);
    const service = new AuthService(db as never);

    await expect(service.signIn({ email: 'trader@example.test', password: 'wrong-password' })).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS', statusCode: 401, message: 'Invalid credentials.',
    } satisfies Partial<AppError>);
  });

  it('rotates refresh tokens and revokes the entire family when an old token is reused', async () => {
    const passwordHash = await argon2.hash('correct-password', { type: argon2.argon2id });
    const { db, tokens, audits } = createDatabase([{ id: 'user-1', email: 'trader@example.test', passwordHash, isActive: true, role: 'USER' }]);
    const service = new AuthService(db as never);
    const first = await service.signIn({ email: 'trader@example.test', password: 'correct-password' });
    const second = await service.rotate(first.refreshToken);

    await expect(service.rotate(first.refreshToken)).rejects.toMatchObject({ code: 'INVALID_REFRESH_TOKEN', statusCode: 401 } satisfies Partial<AppError>);
    expect(tokens).toHaveLength(2);
    expect(tokens.every((token) => token.revokedAt !== null)).toBe(true);
    expect(audits).toContainEqual(expect.objectContaining({ action: 'AUTH_REFRESH_REUSE' }));
    await expect(service.rotate(second.refreshToken)).rejects.toMatchObject({ code: 'INVALID_REFRESH_TOKEN' } satisfies Partial<AppError>);
  });

  it('revokes only the session family being signed out', async () => {
    const passwordHash = await argon2.hash('correct-password', { type: argon2.argon2id });
    const { db, tokens } = createDatabase([{ id: 'user-1', email: 'trader@example.test', passwordHash, isActive: true, role: 'USER' }]);
    const service = new AuthService(db as never);
    const first = await service.signIn({ email: 'trader@example.test', password: 'correct-password' });
    const second = await service.signIn({ email: 'trader@example.test', password: 'correct-password' });

    await service.signOut(first.refreshToken);
    const firstStored = tokens.find((token) => token.tokenHash === hashRefreshToken(first.refreshToken))!;
    const secondStored = tokens.find((token) => token.tokenHash === hashRefreshToken(second.refreshToken))!;
    expect(firstStored.revokedAt).not.toBeNull();
    expect(secondStored.revokedAt).toBeNull();
  });
});
