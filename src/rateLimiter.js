'use strict';

/**
 * Per-client token bucket. Bursts up to `capacity` requests, then refills
 * at `refillPerSecond` tokens/sec. One bucket per client key (IP, API key,
 * whatever the caller uses to identify a client) so one noisy uploader
 * can't starve everyone else's quota — each client's allowance is fully
 * independent.
 */
class TokenBucket {
  constructor(capacity, refillPerSecond) {
    this.capacity = capacity;
    this.refillPerSecond = refillPerSecond;
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }

  _refill() {
    const now = Date.now();
    const elapsedSeconds = (now - this.lastRefill) / 1000;
    if (elapsedSeconds <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSeconds * this.refillPerSecond);
    this.lastRefill = now;
  }

  tryConsume(cost = 1) {
    this._refill();
    if (this.tokens >= cost) {
      this.tokens -= cost;
      return true;
    }
    return false;
  }
}

class RateLimiter {
  constructor({ capacity = 500, refillPerSecond = 200 } = {}) {
    this.capacity = capacity;
    this.refillPerSecond = refillPerSecond;
    this.buckets = new Map();
  }

  _bucketFor(clientKey) {
    let bucket = this.buckets.get(clientKey);
    if (!bucket) {
      bucket = new TokenBucket(this.capacity, this.refillPerSecond);
      this.buckets.set(clientKey, bucket);
    }
    return bucket;
  }

  allow(clientKey, cost = 1) {
    return this._bucketFor(clientKey).tryConsume(cost);
  }

  size() {
    return this.buckets.size;
  }
}

module.exports = { RateLimiter, TokenBucket };
