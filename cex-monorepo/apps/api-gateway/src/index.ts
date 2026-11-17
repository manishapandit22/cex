import { randomUUID } from 'node:crypto';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { ZodError } from 'zod';
import { loadConfig, type Config } from '@cex/config';
import { prisma, type PrismaClient } from '@cex/db';
import { AppError } from './errors/app-error.js';
import { requireRole } from './middleware/auth.js';
import { authRoutes } from './routes/auth.js';

declare module 'fastify' {
  interface FastifyInstance {
    gatewayConfig: Config;
    prisma: PrismaClient;
    redis: Redis;
  }
}

export interface GatewayDependencies { prisma?: PrismaClient; redis?: Redis; }

export async function buildApp(config: Config = loadConfig(), dependencies: GatewayDependencies = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024, genReqId: () => randomUUID() });
  const redis = dependencies.redis ?? new Redis(config.REDIS_URL, { maxRetriesPerRequest: 1 });
  app.decorate('gatewayConfig', config);
  app.decorate('prisma', dependencies.prisma ?? prisma);
  app.decorate('redis', redis);

  await app.register(cors, { origin: config.CORS_ORIGINS.split(',').map((origin) => origin.trim()), credentials: true });
  await app.register(helmet);
  await app.register(cookie);
  await app.register(jwt, { secret: config.JWT_ACCESS_SECRET });
  await app.register(rateLimit, { global: false, redis, keyGenerator: (request) => request.ip });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid request.', details: error.flatten() } });
    if (error instanceof AppError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message, details: error.details } });
    if (typeof error === 'object' && error !== null && 'statusCode' in error && error.statusCode === 429) {
      return reply.code(429).send({ error: { code: 'RATE_LIMITED', message: 'Too many authentication attempts.', details: {} } });
    }
    request.log.error({ err: error, requestId: request.id }, 'Unhandled request error');
    return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error.', details: {} } });
  });

  app.get('/api/v1/healthz', async () => {
    await app.prisma.$queryRawUnsafe('SELECT 1');
    await app.redis.ping();
    return { status: 'ok' };
  });
  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  app.get('/api/v1/admin/test', { preHandler: requireRole('ADMIN') }, async () => ({ ok: true }));

  app.addHook('onClose', async () => {
    if (!dependencies.redis) await redis.quit();
  });
  return app;
}

if (process.env.NODE_ENV !== 'test') {
  const app = await buildApp();
  await app.listen({ host: '0.0.0.0', port: app.gatewayConfig.API_PORT });
}
