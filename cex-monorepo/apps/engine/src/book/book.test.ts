import { Side } from '@cex/types';
import { describe, expect, it } from 'vitest';
import { Book } from './book.js';
import { DoublyLinkedList } from './linked-list.js';
import { SortedPriceLevels } from './price-levels.js';
import type { EngineOrder } from './types.js';

let seq = 0n;
export function makeOrder(overrides: Partial<EngineOrder> & { orderId: string }): EngineOrder {
  seq += 1n;
  return {
    userId: 'user-1', market: 'BTC-USDT', side: Side.BUY, type: 'LIMIT', price: 100n, quantity: 10n, filled: 0n,
    engineSeq: seq, postOnly: false, ioc: false, lockedAmount: 0n, ...overrides,
  };
}

describe('DoublyLinkedList', () => {
  it('appends in order, removes from the middle, and tracks size', () => {
    const list = new DoublyLinkedList<string>();
    const a = list.pushBack('a');
    const b = list.pushBack('b');
    list.pushBack('c');
    list.remove(b);
    expect([...list.iterate()]).toEqual(['a', 'c']);
    expect(list.size).toBe(2);
    expect(list.first).toBe(a);
    expect(list.last?.value).toBe('c');
  });

  it('removes the head and tail and ends empty', () => {
    const list = new DoublyLinkedList<number>();
    const one = list.pushBack(1);
    const two = list.pushBack(2);
    list.remove(one);
    expect(list.first).toBe(two);
    list.remove(two);
    expect(list.first).toBeNull();
    expect(list.last).toBeNull();
    expect(list.size).toBe(0);
  });

  it('rejects removal of a node that is not in the list', () => {
    const list = new DoublyLinkedList<number>();
    const node = list.pushBack(1);
    list.remove(node);
    expect(() => list.remove(node)).toThrow();
    expect(() => new DoublyLinkedList<number>().remove(node)).toThrow();
  });
});

describe('SortedPriceLevels', () => {
  it('keeps bids best-first descending and asks best-first ascending', () => {
    const bids = new SortedPriceLevels(Side.BUY);
    const asks = new SortedPriceLevels(Side.SELL);
    for (const price of [100n, 103n, 101n, 102n]) { bids.getOrCreateLevel(price); asks.getOrCreateLevel(price); }
    expect(bids.topN(10).map((l) => l.price)).toEqual([103n, 102n, 101n, 100n]);
    expect(asks.topN(10).map((l) => l.price)).toEqual([100n, 101n, 102n, 103n]);
    expect(bids.best()?.price).toBe(103n);
    expect(asks.best()?.price).toBe(100n);
  });

  it('returns the same level for the same price and supports lookup and delete', () => {
    const levels = new SortedPriceLevels(Side.BUY);
    const level = levels.getOrCreateLevel(100n);
    expect(levels.getOrCreateLevel(100n)).toBe(level);
    expect(levels.getLevel(100n)).toBe(level);
    expect(levels.getLevel(99n)).toBeUndefined();
    expect(levels.deleteLevel(100n)).toBe(true);
    expect(levels.deleteLevel(100n)).toBe(false);
    expect(levels.best()).toBeUndefined();
  });

  it('limits topN', () => {
    const levels = new SortedPriceLevels(Side.SELL);
    for (const price of [5n, 4n, 3n, 2n, 1n]) levels.getOrCreateLevel(price);
    expect(levels.topN(2).map((l) => l.price)).toEqual([1n, 2n]);
    expect(levels.topN(0)).toEqual([]);
  });
});

