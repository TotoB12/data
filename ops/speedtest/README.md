# Download-only speedtest endpoint operations

This directory contains **operational tooling and offline tests**. The existing Data Flood Console now downloads exclusively through its own fixed-size `https://data.totob12.com/__down` endpoint; only its worker's endpoint compatibility changes. Design, controls, presets, adaptive tuning, counters and display formats remain unchanged. `.gitignore`, Pages settings, and the `data.totob12.com` → `data-bqs.pages.dev` mapping remain unchanged. A GitHub merge may trigger the existing automatic Pages deployment. Do not publish fixtures, credentials, reports, or a client harness through Pages.

## Finite known-size compatibility contract

`contract.json` is the approved allowlist; `speedtest_ops.py` renders `cloudflare-rules.json`. Targets are fixed in code as well as JSON so changing JSON cannot silently redirect deployment elsewhere.

- Account: `a8f49ad6ebe26d6d38841a5e1d49ce6d`; zone: `fe78766bf0bcad4c3858ae957b0d4041` (`totob12.com`).
- Dedicated **Standard** bucket: `totob12-speedtest`, location hint `weur`; custom origin: `speed-origin.totob12.com`, TLS minimum `1.2`; public `r2.dev` access disabled.
- Contract version **2** preserves all seven SDK fixtures (`0`, `100000`, `1000000`, `10000000`, `25000000`, `100000000`, `250000000`) and adds the old console's 13 exact-byte sizes: **8, 16, 24, 32, 40, 48, 56, 64, 72, 80, 88, 96 and 100 MiB**, each multiplied by `1048576`. `legacy_sizes` and `client_sizes` identify the two sets; `sizes` is their sorted union. Exactly **20** raw, unencoded random objects under `speedtest/N.bin`, totaling **1,145,269,024 bytes**; added fixtures total **759,169,024 bytes**. No Content-Encoding. Stored Content-Type is `application/octet-stream`; stored Cache-Control is `no-store, no-transform`. This is finite known-size compatibility, **not arbitrary-size generation or a complete Cloudflare speedtest clone**.
- Original raw path must be exactly `/__down`; `GET` and `HEAD` are routed/re-written. `OPTIONS` is routed only for a real preflight: exactly one nonempty `Origin` value and exactly one `Access-Control-Request-Method` value equal to `GET` or `HEAD` (case-sensitive). Arbitrary origins, including opaque `null`, are allowed; missing/empty/duplicate headers, plain OPTIONS and POST-oriented preflights stay on Pages. Header-map keys are lowercase; array-cardinality checks prevent missing-value comparisons from admitting absent headers. No regex/paid matching feature is used.
- The immutable `raw.http.request.uri.args` map enforces exactly one `bytes` value, equal to a canonical decimal spelling in the 20-size allowlist. Optional `cb` is a singleton nonempty raw value of at most 128 characters; it is ignored for fixture selection. Optional `during` is a singleton `idle` or `download` **only with `bytes=0`**. Parameter order is irrelevant: `cb=x&bytes=8388608`, `bytes=8388608&cb=x`, and either latency ordering are accepted. Only raw names `bytes`, `cb`, `during` are allowed; duplicate keys, encoded/leading-zero/negative/nondecimal byte values, unknown keys (`measId`, etc.) and other sizes fail closed. Optional absence uses a negated array-length existence check, not an empty-string comparison. `queries` in the JSON is a canonical verifier probe list, not an exhaustive literal whitelist.
- One dynamic URL rewrite, stable ref `bella_speedtest_rewrite`: `concat("/speedtest/", http.request.uri.args["bytes"][0], ".bin")`; the original raw singleton/allowlist guard precedes it. The rewritten query is explicitly `""`, so `cb` never creates a separate CDN object key. Browser fetches still use `cache: "no-store"`; browser no-store and the scoped CDN edge cache are distinct policies.
- One `cloudflare_r2` Cloud Connector, target `speed-origin.totob12.com`, same data-host allowlist. Connector updates preserve the entire unrelated connector list, including IDs and order.
- One cache exception **appended after** the existing enabled `expression: true`, `cache: false` catchall. Never modify that catchall. Cache eligibility is GET/HEAD only: either the structural data-host download allowlist or the 20 exact origin object paths with an empty raw query. OPTIONS is excluded. Edge TTL overrides origin for 30 days (`2592000`); status 200 gets that TTL, other valid HTTP status codes get `-1` (do not cache). Browser TTL respects origin.
- One response-header rule on the download scope, including only qualifying data-host preflights: `Cache-Control: no-store, no-transform`, `Access-Control-Allow-Origin: *`, `Timing-Allow-Origin: *`; expose `Content-Length, Content-Range, Accept-Ranges, CF-Cache-Status, Age, Server-Timing, Content-Encoding`. Rewrites, connector, headers, compression and SSL share that data-host gate; direct origin scope remains GET/HEAD only. Bucket CORS has stable rule ID `bella-speedtest-public-downloads`; exact CORS readback includes it and never drops unknown writable fields.
- One scoped compression rule (`compress_response`, `algorithms: [{"name":"none"}]`) and one scoped configuration rule (`set_config`, `ssl: strict`). No global SSL/security changes, Workers, Functions, Tiered Cache, Cache Reserve or paid features.

