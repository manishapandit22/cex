import { Side } from '@cex/types';
import { DoublyLinkedList } from './linked-list.js';
import type { EngineOrder, PriceLevel } from './types.js';

/**
 * Price levels for one side of a book, kept in a sorted array ordered worst to best,
 * so the best level is the last element: reading and removing it is O(1), and
 * locating any level is a binary search.
 */
export class SortedPriceLevels {
  private readonly levels: PriceLevel[] = [];

  constructor(readonly side: Side) {}

  get size(): number { return this.levels.length; }

  /** True when price `a` is worse than price `b` for this side. */
  private isWorse(a: bigint, b: bigint): boolean {
    return this.side === Side.BUY ? a < b : a > b;
  }

  /** Index of the level at `price`, or the insertion index when absent. */
  private search(price: bigint): { index: number; found: boolean } {
    let low = 0;
    let high = this.levels.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      const level = this.levels[mid]!;
      if (level.price === price) return { index: mid, found: true };
      if (this.isWorse(level.price, price)) low = mid + 1; else high = mid;
    }
    return { index: low, found: false };
  }

  best(): PriceLevel | undefined { return this.levels[this.levels.length - 1]; }

  getLevel(price: bigint): PriceLevel | undefined {
    const { index, found } = this.search(price);
    return found ? this.levels[index] : undefined;
  }

  getOrCreateLevel(price: bigint): PriceLevel {
    const { index, found } = this.search(price);
    if (found) return this.levels[index]!;
    const level: PriceLevel = { price, totalQuantity: 0n, queue: new DoublyLinkedList<EngineOrder>() };
    this.levels.splice(index, 0, level);
    return level;
  }

  deleteLevel(price: bigint): boolean {
    const { index, found } = this.search(price);
    if (!found) return false;
    this.levels.splice(index, 1);
    return true;
  }

  /** The best `n` levels, best first. */
  topN(n: number): PriceLevel[] {
    const result: PriceLevel[] = [];
    for (let i = this.levels.length - 1; i >= 0 && result.length < n; i -= 1) result.push(this.levels[i]!);
    return result;
  }

  /** Every level, best first. */
  all(): PriceLevel[] { return this.topN(this.levels.length); }
}
