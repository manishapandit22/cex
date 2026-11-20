import type { Side } from '@cex/types';
import type { DoublyLinkedList } from './linked-list.js';

export interface EngineOrder {
  orderId: string;
  userId: string;
  market: string;
  side: Side;
  type: 'LIMIT' | 'MARKET';
  /** 0n for market orders; resting orders always have a positive price. */
  price: bigint;
  quantity: bigint;
  filled: bigint;
  /** Time priority: lower engineSeq is matched first at equal price. */
  engineSeq: bigint;
  postOnly: boolean;
  ioc: boolean;
  /** Remaining lock for this order (quote for BUY, base for SELL). */
  lockedAmount: bigint;
}

export interface PriceLevel {
  price: bigint;
  /** Sum of remaining quantity (quantity - filled) of every order in the queue. */
  totalQuantity: bigint;
  queue: DoublyLinkedList<EngineOrder>;
}

export function remainingQuantity(order: EngineOrder): bigint {
  return order.quantity - order.filled;
}