describe('Book', () => {
  it('serves orders in FIFO order within a level', () => {
    const book = new Book();
    book.add(makeOrder({ orderId: 'a' }));
    book.add(makeOrder({ orderId: 'b' }));
    book.add(makeOrder({ orderId: 'c' }));
    expect(book.bestBid()?.orderId).toBe('a');
    book.remove('a');
    expect(book.bestBid()?.orderId).toBe('b');
  });

  it('removes from the middle of a level and keeps the total correct', () => {
    const book = new Book();
    book.add(makeOrder({ orderId: 'a', quantity: 1n }));
    book.add(makeOrder({ orderId: 'b', quantity: 2n }));
    book.add(makeOrder({ orderId: 'c', quantity: 4n }));
    expect(book.remove('b')?.orderId).toBe('b');
    expect(book.bids.getLevel(100n)?.totalQuantity).toBe(5n);
    expect([...book.bids.getLevel(100n)!.queue.iterate()].map((o) => o.orderId)).toEqual(['a', 'c']);
  });

  it('finds the best price after deleting levels', () => {
    const book = new Book();
    book.add(makeOrder({ orderId: 'b1', side: Side.BUY, price: 100n }));
    book.add(makeOrder({ orderId: 'b2', side: Side.BUY, price: 101n }));
    book.add(makeOrder({ orderId: 'b3', side: Side.BUY, price: 99n }));
    book.add(makeOrder({ orderId: 'a1', side: Side.SELL, price: 105n }));
    book.add(makeOrder({ orderId: 'a2', side: Side.SELL, price: 103n }));
    expect(book.bestBid()?.price).toBe(101n);
    expect(book.bestAsk()?.price).toBe(103n);
    book.remove('b2');
    book.remove('a2');
    expect(book.bestBid()?.price).toBe(100n);
    expect(book.bestAsk()?.price).toBe(105n);
    book.remove('a1');
    expect(book.bestAsk()).toBeUndefined();
  });

  it('deletes a level when its last order is removed', () => {
    const book = new Book();
    book.add(makeOrder({ orderId: 'a' }));
    book.remove('a');
    expect(book.bids.size).toBe(0);
    expect(book.size).toBe(0);
  });

  it('reduces on partial fills and removes the order when fully filled', () => {
    const book = new Book();
    book.add(makeOrder({ orderId: 'a', quantity: 10n }));
    const partial = book.reduce('a', 4n);
    expect(partial.filled).toBe(4n);
    expect(book.bids.getLevel(100n)?.totalQuantity).toBe(6n);
    expect(book.get('a')).toBeDefined();
    book.reduce('a', 6n);
    expect(book.get('a')).toBeUndefined();
    expect(book.bids.size).toBe(0);
  });

  it('counts already-filled quantity out of the level total', () => {
    const book = new Book();
    book.add(makeOrder({ orderId: 'a', quantity: 10n, filled: 3n }));
    expect(book.bids.getLevel(100n)?.totalQuantity).toBe(7n);
  });

  it('reports aggregated depth best first', () => {
    const book = new Book();
    book.add(makeOrder({ orderId: 'b1', side: Side.BUY, price: 100n, quantity: 2n }));
    book.add(makeOrder({ orderId: 'b2', side: Side.BUY, price: 100n, quantity: 3n }));
    book.add(makeOrder({ orderId: 'b3', side: Side.BUY, price: 99n, quantity: 1n }));
    book.add(makeOrder({ orderId: 'a1', side: Side.SELL, price: 101n, quantity: 7n }));
    expect(book.depth(1)).toEqual({ bids: [[100n, 5n]], asks: [[101n, 7n]] });
    expect(book.depth(10).bids).toEqual([[100n, 5n], [99n, 1n]]);
  });

  it('returns undefined for unknown ids and throws for invalid operations', () => {
    const book = new Book();
    book.add(makeOrder({ orderId: 'a', quantity: 5n }));
    expect(book.remove('missing')).toBeUndefined();
    expect(book.get('missing')).toBeUndefined();
    expect(() => book.add(makeOrder({ orderId: 'a' }))).toThrow(/already/);
    expect(() => book.add(makeOrder({ orderId: 'm', price: 0n }))).toThrow();
    expect(() => book.add(makeOrder({ orderId: 'z', quantity: 5n, filled: 5n }))).toThrow();
    expect(() => book.reduce('missing', 1n)).toThrow();
    expect(() => book.reduce('a', 0n)).toThrow();
    expect(() => book.reduce('a', 6n)).toThrow();
  });
});

describe('Book snapshot', () => {
  function populated(): Book {
    const book = new Book();
    book.add(makeOrder({ orderId: 'b1', side: Side.BUY, price: 100n, quantity: 5n, lockedAmount: 500n }));
    book.add(makeOrder({ orderId: 'b2', side: Side.BUY, price: 102n, quantity: 3n, postOnly: true }));
    book.add(makeOrder({ orderId: 'b3', side: Side.BUY, price: 100n, quantity: 2n }));
    book.add(makeOrder({ orderId: 'a1', side: Side.SELL, price: 110n, quantity: 4n, ioc: true }));
    book.add(makeOrder({ orderId: 'a2', side: Side.SELL, price: 108n, quantity: 9n }));
    book.reduce('b1', 2n);
    return book;
  }

  it('lists bids descending and asks ascending with orders in FIFO order', () => {
    const snapshot = populated().snapshot();
    expect(snapshot.bids.map((l) => l.price)).toEqual(['102', '100']);
    expect(snapshot.asks.map((l) => l.price)).toEqual(['108', '110']);
    expect(snapshot.bids[1]!.orders.map((o) => o.orderId)).toEqual(['b1', 'b3']);
  });

  it('is byte-identical after snapshot -> restore -> snapshot', () => {
    const first = JSON.stringify(populated().snapshot());
    const second = JSON.stringify(Book.restore(JSON.parse(first)).snapshot());
    expect(second).toBe(first);
  });

  it('restores a book that behaves like the original', () => {
    const restored = Book.restore(populated().snapshot());
    expect(restored.bestBid()?.orderId).toBe('b2');
    expect(restored.bestAsk()?.orderId).toBe('a2');
    expect(restored.bids.getLevel(100n)?.totalQuantity).toBe(5n);
    expect(restored.size).toBe(5);
    expect(restored.get('a1')?.ioc).toBe(true);
  });

  it('snapshots an empty book', () => {
    expect(new Book().snapshot()).toEqual({ bids: [], asks: [] });
  });
});
