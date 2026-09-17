import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import configHandler from '../api/config.js';
import ordersHandler from '../api/orders.js';
import captureHandler from '../api/capture.js';
import accessHandler from '../api/access.js';
import { COOKIES, createOrder, OFFER_DURATION_MS, PRODUCT, signToken } from '../lib/payments.js';

const ORIGIN = 'https://formumaxlabs.vercel.app';
const ORDER_ID = '5O190127TN364715T';
const CAPTURE_ID = '8MC585209K746392H';
const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
const originalNow = Date.now;
let counter = 0;

beforeEach(() => {
  Object.assign(process.env, {
    PAYPAL_CLIENT_ID: `test-client-${++counter}`,
    PAYPAL_CLIENT_SECRET: 'mock-server-only-secret',
    ACCESS_TOKEN_SECRET: 'mock-signing-key-32-characters-long-for-tests',
    COURSE_NOTION_URL: 'https://course.notion.site/worldwide-course',
    SITE_URL: ORIGIN,
    META_PIXEL_ID: '1467482891263700',
  });
  delete process.env.META_CAPI_ACCESS_TOKEN;
  delete process.env.META_TEST_EVENT_CODE;
  delete process.env.VERCEL_URL;
  delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
});
afterEach(() => {
  Date.now = originalNow;
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
});

function browser() {
  const jar = new Map();
  return {
    jar,
    async call(handler, { method = 'GET', body, headers = {}, cookie } = {}) {
      const storedHeaders = new Map();
      const req = {
        method, body,
        headers: {
          origin: ORIGIN,
          'content-type': 'application/json',
          'sec-fetch-site': 'same-origin',
          'user-agent': 'Test Browser',
          'x-forwarded-for': '203.0.113.10',
          cookie: cookie ?? [...jar].map(([key, value]) => `${key}=${value}`).join('; '),
          ...headers,
        },
      };
      const res = {
        statusCode: 200,
        headers: storedHeaders,
        setHeader(name, value) { storedHeaders.set(name.toLowerCase(), value); },
        getHeader(name) { return storedHeaders.get(name.toLowerCase()); },
        status(code) { this.statusCode = code; return this; },
        json(data) { this.body = data; return this; },
      };
      await handler(req, res);
      for (const cookieValue of storedHeaders.get('set-cookie') || []) {
        const part = cookieValue.split(';')[0];
        const equals = part.indexOf('=');
        jar.set(part.slice(0, equals), part.slice(equals + 1));
      }
      return res;
    },
  };
}

function provider({ captureStatus = 'COMPLETED', approve = true, mutateOrder, captureTimeout = false, metaError = false, price = '19.00', existingSessionId } = {}) {
  const courseOrder = sessionId => ({
    id: ORDER_ID, intent: 'CAPTURE', status: approve ? 'APPROVED' : 'CREATED',
    payer: { email_address: 'Buyer@example.com' },
    purchase_units: [{
      reference_id: 'ultimate-video-ai-mastery',
      custom_id: `ultimate-video-ai-mastery:${sessionId}`,
      amount: { value: price, currency_code: 'USD' },
      items: [{ sku: 'ultimate-video-ai-mastery', quantity: '1', unit_amount: { value: price, currency_code: 'USD' } }],
    }],
  });
  const state = { calls: [], order: existingSessionId ? courseOrder(existingSessionId) : null, captured: false, meta: [] };
  globalThis.fetch = async (url, options = {}) => {
    const path = new URL(url).pathname;
    state.calls.push({ url, options, path });
    if (url.startsWith('https://graph.facebook.com/')) {
      state.meta.push(JSON.parse(options.body));
      if (metaError) throw new Error('Mock Meta outage');
      return Response.json({ events_received: 1 });
    }
    assert.equal(new URL(url).origin, 'https://api-m.paypal.com', 'all PayPal requests must be LIVE');
    if (path === '/v1/oauth2/token') return Response.json({ access_token: 'mock-oauth-token', expires_in: 600 });
    if (path === '/v2/checkout/orders' && options.method === 'POST') {
      const request = JSON.parse(options.body);
      const sessionId = request.purchase_units[0].custom_id.split(':')[1];
      state.order = courseOrder(sessionId);
      return Response.json({ id: ORDER_ID, status: 'CREATED' }, { status: 201 });
    }
    const capture = {
      id: CAPTURE_ID, status: captureStatus,
      amount: { value: price, currency_code: 'USD' },
      supplementary_data: { related_ids: { order_id: ORDER_ID } },
      create_time: '2026-09-16T08:00:00Z',
    };
    if (path === `/v2/checkout/orders/${ORDER_ID}/capture`) {
      state.captured = true;
      if (captureTimeout) throw new Error('Mock response lost after successful capture');
      return Response.json({ id: ORDER_ID, status: 'COMPLETED' }, { status: 201 });
    }
    if (path === `/v2/checkout/orders/${ORDER_ID}`) {
      const result = structuredClone(state.order);
      if (state.captured) {
        result.status = 'COMPLETED';
        result.purchase_units[0].payments = { captures: [capture] };
      }
      if (mutateOrder) mutateOrder(result);
      return Response.json(result);
    }
    if (path === `/v2/payments/captures/${CAPTURE_ID}`) return Response.json(capture);
    throw new Error(`Unexpected mock request: ${path}`);
  };
  return state;
}

