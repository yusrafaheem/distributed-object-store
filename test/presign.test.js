'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { presign, verifyPresigned, PresignError } = require('../src/presign');

const METHOD = 'GET';
const RESOURCE_PATH = '/files/abc123/download-presigned';

test('a freshly presigned URL verifies successfully', () => {
  const { expiresAt, signature } = presign(METHOD, RESOURCE_PATH, { ttlSeconds: 60 });

  assert.doesNotThrow(() =>
    verifyPresigned(METHOD, RESOURCE_PATH, { expires: expiresAt, sig: signature })
  );
});

test('an expired URL is rejected', () => {
  const { signature } = presign(METHOD, RESOURCE_PATH, { ttlSeconds: 60 });
  const alreadyExpired = Date.now() - 1000;

  assert.throws(
    () => verifyPresigned(METHOD, RESOURCE_PATH, { expires: alreadyExpired, sig: signature }),
    (err) => err instanceof PresignError && /expired/.test(err.message)
  );
});

test('a tampered signature is rejected', () => {
  const { expiresAt, signature } = presign(METHOD, RESOURCE_PATH, { ttlSeconds: 60 });
  const tampered = signature.slice(0, -4) + 'aaaa';

  assert.throws(
    () => verifyPresigned(METHOD, RESOURCE_PATH, { expires: expiresAt, sig: tampered }),
    (err) => err instanceof PresignError && /tampered/.test(err.message)
  );
});

test('a signature cannot be reused for a different HTTP method', () => {
  const { expiresAt, signature } = presign(METHOD, RESOURCE_PATH, { ttlSeconds: 60 });

  assert.throws(
    () => verifyPresigned('DELETE', RESOURCE_PATH, { expires: expiresAt, sig: signature }),
    (err) => err instanceof PresignError && /tampered/.test(err.message)
  );
});

test('a signature cannot be reused for a different resource path', () => {
  const { expiresAt, signature } = presign(METHOD, RESOURCE_PATH, { ttlSeconds: 60 });

  assert.throws(
    () => verifyPresigned(METHOD, '/files/some-other-file/download-presigned', { expires: expiresAt, sig: signature }),
    (err) => err instanceof PresignError && /tampered/.test(err.message)
  );
});
