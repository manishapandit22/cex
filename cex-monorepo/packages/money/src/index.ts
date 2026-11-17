import { z } from 'zod';

export const SCALE = 100_000_000n;
const BPS_DENOMINATOR = 10_000n;
const SCALED_DECIMAL_PATTERN = /^\d+(?:\.\d{1,8})?$/;

export class MoneyError extends Error { override name = 'MoneyError'; }
export interface FormatOptions { trimTrailingZeros?: boolean; }

/** Parses a non-negative plain decimal string into the exchange's scaled bigint. */
export function toScaled(value: string): bigint {
  if (!SCALED_DECIMAL_PATTERN.test(value)) throw new MoneyError('Amount must be a non-negative decimal string with at most 8 decimal places.');
  const whole = value.split('.')[0]!;
  const fraction = value.split('.')[1] ?? '';
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(8, '0'));
}

/** Formats a scaled bigint without floating-point arithmetic. */
export function fromScaled(value: bigint, options: FormatOptions = {}): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / SCALE;
  let fraction = (absolute % SCALE).toString().padStart(8, '0');
  if (options.trimTrailingZeros !== false) fraction = fraction.replace(/0+$/, '');
  const formatted = fraction.length === 0 ? whole.toString() : `${whole}.${fraction}`;
  return negative ? `-${formatted}` : formatted;
}

export function mulDiv(a: bigint, b: bigint, divisor: bigint): bigint {
  if (divisor === 0n) throw new MoneyError('Division by zero.');
  return (a * b) / divisor;
}

export function mulDivCeil(a: bigint, b: bigint, divisor: bigint): bigint {
  if (divisor <= 0n) throw new MoneyError('Divisor must be positive.');
  const product = a * b;
  if (product < 0n) throw new MoneyError('Ceiling division only supports non-negative values.');
  return (product + divisor - 1n) / divisor;
}

export function quoteAmount(price: bigint, quantity: bigint): bigint { return mulDiv(price, quantity, SCALE); }

/** Fees are charged in the received asset and rounded up. */
export function calcFee(receivedAmount: bigint, feeBps: number): bigint {
  if (!isFinite(feeBps) || feeBps % 1 !== 0 || feeBps < 0) throw new MoneyError('Fee basis points must be a non-negative integer.');
  if (receivedAmount < 0n) throw new MoneyError('Received amount cannot be negative.');
  return mulDivCeil(receivedAmount, BigInt(feeBps), BPS_DENOMINATOR);
}

/** Quote lock for a limit buy, rounded up so it cannot undercount. */
export function lockForBuyLimit(price: bigint, quantity: bigint): bigint { return mulDivCeil(price, quantity, SCALE); }

export function isMultipleOf(value: bigint, step: bigint): boolean {
  if (step <= 0n) throw new MoneyError('Step must be positive.');
  return value % step === 0n;
}
export function minBig(a: bigint, b: bigint): bigint { return a < b ? a : b; }
export function maxBig(a: bigint, b: bigint): bigint { return a > b ? a : b; }

/** Explicitly marked bigint-bearing wire keys; numeric-looking IDs remain strings. */
export const SCALED_WIRE_KEYS = new Set([
  'price', 'quantity', 'quoteQuantity', 'filledQuantity', 'available', 'locked',
  'amount', 'delta', 'tickSize', 'lotSize', 'minNotional', 'makerFee', 'takerFee', 'fee',
]);

type WireValue = null | boolean | string | WireValue[] | { [key: string]: WireValue };

export function serialize(value: unknown): WireValue {
  if (typeof value === 'bigint') return value.toString();
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map(serialize);
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, serialize(entry)]));
  throw new MoneyError('Only JSON-compatible values can be serialized.');
}

/** Restores scaled bigint fields only when their key is explicitly known. */
export function deserialize(value: WireValue): unknown {
  if (Array.isArray(value)) return value.map(deserialize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
      if (SCALED_WIRE_KEYS.has(key) && typeof entry === 'string') {
        if (!/^-?\d+$/.test(entry)) throw new MoneyError(`Invalid scaled value for ${key}.`);
        return [key, BigInt(entry)];
      }
      return [key, deserialize(entry)];
    }));
  }
  return value;
}

/** Zod validator for scaled-integer strings used by API DTOs. */
export function zScaledString(): z.ZodString {
  return z.string().regex(/^\d+$/, 'Expected a non-negative scaled integer string.');
}