async function begin(client, consent = false) {
  const config = await client.call(configHandler);
  assert.equal(config.statusCode, 200);
  assert.equal(config.body.checkoutAvailable, true);
  const result = await client.call(ordersHandler, {
    method: 'POST', body: { productId: PRODUCT.id, consent, fbp: 'fb.1.1726473600000.12345' },
  });
  assert.equal(result.statusCode, 201);
  return result;
}

test('config initializes secure checkout session without exposing secrets or course URL', async () => {
  const client = browser();
  const result = await client.call(configHandler);
  assert.equal(result.body.price, '19.00');
  assert.equal(result.body.currency, 'USD');
  assert.equal(result.body.checkoutAvailable, true);
  assert.ok(!JSON.stringify(result.body).includes('notion'));
  assert.ok(!JSON.stringify(result.body).includes(process.env.PAYPAL_CLIENT_SECRET));
  assert.match(result.headers.get('set-cookie')[0], /HttpOnly; Secure; SameSite=Lax/);
  assert.match(result.headers.get('cache-control'), /no-store/);
});

test('missing course fulfillment URL closes checkout before any PayPal request', async () => {
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error('Network must not be called'); };
  delete process.env.COURSE_NOTION_URL;
  const client = browser();
  const config = await client.call(configHandler);
  assert.equal(config.body.checkoutAvailable, false);
  assert.equal(config.body.paypalClientId, null);
  const order = await client.call(ordersHandler, { method: 'POST', body: { productId: PRODUCT.id } });
  assert.equal(order.statusCode, 503);
  assert.equal(requests, 0);
});

test('order creation uses fixed server price and stable idempotency key on response recovery', async () => {
  const state = provider();
  const client = browser();
  await begin(client);
  const first = state.calls.find(call => call.path === '/v2/checkout/orders');
  const payload = JSON.parse(first.options.body);
  assert.deepEqual(payload.purchase_units[0].amount, { currency_code: 'USD', value: '19.00', breakdown: { item_total: { currency_code: 'USD', value: '19.00' } } });
  assert.equal(payload.purchase_units[0].items[0].category, 'DIGITAL_GOODS');
  assert.equal(payload.application_context.shipping_preference, 'NO_SHIPPING');
  client.jar.delete(COOKIES.order); // Simulate a lost create response, preserving config session.
  await client.call(ordersHandler, { method: 'POST', body: { productId: PRODUCT.id } });
  const creates = state.calls.filter(call => call.path === '/v2/checkout/orders');
  assert.equal(creates.length, 2);
  assert.equal(creates[0].options.headers['PayPal-Request-Id'], creates[1].options.headers['PayPal-Request-Id']);
  assert.ok(creates[0].options.headers['PayPal-Request-Id'].length <= 38);
});

test('client amount/currency/product changes are rejected without creating orders', async () => {
  const state = provider();
  const client = browser();
  await client.call(configHandler);
  for (const body of [
    { productId: PRODUCT.id, amount: '0.01' },
    { productId: PRODUCT.id, price: '0.01' },
    { productId: PRODUCT.id, currency: 'EUR' },
    { productId: 'different-product' },
    { productId: PRODUCT.id, consent: 'true' },
  ]) {
    const result = await client.call(ordersHandler, { method: 'POST', body });
    assert.equal(result.statusCode, 400);
  }
  assert.equal(state.calls.length, 0);
});

