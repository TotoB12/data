# Accounts and leaderboards: implementation plan

Prepared 1 October 2026 for `TotoB12/data`. This is the original design plan. The account, transport, scoring and deployment code is now implemented; see [the README](../README.md) for actual setup and validation. Production ranking remains gated on the owner's deployed usage benchmark.

## Decision and first gate

Keep the existing Cloudflare speed-test and vetted Hetzner sources. Use **one ordinary Cloudflare Worker with Static Assets and D1**, with email OTP authentication. Ranked traffic passes through a persistent streaming route in that Worker. No dedicated server, buckets, Durable Objects, queues, or stored download files.

The first deliverable must be a bounded transport prototype and its usage measurements. **Do not build the full feature until the prototype demonstrates acceptable throughput and total quota consumption.** A low request count alone is insufficient: every ranked byte still passes through the Worker and costs processing time.

The initial transport candidate uses **two incoming Worker requests per uninterrupted, already authenticated run**: one control WebSocket and one continuous HTTP download response. Repeated upstream downloads happen within that response. Compare a single binary WebSocket only if it reduces measured total usage while preserving throughput and bounded memory.

This preserves the source but changes the route to browser → Worker → original source. No supported public interface was established that lets our backend verify all bytes from the current direct browser downloads. If the relay cannot meet the usage budget, stop at the benchmark result; do not silently credit unverifiable browser totals. Anonymous direct downloading remains available.

The supporting evidence and alternatives are in [the research report](accounts-and-leaderboards-research.md). This plan supersedes its earlier per-transfer request/ledger examples.

## Smallest practical request flow

| Action | Incoming Worker requests | Other work |
| --- | ---: | --- |
| Load static page, JS, CSS, fonts | 0 application invocations | Asset-first serving |
| Anonymous direct downloads | 0 | Existing browser-to-source flow |
| Request email code | 1 | Limited auth/database work; one email |
| Verify email code | 1 | Session cookie and profile returned together |
| Start authenticated ranked run | 2 | Control WebSocket plus persistent HTTP stream |
| Download another upstream chunk | 0 additional | Upstream fetch and streaming CPU |
| Submit a signed progress receipt | 0 additional | Message on existing socket; sparse D1 commit |
| Open leaderboard | 0 additional on existing socket, otherwise 1 | One response containing all four periods |
| Switch leaderboard period | 0 | Already fetched data |

Login, reconnects, reloads, expired stream grants, additional data lanes, and later visits add requests. Two is a stable-run target, not a lifetime allowance per person. Do not add automatic session polling, HTTP heartbeats, leaderboard polling, or one Worker request per upstream file.

