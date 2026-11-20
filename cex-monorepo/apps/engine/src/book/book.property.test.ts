import { Side } from '@cex/types';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Book } from './book.js';
import { remainingQuantity, type EngineOrder } from './types.js';

type Op =
  | { kind: 'add'; side: Side; price: number; quantity: number }
  | { kind: 'remove'; pick: number }
  | { kind: 'reduce'; pick: number; fraction: number };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 5, arbitrary: fc.record({ kind: fc.constant('add' as const), side: fc.constantFrom(Side.BUY, Side.SELL), price: fc.integer({ min: 1, max: 20 }), quantity: fc.integer({ min: 1, max: 1000 }) }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('remove' as const), pick: fc.nat() }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant('reduce' as const), pick: fc.nat(), fraction: fc.integer({ min: 1, max: 100 }) }) },
);

function assertInvariants(book: Book): void {
  const checkSide = (levels: ReturnType<Book['bids']['all']>, descending: boolean): number => {
    let orders = 0;
    levels.forEach((level, i) => {
      if (i > 0) {
        const previous = levels[i - 1]!.price;
        expect(descending ? previous > level.price : previous < level.price).toBe(true);
      }
      const resting = [...level.queue.iterate()];
      expect(resting.length).toBeGreaterThan(0);
      expect(level.queue.size).toBe(resting.length);
      expect(level.totalQuantity).toBe(resting.reduce((sum, order) => sum + remainingQuantity(order), 0n));
      for (let j = 1; j < resting.length; j += 1) expect(resting[j]!.engineSeq > resting[j - 1]!.engineSeq).toBe(true);
      resting.forEach((order) => {
        expect(order.price).toBe(level.price);
        expect(book.index.get(order.orderId)?.node.value).toBe(order);
      });
      orders += resting.length;
    });
    return orders;
  };
  const bidOrders = checkSide(book.bids.all(), true);
  const askOrders = checkSide(book.asks.all(), false);
  expect(book.index.size).toBe(bidOrders + askOrders);
}

describe('Book properties', () => {
  it('keeps sides sorted, totals exact and the index consistent under random operations', () => {
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 80 }), (ops) => {
        const book = new Book();
        const ids: string[] = [];
        let next = 0n;
        for (const op of ops) {
          if (op.kind === 'add') {
            next += 1n;
            const order: EngineOrder = {
              orderId: `o${next}`, userId: 'u', market: 'BTC-USDT', side: op.side, type: 'LIMIT',
              price: BigInt(op.price), quantity: BigInt(op.quantity), filled: 0n, engineSeq: next,
              postOnly: false, ioc: false, lockedAmount: 0n,
            };
            book.add(order);
            ids.push(order.orderId);
          } else if (ids.length > 0) {
            const id = ids[op.pick % ids.length]!;
            if (op.kind === 'remove') book.remove(id);
            else {
              const order = book.get(id);
              if (order) book.reduce(id, (remainingQuantity(order) * BigInt(op.fraction) + 99n) / 100n);
            }
          }
          assertInvariants(book);
        }
      }),
      { numRuns: 1000 },
    );
  });

  it('round-trips any reachable book through snapshot and restore', () => {
    fc.assert(
      fc.property(fc.array(fc.record({ side: fc.constantFrom(Side.BUY, Side.SELL), price: fc.integer({ min: 1, max: 15 }), quantity: fc.integer({ min: 1, max: 500 }) }), { maxLength: 60 }), (orders) => {
        const book = new Book();
        orders.forEach((o, i) => book.add({
          orderId: `o${i}`, userId: 'u', market: 'BTC-USDT', side: o.side, type: 'LIMIT', price: BigInt(o.price),
          quantity: BigInt(o.quantity), filled: 0n, engineSeq: BigInt(i + 1), postOnly: false, ioc: false, lockedAmount: 0n,
        }));
        const first = JSON.stringify(book.snapshot());
        expect(JSON.stringify(Book.restore(JSON.parse(first)).snapshot())).toBe(first);
      }),
      { numRuns: 1000 },
    );
  });
});
