import type { AccessClaims } from '../middleware/auth.js';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: AccessClaims;
    user: AccessClaims;
  }
}

export {};
