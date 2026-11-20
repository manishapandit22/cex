import { Side } from '@cex/types';
import type { ListNode } from './linked-list.js';
import { SortedPriceLevels } from './price-levels.js';
import { remainingQuantity, type EngineOrder } from './types.js';

export interface IndexEntry { side: Side; price: bigint; node: ListNode<EngineOrder>; }

export interface SnapshotOrder {
  orderId: string; userId: string; market: string; side: Side; type: 'LIMIT' | 'MARKET';
  price: string; quantity: string; filled: string; engineSeq: string;
  postOnly: boolean; ioc: boolean; lockedAmount: string;
}
export interface SnapshotLevel { price: string; orders: SnapshotOrder[]; }
/** Deterministic: bids by descending price, asks by ascending price, orders in FIFO order. */
export interface BookSnapshot { bids: SnapshotLevel[]; asks: SnapshotLevel[]; }

export type DepthLevel = [price: bigint, totalQuantity: bigint];

/**
 * A pure, I/O-free order book for one market. It stores resting orders only: it does not
 * match, and it does not prevent a crossed book (that is the matching engine's job).
 */
export class Book {
  readonly bids = new SortedPriceLevels(Side.BUY);
  readonly asks = new SortedPriceLevels(Side.SELL);
  readonly index = new Map<string, IndexEntry>();

  private levelsFor(side: Side): SortedPriceLevels { return side === Side.BUY ? this.bids : this.asks; }

  get size(): number { return this.index.size; }

  add(order: EngineOrder): void {
    if (this.index.has(order.orderId)) throw new Error(`Order ${order.orderId} is already in the book.`);
    if (order.price <= 0n) throw new Error('Only orders with a positive price can rest in the book.');
    if (order.filled < 0n || remainingQuantity(order) <= 0n) throw new Error('Order has no remaining quantity.');
    const level = this.levelsFor(order.side).getOrCreateLevel(order.price);
    const node = level.queue.pushBack(order);
    level.totalQuantity += remainingQuantity(order);
    this.index.set(order.orderId, { side: order.side, price: order.price, node });
  }

  get(orderId: string): EngineOrder | undefined { return this.index.get(orderId)?.node.value; }

  /** Removes a resting order in O(1) and returns it, or undefined if unknown. */
  remove(orderId: string): EngineOrder | undefined {
    const entry = this.index.get(orderId);
    if (!entry) return undefined;
    const levels = this.levelsFor(entry.side);
    const level = levels.getLevel(entry.price)!;
    const order = entry.node.value;
    level.queue.remove(entry.node);
    level.totalQuantity -= remainingQuantity(order);
    if (level.queue.size === 0) levels.deleteLevel(level.price);
    this.index.delete(orderId);
    return order;
  }

  /** Applies a (partial) fill of `quantity`; the order leaves the book when fully filled. */
  reduce(orderId: string, quantity: bigint): EngineOrder {
    const entry = this.index.get(orderId);
    if (!entry) throw new Error(`Order ${orderId} is not in the book.`);
    const order = entry.node.value;
    if (quantity <= 0n || quantity > remainingQuantity(order)) {
      throw new Error('Fill quantity must be positive and at most the remaining quantity.');
    }
    const level = this.levelsFor(entry.side).getLevel(entry.price)!;
    order.filled += quantity;
    level.totalQuantity -= quantity;
    if (remainingQuantity(order) === 0n) this.remove(orderId);
    return order;
  }

  bestBid(): EngineOrder | undefined { return this.bids.best()?.queue.first?.value; }
  bestAsk(): EngineOrder | undefined { return this.asks.best()?.queue.first?.value; }

  /** Aggregated L2 depth, best level first. */
  depth(n: number): { bids: DepthLevel[]; asks: DepthLevel[] } {
    const toDepth = (levels: SortedPriceLevels): DepthLevel[] =>
      levels.topN(n).map((level): DepthLevel => [level.price, level.totalQuantity]);
    return { bids: toDepth(this.bids), asks: toDepth(this.asks) };
  }

  snapshot(): BookSnapshot {
    const dump = (levels: SortedPriceLevels): SnapshotLevel[] => levels.all().map((level) => ({
      price: level.price.toString(),
      orders: [...level.queue.iterate()].map((order): SnapshotOrder => ({
        orderId: order.orderId, userId: order.userId, market: order.market, side: order.side, type: order.type,
        price: order.price.toString(), quantity: order.quantity.toString(), filled: order.filled.toString(),
        engineSeq: order.engineSeq.toString(), postOnly: order.postOnly, ioc: order.ioc,
        lockedAmount: order.lockedAmount.toString(),
      })),
    }));
    return { bids: dump(this.bids), asks: dump(this.asks) };
  }

  static restore(snapshot: BookSnapshot): Book {
    const book = new Book();
    for (const level of [...snapshot.bids, ...snapshot.asks]) {
      for (const o of level.orders) {
        book.add({
          orderId: o.orderId, userId: o.userId, market: o.market, side: o.side, type: o.type,
          price: BigInt(o.price), quantity: BigInt(o.quantity), filled: BigInt(o.filled),
          engineSeq: BigInt(o.engineSeq), postOnly: o.postOnly, ioc: o.ioc, lockedAmount: BigInt(o.lockedAmount),
        });
      }
    }
    return book;
  }
}
