import { handler } from '../lib/payments.js';

// No durable, verified course-sales feed is available for this deployment.
// The live PayPal app's Transaction Search permission was checked and denied.
// Keep this empty until an authenticated source can verify this exact product,
// original completed captures, and their real timestamps. Never manufacture
// social proof from page visits, checkout attempts, fixtures, or process memory.
export default handler('GET', async (_req, res) => {
  res.status(200).json([]);
});
