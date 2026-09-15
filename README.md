# just-an-automated-pantry

A Model Context Protocol (MCP) server that tracks pantry inventory — current state plus the
full history of every change — so an AI client can read a photo of a shelf, record what it
sees, and later reason about consumption, reordering and price movement.

Deployed on Fly.io. Sign-in is Google OAuth, restricted to an email allowlist.

## What it is for

The server is deliberately dumb about images and receipts: the AI client does the OCR and
parsing, and sends structured JSON here. That keeps this service a durable, queryable record
rather than a second-guessing pipeline.

Intended flows:

| Flow | Tools |
| --- | --- |
| Photo of a shelf → recorded stock | `list_items`, `record_pantry_snapshot` |
| Receipt → prices and restock | `record_prices`, `adjust_pantry_stock` |
| Scheduled reorder task | `get_low_stock_items`, `get_pantry_state` |
| "What do we burn through fastest?" | `get_item_history` |
| "Is this getting more expensive?" | `get_price_history` |

## Tools

| Tool | Purpose |
| --- | --- |
| `get_pantry_state` | Current stock: item, brand, quantity, unit, location, expiry, low-stock and expired flags |
| `record_pantry_snapshot` | Absolute observed quantities — the shape a photo produces |
| `adjust_pantry_stock` | Relative deltas — the shape a receipt or a "we ate one" note produces |
| `upsert_item` | Create or edit a catalogue item (name, brand, SKU, price, unit, thresholds) |
| `list_items` | Search the catalogue by name, brand or SKU |
| `get_item_history` | Change log for one item, with in/out totals |
| `get_low_stock_items` | Items at or below `min_quantity`, with a suggested order quantity |
| `record_prices` | File price observations from a receipt |
| `get_price_history` | Price observations for one item with min/max/average |
| `list_locations` | Storage locations and how many items each holds |

### Design notes

- **Snapshot and delta are both first class.** A photo knows totals; a receipt knows changes.
  Forcing either into the other's shape makes the client do read-modify-write arithmetic it
  will eventually get wrong.
- **`batch_id` makes writes idempotent.** Pass a UUID per photo or receipt. A retried upload
  replays the stored result instead of counting the shelf twice.
- **Ambiguous names are refused, not guessed.** If `Spaghetti` matches two brands, the tool
  returns the candidates and asks for a brand or an `item_id`. Guessing would split one
  product's history across two rows, or merge two products into one.
- **Stock clamps at zero.** A miscounted consumption cannot drive quantities negative and
  poison the reorder maths; the event records what was actually applied.
- **`mark_missing_as_zero` is opt-in and location-scoped.** Only use it when a photo covers a
  whole location, since it zeroes everything previously stocked there but absent from the frame.

## Architecture

- Node 22 + TypeScript, Express, `node:sqlite` on a Fly volume at `/data`.
- MCP over streamable HTTP at `POST /mcp`, **stateless** — each request builds a fresh server
  instance, so nothing is lost when Fly suspends or restarts the machine.
- The server is its own OAuth 2.1 authorization server (RFC 8414 metadata, RFC 7591 dynamic
  client registration, RFC 9728 resource metadata, mandatory S256 PKCE) and federates the
  actual sign-in to Google. Claude's connector flow needs dynamic registration and resource
  metadata; Google offers neither, so it sits upstream as the identity provider only.
- Access tokens are opaque random strings stored as SHA-256 hashes. Refresh tokens rotate.

### Endpoints

| Path | Purpose |
| --- | --- |
| `POST /mcp` | MCP streamable HTTP endpoint (Bearer token required) |
| `GET /.well-known/oauth-protected-resource` | RFC 9728 resource metadata |
| `GET /.well-known/oauth-authorization-server` | RFC 8414 AS metadata |
| `POST /register` | Dynamic client registration |
| `GET /authorize` | Starts the Google sign-in |
| `GET /auth/google/callback` | Google redirect target |
| `POST /token` | Authorization code and refresh token grants |
| `POST /revoke` | Token revocation |
| `GET /healthz` | Health check |

## Setup

### 1. Google Cloud Console (manual, one time)

Add this exact **Authorized redirect URI** to OAuth client
`88880879927-bp3hcalrh905sc2d94mgtfjc3f124o90.apps.googleusercontent.com`:

```
https://just-an-automated-pantry.fly.dev/auth/google/callback
```

If the OAuth consent screen is in *Testing*, add each allowlisted address as a test user.

### 2. GitHub `production` environment

| Name | Kind | Purpose |
| --- | --- | --- |
| `FLY_API_TOKEN` | secret | Fly deploy token (`FLY_TOKEN` / `FLY_ACCESS_TOKEN` also accepted) |
| `GOOGLE_OAUTH_SECRET` | secret | Google OAuth client secret |
| `ALLOWED_EMAILS` | variable *(optional)* | Comma-separated allowlist; defaults to `hello@jlawcordova.com` |

### 3. Deploy

Push to `main` or run the **Deploy to Fly** workflow manually from `main`. It typechecks, builds,
runs the smoke test, then creates the app and volume if needed, stages the Fly secrets and deploys.

Pull requests run the same typecheck, build and smoke test, but never deploy — Fly is only ever
updated from `main`.

### 4. Add the connector to Claude

Settings → Connectors → Add custom connector → `https://just-an-automated-pantry.fly.dev/mcp`.
Claude registers itself, sends you to Google, and stores the resulting token.

## Local development

```bash
npm ci
npm run build

GOOGLE_OAUTH_SECRET=dummy \
ALLOWED_EMAILS=you@example.com \
DATA_DIR=./data \
PUBLIC_URL=http://localhost:8080 \
npm start
```

Run the end-to-end smoke test — it boots the server against a throwaway database and checks the
OAuth surface and all ten tools:

```bash
npm run build && node --experimental-sqlite scripts/smoke-test.mjs
```

## Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `8080` | |
| `PUBLIC_URL` | `http://localhost:$PORT` | Must match the deployed origin; the OAuth metadata and the Google redirect URI are derived from it |
| `DATA_DIR` | `/data` | SQLite lives here |
| `GOOGLE_CLIENT_ID` | the project's client id | |
| `GOOGLE_OAUTH_SECRET` | *(required)* | Server refuses to start without it |
| `ALLOWED_EMAILS` | *(empty)* | Comma-separated. **Empty rejects everyone** — it fails closed on purpose |
| `ACCESS_TOKEN_TTL` | `2592000` | Access token lifetime in seconds (30 days) |

## Known MVP limits

- One machine, one volume. Fine for a household; there is no replication or backup yet.
- Expiry is a single date per item-location, not per-lot. Two batches of milk with different
  dates collapse to the earlier one.
- Item matching is exact on normalised name and brand. "Coke" and "Coca-Cola" stay distinct
  unless the client reconciles them via `list_items` first.
- The allowlist gates sign-in, but everyone who passes it shares one pantry. There is no
  per-user isolation.
