'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { TokenBucket, RateLimiter } = require('../src/rateLimiter');

test('TokenBucket allows bursts up to capacity then rejects', () => {
  const bucket = new TokenBucket({ capacity: 5, refillRatePerSecond: 0 });

  for (let i = 0; i < 5; i++) {
    assert.equal(bucket.tryRemoveToken(), true, `token ${i} should be allowed`);
  }
  assert.equal(bucket.tryRemoveToken(), false, 'bucket should be exhausted after capacity is used');
});

test('TokenBucket refills over time', async () => {
  const bucket = new TokenBucket({ capacity: 2, refillRatePerSecond: 100 });

  assert.equal(bucket.tryRemoveToken(), true);
  assert.equal(bucket.tryRemoveToken(), true);
  assert.equal(bucket.tryRemoveToken(), false);

  // At 100 tokens/sec, waiting 30ms should refill at least one token.
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(bucket.tryRemoveToken(), true);
});

test('RateLimiter gives each client key an independent bucket', () => {
  const limiter = new RateLimiter({ capacity: 2, refillRatePerSecond: 0 });

  assert.equal(limiter.allow('client-a'), true);
  assert.equal(limiter.allow('client-a'), true);
  assert.equal(limiter.allow('client-a'), false);

  // client-b has never made a request, so it should have its own fresh bucket.
  assert.equal(limiter.allow('client-b'), true);
  assert.equal(limiter.allow('client-b'), true);
  assert.equal(limiter.allow('client-b'), false);
});
