/**
 * Per-key token buckets. Each device may send `ratePerSec` events on average with bursts up
 * to `burst`. Used to stop one misbehaving device from flooding the pipeline.
 */
export class TokenBuckets {
  constructor({ ratePerSec, burst }) {
    this.rate = ratePerSec / 1000;
    this.burst = burst;
    this.buckets = new Map();
  }

  take(key, now = Date.now()) {
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: this.burst, at: now };
      this.buckets.set(key, b);
    }
    b.tokens = Math.min(this.burst, b.tokens + (now - b.at) * this.rate);
    b.at = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }
}
