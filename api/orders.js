import { ApiError, analyticsValue, createOrder, handler, PRODUCT, readBody, readToken, requireConfiguration, setToken, validateId } from '../lib/payments.js';

export default handler('POST', async (req, res) => {
  requireConfiguration();
  const body = await readBody(req, ['productId', 'consent', 'fbp', 'fbc']);
  if (body.productId !== PRODUCT.id || (body.consent !== undefined && typeof body.consent !== 'boolean')) {
    throw new ApiError(400, 'INVALID_PRODUCT', 'Please select the course from this website.');
  }
  const checkout = readToken(req, 'checkout');
  if (!checkout?.sessionId) throw new ApiError(409, 'CHECKOUT_SESSION_REQUIRED', 'Please refresh the page before starting checkout.');
  const previous = readToken(req, 'order');
  if (previous?.sessionId === checkout.sessionId && previous.productId === PRODUCT.id) {
    // Consent may only be reduced on an existing order, never silently upgraded.
    if (body.consent === false && previous.consent) setToken(res, 'order', { ...previous, consent: false, fbp: undefined, fbc: undefined });
    res.status(200).json({ orderId: previous.orderId, price: PRODUCT.price, currency: PRODUCT.currency });
    return;
  }
  const order = await createOrder(checkout.sessionId);
  validateId(order.id);
  setToken(res, 'order', {
    sessionId: checkout.sessionId, orderId: order.id, productId: PRODUCT.id,
    consent: body.consent === true,
    ...(body.consent === true ? { fbp: analyticsValue(body.fbp), fbc: analyticsValue(body.fbc) } : {}),
  });
  res.status(201).json({ orderId: order.id, price: PRODUCT.price, currency: PRODUCT.currency });
});
