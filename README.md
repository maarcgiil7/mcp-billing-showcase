# MCP-Billing

**OAuth 2.1 + API key management + Stripe usage-based billing + rate limiting for MCP servers — in one self-hosted repo.**

No revenue share. No platform fees. No vendor lock-in. You own the code and 100% of what you charge.

→ **[Buy now — €79 launch price](https://gilmarc4.gumroad.com/l/mcp-billing)**  
→ **[Watch the demo (67s)](https://youtu.be/hzzPkL3Ro5g)**  
→ **[Landing page](mcp-billing.com)**

---

## The problem

The auth side of MCP servers is mostly solved: OAuth 2.1 where the client supports it, API keys where it doesn't. The part nobody ships is **billing** — specifically, deciding what actually counts as a billable request once you have retries, partial failures, and streamed responses in the picture.

> *"Four hours in, I was reading RFC 9728... not one line of auth code made the search smarter. I burned a weekend on identity plumbing. I shipped with a static API key."*  
> — Real developer, r/mcp

MCP-Billing takes an explicit, documented position on retries, interrupted calls, and streaming — instead of leaving you to figure it out after a chargeback.

---

## How the billing decisions were made

The three billing edge cases in this boilerplate (retries, partial failures, and interrupted streams) weren't designed upfront — they emerged from a real implementation problem: deciding what to do when Stripe confirmation arrives after the tool has already executed.

The core decision was to write the `UsageEvent` to Postgres first, unconditionally, and only then attempt to report to Stripe. If the Stripe call fails, the event stays in the DB with `syncedAt: null` instead of disappearing into a silent catch. The index `@@index([status, syncedAt])` is there for the retry job — implementing it is documented as the buyer's responsibility.

Full write-up, including the exchange with an engineering lead at AppSignal who validated the approach → [Dev.to article](https://dev.to/marcgil_dev/i-spent-a-week-on-oauth-plumbing-for-an-mcp-server-before-writing-a-single-line-of-actual-product-3ik4)

---

## What's included

| Feature | What it does |
|---|---|
| **OAuth 2.1 + PKCE** | Full authorization code flow. PKCE enforced. Refresh token rotation. Reuse detection with Redis. |
| **API key management** | Generate, rotate, and revoke keys from the dashboard. `mcpb_` prefix, SHA-256 hash storage, 7-day grace period on rotation. |
| **Stripe usage-based billing** | Report usage via `POST /api/usage`. Retries, partial failures, and streaming all handled explicitly — documented with code examples. |
| **Rate limiting** | Sliding window algorithm via Upstash Redis Lua script. Per-plan limits. `X-RateLimit-*` headers on every response. |
| **Quota management** | Atomic check-and-decrement in Redis. Fail-closed on quota, fail-open on rate limiter — intentionally different behaviors. |
| **Multi-tenant** | Each user has their own API keys, OAuth clients, quota, and usage history. |
| **Dashboard UI** | Overview, API keys, usage, billing, settings. Built with Next.js Server Components + Tailwind. |
| **300 tests** | Vitest. >95% coverage in `/lib`, ~87% in `/app/api`. |

---

## How billing works

Your MCP server reports usage by calling `POST /api/usage` after each tool call:

```ts
await fetch(`${APP_URL}/api/usage`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${apiKeyOrOauthToken}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    idempotencyKey,  // stable across retries — derived from MCP request ID
    endpoint: "search_documents",
    units: 1,
    status: "completed", // "completed" | "partial" | "failed"
  }),
});
```

Only `status: "completed"` is billable by default. `partial` and `failed` are always recorded in Postgres for auditing, but never reported to Stripe unless you explicitly change `BILLABLE_STATUSES`.

**Retries:** `idempotencyKey` is enforced unique at the database level — a duplicate key returns `200` without re-billing. The guarantee lives in a `UNIQUE` constraint, not a `SELECT`-before-`INSERT` race condition.

**Interrupted calls:** Send `status: "partial"` — don't skip the call to `/api/usage`. The event is logged; you decide later whether partials are billable.

**Streaming:** Register usage once, when the full stream finishes. Accumulate units across chunks, send one `POST /api/usage` at the end.

---

## Stack

```
Runtime:     Node.js 20 LTS
Framework:   Next.js 15 (App Router)
Language:    TypeScript 5 (strict)
Auth:        OAuth 2.1 + PKCE + API keys (custom, no Keycloak)
Billing:     Stripe Billing Meters + webhooks
DB:          PostgreSQL via Supabase (free tier)
ORM:         Prisma
Cache:       Upstash Redis (free tier)
Deploy:      Vercel / Railway / Fly.io
Tests:       Vitest — 300 passing
```

---

## Quickstart (5 steps)

```bash
# 1. Clone and install
git clone <your-purchase-url>
cd mcp-billing && npm install

# 2. Copy and fill environment variables
cp .env.example .env.local

# 3. Generate the RS256 key pair
openssl genrsa -out private.pem 2048
openssl rsa -in private.pem -pubout -out public.pem
# Paste contents into JWT_PRIVATE_KEY and JWT_PUBLIC_KEY, then delete the .pem files

# 4. Migrate and seed the database
npm run db:migrate:deploy
npm run db:seed

# 5. Run
npm run dev
# → http://localhost:3000
```

---

## Deploy to Vercel

1. Import the repo in Vercel
2. Set all env vars in **Project Settings → Environment Variables** before the first deploy
3. Set `APP_URL` to your production domain — it's baked into JWT `iss`, OAuth metadata, and Stripe redirect URLs
4. Run `npm run db:migrate:deploy` against your production database before the first request
5. Point your Stripe webhook at `<APP_URL>/api/webhooks/stripe`

---

## Security decisions

- **RS256, not HS256** — access tokens signed with an asymmetric key pair. `middleware.ts` verifies with the public key only; the private key never touches Edge Runtime.
- **Refresh token rotation** — every use issues a new token. Reuse of a revoked token triggers full chain revocation, verified against real Redis.
- **API keys stored as SHA-256 hash only** — the full key is shown once at creation and never again.
- **Webhook signature verification** — `stripe.webhooks.constructEvent()` on raw body, always. No exceptions.
- **Quota check is fail-closed; rate limiter is fail-open** — intentionally different behaviors documented in code.

---

## What's configurable

Five places in the code are marked `TODO: customize`:

- `BILLABLE_STATUSES` — which event statuses get reported to Stripe (default: `["completed"]`)
- `ANONYMOUS_RATE_LIMITS` — rate limits for unauthenticated traffic
- `PLANS` and `PLAN_RATE_LIMITS` in `seed.ts` — your actual plan quotas and limits
- OAuth scope validation — no fixed whitelist by default; add it in `validateAuthorizeRequest`
- Stripe meter event name — `STRIPE_METER_EVENT_NAME` in `metering.ts`

---

## Known trade-offs

- **JWT access tokens are stateless** — revoking a client doesn't invalidate already-issued tokens. They expire naturally in 15 minutes. If you need immediate revocation, add a revocation check in `middleware.ts`.
- **Quota enforcement is reactive, not preventive** — the tool call executes before usage is reported. Under high concurrency, a user can briefly exceed quota. Add a pre-call quota check in `middleware.ts` if you need hard enforcement.
- **Stripe webhooks return 400 on any exception** — including transient Postgres outages. Stripe won't retry `4xx`. Split signature errors (keep `400`) from processing errors (`500`) in `api/webhooks/stripe/route.ts` if this matters at your volume.

---

## License

MIT with resale restriction: use in unlimited personal and client projects. You may not resell the boilerplate itself as a product.

---

**→ [Get MCP-Billing — €79 launch price](https://gilmarc4.gumroad.com/l/mcp-billing)**
