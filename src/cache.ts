/**
 * Small TTL cache that also de-duplicates concurrent in-flight requests:
 * if two callers ask for the same key at once, only one upstream call is made
 * and both await the same promise. Failed lookups are not cached.
 */
export class AsyncTtlCache<V> {
  private readonly entries = new Map<string, { value: Promise<V>; expires: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 1000,
  ) {}

  get(key: string, load: () => Promise<V>): Promise<V> {
    const now = Date.now();
    const hit = this.entries.get(key);
    if (hit && hit.expires > now) return hit.value;

    const value = load();
    this.entries.set(key, { value, expires: now + this.ttlMs });
    value.catch(() => {
      // Only evict if this exact promise is still the cached one.
      if (this.entries.get(key)?.value === value) this.entries.delete(key);
    });
    this.evict();
    return value;
  }

  private evict(): void {
    if (this.entries.size <= this.maxEntries) return;
    const now = Date.now();
    for (const [k, e] of this.entries) if (e.expires <= now) this.entries.delete(k);
    // Map preserves insertion order, so the first keys are the oldest.
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}