Unsupported data-host requests retain the existing **Pages HTML 200 fallback**, not a new synthetic 400/404. The origin is deliberately publicly readable. Its nonallowlisted paths/queries are outside the cache exception, not access-controlled. **CORS and this query allowlist are not authentication or billing protection.** Do not store private/additional content in this bucket. This is not a zero-cost guarantee; account billing and public-request exposure still require operator review.

## Offline development / CI

Python 3.12+, Node 22; stdlib only for the tests, renderer, generator, account deployment and HTTP verifier. CI has only `contents: read`; no cloud secrets, schedules, account requests, S3 work or public endpoint tests. Action major-version tags are used instead of unverified guessed commit SHAs.

```sh
python -m unittest discover -s ops/speedtest/tests -v
python ops/speedtest/speedtest_ops.py --check
node --check ops/speedtest/examples/download-only-config.mjs
node ops/speedtest/tests/test_example.mjs
node --check flood-worker.js
node --test ops/speedtest/tests/test_flood_client.mjs
python ops/speedtest/deploy.py --dry-run --offline
python ops/speedtest/verify.py --plan
python ops/speedtest/verify.py --plan --mode full --allow-large --budget-bytes 1400000000
```

To deliberately regenerate the checked-in payload, redirect the renderer output to `ops/speedtest/cloudflare-rules.json`, then run `--check` and tests. The Python matcher and mock transports are **contract models, not Cloudflare expression validation, live API compatibility, routing or normalization proof**. Raw-field availability, rule quotas, plan entitlements, actual API canonicalization and cache behavior must be checked on the real account by the deploying operator. A documentation-compatible payload is not evidence it was accepted.

## Existing console integration

`flood-worker.js` has one download source, `https://data.totob12.com/__down`. It requests the original console's exact reachable MiB sizes, capped at **100 MiB (104,857,600 bytes)**, without rounding them up to SDK decimal fixtures. Requests retain the old-client `GET ?cb=...&bytes=N` shape; no Range or unrelated service is used. Browser cache is `no-store`, credentials are omitted and redirects are refused. Before reading, the worker requires HTTP 200, the exact requested URL, `application/octet-stream`, the matching literal Content-Length and absent Content-Encoding, so unsupported-query Pages HTML is not accepted.

