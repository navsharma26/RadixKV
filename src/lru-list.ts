/**
 * Doubly Linked List Node for LRU tracking.
 */
export class LruNode<K, V> {
  public key: K;
  public value: V;
  public expiresAt: number | null;
  public prev: LruNode<K, V> | null = null;
  public next: LruNode<K, V> | null = null;

  constructor(key: K, value: V, expiresAt: number | null = null) {
    this.key = key;
    this.value = value;
    this.expiresAt = expiresAt;
  }
}

/**
 * High-performance Doubly Linked List with sentinel head and tail nodes.
 * Guarantees strict O(1) insertion, removal, and re-ordering without boundary branch checks.
 */
export class DoublyLinkedList<K, V> {
  private readonly head: LruNode<K, V>;
  private readonly tail: LruNode<K, V>;
  private count: number = 0;

  constructor() {
    // Sentinel nodes (dummy head and tail)
    this.head = new LruNode<K, V>(null as unknown as K, null as unknown as V);
    this.tail = new LruNode<K, V>(null as unknown as K, null as unknown as V);

    this.head.next = this.tail;
    this.tail.prev = this.head;
  }

  public get size(): number {
    return this.count;
  }

  /**
   * Inserts a node at the head (Most Recently Used position).
   */
  public pushFront(node: LruNode<K, V>): void {
    node.prev = this.head;
    node.next = this.head.next;

    this.head.next!.prev = node;
    this.head.next = node;
    this.count++;
  }

  /**
   * Moves an existing node from its current position to the head (MRU).
   */
  public moveToFront(node: LruNode<K, V>): void {
    if (node.prev === this.head) {
      // Already at the front
      return;
    }

    this.unlink(node);

    node.prev = this.head;
    node.next = this.head.next;

    this.head.next!.prev = node;
    this.head.next = node;
    this.count++;
  }

  /**
   * Removes a specific node from the list in O(1).
   */
  public remove(node: LruNode<K, V>): void {
    if (!node.prev || !node.next) {
      return; // Already removed or not in list
    }
    this.unlink(node);
  }

  /**
   * Removes and returns the node at the tail (Least Recently Used position).
   * Returns null if the list is empty.
   */
  public popTail(): LruNode<K, V> | null {
    if (this.count === 0) {
      return null;
    }

    const lruNode = this.tail.prev!;
    this.unlink(lruNode);
    return lruNode;
  }

  /**
   * Returns up to maxCount nodes from the tail (least recently used) without removing them.
   */
  public getTailNodes(maxCount: number): LruNode<K, V>[] {
    const nodes: LruNode<K, V>[] = [];
    let curr = this.tail.prev;
    while (curr && curr !== this.head && nodes.length < maxCount) {
      nodes.push(curr);
      curr = curr.prev;
    }
    return nodes;
  }

  /**
   * Unlinks a node from its neighbors and decrements count.
   */
  private unlink(node: LruNode<K, V>): void {
    if (node.prev && node.next) {
      node.prev.next = node.next;
      node.next.prev = node.prev;

      node.prev = null;
      node.next = null;
      this.count--;
    }
  }

  /**
   * Clears the entire list.
   */
  public clear(): void {
    let current = this.head.next;
    while (current && current !== this.tail) {
      const next = current.next;
      current.prev = null;
      current.next = null;
      current = next;
    }

    this.head.next = this.tail;
    this.tail.prev = this.head;
    this.count = 0;
  }
}
