import { accessPayload, ApiError, currentCapture, handler, PRODUCT, readToken, requireConfiguration, validateId } from '../lib/payments.js';

export default handler('GET', async (req, res) => {
  requireConfiguration();
  const access = readToken(req, 'access');
  if (!access || access.productId !== PRODUCT.id) throw new ApiError(401, 'ACCESS_REQUIRED', 'Complete checkout to unlock your course.');
  validateId(access.orderId);
  validateId(access.captureId);
  // PayPal is the source of truth: pending, reversed, refunded, and partially
  // refunded payments must not unlock a new access response.
  await currentCapture(access.captureId, access.orderId);
  res.status(200).json(accessPayload(access.orderId, access.captureId));
});