The page still starts only through its existing toggle. No SDK, upload, logging backend, production harness or new controls are added. Original counters, reset/stop/restart handling, source backoff/fallback behavior and displayed units/target chunk size are deliberately unchanged: internal `MB`/`GB` conversions remain binary (MiB/GiB), while endpoint query values are decimal spellings of exact byte counts. The console's MiB target maps to its exact known fixture, not a larger SDK size; existing header-based accounting is not packet-level usage measurement. Offline VM tests cover endpoint compatibility and preserve these legacy behaviors; they do not prove live routing or browser behavior.

## Generate fixtures privately

Use a new absolute directory outside **every** repository and Pages/public deployment tree; outputs under this repository, symlink paths, and public/www/htdocs/dist/build/pages ancestry are refused. For a new complete corpus, reserve at least 1,145,269,024 bytes plus space for temporary chunks. Preserve existing legacy fixture bytes/hashes; do not regenerate them to expand an existing deployment. These are binary OS-random bytes, not repeated patterns, zero-filled files, base64 or compressed files.

```sh
PRIVATE="$HOME/.speedtest-private"
python ops/speedtest/generate-fixtures.py --output-dir "$PRIVATE/fixtures"
python ops/speedtest/generate-fixtures.py --output-dir "$PRIVATE/fixtures" --validate-only
```

The generator streams `os.urandom` chunks, fsyncs and atomically links each completed file without overwriting. `manifest.json` records exact keys, lengths, SHA-256 and HTTP metadata; manifest mode is 0600, newly created directories 0700. A rerun re-hashes existing fixtures against the manifest and writes nothing. Corrupt/missing/unmanifested files stop the run. After an interrupted generation, inspect the private orphan files; do not silently overwrite them. Keep one immutable fixture set for the entire deployment and verification.

## Credentials / prerequisites

Do not pass credentials in arguments, repo files, audit records, chat, shell tracing, or CI. There are **two different** credential paths:

1. Account configuration stages use only environment variable `CLOUDFLARE_API_TOKEN`. The owner must provide the minimum permissions required by the actual API endpoints for this account/zone: R2 bucket/domain/CORS configuration, DNS read (snapshot only), Cloud Connector read/write and the five relevant Rulesets phases. Permission-group discovery or account-admin grants are not a workaround for a denial. Consult the API's per-operation token requirements and existing owner-approved access. The tool does not write DNS directly; R2 domain attachment may provision the domain's DNS mapping. It never changes the existing data-host record.
2. **Object upload uses direct S3 only:** environment variables `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`; endpoint `https://a8f49ad6ebe26d6d38841a5e1d49ce6d.r2.cloudflarestorage.com`, region `auto`. Ask the owner through their secure workflow for an R2 **Object Read & Write** token restricted to **`totob12-speedtest` only**. No account-admin or bucket-configuration permission is needed for this stage. The tool does not consult AWS profiles or unrelated stored credentials. Owner must revoke the short-lived object credentials after deployment/readback and clear them from the environment. Never ask for a secret in chat.

Optional S3 dependency, installed outside the repository only when needed:

```sh
python -m venv "$PRIVATE/s3-venv"
"$PRIVATE/s3-venv/bin/python" -m pip install -r ops/speedtest/requirements-s3.txt
```

Keep operator execution exclusive: S3 snapshot/pre-upload checks detect observed drift but multipart replacement is not an atomic compare-and-swap. A concurrent writer can still race the last HeadObject; do not run two deployments or another writer simultaneously.

### Provisioning history reported by the parent operator

The parent first reported Standard/WEUR bucket creation, CORS, disabled r2.dev and TLS-attached origin readback, but REST/MCP object HTTP metadata ignored Cache-Control. A streamed attempted 250,000,000-byte object silently stored **134,210,688 bytes** despite a successful response; the corrupt approved object was deleted. Do not reuse that upload path or trust its success result.

