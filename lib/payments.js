import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

export const PRODUCT = Object.freeze({
  id: 'ultimate-video-ai-mastery',
  name: 'Ultimate Video AI Mastery',
  price: '29.99',
  regularPrice: '49.99',
  currency: 'USD',
});

const PAYPAL_BASE = 'https://api-m.paypal.com';
// Price-less cookies were issued only by the original USD29 checkout. Never
// reinterpret them using today's welcome price after a pricing migration.
const LEGACY_PRICE = '29.00';
const HISTORICAL_PRICES = Object.freeze(['19.00', '29.00', '99.00']);
export const COOKIES = Object.freeze({
  checkout: '__Host-fm_checkout',
  order: '__Host-fm_order',
  access: '__Host-fm_access',
  offer: '__Host-fm_offer',
});
const CHECKOUT_AGE = 2 * 60 * 60;
const ACCESS_AGE = 365 * 24 * 60 * 60;
export const OFFER_DURATION_MS = 5 * 60 * 60 * 1000;
const ID_PATTERN = /^[A-Z0-9]{10,32}$/;
let oauthCache;

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function header(req, name) {
  const value = req.headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value || '';
}

function originOf(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || (process.env.NODE_ENV !== 'production' && url.hostname === 'localhost')
      ? url.origin : '';
  } catch { return ''; }
}

export function configuration() {
  let notionUrl = '';
  try {
    const url = new URL(process.env.COURSE_NOTION_URL || '');
    if (url.protocol === 'https:' && !url.username && !url.password &&
      ['notion.so', 'notion.site'].some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`))) {
      notionUrl = url.href;
    }
  } catch { /* Incomplete configuration closes checkout. */ }
  const siteOrigin = originOf(process.env.SITE_URL || '');
  const clientId = process.env.PAYPAL_CLIENT_ID || '';
  const secret = process.env.PAYPAL_CLIENT_SECRET || '';
  const signingSecret = process.env.ACCESS_TOKEN_SECRET || '';
  return {
    notionUrl, siteOrigin, clientId, secret, signingSecret,
    ready: Boolean(notionUrl && siteOrigin && clientId && secret && signingSecret.length >= 32),
  };
}

export function requireConfiguration() {
  const config = configuration();
  if (!config.ready) throw new ApiError(503, 'CHECKOUT_UNAVAILABLE', 'Checkout is temporarily unavailable. Please try again shortly.');
  return config;
}

export function assertRequest(req, method, { mutation = false } = {}) {
  if (req.method !== method) throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'This request method is not supported.');
  const allowedOrigins = new Set([
    'https://formumaxlabs.vercel.app',
    'https://formumaxlabs.com',
    'https://www.formumaxlabs.com',
    originOf(process.env.SITE_URL || ''),
    originOf(`https://${process.env.VERCEL_URL || ''}`),
    originOf(`https://${process.env.VERCEL_PROJECT_PRODUCTION_URL || ''}`),
  ].filter(Boolean));
  const origin = header(req, 'origin');
  if ((origin && !allowedOrigins.has(origin)) || header(req, 'sec-fetch-site') === 'cross-site' || (mutation && !origin)) {
    throw new ApiError(403, 'ORIGIN_REJECTED', 'Please complete checkout from this website.');
  }
  if (mutation && !/^application\/json(?:\s*;|$)/i.test(header(req, 'content-type'))) {
    throw new ApiError(415, 'JSON_REQUIRED', 'A JSON request is required.');
  }
}