test('cross-site mutations, unsupported methods, and oversized requests are denied', async () => {
  const state = provider();
  const client = browser();
  await client.call(configHandler);
  const denied = await client.call(ordersHandler, { method: 'POST', body: { productId: PRODUCT.id }, headers: { origin: 'https://attacker.example' } });
  assert.equal(denied.statusCode, 403);
  const missingOrigin = await client.call(ordersHandler, { method: 'POST', body: {}, headers: { origin: '' } });
  assert.equal(missingOrigin.statusCode, 403);
  const badMethod = await client.call(captureHandler);
  assert.equal(badMethod.statusCode, 405);
  const large = await client.call(ordersHandler, { method: 'POST', body: {}, headers: { 'content-length': '9000' } });
  assert.equal(large.statusCode, 413);
  const chunked = await client.call(ordersHandler, { method: 'POST', body: { productId: PRODUCT.id, fbp: 'x'.repeat(9000) } });
  assert.equal(chunked.statusCode, 413);
  assert.equal(state.calls.length, 0);
});

test('capture requires ownership: copied order IDs and modified cookies cannot unlock access', async () => {
  const state = provider();
  const buyer = browser();
  await begin(buyer);
  const attacker = browser();
  await attacker.call(configHandler);
  const withoutCookie = await attacker.call(captureHandler, { method: 'POST', body: { orderId: ORDER_ID } });
  assert.equal(withoutCookie.statusCode, 403);
  const original = buyer.jar.get(COOKIES.order);
  buyer.jar.set(COOKIES.order, `x${original.slice(1)}`);
  const tampered = await buyer.call(captureHandler, { method: 'POST', body: { orderId: ORDER_ID } });
  assert.equal(tampered.statusCode, 403);
  assert.equal(state.captured, false);
});

test('only exact production origins allow a DNS-only custom-domain switch', async () => {
  provider();
  const client = browser();
  await client.call(configHandler);
  for (const origin of ['https://formumaxlabs.com', 'https://www.formumaxlabs.com', ORIGIN]) {
    const result = await client.call(ordersHandler, { method: 'POST', body: { productId: PRODUCT.id }, headers: { origin } });
    assert.ok([200, 201].includes(result.statusCode), origin);
  }
  for (const origin of ['https://formumaxlabs.com.attacker.example', 'https://fake.formumaxlabs.com', 'http://formumaxlabs.com']) {
    const result = await client.call(ordersHandler, { method: 'POST', body: { productId: PRODUCT.id }, headers: { origin } });
    assert.equal(result.statusCode, 403, origin);
  }
});

test('successful capture grants access once and repeated capture does not charge again', async () => {
  const state = provider();
  const buyer = browser();
  await begin(buyer);
  const first = await buyer.call(captureHandler, { method: 'POST', body: { orderId: ORDER_ID } });
  assert.equal(first.statusCode, 200);
  assert.equal(first.body.notionUrl, process.env.COURSE_NOTION_URL);
  assert.equal(first.body.eventId, `purchase_${CAPTURE_ID}`);
  assert.ok(buyer.jar.has(COOKIES.access));
  const second = await buyer.call(captureHandler, { method: 'POST', body: { orderId: ORDER_ID } });
  assert.equal(second.statusCode, 200);
  assert.equal(second.body.eventId, first.body.eventId);
  assert.equal(state.calls.filter(call => call.path.endsWith('/capture')).length, 1);
  const access = await buyer.call(accessHandler);
  assert.equal(access.statusCode, 200);
  assert.equal(access.body.captureId, CAPTURE_ID);
});

test('lost capture response recovers completed payment safely without a second capture', async () => {
  const state = provider({ captureTimeout: true });
  const client = browser();
  await begin(client);
  const result = await client.call(captureHandler, { method: 'POST', body: { orderId: ORDER_ID } });
  assert.equal(result.statusCode, 200);
  assert.equal(state.calls.filter(call => call.path.endsWith('/capture')).length, 1);
});

