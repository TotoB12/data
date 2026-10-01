# Data Flood Console

The original browser download engine remains the guest mode. Optional email-code accounts and UTC daily, weekly, monthly and all-time leaderboards run on one Cloudflare Worker with Static Assets and D1. Downloads use the existing Cloudflare/Hetzner sources; no bucket or dedicated server is needed.

## Local development

Use Node 22 or newer:

```sh
npm ci
cp .dev.vars.example .dev.vars
# Replace the three example signing/auth secrets with independent random values.
npm run dev
```

Open `http://localhost:8787`. Wrangler applies local migrations before starting. Its local email binding writes messages to `.wrangler` and does not send email. The local Turnstile test keys only belong in local development. Ranking is disabled by default; to exercise it locally set `RANKED_ENABLED` to `true` in `wrangler.jsonc`, rebuild assets, and restart development. Local ranked mode still contacts the original sources; use small run limits.

The repository can also retain ordinary static hosting for guest mode. Deploying the backend enables accounts; static publishing alone does not provision a database or email sender.

## Owner setup and deployment

1. Onboard a sender domain in Cloudflare Email Service and create a Turnstile widget for the application's hostname. The account must have access to Email Sending.
2. Copy `.env.example` to `.env`. Supply account ID, an API token with Workers Scripts Edit and D1 Edit access, the HTTPS application origin, verified sender address, and Turnstile keys. Use a dedicated `DATA_WORKER_NAME` for preview/benchmark environments.
3. Run `npm ci` and `npm run deploy`. The script creates or reuses the named D1 database, applies versioned migrations, builds an explicit asset allowlist, deploys the Worker, and installs missing secrets. Auth/signing secrets are generated once and existing secrets are preserved on later runs. `.env`, `.deploy`, `.dev.vars`, and runtime state are ignored by Git and never served.
4. For Cloudflare Workers Builds, set the same values in its build environment and use `npm run deploy` as the deploy command. This requires the token permissions above. No secret is checked into the repository.

`npm run setup` prepares the database and generated deployment config without publishing. API-token/domain authorization is a one-time owner prerequisite; files in Git cannot grant that access. The setup script never resets existing data or rotates existing secrets.

## Ranking and usage controls

An uninterrupted authenticated run opens one control WebSocket and one HTTP download stream. The stream repeatedly fetches allowlisted original sources and emits signed cumulative receipts after payload records. Receipts travel back over the same socket. Incoming Worker requests are not created per upstream file or progress message. Login uses two additional requests; reconnects, new bounded runs and standalone leaderboard visits add requests.

Scores use actual payload bytes backed by a valid receipt. D1 stores a high-water mark per run/day, with database triggers atomically applying only its increase to daily and all-time totals. Replayed/lower receipts add zero. A single-use grant and per-account lease prevent simultaneous copies. A segment is assigned to the UTC day when its receipt is issued; weeks start Monday. Receipt redemption remains possible until 24 hours after the fixed stream deadline. Saved unacknowledged proofs can be retried after reconnecting, separately for each account.

Progress is saved at most once every two minutes during a normal run, plus finish. The server allows two checkpoint submissions per two-minute window to accommodate finish/recovery. A disconnect can lose the final unreceipted segment. Local IndexedDB retains completed unacknowledged proofs; losing that browser storage can lose unacknowledged credit. Ordinary totals represent received payload, not carrier-billed traffic or physical-device proof.

Default allowances are conservative: **1 GiB / ten minutes per run, 10 GiB reserved per account per UTC day, and 100 GiB reserved for the project per UTC month**, with two upstream readers. Admission reserves the whole allowance, even if the client withholds proofs. Reservations are not refunded automatically; repeated brief runs can exhaust the allowance. New runs stop when the budget is exhausted. A stopped stream releases its lease during stream cleanup; a crashed stream can hold it until its deadline. No recurring data-stream database polling is used.

The owner can change the documented variables after measuring usage. Every ranked byte uses Worker processing: two requests do not imply negligible CPU. **`RANKED_ENABLED=false` is the default until a deployed bounded benchmark is accepted.** That flag blocks new ranked streams. Existing streams retain their fixed byte/time deadline; it is not an instantaneous remote kill switch. Disabling accounts is possible by removing access or deployment; login email sends have independent daily/cooldown/attempt limits.

## Bounded deployed benchmark

Use an isolated Worker/database, a signed-in test account, and `MAX_RUN_BYTES=16777216` (16 MiB). Set ranking true only for that isolated deployment. Supply `BENCHMARK_ORIGIN`, `BENCHMARK_COOKIE` (the test account's session cookie), and optionally `BENCHMARK_BYTES` (maximum 64 MiB), then run:

```sh
npm run benchmark
```

The script performs one bounded relay run and one bounded direct Cloudflare download. It records throughput, request topology, and checkpoint D1 row counts to the ignored `benchmark-results.json`. It never sends email or prints the session cookie. Obtain **combined CPU for both data and control invocations** from Cloudflare observability; client elapsed time is not CPU. Repeat representative desktop/mobile browser and slow-reader comparisons. The script's relay source mix may differ from its direct Cloudflare reference, so it is a diagnostic, not proof of an identical-path comparison.

The implementation plan proposes at least 90% of comparable direct throughput and an initial CPU ceiling of 100 ms/GiB plus 100 ms/run, with a provisional monthly review threshold of 300,000 CPU-ms (1% of Paid inclusion). These are unmeasured targets. Project realistic monthly volume with measured coefficients before enabling broad access. Reserved byte budgets limit admitted work; they do not guarantee a CPU bill ceiling. Cloudflare billing alerts do not stop spending.

Keep `RECEIPT_SECRET` stable until every run's redemption window has passed. Changing it invalidates pending proofs. Use an isolated Worker name/database for previews and benchmarks so test traffic cannot enter production boards.

## Validation

```sh
npm run assets
npm run types
npm run check
npm test
npm run build
npx playwright install chromium
npm run test:browser
```

CI uses mocked upstream payloads and email sends. Tests exercise native D1 OTP login, the actual Worker login/control/download/redemption flow, forged/duplicate/concurrent proofs, recovery, session revocation, UTC periods, shared limits, quota reservations, streaming backpressure/cancellation, partial local counters, repeat provisioning and desktop/mobile UI request counts.

The dry-run build and local browser checks do not establish deployed throughput, billable CPU, email deliverability, or permissions in TotoB12's account. Production ranking requires that bounded benchmark and owner onboarding.
