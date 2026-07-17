'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { generatePresignedUrl, verifyPresignedSignature } = require('../src/presign');

const SECRET = 'test-secret-key-do-not-use-in-prod';

test('a freshly presigned URL verifies successfully', () => {
  const { signature, expiresAt } = generatePresignedUrl({
    secret: SECRET,
    method: 'GET',
    resourcePath: '/files/abc123/download-presigned',
    ttlSeconds: 60,
  });

  const result = verifyPresignedSignature({
    secret: SECRET,
    method: 'GET',
    resourcePath: '/files/abc123/download-presigned',
    signature,
    expiresAt,
  });

  assert.equal(result.valid, true);
});

test('an expired URL is rejected', () => {
  const { signature } = generatePresignedUrl({
    secret: SECRET,
    method: 'GET',
    resourcePath: '/files/abc123/download-presigned',
    ttlSeconds: 60,
  });

  const alreadyExpired = Date.now() - 1000;
  const result = verifyPresignedSignature({
    secret: SECRET,
    method: 'GET',
    resourcePath: '/files/abc123/download-presigned',
    signature,
    expiresAt: alreadyExpired,
  });

  assert.equal(result.valid, false);
  assert.equal(result.reason, 'expired');
});

test('a tampered signature is rejected', () => {
  const { signature, expiresAt } = generatePresignedUrl({
    secret: SECRET,
    method: 'GET',
    resourcePath: '/files/abc123/download-presigned',
    ttlSeconds: 60,
  });

  const tampered = signature.slice(0, -4) + 'AAAA';
  const result = verifyPresignedSignature({
    secret: SECRET,
    method: 'GET',
    resourcePath: '/files/abc123/download-presigned',
    signature: tampered,
    expiresAt,
  });

  assert.equal(result.valid, false);
  assert.equal(result.reason, 'bad_signature');
});

test('a signature cannot be reused for a different HTTP method', () => {
  const { signature, expiresAt } = generatePresignedUrl({
    secret: SECRET,
    method: 'GET',
    resourcePath: '/files/abc123/download-presigned',
    ttlSeconds: 60,
  });

  const result = verifyPresignedSignature({
    secret: SECRET,
    method: 'DELETE',
    resourcePath: '/files/abc123/download-presigned',
    signature,
    expiresAt,
  });

  assert.equal(result.valid, false);
  assert.equal(result.reason, 'bad_signature');
});

test('a signature cannot be reused for a different resource path', () => {
  const { signature, expiresAt } = generatePresignedUrl({
    secret: SECRET,
    method: 'GET',
    resourcePath: '/files/abc123/download-presigned',
    ttlSeconds: 60,
  });

  const result = verifyPresignedSignature({
    secret: SECRET,
    method: 'GET',
    resourcePath: '/files/some-other-file/download-presigned',
    signature,
    expiresAt,
  });

  assert.equal(result.valid, false);
  assert.equal(result.reason, 'bad_signature');
});