The parent subsequently resolved secure direct-S3 access, conditionally self-copied the six existing objects to set exact stored Cache-Control/SHA metadata, and generated/uploaded the exact 250,000,000-byte object by multipart. They reported HeadObject length/HTTP metadata readback for all seven (386,100,000 bytes total), recorded in an external **`r2-corpus-manifest.json`** with known expected body SHA-256 values. **Do not regenerate or re-upload those seven legacy fixtures.** Their old seven-object receipt is historical version-1 evidence, not a complete version-2 manifest. Before expanded routing, the operator must add/verify only the 13 missing client fixtures and produce a combined 20-object receipt preserving all legacy hashes. Version-2 tooling deliberately rejects an incomplete seven-object receipt; use the combined receipt with `verify.py --corpus-manifest`. This implementation only validates the receipt locally; it has not contacted the account or independently proved remote body equality. Full streamed public hashes, routing/cache/browser checks and owner credential revocation still belong to the deploying operator.

## Staged deployment (default is dry-run)

Use a **NEW** absolute external `--audit-dir` for every live dry-run or apply; directory 0700 and JSON files 0600. Account snapshots include the full current bucket configuration, domains, managed domain, CORS, connector list, all five phase entrypoints and paginated zone DNS. Snapshots and collision/diff checks precede any write. Every changed target is fetched again and compared; unexpected readbacks stop without deleting unrelated state or automatic rollback.

```sh
# Auth environment must already have been set securely by the owner.
python ops/speedtest/deploy.py --stage bucket --audit-dir "$PRIVATE/audit-bucket-dry-001"
python ops/speedtest/deploy.py --stage bucket --apply --audit-dir "$PRIVATE/audit-bucket-apply-001"
python ops/speedtest/deploy.py --stage origin --audit-dir "$PRIVATE/audit-origin-dry-001"
python ops/speedtest/deploy.py --stage origin --apply --audit-dir "$PRIVATE/audit-origin-apply-001"
```

Wait for origin ownership and certificate `status` to be `active`, verify TLS and the exact CORS/managed-domain state. The rules stage refuses an absent bucket, inactive origin, wrong minimum TLS, enabled r2.dev or CORS drift. `--stage all` covers **account configuration only**, never uploads, and is available only when those prerequisites are already ready. Prefer separated stages for a new deployment. Confirm all 20 objects' exact stored lengths, hashes and metadata before enabling expanded routing. Do not replace the seven static legacy rewrites while new fixtures are absent or unverified.

### Direct S3 objects stage

```sh
# Fully offline: reads/hashes private fixtures only, no credentials or boto3.
python ops/speedtest/deploy.py --stage objects --dry-run --offline --fixture-dir "$PRIVATE/fixtures"

# S3 dry-run performs HeadObject snapshots but does not upload.
"$PRIVATE/s3-venv/bin/python" ops/speedtest/deploy.py --stage objects \
  --fixture-dir "$PRIVATE/fixtures" --audit-dir "$PRIVATE/audit-objects-dry-001"

# New deployment only: upload approved known keys, never other keys.
"$PRIVATE/s3-venv/bin/python" ops/speedtest/deploy.py --stage objects --apply \
  --fixture-dir "$PRIVATE/fixtures" --audit-dir "$PRIVATE/audit-objects-apply-001"
```

For a new deployment with existing incomplete/metadata-deficient fixtures, both plan/apply require explicit `--replace-existing-objects` to permit replacing **selected approved keys only**. This is a deliberate overwrite, not a general bucket sync. To operate only the largest missing fixture, add `--size 250000000`; repeat `--size` for a subset. Do not leave any other approved object with wrong Cache-Control or a different intended fixture hash. All 20 must correspond to the combined deployed corpus manifest. For the repaired seven-object parent corpus, preserve those keys and add only missing client fixtures; repeat `--size` for the 13 client sizes. Never regenerate legacy bytes merely to obtain a new manifest.

