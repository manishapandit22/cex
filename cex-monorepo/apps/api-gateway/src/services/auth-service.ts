import { createHash, randomBytes, randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { Prisma, type PrismaClient, type Role } from '@cex/db';
import { AppError } from '../errors/app-error.js';
import type { SignInInput, SignUpInput } from '../schemas/auth.js';

const REFRESH_BYTES = 32;
const UNITS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** Parses durations such as "15m" or "7d" into milliseconds. */
export function parseDurationMs(value: string): number {
  const match = /^(\d+)([smhd])$/.exec(value.trim());
  if (!match) throw new Error(`Invalid duration: ${value}`);
  return Number(match[1]) * UNITS[match[2]!]!;
}

// Verified against when the email is unknown so signin timing does not reveal registered emails.
let dummyHash: Promise<string> | undefined;
function getDummyHash(): Promise<string> {
  dummyHash ??= argon2.hash('dummy-password-for-timing', { type: argon2.argon2id });
  return dummyHash;
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function createRefreshToken(): string { return randomBytes(REFRESH_BYTES).toString('base64url'); }

export class AuthService {
  constructor(private readonly db: PrismaClient, private readonly refreshTtlMs: number = 7 * 86_400_000) {}

  private expiresAt(): Date { return new Date(Date.now() + this.refreshTtlMs); }

  async signUp(input: SignUpInput): Promise<{ id: string; email: string }> {
    const existing = await this.db.user.findUnique({ where: { email: input.email } });
    if (existing) throw new AppError('EMAIL_TAKEN', 409, 'An account with this email already exists.');
    const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });
    let user;
    try {
      user = await this.db.user.create({ data: { email: input.email, passwordHash } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new AppError('EMAIL_TAKEN', 409, 'An account with this email already exists.');
      }
      throw error;
    }
    await this.db.auditLog.create({ data: { actorId: user.id, action: 'AUTH_SIGNUP', meta: {} } });
    return { id: user.id, email: user.email };
  }

  async signIn(input: SignInInput): Promise<{ userId: string; role: Role; refreshToken: string; csrfToken: string }> {
    const user = await this.db.user.findUnique({ where: { email: input.email } });
    const passwordOk = await argon2.verify(user?.passwordHash ?? await getDummyHash(), input.password);
    if (!user || !user.isActive || !passwordOk) throw new AppError('INVALID_CREDENTIALS', 401, 'Invalid credentials.');
    const refreshToken = createRefreshToken();
    await this.db.refreshToken.create({ data: { userId: user.id, familyId: randomUUID(), tokenHash: hashRefreshToken(refreshToken), expiresAt: this.expiresAt() } });
    return { userId: user.id, role: user.role, refreshToken, csrfToken: randomBytes(24).toString('base64url') };
  }

  /** Records only a thresholded failure signal; passwords are never retained. */
  async recordSignInFailure(email: string): Promise<void> {
    await this.db.auditLog.create({ data: { actorId: null, action: 'AUTH_SIGNIN_FAILURE_BURST', meta: { email } } });
  }

  async rotate(refreshToken: string): Promise<{ userId: string; role: Role; refreshToken: string; csrfToken: string }> {
    const tokenHash = hashRefreshToken(refreshToken);
    const session = await this.db.refreshToken.findUnique({ where: { tokenHash }, include: { user: true } });
    if (!session) throw new AppError('INVALID_REFRESH_TOKEN', 401, 'Authentication required.');
    if (session.expiresAt <= new Date() || !session.user.isActive) {
      // Expired or deactivated: reject without treating it as token reuse.
      throw new AppError('INVALID_REFRESH_TOKEN', 401, 'Authentication required.');
    }
    if (session.revokedAt) {
      await this.db.$transaction([
        this.db.refreshToken.updateMany({ where: { familyId: session.familyId, revokedAt: null }, data: { revokedAt: new Date() } }),
        this.db.auditLog.create({ data: { actorId: session.userId, action: 'AUTH_REFRESH_REUSE', meta: { familyId: session.familyId } } }),
      ]);
      throw new AppError('INVALID_REFRESH_TOKEN', 401, 'Authentication required.');
    }
    const replacement = createRefreshToken();
    await this.db.$transaction([
      this.db.refreshToken.update({ where: { id: session.id }, data: { revokedAt: new Date() } }),
      this.db.refreshToken.create({ data: { userId: session.userId, familyId: session.familyId, tokenHash: hashRefreshToken(replacement), expiresAt: this.expiresAt() } }),
    ]);
    return { userId: session.userId, role: session.user.role, refreshToken: replacement, csrfToken: randomBytes(24).toString('base64url') };
  }

  async signOut(refreshToken: string): Promise<void> {
    const session = await this.db.refreshToken.findUnique({ where: { tokenHash: hashRefreshToken(refreshToken) } });
    if (!session) return;
    await this.db.refreshToken.updateMany({ where: { familyId: session.familyId, revokedAt: null }, data: { revokedAt: new Date() } });
  }

  async signOutAll(userId: string): Promise<void> {
    await this.db.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
  }

  async getProfile(userId: string): Promise<{ id: string; email: string; role: Role; createdAt: Date }> {
    const user = await this.db.user.findUnique({ where: { id: userId } });
    if (!user || !user.isActive) throw new AppError('UNAUTHORIZED', 401, 'Authentication required.');
    return { id: user.id, email: user.email, role: user.role, createdAt: user.createdAt };
  }

  /** Deletes tokens that expired before `now`; intended for a periodic job. */
  async purgeExpiredTokens(now = new Date()): Promise<number> {
    const result = await this.db.refreshToken.deleteMany({ where: { expiresAt: { lt: now } } });
    return result.count;
  }
}
