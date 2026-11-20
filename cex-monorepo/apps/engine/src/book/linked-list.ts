export class ListNode<T> {
  prev: ListNode<T> | null = null;
  next: ListNode<T> | null = null;
  /** The list that currently owns this node; null once removed. */
  list: DoublyLinkedList<T> | null = null;
  constructor(public value: T) {}
}

/** Doubly linked list with O(1) append and O(1) removal of a known node. */
export class DoublyLinkedList<T> {
  private head: ListNode<T> | null = null;
  private tail: ListNode<T> | null = null;
  private length = 0;

  get size(): number { return this.length; }
  get first(): ListNode<T> | null { return this.head; }
  get last(): ListNode<T> | null { return this.tail; }

  pushBack(value: T): ListNode<T> {
    const node = new ListNode(value);
    node.list = this;
    node.prev = this.tail;
    if (this.tail) this.tail.next = node; else this.head = node;
    this.tail = node;
    this.length += 1;
    return node;
  }

  remove(node: ListNode<T>): void {
    if (node.list !== this) throw new Error('Node does not belong to this list.');
    if (node.prev) node.prev.next = node.next; else this.head = node.next;
    if (node.next) node.next.prev = node.prev; else this.tail = node.prev;
    node.prev = null;
    node.next = null;
    node.list = null;
    this.length -= 1;
  }

  *iterate(): IterableIterator<T> {
    for (let node = this.head; node; node = node.next) yield node.value;
  }
}