The S3 stage explicitly supplies Content-Type, **stored Cache-Control**, Standard S3 storage class (`STANDARD`), and SHA-256/owner user metadata; it never supplies Content-Encoding. Uploads stream from disk. Objects at/above 64 MiB use multipart with 32 MiB parts and two concurrent streams, including the exact 250,000,000-byte object. SDK request retries are limited to one attempt; this does not turn logical byte counts into packet-level billing measurement. A successful upload is accepted only after HeadObject confirms exact ContentLength, type, Cache-Control, absent ContentEncoding, Standard storage and expected user metadata. Silent truncation or missing cache metadata is a failure. Failure evidence is retained; no automatic object deletion or rollback.

**HeadObject length/hash metadata is not body equality proof.** A multipart ETag is not SHA-256. The report says `remote_body_hash_verified: false`; use the bounded HTTP verifier for actual streamed remote body hashes. Upload totals report logical successful file bytes separately and do not claim to account for failed/retried transport bytes.

### Rules / connector stage

For version-1 migration, first verify all added fixtures and prepare the combined
20-object known-hash/HeadObject receipt. Review an offline plan with
`--migrate-legacy-rewrites --update-owned`; live migration additionally requires
`--corpus-manifest /absolute/private/combined-receipt.json`. The receipt is copied
into the private audit and validates exact lengths/metadata/expected hashes, not
remote body equality. The operator still owns body verification before routing.

`--migrate-legacy-rewrites` recognizes **only all seven exact approved version-1
static rules** (refs, expressions, action parameters, enabled state and every
writable field). Missing/partial, duplicate, mixed static/dynamic, drifted or
unknown owned rules fail closed even with `--update-owned`. One audited ruleset
PUT removes just those proven rules, inserts the dynamic rule at their first
position, and preserves every unrelated rule's ID, writable configuration and
relative order. Exact full-array readback is mandatory; observed concurrency
stops before writes. Other phases' owned expressions/connector need reviewed
`--update-owned` updates for the expanded scope. The existing cache:false catchall
and Oliver's SSL rule are never replaced or reordered.

```sh
python ops/speedtest/deploy.py --stage rules --audit-dir "$PRIVATE/audit-rules-dry-001"
python ops/speedtest/deploy.py --stage rules --apply --audit-dir "$PRIVATE/audit-rules-apply-001"
# Offline diff against a private prior snapshot, never a stale live apply:
python ops/speedtest/deploy.py --offline --stage rules --snapshot-input "$PRIVATE/audit-rules-dry-001/before.json"

# Version-1 migration preview; no account calls or writes:
python ops/speedtest/deploy.py --offline --stage rules --migrate-legacy-rewrites --update-owned \
  --snapshot-input "$PRIVATE/audit-rules-dry-001/before.json"
# AFTER every added object is verified, reviewed live dry-run (omit --offline):
python ops/speedtest/deploy.py --stage rules --migrate-legacy-rewrites --update-owned \
  --corpus-manifest "$PRIVATE/r2-corpus-v2-manifest.json" --audit-dir "$PRIVATE/audit-v2-dry-001"
# Apply only the reviewed migration with a NEW audit directory and --apply.
```

Review private `plan.json` against `before.json`, including broader wildcard/global rules the conservative collision detector cannot fully reason about. Expected refs are deterministic `bella_speedtest_*`; same owned rules are no-ops. Duplicate refs, unknown owned refs, nonowned endpoint-host rules/connectors, misplaced cache exception and unknown connector fields fail closed. Owned drift is refused by default; after reviewing its exact scope, `--update-owned` permits PATCH of only those exact rule refs, the exact owned connector description and the dedicated bucket CORS. It does not give permission to rewrite unrelated rules.

On redeployment, an existing owned strict SSL rule followed by an enabled non-strict `set_config` SSL rule is rejected unless nonoverlap is provable (literal unrelated-host equality or `false`). A later global Flexible/Full/off rule or uncertain wildcard predicate requires manual review even with `--update-owned`. The tool never repositions the owned rule or changes unrelated SSL rules, including Oliver's strict rule. Earlier global settings remain untouched; an initially appended endpoint strict rule follows them.

