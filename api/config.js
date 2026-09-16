import { configuration, handler, PRODUCT, startSession } from '../lib/payments.js';

export default handler('GET', async (req, res) => {
  const config = configuration();
  if (config.ready) startSession(req, res);
  res.status(200).json({
    paypalClientId: config.ready ? config.clientId : null,
    price: PRODUCT.price,
    currency: PRODUCT.currency,
    productId: PRODUCT.id,
    productName: PRODUCT.name,
    checkoutAvailable: config.ready,
    pixelId: /^\d+$/.test(process.env.META_PIXEL_ID || '') ? process.env.META_PIXEL_ID : null,
  });
});
