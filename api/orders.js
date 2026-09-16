import { ApiError, analyticsValue, boundPrice, createOrder, handler, PRODUCT, readBody, readToken, requireConfiguration, setToken, validateId, visitorOffer } from '../lib/payments.js';

export default handler('POST', async (req, res) => {
  requireConfiguration();
  const body = await readBody(req, ['productId', 'consent', 'fbp', 'fbc', 'expectedPrice']);
  if (body.productId !== PRODUCT.id || (body.consent !== undefined && typeof body.consent !== 'boolean')) {
    throw new ApiError(400, 'INVALID_PRODUCT', 'Please select the course from this website.');
  }
  const checkout = readToken(req, 'checkout');
  if (!checkout?.sessionId) throw new ApiError(409, 'CHECKOUT_SESSION_REQUIRED', 'Please refresh the page before starting checkout.');
  const previous = readToken(req, 'order');
  if (previous?.sessionId === checkout.sessionId && previous.productId === PRODUCT.id) {
    const price = boundPrice(previous);
    if (body.expectedPrice !== undefined && body.expectedPrice !== price) throw new ApiError(409, 'PRICE_CHANGED', `Your existing PayPal order is US$${Number(price)}. Please review the updated checkout total and try again.`);
    // Consent may only be reduced on an existing order, never silently upgraded.
    if (body.consent === false && previous.consent) setToken(res, 'order', { ...previous, consent: false, fbp: undefined, fbc: undefined });
    res.status(200).json({ orderId: previous.orderId, price, currency: PRODUCT.currency });
    return;
  }
  const price = visitorOffer(req, res).price;
  if (body.expectedPrice !== undefined && body.expectedPrice !== price) throw new ApiError(409, 'PRICE_CHANGED', `The promotional window has ended. The course is now US$${Number(price)}. Please review the updated checkout total and try again.`);
  const order = await createOrder(checkout.sessionId, price);
  validateId(order.id);
  setToken(res, 'order', {
    sessionId: checkout.sessionId, orderId: order.id, productId: PRODUCT.id, price,
    consent: body.consent === true,
    ...(body.consent === true ? { fbp: analyticsValue(body.fbp), fbc: analyticsValue(body.fbc) } : {}),
  });
  res.status(201).json({ orderId: order.id, price, currency: PRODUCT.currency });
});