Existing rulesets normally receive individual append POSTs (owned updates use PATCH). The sole explicit replacement exception is the audited seven-static-to-one-dynamic rewrite migration described here; there is no owned-prefix bulk deletion. Missing phase entrypoints are created with zone kind and just the approved phase's rules. Initial deployment order is scoped SSL/compression/headers, rewrites, connector, then the cache exception **last**: keep the existing cache:false catchall in force until routing is ready so transient Pages HTML cannot be cached for 30 days. Connector API requires PUT of a full array: its existing unrelated entries/IDs/order are preserved, a fresh comparison guards observed concurrent changes, and full list readback is checked. Account token, transport errors and raw API error bodies are never printed. A live failure/permission denial stops; offline render does not pretend a deployment happened.

Cloud Connector PUT can regenerate the exact `bella_speedtest_connector` rule's ID. Its description is the stable ownership marker: refresh GET before every action, including rollback/restore, rather than reuse a prior ID. Readback accepts only its nonempty server-assigned ID changing; every other field and array order/count remain exact, and unrelated ID drift is fatal.

Optional GET absence handling is narrow: HTTP 404, one failure-envelope error, code `10003` and the exact missing-entrypoint message for the requested approved phase/path (the dedicated connector route expects `http_request_cloud_connector`). Only that connector absence is normalized to `[]` for snapshot/prewrite comparison. The exact approved bucket GET instead recognizes R2 missing-bucket code `10006`; it is not a generic 404 rule for bucket subroutes. Error JSON is read with a 64KiB ceiling and closed; malformed/oversized responses, wrong paths/phases, other codes, HTTP 403 or failed reads stop with sanitized diagnostics. Permissions must be fixed by the owner, never bypassed.

## Real HTTP verification / traffic budget

Choose the intended deployed corpus, not a newly generated unrelated random set. `--manifest` is the generator's manifest and re-hashes all local fixture files. **`--corpus-manifest`** accepts the parent's combined external `r2-corpus-v2-manifest.json` known-SHA/HeadObject receipt without needing local copies of the six self-copied objects. It validates the exact bucket, all 20 keys/order/sizes, total/count, SHA syntax (including the empty-file digest), stored HTTP metadata and metadata-readback marker. Those are receipt validations, **not** local-file hashes or remote-body proof; provenance is explicit in the JSON report. The subsequent HTTP GETs still must match each known expected SHA. Do not substitute multipart ETags or blindly copied user metadata for known body hashes.

```sh
# Expanded parent corpus: offline combined-v2 receipt validation/preview.
python ops/speedtest/verify.py --plan --corpus-manifest "$PRIVATE/r2-corpus-v2-manifest.json"
# After review and approved routing: use that SAME receipt, no re-upload.
python ops/speedtest/verify.py --corpus-manifest "$PRIVATE/r2-corpus-v2-manifest.json" \
  --report "$PRIVATE/verify-current-quick-001.json"
python ops/speedtest/verify.py --mode full --allow-large --budget-bytes 1400000000 \
  --corpus-manifest "$PRIVATE/r2-corpus-v2-manifest.json" --report "$PRIVATE/verify-current-full-001.json"

# Alternative: a new deployment made from locally generated fixtures.
python ops/speedtest/verify.py --manifest "$PRIVATE/fixtures/manifest.json" \
  --report "$PRIVATE/verify-quick-001.json"
# Explicit consent + budget required; never selected automatically:
python ops/speedtest/verify.py --mode full --allow-large --budget-bytes 1400000000 \
  --manifest "$PRIVATE/fixtures/manifest.json" --report "$PRIVATE/verify-full-001.json"
```

