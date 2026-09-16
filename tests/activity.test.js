import test from 'node:test';
import assert from 'node:assert/strict';
import activity from '../api/activity.js';

function response() {
  const headers = new Map();
  return {
    headers,
    setHeader(name, value) { headers.set(name.toLowerCase(), value); },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; },
  };
}

test('activity fails closed without an approved course-sales source and performs no merchant lookup', async () => {
  const previousFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error('No merchant financial data should be fetched'); };
  try {
    const res = response();
    await activity({ method: 'GET', headers: { origin: 'https://formumaxlabs.com' } }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, []);
    assert.equal(requests, 0);
    assert.match(res.headers.get('cache-control'), /no-store/);
  } finally { globalThis.fetch = previousFetch; }
});

test('visitors cannot submit fabricated purchases to the activity endpoint', async () => {
  const res = response();
  await activity({
    method: 'POST', headers: { origin: 'https://formumaxlabs.com', 'content-type': 'application/json' },
    body: { purchaser: 'Invented Buyer', purchasedAt: new Date().toISOString(), amount: 29 },
  }, res);
  assert.equal(res.statusCode, 405);
  assert.equal(res.body.error.code, 'METHOD_NOT_ALLOWED');
  assert.equal(res.headers.get('allow'), 'GET');
});