WebSocket upgrades count as Worker requests; subsequent messages and upstream fetch subrequests do not add ordinary Worker request charges. CPU still applies. Static assets must use asset-first routing, with Worker execution limited to the API paths. A dynamic Worker Cache API hit still invokes the Worker. [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [Static Assets routing](https://developers.cloudflare.com/workers/static-assets/routing/).

## Transport and trusted scoring

1. The control WebSocket authenticates the existing cookie, creates a run, and returns profile information and a signed download grant. Reuse this connection for accepted totals and user-requested leaderboard data.
2. The HTTP endpoint validates the grant and streams successive or bounded concurrent downloads from server-selected sources. The browser cannot supply an arbitrary URL. Never forward its account cookie or authorization to an upstream host.
3. Count actual forwarded payload bytes. Insert a signed cumulative receipt **after** the payload it covers. Receipts never appear in headers, grant responses, logs, or a metadata endpoint that can bypass the data.
4. The browser retains its newest receipts and submits them over the control socket. The backend verifies the signature and awards only the increase beyond the stored cumulative maximum.
5. Acknowledge durable progress only after the database transaction succeeds. Retain unacknowledged receipts locally for retry after reconnecting.

The HTTP and WebSocket endpoints are separate invocations. They cannot depend on shared JavaScript memory. HTTP backpressure bounds the data stream; do not claim that WebSocket acknowledgements directly control its sender without another coordination mechanism. Plain browser WebSockets lack automatic backpressure, so the one-connection comparison needs an explicit bounded send window. Disable and verify WebSocket `permessage-deflate` for that comparison as well as HTTP response compression. [Workers Streams](https://developers.cloudflare.com/workers/runtime-apis/streams/), [WebSocket behavior](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket).

Initial benchmark settings, adjustable from measured results:

- Emit a receipt after 64 MiB, or approximately five seconds of flowing data, and at clean completion. This is a framing interval, not a 64 MiB memory buffer.
- Persist new progress **once every two minutes**, plus an explicit finish and UTC day transition. Skip unchanged progress. Coalesce receipts to the greatest count for each run/day.
- Keep only a small, fixed number of payload buffers pending. Bound upstream concurrency and cancel upstream readers when the downstream connection is cancelled.
- Give every run fixed byte/time bounds and a fixed redemption deadline. Choose production stream limits from measured CPU and subrequest consumption, not an assumed unlimited connection lifetime.
- No caching or response compression on the ranked stream. Reject client Range, HEAD, conditional-request shortcuts, and unsupported upstream encodings. Validate redirects and upstream status/length; construct fresh downstream headers.
- Count original payload only, excluding our framing and receipt bytes. An interrupted tail without a receipt is local progress, not accepted credit.

The receipt includes a version, signing-key ID, user ID, run ID, UTC day, cumulative payload bytes for that day, issuance time, and immutable stream/redemption deadlines. Use separate signature purposes for grants and receipts. Never extend a past run's redemption deadline on reconnect, and keep verification keys until their receipts expire.

This prevents simple invented totals and replay-based score inflation. It measures accepted payload delivered through the account's stream; it cannot prove a particular physical device, carrier-billed traffic, or a unique human.

## Database design and period rules

Use the auth library's user/session/OTP tables, plus:

| State | Purpose |
| --- | --- |
| `runs` | User binding, admission state, fixed stream and redemption deadlines |
| `run_day_highwater` | Greatest credited byte count per run and UTC day |
| `user_day_totals` | Accepted bytes per user and UTC day |
| `user_totals` | Public alias reference and cached all-time total |

No per-buffer, per-file, or per-receipt history table. Indexes must earn their cost through the actual leaderboard queries.

For a valid signed cumulative count `C`, compute `delta = max(0, C - stored_count)` **inside one atomic D1 transaction**, update daily and all-time totals by that delta, then advance the stored count. All statements must enforce the authenticated user, stored run, fixed deadlines, and acceptance conditions. Never read the old count into JavaScript and later increment totals in a separate transaction. D1's transactional batch API is a candidate; prove the SQL with concurrent tests. [D1 batch semantics](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch).

Duplicate or smaller receipts add zero and avoid aggregate writes. Concurrent receipts for 100, 80, and 120 bytes must produce exactly 120 total credited bytes. Reject unknown/deleted runs; never recreate a run from a receipt. A restarted data stream uses a new run identity rather than accepting a browser-provided credited offset.

Use calendar periods in UTC: today, current week starting Monday, current month, and all time. Attribute a completed receipt segment to the server's issuance day, not the browser clock or submission time. A segment crossing midnight belongs to its completion day; this is a bounded approximation, published in the scoring rules. Preserve the previous day's last unacknowledged receipt when a new day starts.

Daily, weekly, and monthly boards initially query indexed daily totals; all-time uses the cached total. Return small top lists together and cache their public response for five minutes. Test with a populated database. If read cost warrants precomputed weekly/monthly totals, document the extra write cost before adding them.

Use a bounded redemption window, initially up to 24 hours after the fixed stream deadline. Previous-period boards can change during that recovery window. Retain run/high-water state until after that deadline plus a cleanup margin; reject expired receipts even if the row remains. Run small, indexed cleanup batches during existing maintenance/checkpoint work, with a durable throttle, rather than a new polling service. Keep daily aggregate history.

A database checkpoint makes already-received proofs durable; it does not create proof. Store pending proofs in IndexedDB for recovery. A browser crash can lose the final unreceipted segment, and storage loss can lose unacknowledged progress. Do not rely on tab-close delivery or `waitUntil()` finishing a long download.

## Authentication and frontend

- Use a current patched Better Auth release with native D1 support and its email OTP plugin; pin the tested version. Configure short-lived codes, limited attempts, keyed OTP hashing, resend cooldowns, shared persistent throttles, and a daily email-send budget.
- Use Cloudflare Email Sending if the account and sender domain are eligible; verify its current onboarding requirements before implementation. Add Turnstile to code requests. Email/domain verification and service credentials cannot be replaced by files committed to Git.
- Return the profile when verifying the code. Start with a seven-day Secure, HttpOnly, SameSite, host-only session cookie, with renewal no more than daily. Use the existing control connection for profile state. A cookie refresh, when needed, can accompany an existing HTTP response; do not assume a WebSocket message can set a cookie.
- Recheck session validity alongside existing scoring transactions. Rate-limit the WebSocket handshake and messages, OTP routes, and run admission; a client-side timer is not enforcement. Explicitly protect wrappers that call auth server APIs outside library-managed routes.
- Publish aliases and accepted totals only. Email and private account data never enter a public leaderboard cache.
- Keep the current simple frontend and browser worker. Show local received data separately from accepted account totals. Correct partial-download counting and use consistent GiB/MiB or decimal units.
- Load leaderboards only when requested. Cache the four lists together in the browser; tab switching and window focus must not generate requests. Reuse an active control socket where possible.

Auth API choices must be checked against the pinned implementation. [Better Auth email OTP](https://www.better-auth.com/docs/plugins/email-otp), [Better Auth native D1 support](https://better-auth.com/blog/1-5#cloudflare-d1-support), [Cloudflare Email Service](https://developers.cloudflare.com/email-service/).

## Usage budget and benchmark acceptance

Minimize **CPU, requests, database work, and email sends separately**. Do not optimize away one request if it adds significant CPU. At current overage rates, saving one request is worth only 15 ms of CPU; the comparison is useful even while operating within the included quotas.

Current Workers Paid inclusions are 10 million requests and 30 million CPU-ms monthly, shared with the account's other applications. Paid D1 includes 25 billion rows read and 50 million rows written monthly; indexes contribute to billed writes. Ordinary Worker pricing does not add an egress-byte or elapsed-connection-duration charge. Recheck rates when preparing the PR. [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [D1 index billing](https://developers.cloudflare.com/d1/best-practices/use-indexes/).

Proposed prototype gates, not measured results:

| Measure | Initial acceptance target |
| --- | --- |
| Throughput | At least 90% of the existing direct path in comparable runs |
| Incoming requests | Two for an uninterrupted signed-in run; separately report retries and rotations |
| CPU | At most 100 ms/GiB plus 100 ms fixed overhead per run; optimize below this where possible |
| D1 | At most 200 metered rows written and 1,000 read for a ten-minute run, including relevant indexes and bounded board reads |
| Memory | Bounded across run duration, including slow-reader and concurrent-client tests |
| Correctness | No forged/replayed credit; cancellation stops upstream work |

Measure median and p95 CPU/throughput, fixed and per-GiB CPU, actual D1 `meta.rows_read`/`rows_written`, reconnect rate, and stream-limit restarts. Sum CPU across the data and control invocations, all message processing, scoring, and any reconnections; measuring only the HTTP relay or WebSocket handshake understates usage. Compare the same source, payload size, connection, and concurrency. Begin with explicitly small byte/time limits; CI uses mock sources. Local emulation does not establish deployed CPU billing or network performance.

**Passing the per-run targets is not enough:** project the results against the expected monthly volume. A provisional project review threshold is 1% of the Paid CPU inclusion: **300,000 CPU-ms per month**. Use similarly conservative review thresholds of 100,000 incoming requests and 500,000 D1 written rows. These are planning thresholds, not reserved resources, automatic spending caps, or authorization to consume them. Adjust them with actual traffic expectations and the friend's other usage before enabling ranking broadly.

Illustration at the proposed CPU ceiling, for 1,000 already authenticated runs:

| Payload per run | Run requests | Estimated CPU-ms | Share of Paid CPU inclusion |
| --- | ---: | ---: | ---: |
| 1 GiB | 2,000 | 200,000 | 0.67% |
| 10 GiB | 2,000 | 1,100,000 | 3.67% |
| 100 GiB | 2,000 | 10,100,000 | 33.67% |

These are arithmetic scenarios, not forecasts. They exclude additional login, browsing, cleanup, retries, abuse, and other applications. The latter two would fail the provisional 1% review threshold despite their tiny request count. Replace the assumed CPU coefficients with benchmark results:

```text
monthly CPU-ms = runs × (measured fixed CPU-ms + GiB/run × measured CPU-ms/GiB)
```

If the measured volume would exceed the agreed budget, limit admission to ranked runs or leave ranking disabled pending a decision. Do not silently increase the budget or weaken the verification model.

Add per-invocation CPU/subrequest limits, bounded stream byte/time limits, reconnection backoff, server-enforced receipt-processing limits, and an operator switch for new ranked runs. Use a dedicated Worker/database to identify this application's consumption. Keep production logs sparse; no per-buffer logging or receipt secrets. Platform alerts are informational and do not cap spending. [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [Cloudflare budget alerts](https://developers.cloudflare.com/billing/manage/budget-alerts/).

Enforce admission with a D1-backed per-account lease and an atomically claimed, single-use download grant. Reserve a server-selected byte/runtime allowance at admission against per-account and project-wide allowances; cap run starts too. **Never budget from redeemed score alone:** a client can consume data and withhold every receipt. Refund unused reservations only on trusted stream completion, retaining them conservatively after a crash. Reservations bound admitted work; the mapping to billed CPU remains an estimate and does not guarantee a monthly bill ceiling.

Only the data stream's terminal cleanup releases its lease, conditional on the run still owning it. Returning the streaming response or closing the control socket must not release that lease early. Enforce a deadline independently of incoming reads so a stalled client cannot keep upstream work alive indefinitely. Initially avoid recurring data-stream database polls: an abandoned lease may delay restart until cleanup or expiry. A control-socket stop/revocation does not instantly terminate a separate HTTP invocation; prompt remote termination would require sparse shared-state reads and their measured database cost. Bound that limitation with conservative stream deadlines.

## Repository and deployment shape

Proposed files:

```text
public/                    existing static frontend and assets
src/worker.ts              routing, static asset binding, API entry
src/auth.ts                OTP/session configuration and rate limits
src/stream.ts              allowlisted source relay and framing
src/receipts.ts            grants, signatures, bounded validation
src/scoring.ts             atomic cumulative accounting and boards
migrations/                checked-in auth and scoring migrations
scripts/bootstrap.*        idempotent owner setup and deployment checks
tests/                     protocol, database, auth, bounded integration tests
wrangler.jsonc             bindings, API routing, limits, compatibility settings
.dev.vars.example          variable names and non-secret examples only
docs/                      setup, scoring rules, usage results
```

Serve `public/`, not the repository root. Use one Worker and one D1 database per environment. Keep preview/test state isolated from production and avoid a new frontend framework solely for these features.

The bootstrap script should verify account authorization, create or reuse the named database, record its binding, apply migrations, and deploy with validated configuration. A second run must preserve database data, resource IDs, and secrets. Configure Git-based deployment after the initial setup. Do not assume ordinary static Pages publication automatically provisions these resources.

TotoB12's unavoidable initial steps are account/repository authorization, selecting or verifying a sender domain, and providing required secrets/Turnstile configuration. Everything repeatable can be scripted and checked into the repository; runtime data and secrets remain in Cloudflare. Do not commit account tokens, signing keys, OTP secrets, or local runtime state. Exact current provisioning permissions must be validated in a fresh test environment before claiming one-command setup. [D1 setup](https://developers.cloudflare.com/d1/get-started/), [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/).

## Implementation order for the later PR

1. **Fresh checkout and baseline:** clone/fork the intended upstream, use a `codex/` branch, inspect current changes/instructions, and capture bounded direct-mode measurements. Bring only relevant planning documents into that checkout.
2. **Transport spike:** implement signed framing and a minimal control socket behind a disabled-by-default ranking flag. Use temporary test identities only in the isolated test environment. Measure the proposed HTTP-plus-WebSocket path; compare a single socket if worthwhile. Record results and choose limits.
3. **Go/no-go:** compare CPU/volume projections against the small project budget and speed targets. Continue only if the measurements support the feature. Otherwise deliver the measured tradeoff without claiming the original constraints have been satisfied.
4. **Accounts and scoring:** add OTP, migrations, atomic cumulative accounting, recovery/retention, admission limits, and cached board queries. Connect the real session to the already-tested protocol.
5. **UI and local counters:** add login/profile, accepted totals, the four boards, and clear ranked/unranked states. Fix the partial-read counter errors without reducing direct-mode throughput.
6. **Deployment and review:** exercise bootstrap and repeat deployment against isolated resources, run scoped checks, inspect the working browser on desktop/mobile, and prepare the PR with measured usage, remaining limitations, setup steps, and rollback instructions. No production rollout is implied by this planning task.

Required tests cover forged and cross-account receipts; grant/receipt purpose separation; duplicates and concurrent/out-of-order totals; cross-day and delayed redemption; expired/deleted-run replay; partial reads; lost acknowledgements and recovery; shared admission/rate limits; OTP attempts and session revocation; stream compression/Range/HEAD shortcuts; slow readers, cancellation, and bounded memory. Check the browser's actual request trace to ensure there are no hidden session or leaderboard polling calls.

The PR is ready only when the usage report reflects a deployed bounded experiment, scoring integrity tests pass, original anonymous functionality remains usable, and owner setup has been demonstrated without exposing secrets.
