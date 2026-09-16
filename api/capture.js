import { ApiError, captureOrder, grantAccess, handler, orderSession, readBody, requireConfiguration, sendPurchase, setToken, validateId } from '../lib/payments.js';

export default handler('POST', async (req, res) => {
  requireConfiguration();
  const body = await readBody(req, ['orderId', 'consent']);
  if (body.consent !== undefined && typeof body.consent !== 'boolean') throw new ApiError(400, 'INVALID_REQUEST', 'The checkout request is invalid.');
  const session = orderSession(req, validateId(body.orderId));
  if (body.consent === false && session.consent) {
    session.consent = false;
    delete session.fbp;
    delete session.fbc;
    setToken(res, 'order', session);
  }
  const { order, capture } = await captureOrder(session);
  const payload = grantAccess(res, session, capture);
  // Analytics must never prevent delivery of an already paid course.
  await sendPurchase(req, session, order, capture);
  res.status(200).json(payload);
});
