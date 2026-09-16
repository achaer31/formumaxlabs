# Course payments

The four `/api` handlers use Vercel's Node.js runtime and native `fetch` / `crypto`.
The only PayPal API base is **https://api-m.paypal.com** (live). No secret may be
prefixed with `VITE_` or committed to Git.

Required Vercel production environment values:

- `PAYPAL_CLIENT_ID`: live client ID (public via `/api/config`).
- `PAYPAL_CLIENT_SECRET`: live server-side secret.
- `ACCESS_TOKEN_SECRET`: randomly generated secret of at least 32 characters.
- `COURSE_NOTION_URL`: published HTTPS Notion course URL; never embedded in the client bundle.
- `SITE_URL`: public origin, initially `https://formumaxlabs.vercel.app`. Update when connecting the custom domain.
- `META_PIXEL_ID`: pixel/dataset ID for browser events.

Optional server-side Meta conversion reporting:

- `META_CAPI_ACCESS_TOKEN`: secret Conversions API token.
- `META_TEST_EVENT_CODE`: only for a deliberate Meta Test Events session. **Remove this value for real advertising traffic**, otherwise server events are test events. A test event code does not authorize the Conversions API.

## Browser contract

Call all APIs same-origin with browser cookies and JSON `Content-Type` on POSTs.
Errors have `{ "error": { "code": "...", "message": "..." } }`.

1. `GET /api/config`: initializes a secure HttpOnly checkout session and returns
   `{paypalClientId, price, currency, productId, productName, checkoutAvailable, pixelId}`.
   Check `checkoutAvailable` before loading PayPal buttons.
2. `POST /api/orders` with `{productId:"ultimate-video-ai-mastery", consent:boolean, fbp?, fbc?}`.
   Returns `{orderId, price:"29.00", currency:"USD"}`. The client cannot supply prices.
   Creation retries reuse a stable PayPal request ID for the checkout session.
3. After buyer approval, `POST /api/capture` with `{orderId, consent?:boolean}`.
   A false consent value revokes advertising consent for this order. Only a verified
   `COMPLETED` USD 29 capture for the right product and signed order session sets
   the paid cookie. Returns `{orderId,captureId,notionUrl,eventId,price,currency}`.
   Fire a consented browser Purchase using `eventID: response.eventId` for deduplication.
   `PAYMENT_DECLINED` can use the PayPal SDK's restart method; `PAYMENT_PENDING`
   should offer a manual retry of the same capture request.
4. `GET /api/access`: requires the signed paid cookie and checks the latest PayPal
   capture status before returning the same access payload. Never unlock using a
   query-string order ID or client-side payment status.

`PageView`, `ViewContent`, `InitiateCheckout`, and `AddPaymentInfo` are browser
events. The optional server-side Purchase respects the consent saved with the
checkout, hashes the payer email, and uses `purchase_<captureId>` for the event ID.
An analytics outage never blocks delivery of a completed purchase.

## Behavior and limits

- Signed `__Host-` cookies are Secure, HttpOnly, SameSite=Lax, and host-only.
- All API responses are private/no-store; mutation origins and request methods are checked.
- PayPal is the payment source of truth. Captures are idempotent, amount/currency/product
  are checked on the server, and a lost capture response is recovered by reading the order.
- Missing credentials, signing secret, site origin, or fulfillment URL closes checkout.
- Pending, denied, reversed, refunded, and partially refunded payments do not unlock new access.
- The access cookie lasts one year and is local to the purchasing browser and domain.
  Domain migration, deleted cookies, and a different device require customer support to
  restore access after verifying the PayPal transaction. There is no invented email service.
  This cookie expiry is a browser convenience limit, not an expiry of the purchased
  course entitlement; the course offer and purchase terms define that entitlement.
- A published shared Notion page can be forwarded after disclosure. Rechecking PayPal
  prevents API access after refunds but cannot revoke an already-known Notion link.
  Per-buyer Notion invitations or an authenticated course platform would be needed for that.
- No live purchase is performed by the test suite. It replaces every network call with fixtures.

Run the meaningful payment tests with `node --test tests/payments.test.js`.

## Recent purchase notifications

`GET /api/activity` currently returns an empty JSON array (`[]`). A live, read-only
check found that the configured PayPal app lacks the Transaction Search scope and
the reporting endpoint returns HTTP 403. No verified, durable course-sales source
is available in this deployment, so the endpoint deliberately does not generate
purchase notices or expose merchant transaction data. A frontend may hide purchase
notices and display factual offer information, without invented purchasers or times.

Future activity integration must verify the exact course product, amount/currency,
original capture, current completed status, and actual timestamp before publishing
an anonymous event. Enabling reporting permission alone does not activate a feed;
that verification still needs to be implemented. No in-memory list is used as a
pretend purchase record, and no new data-storage service is provisioned.

References checked during implementation:

- [Orders v2](https://developer.paypal.com/api/orders/v2)
- [Show order details](https://developer.paypal.com/api/orders/v2/orders-get)
- [Show captured payment details](https://developer.paypal.com/api/payments/v2/captures-get)
- [PayPal idempotency](https://developer.paypal.com/reference/guidelines/idempotency/)
- [Meta server event parameters](https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/server-event/)
