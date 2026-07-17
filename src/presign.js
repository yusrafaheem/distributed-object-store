'use strict';

const crypto = require('crypto');

const SECRET = process.env.PRESIGN_SECRET || 'dev-secret-change-in-production';

function sign(payload) {
  return crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
}

/**
 * Generates a presigned, time-limited URL path for a given resource + verb,
 * the same pattern S3/GCS use so clients can upload/download directly
 * without round-tripping through an auth check on every single chunk. The
 * signature covers method + resource + expiry, so a signed download URL
 * can't be replayed as an upload, and neither can be used past its expiry.
 */
function presign(method, resourcePath, { ttlSeconds = 300 } = {}) {
  const expiresAt = Date.now() + ttlSeconds * 1000;
  const payload = `${method}:${resourcePath}:${expiresAt}`;
  const signature = sign(payload);
  const url = `${resourcePath}?expires=${expiresAt}&sig=${signature}`;
  return { url, expiresAt, signature };
}

class PresignError extends Error {
  constructor(reason) {
    super(`Presigned URL rejected: ${reason}`);
    this.name = 'PresignError';
  }
}

/**
 * Verifies a presigned request. Throws PresignError with a specific reason
 * (expired vs tampered) rather than a generic boolean, because those are
 * operationally different failure modes worth distinguishing in logs/metrics.
 */
function verifyPresigned(method, resourcePath, { expires, sig }) {
  if (!expires || !sig) throw new PresignError('missing expires/sig');
  const expiresAt = Number(expires);
  if (Number.isNaN(expiresAt)) throw new PresignError('malformed expires');
  if (Date.now() > expiresAt) throw new PresignError('expired');
  const payload = `${method}:${resourcePath}:${expiresAt}`;
  const expected = sign(payload);
  const expectedBuf = Buffer.from(expected, 'hex');
  const actualBuf = Buffer.from(String(sig), 'hex');
  if (expectedBuf.length !== actualBuf.length || !crypto.timingSafeEqual(expectedBuf, actualBuf)) {
    throw new PresignError('tampered');
  }
  return true;
}

module.exports = { presign, verifyPresigned, PresignError };
