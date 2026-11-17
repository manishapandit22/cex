import { describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { seedDatabase } from './seed.js';

const prisma = new PrismaClient();

describe('@cex/db seed', () => {
  it('can run twice without duplicating its canonical records', async () => {
    process.env.SEED_ADMIN_PASSWORD ??= 'phase-02-test-admin-password';

    await seedDatabase(prisma);
    await seedDatabase(prisma);

    const [assets, markets, admins] = await Promise.all([
      prisma.asset.count({ where: { symbol: { in: ['USDT', 'SOL', 'BTC'] } } }),
      prisma.market.count({ where: { symbol: { in: ['SOL_USDT', 'BTC_USDT'] } } }),
      prisma.user.count({ where: { email: 'admin@cex.local', role: 'ADMIN' } }),
    ]);

    expect({ assets, markets, admins }).toEqual({ assets: 3, markets: 2, admins: 1 });
    await prisma.$disconnect();
  });
});