test('unapproved payments never call capture or grant access', async () => {
  const state = provider({ approve: false });
  const client = browser();
  await begin(client);
  const result = await client.call(captureHandler, { method: 'POST', body: { orderId: ORDER_ID } });
  assert.equal(result.statusCode, 409);
  assert.equal(result.body.error.code, 'PAYMENT_NOT_APPROVED');
  assert.equal(state.captured, false);
  assert.ok(!client.jar.has(COOKIES.access));
});

test('PayPal product, amount, currency, and ownership mismatches are rejected before capture', async () => {
  for (const mutateOrder of [
    order => { order.purchase_units[0].amount.value = '0.01'; },
    order => { order.purchase_units[0].amount.currency_code = 'EUR'; },
    order => { order.purchase_units[0].items[0].sku = 'wrong-product'; },
    order => { order.purchase_units[0].custom_id = 'wrong-session'; },
    order => { order.purchase_units.push(structuredClone(order.purchase_units[0])); },
  ]) {
    const state = provider({ mutateOrder });
    const client = browser();
    await begin(client);
    const result = await client.call(captureHandler, { method: 'POST', body: { orderId: ORDER_ID } });
    assert.equal(result.statusCode, 409);
    assert.equal(result.body.error.code, 'PAYMENT_MISMATCH');
    assert.equal(state.captured, false);
    assert.ok(!client.jar.has(COOKIES.access));
  }
});

test('pending, declined, reversed, and refunded captures never grant access', async () => {
  for (const captureStatus of ['PENDING', 'DECLINED', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED', 'REVERSED']) {
    const state = provider({ captureStatus });
    const client = browser();
    await begin(client);
    const result = await client.call(captureHandler, { method: 'POST', body: { orderId: ORDER_ID } });
    assert.equal(result.statusCode, 409, captureStatus);
    assert.ok(!result.body.notionUrl);
    assert.ok(!client.jar.has(COOKIES.access));
    assert.equal(state.meta.length, 0);
  }
});

test('access bypass without a valid paid cookie or with an expired cookie is rejected', async () => {
  const state = provider();
  const client = browser();
  const result = await client.call(accessHandler);
  assert.equal(result.statusCode, 401);
  client.jar.set(COOKIES.access, signToken('access', { orderId: ORDER_ID, captureId: CAPTURE_ID, productId: PRODUCT.id }, -1));
  const expired = await client.call(accessHandler);
  assert.equal(expired.statusCode, 401);
  assert.equal(state.calls.length, 0);
});

test('access rechecks current capture status and rejects later refunds', async () => {
  provider();
  const client = browser();
  await begin(client);
  await client.call(captureHandler, { method: 'POST', body: { orderId: ORDER_ID } });
  const refunded = provider({ captureStatus: 'REFUNDED' });
  const result = await client.call(accessHandler);
  assert.equal(result.statusCode, 409);
  assert.equal(result.body.error.code, 'PAYMENT_NOT_COMPLETED');
  assert.ok(refunded.calls.some(call => call.path === `/v2/payments/captures/${CAPTURE_ID}`));
  assert.ok(!result.body.notionUrl);
});

test('Meta purchase is consent-gated, hashed, and deduplicates with browser event ID', async () => {
  process.env.META_CAPI_ACCESS_TOKEN = 'mock-meta-token';
  process.env.META_TEST_EVENT_CODE = 'TEST41665';
  const state = provider();
  const client = browser();
  await begin(client, true);
  const result = await client.call(captureHandler, { method: 'POST', body: { orderId: ORDER_ID } });
  assert.equal(result.statusCode, 200);
  assert.equal(state.meta.length, 1);
  const event = state.meta[0].data[0];
  assert.equal(event.event_name, 'Purchase');
  assert.equal(event.event_id, result.body.eventId);
  assert.equal(event.custom_data.value, 19);
  assert.equal(event.custom_data.currency, 'USD');
  assert.match(event.user_data.em[0], /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(event).includes('Buyer@example.com'));
  assert.equal(state.meta[0].test_event_code, 'TEST41665');
  await client.call(captureHandler, { method: 'POST', body: { orderId: ORDER_ID } });
  assert.equal(state.meta[1].data[0].event_id, event.event_id);
});

test('no Meta events without consent, after revocation, or without a CAPI token', async () => {
  process.env.META_CAPI_ACCESS_TOKEN = 'mock-meta-token';
  for (const [initial, final] of [[false, undefined], [true, false]]) {
    const state = provider();
    const client = browser();
    await begin(client, initial);
    const result = await client.call(captureHandler, { method: 'POST', body: { orderId: ORDER_ID, ...(final !== undefined ? { consent: final } : {}) } });
    assert.equal(result.statusCode, 200);
    assert.equal(state.meta.length, 0);
  }
  delete process.env.META_CAPI_ACCESS_TOKEN;
  const state = provider();
  const client = browser();
  await begin(client, true);
  assert.equal((await client.call(captureHandler, { method: 'POST', body: { orderId: ORDER_ID } })).statusCode, 200);
  assert.equal(state.meta.length, 0);
});

test('Meta outages do not prevent delivery of completed purchases', async () => {
  process.env.META_CAPI_ACCESS_TOKEN = 'mock-meta-token';
  provider({ metaError: true });
  const client = browser();
  await begin(client, true);
  const result = await client.call(captureHandler, { method: 'POST', body: { orderId: ORDER_ID } });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.notionUrl, process.env.COURSE_NOTION_URL);
});

