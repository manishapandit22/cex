import { Prisma } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from './index.js';

const engineSeq = 9_000_000_001n;
const createdAt = new Date('2026-11-04T00:00:00.000Z');

describe('@cex/db trade constraints', () => {
  beforeEach(async () => {
    await prisma.trade.deleteMany({ where: { engineSeq } });
  });

  afterAll(async () => {
    await prisma.trade.deleteMany({ where: { engineSeq } });
    await prisma.$disconnect();
  });

  it('rejects duplicate engine sequence and creation timestamp pairs', async () => {
    const trade = {
      id: 'phase-02-trade-unique-a',
      createdAt,
      engineSeq,
      market: 'SOL_USDT',
      price: 10_000_000n,
      quantity: 100_000_000n,
      makerOrderId: 'phase-02-maker',
      takerOrderId: 'phase-02-taker',
      makerUserId: 'phase-02-maker-user',
      takerUserId: 'phase-02-taker-user',
      takerSide: 'BUY' as const,
      makerFee: 0n,
      takerFee: 0n,
    };

    await prisma.trade.create({ data: trade });

    await expect(
      prisma.trade.create({ data: { ...trade, id: 'phase-02-trade-unique-b' } }),
    ).rejects.toMatchObject({ code: 'P2002' } satisfies Partial<Prisma.PrismaClientKnownRequestError>);
  });
});
