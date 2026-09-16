import { boundPrice, configuration, handler, PRODUCT, readToken, startSession, visitorOffer } from '../lib/payments.js';

export default handler('GET', async (req, res) => {
  const config = configuration();
  const checkout = config.ready ? startSession(req, res) : null;
  const offer = visitorOffer(req, res, config.ready);
  const order = readToken(req, 'order');
  res.status(200).json({
    paypalClientId: config.ready ? config.clientId : null,
    ...offer,
    currency: PRODUCT.currency,
    productId: PRODUCT.id,
    productName: PRODUCT.name,
    checkoutAvailable: config.ready,
    acceptedOrder: order && order.productId === PRODUCT.id && order.sessionId === checkout?.sessionId
      ? { orderId: order.orderId, price: boundPrice(order), currency: PRODUCT.currency } : null,
    pixelId: /^\d+$/.test(process.env.META_PIXEL_ID || '') ? process.env.META_PIXEL_ID : null,
  });
});
