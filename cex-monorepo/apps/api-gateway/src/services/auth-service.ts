import { createHash, randomBytes, randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { Prisma, type PrismaClient, type Role } from '@cex/db';
import { AppError } from '../errors/app-error.js';
import type { SignInInput, SignUpInput } from '../schemas/auth.js';

const REFRESH_BYTES = 32;

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function createRefreshToken(): string { return randomBytes(REFRESH_BYTES).toString('base64url'); }
function expiresAt(days = 7): Date { return new Date(Date.now() + days * 24 * 60 * 60 * 1000); }

export class AuthService {
  constructor(private readonly db: PrismaClient) {}

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
    const valid = user !== null && user.isActive && await argon2.verify(user.passwordHash, input.password);
    if (!valid || !user) throw new AppError('INVALID_CREDENTIALS', 401, 'Invalid credentials.');
    const refreshToken = createRefreshToken();
    await this.db.refreshToken.create({ data: { userId: user.id, familyId: randomUUID(), tokenHash: hashRefreshToken(refreshToken), expiresAt: expiresAt() } });
    return { userId: user.id, role: user.role, refreshToken, csrfToken: randomBytes(24).toString('base64url') };
  }

  /** Records only a thresholded failure signal; passwords are never retained. */
  async recordSignInFailure(email: string): Promise<void> {
    await this.db.auditLog.create({ data: { actorId: null, action: 'AUTH_SIGNIN_FAILURE_BURST', meta: { email } } });
  }

  async rotate(refreshToken: string): Promise<{ userId: string; role: Role; refreshToken: string; csrfToken: string }> {
    const tokenHash = hashRefreshToken(refreshToken);
    const session = await this.db.refreshToken.findUnique({ where: { tokenHash }, include: { user: true } });
    if (!session || session.revokedAt || session.expiresAt <= new Date() || !session.user.isActive) {
      if (session) {
        await this.db.$transaction([
          this.db.refreshToken.updateMany({ where: { familyId: session.familyId, revokedAt: null }, data: { revokedAt: new Date() } }),
          this.db.auditLog.create({ data: { actorId: session.userId, action: 'AUTH_REFRESH_REUSE', meta: { familyId: session.familyId } } }),
        ]);
      }
      throw new AppError('INVALID_REFRESH_TOKEN', 401, 'Authentication required.');
    }
    const replacement = createRefreshToken();
    await this.db.$transaction([
      this.db.refreshToken.update({ where: { id: session.id }, data: { revokedAt: new Date() } }),
      this.db.refreshToken.create({ data: { userId: session.userId, familyId: session.familyId, tokenHash: hashRefreshToken(replacement), expiresAt: expiresAt() } }),
    ]);
    return { userId: session.userId, role: session.user.role, refreshToken: replacement, csrfToken: randomBytes(24).toString('base64url') };
  }

  async signOut(refreshToken: string): Promise<void> {
    const session = await this.db.refreshToken.findUnique({ where: { tokenHash: hashRefreshToken(refreshToken) } });
    if (!session) return;
    await this.db.refreshToken.updateMany({ where: { familyId: session.familyId, revokedAt: null }, data: { revokedAt: new Date() } });
  }
}
