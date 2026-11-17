import type { FastifyRequest } from 'fastify';
import { Role } from '@cex/db';
import { AppError } from '../errors/app-error.js';

export interface AccessClaims { sub: string; role: Role; }

export async function requireAuth(request: FastifyRequest): Promise<void> {
  try {
    await request.jwtVerify<AccessClaims>();
  } catch {
    throw new AppError('UNAUTHORIZED', 401, 'Authentication required.');
  }
}

export function requireRole(role: Role) {
  return async (request: FastifyRequest): Promise<void> => {
    await requireAuth(request);
    if (request.user.role !== role) throw new AppError('FORBIDDEN', 403, 'Insufficient permissions.');
  };
}
