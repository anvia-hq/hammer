interface Entry<T> { value: T; storedAt: number }
export class TtlCache<T> {
  private entries = new Map<string, Entry<T>>();
  constructor(private ttlMs: number) {}
  set(key: string, value: T): void {
    this.entries.set(key, { value, storedAt: Date.now() });
  }
  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.storedAt < this.ttlMs) return undefined;
    return entry.value;
  }
}
