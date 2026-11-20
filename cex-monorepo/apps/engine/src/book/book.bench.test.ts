import { Side } from '@cex/types';
import { describe, expect, it } from 'vitest';
import { Book } from './book.js';

describe('Book benchmark', () => {
  it('completes 100,000 adds and 100,000 cancels in under 1 second', () => {
    const count = 100_000;
    const book = new Book();
    const start = performance.now();
    for (let i = 0; i < count; i += 1) {
      const buy = i % 2 === 0;
      book.add({
        orderId: `o${i}`, userId: 'u', market: 'BTC-USDT', side: buy ? Side.BUY : Side.SELL, type: 'LIMIT',
        // Prices cluster around a mid price, as in a real book (a few hundred levels per side).
        price: BigInt(buy ? 10_000 - (i % 400) : 10_001 + (i % 400)), quantity: 10n, filled: 0n,
        engineSeq: BigInt(i + 1), postOnly: false, ioc: false, lockedAmount: 0n,
      });
    }
    expect(book.size).toBe(count);
    for (let i = 0; i < count; i += 1) book.remove(`o${i}`);
    const elapsed = performance.now() - start;
    expect(book.size).toBe(0);
    expect(book.bids.size).toBe(0);
    expect(book.asks.size).toBe(0);
    expect(elapsed).toBeLessThan(1000);
  });
});
