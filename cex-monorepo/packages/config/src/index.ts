import { z } from 'zod';

const booleanString = z.enum(['true', 'false']).transform((value) => value === 'true');

export const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().url(), REDIS_URL: z.string().url(),
  JWT_ACCESS_SECRET: z.string().min(1), JWT_REFRESH_SECRET: z.string().min(1),
  ACCESS_TOKEN_TTL: z.string().min(1), REFRESH_TOKEN_TTL: z.string().min(1),
  CORS_ORIGINS: z.string().min(1), API_PORT: z.coerce.number().int().positive(), WS_PORT: z.coerce.number().int().positive(),
  MAX_QUEUE_LEN: z.coerce.number().int().positive(), ENGINE_DATA_DIR: z.string().min(1), ENGINE_FSYNC_MS: z.coerce.number().int().nonnegative(),
  SNAPSHOT_EVERY_N: z.coerce.number().int().positive(), SEED_FROM_DB: booleanString, ENGINE_ASSERT: booleanString,
  DEV_DEPOSIT_MAX: z.string().regex(/^\d+$/), SEED_ADMIN_PASSWORD: z.string().min(1),
  NEXT_PUBLIC_API_URL: z.string().url(), NEXT_PUBLIC_WS_URL: z.string().url(), LOG_LEVEL: z.string().min(1),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): Config {
  const result = configSchema.safeParse(environment);
  if (!result.success) throw new Error(`Invalid environment configuration: ${result.error.message}`);
  return result.data;
}