Quick mode GETs only 0/100,000/1,000,000-byte fixtures (including origin objects and cachebuster repeats); HEAD and OPTIONS probe all 20 sizes, both cb orderings and the canonical zero latency forms. Planned object GET body bytes remain **3,500,000**; default ceiling is **5,000,000** including all fallback/error body reads. Large Pages HTML/error bodies may exhaust this small budget: that is a reported failure, not permission to silently raise it. Full mode streams each of the 20 fixtures **once** on the data endpoint; warm cb/reordered GETs and direct-origin GETs are restricted to at most 1,000,000 bytes, with zero-byte loaded-latency variants and small Origin probes. Planned object GET body bytes: **1,147,669,024** (178 exercises), leaving room for fallback/error bodies under the explicit budget. It does not download three copies of the expanded corpus. Reports separately count their own exercised bytes and request results.

The approved deployment verification ceiling is **2,000,000,000 bytes shared across operator exercises**, not a per-command allowance. Aggregate quick, full, browser/client exercises and other verification requests, including prior failed reads; lower the next budget accordingly. The example client's positive requested download counts alone can request up to **969,000,000 bytes**, so do not blindly run it plus full verification within the same 2GB approval. The client can finish early based on duration, which is not a budget guarantee. Tool reports count body bytes actually read, including HTTP errors and partial failed reads; they do **not** claim to include TLS/HTTP headers or bytes sent by the server after closing a response. S3 upload traffic must be tracked separately by the operator.

Verification streams raw bytes without decompression, checks actual length/SHA-256, Content-Length/type/encoding, browser no-store headers, CORS/TAO/exposure, Accept-Ranges, Origin/no-Origin responses and repeated-GET CF cache HIT/Age evidence. OPTIONS must not be cache HIT. Nonempty origin queries must bypass the cache exception. It tests unsupported query/path variants against Pages HTML fallback, including duplicate/empty/overlong cb, nonzero during, encoded bytes and wrong paths. Negative normalization probes are real HTTP tests, not a claim that the Python model predicts Cloudflare normalization.

A warm request can reach another POP (inspect `CF-RAY`) and return MISS; the strict verifier may flag a failed cache assertion despite passing body/header checks. Keep the original failed receipt and record bounded follow-up requests proving actual HIT/Age within the remaining approved traffic budget. The edge TTL does not guarantee retention or HITs across POPs.

No redirects, automatic retries or unlimited error-body reads. Socket timeout defaults to 30 seconds; global deadline defaults to 600 seconds and is checked between streamed reads (a blocked read remains bounded by the socket timeout). The budget is a hard body-read ceiling, not a network egress firewall. Any failed/incomplete assertion returns nonzero and leaves a new private JSON report. A HEAD response is never described as remote body proof. HTTP tests do not replace a consented browser check of readable `PerformanceResourceTiming`, loaded latency and console/CORS behavior.

## Purge and rollback

Do not purge the entire zone. After changing fixtures/metadata/CORS, issue an operator-reviewed **targeted** purge for the canonical original data URLs plus the 20 rewritten data-host paths with empty query and the 20 origin object URLs; include observed old-client cb/order variants if they affect actual cache keys. The rewrite clears cb and during, so do not try to enumerate an unlimited cachebuster space. Rewrites/connector routing may cause more than one key shape to matter. Include the actual `Origin` header variants used by probes/browser clients and consider no-Origin cached variants; URL-only purges may not evict a custom/header-dependent cache key. Consult Cloudflare's single-file purge/CORS guidance, use current observed keys, and read back/test again. This tooling intentionally does not auto-purge or broaden cache keys to unsupported queries.

Rollback should **disable only the created owned rules and connector**, preserving the rest of each ruleset/full connector list; fetch fresh state and exact readbacks. Restore reviewed dedicated-bucket CORS only if appropriate. Do not restore an entire stale zone snapshot over others' changes. Do not delete the bucket, other objects, custom DNS mappings or the origin domain without separate owner approval. Keep private before/plan/readback reports as evidence.

## Download-only client example

