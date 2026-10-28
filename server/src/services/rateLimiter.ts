interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * Limitator cu fereastră fixă, în memorie. Se resetează la repornirea serverului,
 * ceea ce este acceptabil: repornirea durează și e controlată de administrator.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(limit: number, windowMs: number, now: () => number = Date.now) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
  }

  /** Câte milisecunde mai trebuie așteptat; 0 dacă cheia nu e blocată. */
  blockedFor(key: string): number {
    const b = this.current(key);
    return b && b.count >= this.limit ? b.resetAt - this.now() : 0;
  }

  /** Înregistrează o încercare. Întoarce true dacă încercarea se încadrează în limită. */
  hit(key: string): boolean {
    const now = this.now();
    let b = this.current(key);
    if (!b) {
      if (this.buckets.size > 10_000) this.sweep();
      b = { count: 0, resetAt: now + this.windowMs };
      this.buckets.set(key, b);
    }
    b.count++;
    return b.count <= this.limit;
  }

  reset(key: string): void {
    this.buckets.delete(key);
  }

  private current(key: string): Bucket | undefined {
    const b = this.buckets.get(key);
    if (b && b.resetAt <= this.now()) {
      this.buckets.delete(key);
      return undefined;
    }
    return b;
  }

  private sweep(): void {
    const now = this.now();
    for (const [k, b] of this.buckets) if (b.resetAt <= now) this.buckets.delete(k);
  }
}
