# Course payments

The four `/api` handlers use Vercel's Node.js runtime and native `fetch` / `crypto`.
The only PayPal API base is **https://api-m.paypal.com** (live). No secret may be
prefixed with `VITE_` or committed to Git.

Required Vercel production environment values:

- `PAYPAL_CLIENT_ID`: live client ID (public via `/api/config`).
- `PAYPAL_CLIENT_SECRET`: live server-side secret.
- `ACCESS_TOKEN_SECRET`: randomly generated secret of at least 32 characters.
- `COURSE_NOTION_URL`: published HTTPS Notion course URL; never embedded in the client bundle.
- `SITE_URL`: canonical public origin, `https://formumaxlabs.com` for production.
- `META_PIXEL_ID`: pixel/dataset ID for browser events.

Optional server-side Meta conversion reporting:

- `META_CAPI_ACCESS_TOKEN`: secret Conversions API token.
- `META_TEST_EVENT_CODE`: only for a deliberate Meta Test Events session. **Remove this value for real advertising traffic**, otherwise server events are test events. A test event code does not authorize the Conversions API.

## Browser contract

Call all APIs same-origin with browser cookies and JSON `Content-Type` on POSTs.
Errors have `{ "error": { "code": "...", "message": "..." } }`.

1. `GET /api/config`: initializes secure HttpOnly checkout and first-visit offer
   cookies. Returns `{paypalClientId, price, regularPrice:"19.99", offerPrice:"9.99",
   offerActive, offerExpiresAt, serverTime, acceptedOrder, currency, productId,
   productName, checkoutAvailable, pixelId}`. Times are ISO strings; the deadline
   stays fixed on refresh. Check `checkoutAvailable` before loading PayPal buttons.
2. `POST /api/orders` with `{productId:"ultimate-video-ai-mastery", expectedPrice?, consent:boolean, fbp?, fbc?}`.
   Returns `{orderId, price, currency:"USD"}`. The server chooses USD9.99 before the
   signed five-hour deadline and USD19.99 afterward. `expectedPrice` is a display
   consistency check, not permission to set a price: a mismatch returns
   `PRICE_CHANGED` before creating an order. Creation retries reuse a stable
   PayPal request ID for that checkout session and server-chosen price.
3. After buyer approval, `POST /api/capture` with `{orderId, consent?:boolean}`.
   A false consent value revokes advertising consent for this order. Only a verified
   `COMPLETED` capture matching the signed order's accepted price, product,
   and browser session sets
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
Both browser and server Purchase events use the verified paid amount. Historical
course access is not counted as a new purchase.
An analytics outage never blocks delivery of a completed purchase.

## Five-hour visitor offer

`__Host-fm_offer` records the first-visit timestamp and an immutable five-hour
deadline, signed on the server and retained for one year. The expired cookie is
retained so refreshing or returning in that browser does not restart the offer.
Tampered or malformed offer cookies receive the regular price. This is a browser
offer, not an authenticated person-level limit: a separate browser or deleted
cookies cannot be identified without an account or durable identity service.

Existing offer cookies retain their original deadlines across pricing changes;
changing the welcome price never starts a new five-hour window. A newly created
order costs USD9.99 during that window and USD19.99 afterward. Existing signed orders
retain their accepted price, including historical USD19, USD29, USD29.99, USD49.99, or USD99, while the order's
two-hour cookie remains valid. If its earlier checkout cookie expires first, the
checkout session is recovered without extending the order's lifetime. The config
response's `acceptedOrder` exposes this accepted total to that browser.

Historic signed USD19, USD29, USD29.99, USD49.99, and USD99 receipts remain supported. A legacy order or
access cookie without a price always means the original USD29 price, never the
current USD9.99 welcome price. Historical prices are allowed only for an existing
signed order or receipt; new orders accept only USD9.99 or USD19.99. Capture,
access, receipts, and Purchase events use the verified order amount. PayPal amounts
are compared as exact integer cents; truncated USD9 or USD19 amounts cannot match
the current prices. Meta Purchase values retain the verified decimal amount.

`initOffer()` in `src/purchase.js` shares a single config request with checkout
and tracking, updates `[data-course-price]`, `[data-promo-only]`,
`[data-promo-countdown]`, and `[data-promo-label]`, and checks the server again at
expiry. Prices inside the checkout dialog show the accepted order total when
present. A price change before order creation asks the buyer to review the new
total and confirm the purchase terms again; it never silently creates the
higher-priced order from a displayed USD9.99 total.

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
