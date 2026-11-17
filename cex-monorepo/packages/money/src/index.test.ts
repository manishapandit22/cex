import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  MoneyError, SCALE, calcFee, deserialize, fromScaled, isMultipleOf, lockForBuyLimit,
  maxBig, minBig, mulDiv, mulDivCeil, quoteAmount, serialize, toScaled, zScaledString,
} from './index.js';

function normalizeDecimal(value: string): string {
  const whole = value.split('.')[0]!;
  const fraction = value.split('.')[1] ?? '';
  const normalizedWhole = whole.replace(/^0+(?=\d)/, '');
  const normalizedFraction = fraction.replace(/0+$/, '');
  return normalizedFraction.length === 0 ? normalizedWhole : `${normalizedWhole}.${normalizedFraction}`;
}

const decimalArbitrary = fc
  .tuple(
    fc.stringOf(fc.constantFrom(...'0123456789'), { minLength: 1, maxLength: 20 }),
    fc.option(fc.stringOf(fc.constantFrom(...'0123456789'), { minLength: 1, maxLength: 8 }), { nil: undefined }),
  )
  .map(([whole, fraction]) => (fraction === undefined ? whole : `${whole}.${fraction}`));

describe('@cex/money', () => {
  it('adds decimal tenths exactly', () => {
    expect(toScaled('0.1') + toScaled('0.2')).toBe(toScaled('0.3'));
  });

  it('round-trips 10,000 decimal strings in normalized form', () => {
    fc.assert(fc.property(decimalArbitrary, (value) => {
      expect(fromScaled(toScaled(value))).toBe(normalizeDecimal(value));
    }), { numRuns: 10_000 });
  });

  it('implements floor and ceiling formulas without floating point', () => {
    expect(mulDiv(5n, 5n, 2n)).toBe(12n);
    expect(mulDivCeil(5n, 5n, 2n)).toBe(13n);
    expect(quoteAmount(15_000_000n, 200_000_000n)).toBe(30_000_000n);
    expect(lockForBuyLimit(15_000_000n, 200_000_001n)).toBe(30_000_001n);
  });

  it('rounds fees up, including the smallest positive amount', () => {
    expect(calcFee(1n, 10)).toBe(1n);
    expect(calcFee(0n, 10)).toBe(0n);
  });

  it('never undercounts a limit-buy lock', () => {
    fc.assert(fc.property(
      fc.bigInt({ min: 0n, max: SCALE * 1_000_000n }),
      fc.bigInt({ min: 0n, max: SCALE * 1_000_000n }),
      (price, quantity) => {
        expect(lockForBuyLimit(price, quantity) * SCALE).toBeGreaterThanOrEqual(price * quantity);
      },
    ));
  });

  it.each(['1e5', '-1', '1.123456789', '', ' 1', '01x'])('rejects invalid decimal %j', (value) => {
    expect(() => toScaled(value)).toThrow(MoneyError);
  });

  it('preserves every digit in a full order wire round trip', () => {
    const order = {
      orderId: 'order-123', market: 'SOL_USDT', price: 14_250_000_000n,
      quantity: 1_000_000_001n, quoteQuantity: 14_250_000_014n, filledQuantity: 1n,
      balances: [{ available: 999_999_999_999n, locked: 42n }],
    };
    const wire = serialize(order);
    expect(JSON.parse(JSON.stringify(wire))).toEqual(wire);
    expect(deserialize(wire)).toEqual(order);
  });

  it('keeps unmarked numeric strings as strings and validates scaled wire fields', () => {
    expect(deserialize({ id: '000123', amount: '42' })).toEqual({ id: '000123', amount: 42n });
    expect(zScaledString().safeParse('100000000').success).toBe(true);
    expect(zScaledString().safeParse('1.0').success).toBe(false);
  });

  it('formats signed values and exposes comparison and multiple helpers', () => {
    expect(fromScaled(-120_000_000n)).toBe('-1.2');
    expect(fromScaled(120_000_000n, { trimTrailingZeros: false })).toBe('1.20000000');
    expect(isMultipleOf(20n, 10n)).toBe(true);
    expect(minBig(2n, 3n)).toBe(2n);
    expect(maxBig(2n, 3n)).toBe(3n);
  });
});
