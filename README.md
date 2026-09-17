# Formumax Labs

English landing page and one-time PayPal checkout for Ultimate AI Video Mastery: USD 19 during a five-hour browser welcome offer, then USD 29.

- Main route: `/ultimatevideoaimastery`; `/` currently presents the flagship product.
- Paid delivery route: `/ultimatevideoaimastery/access`.
- Written English Notion course: 12 modules, 100 editable prompts, companion resources.
- Payment API uses PayPal live only, fixed server pricing and verified capture.
- Secret course URL and credentials are environment variables; never bundle or commit them.
- Meta Pixel uses opt-in consent. Purchase is emitted only after verified capture; server/browser event IDs match.

## Development

Node 24 and pnpm: `pnpm install`, `pnpm dev`, `pnpm build`, `pnpm test`.

Vite's local dev server serves the frontend only. Use `vercel dev` with securely configured environment variables for the full API flow. Do not use a local API request to initiate an unintended live transaction.

## Deployment

Linked Vercel project: `formumaxlabs`, team `parasuhudigital-s-projects`.
Production URL: `https://formumaxlabs.vercel.app/ultimatevideoaimastery`.
Custom domains: `formumaxlabs.com`, `www.formumaxlabs.com`.
Copy variable names from `.env.example` into encrypted project environment settings. Production PayPal credentials are never included in this repository. Vercel Git integration is linked to `achaer31/formumaxlabs`.

See `lib/PAYMENTS.md` for payment, consent, idempotency and delivery details.

## Operational boundaries

- Notion is delivered by a published link after successful payment. It is not per-user DRM, and a recipient can forward the URL. Search indexing and Notion template duplication are disabled.
- No transactional email provider is configured. The buyer saves their course URL on the success screen; PayPal provides its own receipt. Support can restore access after verifying the transaction.
- The browser Meta Pixel works independently of optional Conversions API. CAPI requires its own access token. Keep test event codes unset in normal production.
- A real completed live purchase was not made during development. Payment security and delivery were verified with mocked API tests; credential authentication and checkout rendering are checked against live PayPal.
- Vercel Hobby is for personal non-commercial use. Upgrade the hosting plan before operating commercial sales.

AI-generated hero is campaign illustration, labelled as such. The motion reference comes from the owner's original course. No fabricated reviews, income guarantees or false scarcity are used.
