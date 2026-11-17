import argon2 from 'argon2';
import { PrismaClient, Role } from '@prisma/client';
import { pathToFileURL } from 'node:url';

const prisma = new PrismaClient();

export async function seedDatabase(client: PrismaClient = prisma): Promise<void> {
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (!password) throw new Error('SEED_ADMIN_PASSWORD is required to seed the admin user.');

  await Promise.all([
    client.asset.upsert({ where: { symbol: 'USDT' }, update: { name: 'Tether', decimals: 6 }, create: { symbol: 'USDT', name: 'Tether', decimals: 6 } }),
    client.asset.upsert({ where: { symbol: 'SOL' }, update: { name: 'Solana', decimals: 9 }, create: { symbol: 'SOL', name: 'Solana', decimals: 9 } }),
    client.asset.upsert({ where: { symbol: 'BTC' }, update: { name: 'Bitcoin', decimals: 8 }, create: { symbol: 'BTC', name: 'Bitcoin', decimals: 8 } }),
  ]);

  await Promise.all([
    client.market.upsert({ where: { symbol: 'SOL_USDT' }, update: {}, create: { symbol: 'SOL_USDT', baseAsset: 'SOL', quoteAsset: 'USDT', tickSize: 1_000_000n, lotSize: 1_000_000n, minNotional: 100_000_000n } }),
    client.market.upsert({ where: { symbol: 'BTC_USDT' }, update: {}, create: { symbol: 'BTC_USDT', baseAsset: 'BTC', quoteAsset: 'USDT', tickSize: 1_000_000n, lotSize: 100_000n, minNotional: 100_000_000n } }),
  ]);

  const admin = await client.user.findUnique({
    where: { email: 'admin@cex.local' },
    select: { id: true },
  });

  if (admin) {
    await client.user.update({ where: { id: admin.id }, data: { role: Role.ADMIN } });
    return;
  }

  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  await client.user.create({
    data: { email: 'admin@cex.local', passwordHash, role: Role.ADMIN },
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  seedDatabase().finally(() => prisma.$disconnect());
}