export async function readBody(req, allowedKeys) {
  if (Number(header(req, 'content-length')) > 8192) throw new ApiError(413, 'REQUEST_TOO_LARGE', 'The request is too large.');
  let body = req.body;
  try {
    if (body === undefined) {
      let raw = '';
      for await (const chunk of req) {
        raw += chunk.toString();
        if (Buffer.byteLength(raw) > 8192) throw new ApiError(413, 'REQUEST_TOO_LARGE', 'The request is too large.');
      }
      body = JSON.parse(raw || '{}');
    } else if (typeof body === 'string' || Buffer.isBuffer(body)) {
      if (Buffer.byteLength(body) > 8192) throw new ApiError(413, 'REQUEST_TOO_LARGE', 'The request is too large.');
      body = JSON.parse(body.toString());
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, 'INVALID_JSON', 'The request could not be read.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !allowedKeys.includes(key))) {
    throw new ApiError(400, 'INVALID_REQUEST', 'The checkout request is invalid.');
  }
  if (Buffer.byteLength(JSON.stringify(body)) > 8192) throw new ApiError(413, 'REQUEST_TOO_LARGE', 'The request is too large.');
  return body;
}

export function signToken(purpose, data, maxAge = CHECKOUT_AGE) {
  const secret = process.env.ACCESS_TOKEN_SECRET || '';
  if (secret.length < 32) throw new ApiError(503, 'CHECKOUT_UNAVAILABLE', 'Checkout is temporarily unavailable.');
  const encoded = Buffer.from(JSON.stringify({ ...data, purpose, exp: Math.floor(Date.now() / 1000) + maxAge })).toString('base64url');
  const signature = createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

export function readToken(req, purpose) {
  const cookie = header(req, 'cookie').split(';').map(part => part.trim()).find(part => part.startsWith(`${COOKIES[purpose]}=`));
  if (!cookie) return null;
  const token = cookie.slice(COOKIES[purpose].length + 1);
  if (token.length > 4096) return null;
  const [encoded, providedSignature, extra] = token.split('.');
  const secret = process.env.ACCESS_TOKEN_SECRET || '';
  if (!encoded || !providedSignature || extra || secret.length < 32 || !/^[\w-]+$/.test(providedSignature)) return null;
  const expected = createHmac('sha256', secret).update(encoded).digest();
  const provided = Buffer.from(providedSignature, 'base64url');
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) return null;
  try {
    const data = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (data.purpose !== purpose || !Number.isFinite(data.exp) || data.exp <= Math.floor(Date.now() / 1000)) return null;
    return data;
  } catch { return null; }
}

export function setToken(res, purpose, data, maxAge = CHECKOUT_AGE) {
  const cookie = `${COOKIES[purpose]}=${signToken(purpose, data, maxAge)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
  const existing = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', [...(existing ? (Array.isArray(existing) ? existing : [existing]) : []), cookie]);
}

export function startSession(req, res) {
  const prior = readToken(req, 'checkout');
  if (prior?.sessionId && /^[a-f0-9-]{36}$/.test(prior.sessionId)) return prior;
  // Checkout may expire before an order created later in that session. Recover
  // its signed owner binding without extending the accepted order's lifetime.
  const pending = readToken(req, 'order');
  if (pending?.productId === PRODUCT.id && /^[a-f0-9-]{36}$/.test(pending.sessionId || '') && ID_PATTERN.test(pending.orderId || '')) {
    boundPrice(pending);
    const session = { sessionId: pending.sessionId };
    setToken(res, 'checkout', session, Math.min(CHECKOUT_AGE, pending.exp - Math.floor(Date.now() / 1000)));
    return session;
  }
  const session = { sessionId: randomUUID() };
  setToken(res, 'checkout', session);
  return session;
}

export function boundPrice(session) {
  const price = session?.price ?? LEGACY_PRICE;
  if (![PRODUCT.price, PRODUCT.regularPrice, ...HISTORICAL_PRICES].includes(price)) throw new ApiError(409, 'PAYMENT_MISMATCH', 'The payment price could not be verified.');
  return price;
}

export function visitorOffer(req, res, initialize = false) {
  const now = Date.now();
  let offer = readToken(req, 'offer');
  const suppliedCookie = header(req, 'cookie').split(';').some(value => value.trim().startsWith(`${COOKIES.offer}=`));
  const valid = offer && typeof offer.visitorId === 'string' && /^[a-f0-9-]{36}$/.test(offer.visitorId) &&
    Number.isFinite(offer.startedAt) && Number.isFinite(offer.expiresAt) &&
    offer.expiresAt - offer.startedAt === OFFER_DURATION_MS && offer.startedAt <= now;
  if (!valid) offer = null;
  if (!offer && !suppliedCookie && initialize) {
    offer = { visitorId: randomUUID(), startedAt: now, expiresAt: now + OFFER_DURATION_MS };
    // Retain the original deadline after it expires. Refreshing never renews it.
    setToken(res, 'offer', offer, ACCESS_AGE);
  }
  const active = Boolean(offer && now < offer.expiresAt);
  return {
    price: active ? PRODUCT.price : PRODUCT.regularPrice,
    regularPrice: PRODUCT.regularPrice, offerPrice: PRODUCT.price,
    offerActive: active, offerExpiresAt: offer ? new Date(offer.expiresAt).toISOString() : null,
    serverTime: new Date(now).toISOString(),
  };
}

export function orderSession(req, orderId) {
  const session = readToken(req, 'order');
  if (!session || session.orderId !== orderId || session.productId !== PRODUCT.id || !session.sessionId) {
    throw new ApiError(403, 'CHECKOUT_SESSION_REQUIRED', 'Your checkout session has expired. Please return to checkout and try again.');
  }
  return session;
}

function requestId(prefix, value) {
  return `${prefix}-${createHash('sha256').update(value).digest('hex').slice(0, 32)}`;
}

async function fetchJson(url, options, timeout = 12000) {
  try {
    const response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(timeout) });
    let data;
    try { data = await response.json(); } catch { data = {}; }
    return { response, data };
  } catch {
    throw new ApiError(502, 'PAYMENT_SERVICE_UNAVAILABLE', 'PayPal is taking longer than expected. Please retry; you will not be charged twice for this order.');
  }
}

async function accessToken() {
  const { clientId, secret } = requireConfiguration();
  const key = createHash('sha256').update(`${clientId}:${secret}`).digest('hex');
  if (oauthCache?.key === key && oauthCache.expiresAt > Date.now()) return oauthCache.token;
  const { response, data } = await fetchJson(`${PAYPAL_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!response.ok || typeof data.access_token !== 'string') {
    throw new ApiError(502, 'PAYMENT_SERVICE_UNAVAILABLE', 'PayPal checkout is temporarily unavailable. Please try again shortly.');
  }
  oauthCache = { key, token: data.access_token, expiresAt: Date.now() + Math.max(0, Number(data.expires_in || 0) - 60) * 1000 };
  return data.access_token;
}

async function paypal(path, { method = 'GET', body, idempotencyKey } = {}) {
  const token = await accessToken();
  const { response, data } = await fetchJson(`${PAYPAL_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(idempotencyKey ? { 'PayPal-Request-Id': idempotencyKey } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    if (response.status === 401) oauthCache = undefined;
    const declined = data.details?.some(detail => detail.issue === 'INSTRUMENT_DECLINED');
    throw new ApiError(declined ? 422 : 502, declined ? 'PAYMENT_DECLINED' : 'PAYMENT_SERVICE_UNAVAILABLE',
      declined ? 'PayPal could not approve this payment method. Please choose another payment method.' : 'PayPal could not finish this request. Please retry this order.');
  }
  return data;
}

export function validateId(value) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) throw new ApiError(400, 'INVALID_ORDER', 'The payment reference is invalid.');
  return value;
}

export function analyticsValue(value) {
  return typeof value === 'string' && /^fb\.\d\.\d{10,16}\.[A-Za-z0-9._-]{1,300}$/.test(value) ? value : undefined;
}

export async function createOrder(sessionId, price = PRODUCT.price) {
  // Historical prices are valid only for an already signed order or receipt.
  if (![PRODUCT.price, PRODUCT.regularPrice].includes(price)) throw new ApiError(409, 'PAYMENT_MISMATCH', 'The payment price could not be verified.');
  return paypal('/v2/checkout/orders', {
    method: 'POST',
    idempotencyKey: requestId('ord', `${sessionId}:${price}`),
    body: {
      intent: 'CAPTURE',
      purchase_units: [{
        reference_id: PRODUCT.id,
        custom_id: `${PRODUCT.id}:${sessionId}`,
        description: `${PRODUCT.name} — digital course access`,
        amount: {
          currency_code: PRODUCT.currency, value: price,
          breakdown: { item_total: { currency_code: PRODUCT.currency, value: price } },
        },
        items: [{ name: PRODUCT.name, sku: PRODUCT.id, quantity: '1', category: 'DIGITAL_GOODS', unit_amount: { currency_code: PRODUCT.currency, value: price } }],
      }],
      application_context: { brand_name: 'Formumax Labs', shipping_preference: 'NO_SHIPPING', user_action: 'PAY_NOW' },
    },
  });
}

function amountInCents(value) {
  if (typeof value !== 'string' || !/^\d+(?:\.\d{1,2})?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
}

function correctAmount(amount, price = LEGACY_PRICE) {
  return amount?.currency_code === PRODUCT.currency && amountInCents(amount.value) === amountInCents(boundPrice({ price }));
}

export function verifyOrder(order, session) {
  const unit = order.purchase_units?.[0];
  const item = unit?.items?.[0];
  if (order.id !== session.orderId || order.intent !== 'CAPTURE' || order.purchase_units?.length !== 1 ||
    unit.reference_id !== PRODUCT.id || unit.custom_id !== `${PRODUCT.id}:${session.sessionId}` ||
    !correctAmount(unit.amount, boundPrice(session)) || unit.items?.length !== 1 || item.sku !== PRODUCT.id ||
    item.quantity !== '1' || !correctAmount(item.unit_amount, boundPrice(session))) {
    throw new ApiError(409, 'PAYMENT_MISMATCH', 'This payment does not match the course checkout. Please contact support with your PayPal receipt.');
  }
  return unit;
}

export function verifyCapture(capture, orderId, captureId, price = LEGACY_PRICE) {
  const relatedOrder = capture.supplementary_data?.related_ids?.order_id;
  if (!ID_PATTERN.test(capture.id || '') || (captureId && capture.id !== captureId) || !correctAmount(capture.amount, price) ||
    (relatedOrder && relatedOrder !== orderId)) {
    throw new ApiError(409, 'PAYMENT_MISMATCH', 'Your payment could not be verified. Please contact support with your PayPal receipt.');
  }
  if (capture.status !== 'COMPLETED') {
    const pending = capture.status === 'PENDING';
    throw new ApiError(409, pending ? 'PAYMENT_PENDING' : 'PAYMENT_NOT_COMPLETED', pending
      ? 'Your payment is still processing. Course access will appear after PayPal completes it. Please retry shortly.'
      : 'This payment is not currently completed. Please contact support with your PayPal receipt.');
  }
  return capture;
}

export async function captureOrder(session) {
  const path = `/v2/checkout/orders/${validateId(session.orderId)}`;
  let order = await paypal(path);
  verifyOrder(order, session);
  if (order.status !== 'COMPLETED') {
    if (order.status !== 'APPROVED') throw new ApiError(409, 'PAYMENT_NOT_APPROVED', 'Please approve your payment with PayPal before continuing.');
    try {
      await paypal(`${path}/capture`, { method: 'POST', body: {}, idempotencyKey: requestId('cap', session.orderId) });
    } catch (error) {
      // A timeout may occur after PayPal captures the payment. Read its current state
      // before offering a retry; the stable request ID also prevents a duplicate charge.
      order = await paypal(path);
      if (order.status !== 'COMPLETED') throw error;
    }
    order = await paypal(path);
  }
  const unit = verifyOrder(order, session);
  if (order.status !== 'COMPLETED' || unit.payments?.captures?.length !== 1) {
    throw new ApiError(409, 'PAYMENT_PENDING', 'Your payment is still processing. Please retry shortly to check course access.');
  }
  const summary = unit.payments.captures[0];
  verifyCapture(summary, session.orderId, undefined, boundPrice(session));
  const capture = await currentCapture(summary.id, session.orderId, boundPrice(session));
  return { order, capture };
}

export async function currentCapture(captureId, orderId, price = LEGACY_PRICE) {
  const capture = await paypal(`/v2/payments/captures/${validateId(captureId)}`);
  return verifyCapture(capture, orderId, captureId, price);
}

export function accessPayload(orderId, captureId, price = LEGACY_PRICE) {
  return { orderId, captureId, notionUrl: requireConfiguration().notionUrl, eventId: `purchase_${captureId}`, price: boundPrice({ price }), currency: PRODUCT.currency };
}

export function grantAccess(res, session, capture) {
  const price = boundPrice(session);
  setToken(res, 'access', { orderId: session.orderId, captureId: capture.id, productId: PRODUCT.id, price }, ACCESS_AGE);
  return accessPayload(session.orderId, capture.id, price);
}

export async function sendPurchase(req, session, order, capture) {
  const token = process.env.META_CAPI_ACCESS_TOKEN;
  const pixel = process.env.META_PIXEL_ID;
  if (session.consent !== true || !token || !/^\d+$/.test(pixel || '')) return false;
  const userData = {};
  const address = header(req, 'x-forwarded-for').split(',')[0].trim();
  if (isIP(address)) userData.client_ip_address = address;
  const agent = header(req, 'user-agent');
  if (agent) userData.client_user_agent = agent.slice(0, 1024);
  if (session.fbp) userData.fbp = session.fbp;
  if (session.fbc) userData.fbc = session.fbc;
  const email = order.payer?.email_address;
  if (typeof email === 'string' && email.includes('@')) userData.em = [createHash('sha256').update(email.trim().toLowerCase()).digest('hex')];
  const captureTime = Date.parse(capture.create_time || '');
  const event = {
    event_name: 'Purchase', event_id: `purchase_${capture.id}`,
    event_time: Number.isFinite(captureTime) ? Math.floor(captureTime / 1000) : Math.floor(Date.now() / 1000),
    action_source: 'website', event_source_url: `${requireConfiguration().siteOrigin}/ultimatevideoaimastery`,
    user_data: userData,
    custom_data: { currency: PRODUCT.currency, value: Number(boundPrice(session)), content_ids: [PRODUCT.id], content_type: 'product', num_items: 1, order_id: session.orderId },
  };
  try {
    const response = await fetch(`https://graph.facebook.com/v25.0/${pixel}/events`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(4000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ data: [event], ...(process.env.META_TEST_EVENT_CODE ? { test_event_code: process.env.META_TEST_EVENT_CODE } : {}) }),
    });
    return response.ok;
  } catch { return false; }
}

export function handler(method, action) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.setHeader('Vercel-CDN-Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      assertRequest(req, method, { mutation: method === 'POST' });
      await action(req, res);
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.status === 405) res.setHeader('Allow', method);
        res.status(error.status).json({ error: { code: error.code, message: error.message } });
      } else {
        res.status(500).json({ error: { code: 'REQUEST_FAILED', message: 'The request could not be completed. Please try again shortly.' } });
      }
    }
  };
}