test('first-visit offer is five hours, persists across refresh, and expires to the real USD29 price', async () => {
  const start = originalNow(); Date.now = () => start;
  const client = browser();
  const first = await client.call(configHandler);
  assert.equal(first.body.price, '19.00'); assert.equal(first.body.regularPrice, '29.00');
  assert.equal(Date.parse(first.body.offerExpiresAt) - Date.parse(first.body.serverTime), OFFER_DURATION_MS);
  const token = client.jar.get(COOKIES.offer);
  assert.ok(first.headers.get('set-cookie').some(value => value.startsWith(COOKIES.offer) && value.includes('Max-Age=31536000')));
  Date.now = () => start + 60 * 60 * 1000;
  const refreshed = await client.call(configHandler);
  assert.equal(refreshed.body.offerExpiresAt, first.body.offerExpiresAt);
  assert.equal(client.jar.get(COOKIES.offer), token);
  Date.now = () => start + OFFER_DURATION_MS;
  const expired = await client.call(configHandler);
  assert.equal(expired.body.price, '29.00'); assert.equal(expired.body.offerActive, false);
  assert.equal(expired.body.offerExpiresAt, first.body.offerExpiresAt);
  assert.equal(client.jar.get(COOKIES.offer), token);
});

test('altered promo deadlines cannot restore the discount or submit a client-selected price', async () => {
  const state = provider(); const client = browser(); await client.call(configHandler);
  const [payload, signature] = client.jar.get(COOKIES.offer).split('.');
  const changed = JSON.parse(Buffer.from(payload, 'base64url').toString());
  changed.expiresAt += OFFER_DURATION_MS;
  client.jar.set(COOKIES.offer, `${Buffer.from(JSON.stringify(changed)).toString('base64url')}.${signature}`);
  const config = await client.call(configHandler);
  assert.equal(config.body.price, '29.00'); assert.equal(config.body.offerActive, false);
  for (const expectedPrice of ['19.00', '0.01']) {
    const result = await client.call(ordersHandler, { method: 'POST', body: { productId: PRODUCT.id, expectedPrice } });
    assert.equal(result.statusCode, 409); assert.equal(result.body.error.code, 'PRICE_CHANGED');
  }
  assert.equal(state.calls.length, 0);
});

test('regular-price USD29 order, capture, access, and Meta Purchase use the actual server-bound amount', async () => {
  process.env.META_CAPI_ACCESS_TOKEN = 'mock-meta-token';
  const start = originalNow(); Date.now = () => start;
  const client = browser(); await client.call(configHandler);
  Date.now = () => start + OFFER_DURATION_MS + 1000;
  const state = provider({ price: '29.00' });
  const config = await client.call(configHandler); assert.equal(config.body.price, '29.00');
  const created = await client.call(ordersHandler, { method: 'POST', body: { productId: PRODUCT.id, expectedPrice: '29.00', consent: true } });
  assert.equal(created.body.price, '29.00');
  const request = state.calls.find(call => call.path === '/v2/checkout/orders');
  assert.equal(JSON.parse(request.options.body).purchase_units[0].amount.value, '29.00');
  const captured = await client.call(captureHandler, { method: 'POST', body: { orderId: ORDER_ID } });
  assert.equal(captured.statusCode, 200); assert.equal(captured.body.price, '29.00');
  assert.equal(state.meta[0].data[0].custom_data.value, 29);
  const access = await client.call(accessHandler); assert.equal(access.statusCode, 200); assert.equal(access.body.price, '29.00');
});