`examples/download-only-config.mjs` is for **`@cloudflare/speedtest@1.14.1`**. It exports config only and makes no requests. Explicit `autoStart: false`; result/measurement logging disabled; authorization disabled; `estimatedServerTime: 0`; download loaded latency on and upload loaded latency off. It keeps initial 2 and 20 latency packets (around the bypass warm-up), 2-packet gaps, and positive download rounds: 100,000×1 bypass + 9, 1,000,000×8, 10,000,000×6, 25,000,000×4, 100,000,000×3, 250,000,000×2. No upload, packet-loss, TURN, RPKI or externally logged measurements. Pin the package exactly if integrating this separate example later; the existing console integration above does not use this SDK. The example adds no UI/harness; live browser verification still needs separate review/consent.

The SDK merges omitted options over its defaults and requires a truthy upload URL even for download/latency engines. The example explicitly replaces upload/TURN-credential URLs and TURN/RPKI hosts with reserved `disabled.invalid` placeholders, with null TURN username/password; it never leaves the default external service targets configured. The approved schedule never uses these placeholders: they are not a network sandbox if someone later adds unsupported measurements. To verify the fully merged config and truthy-URL compatibility offline, optionally pass an already cached **official 1.14.1** `dist/speedtest.js` path to `node ops/speedtest/tests/test_example.mjs /absolute/cached/package/dist/speedtest.js`. That check mocks fetch before SDK import and exercises one latency request; no install, account request or real network transport is performed.

## Primary references and remaining live validation

Phase/action/payload shape was checked against Cloudflare's published documentation source and generated official TypeScript/OpenAPI interfaces; client options against the published 1.14.1 npm package. The documentation HTML surface returned 403 locally, so the official source repository was used. None of these reads contacted an account API.

- https://developers.cloudflare.com/ruleset-engine/reference/phases-list/
- https://developers.cloudflare.com/rules/transform/url-rewrite/create-api/
- https://developers.cloudflare.com/rules/transform/url-rewrite/reference/parameters/
- https://developers.cloudflare.com/rules/transform/response-header-modification/create-api/
- https://developers.cloudflare.com/cache/how-to/cache-rules/create-api/
- https://developers.cloudflare.com/rules/configuration-rules/create-api/
- https://developers.cloudflare.com/rules/compression-rules/create-api/
- https://developers.cloudflare.com/rules/compression-rules/settings/
- https://developers.cloudflare.com/r2/examples/aws/boto3/
- https://developers.cloudflare.com/r2/api/s3/api/
- https://developers.cloudflare.com/r2/api/error-codes/
- https://developers.cloudflare.com/ruleset-engine/rules-language/fields/reference/raw.http.request.uri.args/
- https://developers.cloudflare.com/ruleset-engine/rules-language/fields/reference/raw.http.request.uri.args.names/
- https://developers.cloudflare.com/ruleset-engine/rules-language/fields/reference/http.request.headers/
- https://developers.cloudflare.com/ruleset-engine/rules-language/functions/#len
- https://developers.cloudflare.com/ruleset-engine/rules-language/values/#missing-values
- https://developers.cloudflare.com/cache/how-to/purge-cache/purge-by-single-file/
- https://github.com/cloudflare/cloudflare-docs/tree/production/src/content/docs
- https://github.com/cloudflare/cloudflare-typescript/tree/main/src/resources/r2/buckets
- https://github.com/cloudflare/cloudflare-typescript/blob/main/src/resources/cloud-connector/rules.ts
- https://registry.npmjs.org/@cloudflare/speedtest/-/speedtest-1.14.1.tgz

**Not validated locally:** live Cloudflare expression acceptance/entitlements and normalized readback, direct-S3 credential permissions/upload compatibility, actual 250MB remote body equality, cache HITs and browser timing/CORS. Mock tests explicitly do not certify these. Operator must complete real deployment/readback and bounded public verification before claiming the endpoint is operational.