test('USD19 order accepted before the deadline is honored after the public price becomes USD29', async () => {
  const start = originalNow(); Date.now = () => start;
  const client = browser(); await client.call(configHandler);
  Date.now = () => start + 4 * 60 * 60 * 1000;
  const state = provider(); await begin(client);
  Date.now = () => start + OFFER_DURATION_MS + 1000;
  const config = await client.call(configHandler);
  assert.equal(config.body.price, '29.00'); assert.equal(config.body.acceptedOrder.price, '19.00');
  const retry = await client.call(ordersHandler, { method: 'POST', body: { productId: PRODUCT.id, expectedPrice: '19.00' } });
  assert.equal(retry.statusCode, 200); assert.equal(retry.body.price, '19.00');
  assert.equal(state.calls.filter(call => call.path === '/v2/checkout/orders').length, 1);
  const result = await client.call(captureHandler, { method: 'POST', body: { orderId: ORDER_ID } });
  assert.equal(result.statusCode, 200); assert.equal(result.body.price, '19.00');
});

test('a USD29 order cannot unlock from a mismatched USD19 PayPal amount', async () => {
  const start = originalNow(); Date.now = () => start;
  const client = browser(); await client.call(configHandler);
  Date.now = () => start + OFFER_DURATION_MS + 1000;
  const state = provider({ price: '19.00' }); await client.call(configHandler);
  await client.call(ordersHandler, { method: 'POST', body: { productId: PRODUCT.id, expectedPrice: '29.00' } });
  const result = await client.call(captureHandler, { method: 'POST', body: { orderId: ORDER_ID } });
  assert.equal(result.statusCode, 409); assert.equal(result.body.error.code, 'PAYMENT_MISMATCH');
  assert.equal(state.captured, false);
});

test('valid accepted USD19 order survives an earlier checkout-cookie expiry without extending order lifetime', async () => {
  const start = originalNow(); Date.now = () => start;
  const client = browser(); await client.call(configHandler);
  // A checkout session starts at hour 3.5; its later order is valid until 6.5.
  Date.now = () => start + 3.5 * 60 * 60 * 1000;
  await client.call(configHandler);
  Date.now = () => start + 4.5 * 60 * 60 * 1000;
  const state = provider();
  const created = await client.call(ordersHandler, { method: 'POST', body: { productId: PRODUCT.id, expectedPrice: '19.00' } });
  assert.equal(created.statusCode, 201);
  const orderCookie = client.jar.get(COOKIES.order);
  Date.now = () => start + 5.75 * 60 * 60 * 1000;
  const recovered = await client.call(configHandler);
  assert.equal(recovered.body.price, '29.00');
  assert.equal(recovered.body.acceptedOrder.price, '19.00');
  assert.equal(client.jar.get(COOKIES.order), orderCookie, 'order lifetime must not be refreshed');
  const retried = await client.call(ordersHandler, { method: 'POST', body: { productId: PRODUCT.id, expectedPrice: '19.00' } });
  assert.equal(retried.statusCode, 200);
  assert.equal(retried.body.orderId, created.body.orderId);
  assert.equal(state.calls.filter(call => call.path === '/v2/checkout/orders').length, 1);
  Date.now = () => start + 6.5 * 60 * 60 * 1000;
  const expired = await client.call(configHandler);
  assert.equal(expired.body.acceptedOrder, null, 'expired order cannot be recovered indefinitely');
  assert.equal(expired.body.price, '29.00');
});

test('pricing migration preserves preexisting offer deadlines before and after their original expiry', async () => {
  const start = originalNow();
  const expiresAt = start + OFFER_DURATION_MS;
  const client = browser();
  Date.now = () => start;
  const historicalCookie = signToken('offer', { visitorId: '11111111-1111-1111-1111-111111111111', startedAt: start, expiresAt }, 31536000);
  client.jar.set(COOKIES.offer, historicalCookie);
  Date.now = () => start + 4 * 60 * 60 * 1000;
  const active = await client.call(configHandler);
  assert.equal(active.body.price, '19.00');
  assert.equal(active.body.offerPrice, '19.00');
  assert.equal(active.body.regularPrice, '29.00');
  assert.equal(Date.parse(active.body.offerExpiresAt), expiresAt);
  assert.equal(client.jar.get(COOKIES.offer), historicalCookie);
  Date.now = () => expiresAt;
  const expired = await client.call(configHandler);
  assert.equal(expired.body.price, '29.00');
  assert.equal(expired.body.offerActive, false);
  assert.equal(Date.parse(expired.body.offerExpiresAt), expiresAt);
  assert.equal(client.jar.get(COOKIES.offer), historicalCookie);
});

test('new orders reject historical USD99 prices and never send them to PayPal', async () => {
  const state = provider();
  const client = browser();
  await client.call(configHandler);
  const response = await client.call(ordersHandler, { method: 'POST', body: { productId: PRODUCT.id, expectedPrice: '99.00' } });
  assert.equal(response.statusCode, 409);
  assert.equal(response.body.error.code, 'PRICE_CHANGED');
  await assert.rejects(createOrder('11111111-1111-1111-1111-111111111111', '99.00'), error => error.code === 'PAYMENT_MISMATCH');
  assert.equal(state.calls.length, 0);
});

test('historical USD29, USD99 and price-less USD29 orders retain their bound amount through capture and access', async () => {
  process.env.META_CAPI_ACCESS_TOKEN = 'mock-meta-token';
  const sessionId = '11111111-1111-1111-1111-111111111111';
  for (const storedPrice of ['29.00', '99.00', undefined]) {
    const expectedPrice = storedPrice ?? '29.00';
    const state = provider({ price: expectedPrice, existingSessionId: sessionId });
    const client = browser();
    client.jar.set(COOKIES.checkout, signToken('checkout', { sessionId }));
    client.jar.set(COOKIES.order, signToken('order', { sessionId, orderId: ORDER_ID, productId: PRODUCT.id, consent: true, ...(storedPrice ? { price: storedPrice } : {}) }));
    const config = await client.call(configHandler);
    assert.equal(config.body.price, '19.00', 'current welcome offer must not reinterpret an accepted historic order');
    assert.equal(config.body.acceptedOrder.price, expectedPrice);
    const existing = await client.call(ordersHandler, { method: 'POST', body: { productId: PRODUCT.id, expectedPrice } });
    assert.equal(existing.statusCode, 200);
    assert.equal(existing.body.price, expectedPrice);
    assert.equal(state.calls.length, 0, 'reusing an accepted historic order must not create a new order');
    const captured = await client.call(captureHandler, { method: 'POST', body: { orderId: ORDER_ID } });
    assert.equal(captured.statusCode, 200);
    assert.equal(captured.body.price, expectedPrice);
    assert.equal(state.meta[0].data[0].custom_data.value, Number(expectedPrice));
    const access = await client.call(accessHandler);
    assert.equal(access.statusCode, 200);
    assert.equal(access.body.price, expectedPrice);
  }
});

test('historical paid cookies remain usable and price-less USD29 access rejects a USD19 capture', async () => {
  for (const storedPrice of ['29.00', '99.00', undefined]) {
    const expectedPrice = storedPrice ?? '29.00';
    provider({ price: expectedPrice });
    const client = browser();
    client.jar.set(COOKIES.access, signToken('access', { orderId: ORDER_ID, captureId: CAPTURE_ID, productId: PRODUCT.id, ...(storedPrice ? { price: storedPrice } : {}) }, 31536000));
    const access = await client.call(accessHandler);
    assert.equal(access.statusCode, 200);
    assert.equal(access.body.price, expectedPrice);
  }
  provider({ price: '19.00' });
  const client = browser();
  client.jar.set(COOKIES.access, signToken('access', { orderId: ORDER_ID, captureId: CAPTURE_ID, productId: PRODUCT.id }, 31536000));
  const mismatch = await client.call(accessHandler);
  assert.equal(mismatch.statusCode, 409);
  assert.equal(mismatch.body.error.code, 'PAYMENT_MISMATCH');
  assert.equal(mismatch.body.notionUrl, undefined);
});
