#!/usr/bin/env python3
"""Bounded real HTTP verifier; no account API, redirects, retries or HEAD-only proof."""
from __future__ import annotations

import argparse
import hashlib
import http.client
import json
from pathlib import Path
import time
import urllib.error
import urllib.request

import speedtest_ops as ops


class BudgetExceeded(RuntimeError):
    pass


class Budget:
    def __init__(self, limit):
        if type(limit) is not int or limit < 0:
            raise ValueError('Byte budget must be a nonnegative integer')
        self.limit, self.used = limit, 0

    @property
    def remaining(self):
        return self.limit - self.used


def stream_body(response, budget, chunk_size=1024 * 1024, deadline=None):
    h, size, prefix = hashlib.sha256(), 0, b''
    while True:
        if deadline is not None and time.monotonic() >= deadline:
            raise TimeoutError('Global verification deadline exceeded')
        if budget.remaining <= 0:
            raise BudgetExceeded('Body byte budget exhausted; body closed without an extra read')
        try:
            chunk = response.read(min(chunk_size, budget.remaining))
        except http.client.IncompleteRead as exc:
            # A failed read can still have received a partial body. Count it even
            # though no complete chunk was returned; never discard failure traffic.
            budget.used += len(exc.partial)
            raise
        if not chunk:
            return size, h.hexdigest(), prefix
        budget.used += len(chunk)
        size += len(chunk)
        h.update(chunk)
        if len(prefix) < 512:
            prefix += chunk[:512 - len(prefix)]


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def exercise_plan(mode):
    if mode not in ('quick', 'full'):
        raise ValueError('Unknown verification mode')
    c = ops.load_contract()
    exercises = []
    def add(host, path, query, method, size, **extra):
        exercises.append({'host': host, 'path': path, 'query': query, 'method': method, 'bytes': size, **extra})
    # HEAD/preflight probes cover every size and both cachebuster orders without
    # tripling the large corpus transfer. queries is a canonical probe list,
    # not the structurally matched set of all possible accepted query strings.
    queries = c['queries'] + [query for n in c['sizes'] for query in
                             (f'bytes={n}&cb=head-probe', f'cb=head-probe&bytes={n}')]
    for query in queries:
        n = int(next(part[6:] for part in query.split('&') if part.startswith('bytes=')))
        add(c['data_host'], c['path'], query, 'HEAD', n, origin=True, kind='object')
        add(c['data_host'], c['path'], query, 'OPTIONS', 0, origin=True, kind='preflight')
    small = [n for n in c['sizes'] if n <= 1000000]
    sizes = c['sizes'] if mode == 'full' else small
    for n in sizes:
        add(c['data_host'], c['path'], f'bytes={n}', 'GET', n, origin=True, warm=False, kind='object')
        if n <= 1000000:
            # Different cb/order must still reuse the same query-cleared CDN key.
            add(c['data_host'], c['path'], f'cb=warm-probe&bytes={n}', 'GET', n,
                origin=True, warm=True, kind='object')
            add(c['origin_host'], f'/speedtest/{n}.bin', '', 'GET', n, origin=True, kind='object')
    # Actual zero-body/hash probes for loaded latency, with and without cb.
    for during in ('idle', 'download'):
        for query in (f'during={during}&bytes=0', f'bytes=0&during={during}',
                      f'cb=latency&during={during}&bytes=0', f'bytes=0&during={during}&cb=latency'):
            add(c['data_host'], c['path'], query, 'GET', 0, origin=True, kind='object')
    add(c['data_host'], c['path'], 'bytes=100000', 'GET', 100000, origin=False, kind='object')
    add(c['origin_host'], '/speedtest/100000.bin', 'cb=1', 'GET', 100000, origin=True, kind='origin-query', bypass=True)
    invalid = [('/__down', 'bytes=00'), ('/__down', 'bytes=%30'), ('/__down', 'bytes=0&bytes=0'),
               ('/__down', 'bytes=100000&during=idle'), ('/__down', 'during=IDLE&bytes=0'),
               ('/__down', 'bytes=0&cb='), ('/__down', 'bytes=0&cb=1&cb=2'),
               ('/__down', 'bytes=0&cb=' + 'x' * 129), ('/__down', 'bytes=-1'),
               ('/__down', 'bytes=0&during=idle&during=download'), ('/__down', 'bytes=0&measId=x'),
               ('/__down', 'Bytes=0'), ('/__down', ''), ('/__down', 'bytes=123'),
               ('/__DOWN', 'bytes=0'), ('/%5f_down', 'bytes=0'), ('//__down', 'bytes=0'), ('/__down/', 'bytes=0')]
    for path, query in invalid:
        add(c['data_host'], path, query, 'GET', 0, origin=True, kind='fallback', expect_html=True)
    # Never include HEAD bytes in transfer planning; those are header assertions.
    return exercises


def validate_response(exercise, status, headers, size, digest, prefix, manifest):
    errors, c = [], ops.load_contract()
    h = {key.lower(): value for key, value in headers.items()}
    kind, method = exercise['kind'], exercise['method']
    def require(okay, message):
        if not okay:
            errors.append(message)
    if kind == 'fallback':
        require(status == 200, 'Unsupported request did not retain Pages HTML 200 fallback')
        require('text/html' in h.get('content-type', '').lower(), 'Fallback content type is not HTML')
        require(b'<' in prefix, 'Fallback body does not look like HTML')
        require(h.get('cf-cache-status', '').upper() != 'HIT', 'Fallback unexpectedly cache HIT')
        return errors
    if kind == 'preflight':
        require(status in (200, 204), 'OPTIONS is not a successful CORS preflight')
        methods = {x.strip().upper() for x in h.get('access-control-allow-methods', '').split(',')}
        require('GET' in methods, 'Preflight did not allow GET')
        require(h.get('cf-cache-status', '').upper() not in ('HIT', 'STALE', 'UPDATING', 'REVALIDATED'), 'OPTIONS was cache eligible')
    else:
        require(status == 200, 'Object status is not 200')
        require(h.get('content-type', '').split(';')[0].strip().lower() == c['content_type'], 'Not application/octet-stream')
        require(h.get('content-length') == str(exercise['bytes']), 'Content-Length differs from exact object size')
        require(h.get('accept-ranges', '').lower() == 'bytes', 'Accept-Ranges is not bytes')
        if method == 'GET':
            require(size == exercise['bytes'], 'Streamed body length mismatch')
            entries = {x['bytes']: x for x in manifest['objects']}
            require(digest == entries[exercise['bytes']]['sha256'], 'Streamed SHA-256 mismatch')
        if exercise.get('warm'):
            require(h.get('cf-cache-status', '').upper() == 'HIT', 'Second exact GET did not prove an edge cache HIT')
            require(h.get('age', '').isdigit(), 'Warm HIT missing numeric Age')
        if kind == 'origin-query':
            require(h.get('cf-cache-status', '').upper() not in ('HIT', 'STALE', 'UPDATING', 'REVALIDATED'), 'Origin query unexpectedly cache eligible')
    require(h.get('content-encoding', '').lower() in ('', 'identity'), 'Response body was compressed/encoded')
    # Origin-query is intentionally outside transformation scope: raw metadata and
    # native R2 CORS still apply, but TAO/exposure union is not promised there.
    if kind != 'origin-query':
        require(h.get('cache-control', '') == c['cache_control'], 'Browser Cache-Control differs from no-store, no-transform')
        require(h.get('access-control-allow-origin') == '*', 'ACAO must be * (also tested without Origin)')
        require(h.get('timing-allow-origin') == '*', 'TAO must be *')
        exposed = {x.strip().lower() for x in h.get('access-control-expose-headers', '').split(',')}
        require(set(x.lower() for x in c['expose_headers']) <= exposed, 'Missing exposed measurement headers')
    return errors


def verify_one(exercise, opener, budget, manifest, timeout=30, deadline=None):
    query = '?' + exercise['query'] if exercise['query'] else ''
    url = f'https://{exercise["host"]}{exercise["path"]}{query}'
    headers = {'User-Agent': 'totob12-speedtest-verifier/1',
               'Accept': '*/*', 'Accept-Encoding': 'identity' if exercise['kind'] == 'fallback' else 'gzip, br, zstd'}
    if exercise.get('origin'):
        headers['Origin'] = 'https://data.totob12.com'
    if exercise['method'] == 'OPTIONS':
        headers['Access-Control-Request-Method'] = 'GET'
    request = urllib.request.Request(url, method=exercise['method'], headers=headers)
    started, prior = time.monotonic(), budget.used
    result = {'exercise': exercise, 'url': url, 'ok': False}
    try:
        if deadline is not None and time.monotonic() >= deadline:
            raise TimeoutError('Global verification deadline exceeded')
        # HTTPError is a response; read its body through the SAME byte limiter.
        try:
            response = opener.open(request, timeout=timeout)
        except urllib.error.HTTPError as error_response:
            response = error_response
        with response:
            status = response.status
            response_headers = dict(response.headers.items())
            if exercise['method'] == 'HEAD':
                size, digest, prefix = 0, None, b''
            else:
                size, digest, prefix = stream_body(response, budget, deadline=deadline)
        errors = validate_response(exercise, status, response_headers, size, digest, prefix, manifest)
        result.update(status=status, headers=response_headers, body_bytes=size, sha256=digest, errors=errors, ok=not errors)
    except (BudgetExceeded, TimeoutError, urllib.error.URLError, OSError, ValueError, http.client.HTTPException) as exc:
        # No arbitrary server error body or HTML in report; body hashes remain useful.
        result.update(errors=[str(exc) if isinstance(exc, (BudgetExceeded, TimeoutError, ValueError)) else type(exc).__name__])
    result['transferred_body_bytes'] = budget.used - prior
    result['elapsed_seconds'] = round(time.monotonic() - started, 3)
    return result


def load_expected_manifest(args):
    if args.corpus_manifest:
        path = ops.external_path(args.corpus_manifest)
        manifest = ops.validate_corpus_manifest(path)
        kind, local_verified = 'operator-corpus-receipt', False
    else:
        path = ops.external_path(args.manifest)
        if path.name != 'manifest.json':
            raise ValueError('Use generator manifest.json with --manifest, or an operator receipt with --corpus-manifest')
        manifest = ops.validate_manifest(path.parent)
        kind, local_verified = 'generated-fixtures', True
    return manifest, {'kind': kind, 'path': str(path), 'local_file_hashes_verified': local_verified,
                      'remote_body_hashes_verified_before_http': False}


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--mode', choices=('quick', 'full'), default='quick')
    p.add_argument('--allow-large', action='store_true', help='Required explicit consent for --mode full')
    p.add_argument('--budget-bytes', type=int, help='Hard body-read ceiling (quick default 5000000; full must be explicit)')
    source = p.add_mutually_exclusive_group()
    source.add_argument('--manifest', type=Path, help='External generator manifest.json; locally re-hashes all fixture files')
    source.add_argument('--corpus-manifest', type=Path, help='External operator known-SHA/HeadObject receipt; no local copies/re-upload required')
    p.add_argument('--report', type=Path, help='Required NEW absolute external JSON report path')
    p.add_argument('--timeout', type=float, default=30, help='Per socket operation timeout in seconds')
    p.add_argument('--max-seconds', type=float, default=600, help='Global deadline checked between every streamed read')
    p.add_argument('--plan', action='store_true', help='Offline exercise selection/budget preview only; no HTTP')
    args = p.parse_args(argv)
    c = ops.load_contract()
    if args.mode == 'full' and (not args.allow_large or args.budget_bytes is None):
        p.error('--mode full requires --allow-large and an explicit --budget-bytes')
    limit = args.budget_bytes if args.budget_bytes is not None else 5000000
    if not 0 < limit <= c['max_verification_bytes'] or args.timeout <= 0 or args.max_seconds <= 0:
        p.error('Positive timeout/deadline and byte budget <= 2000000000 required')
    exercises = exercise_plan(args.mode)
    planned = sum(e['bytes'] for e in exercises if e['method'] == 'GET' and not e.get('expect_html'))
    if planned >= limit:
        p.error('Budget must exceed planned object GET bytes, leaving room for Pages/error bodies and EOF detection')
    if args.plan:
        preview = {'mode': args.mode, 'planned_object_get_bytes': planned, 'budget_bytes': limit,
                   'exercise_count': len(exercises), 'exercises': exercises}
        if args.manifest or args.corpus_manifest:
            try:
                _, manifest_source = load_expected_manifest(args)
                preview['manifest_source'] = manifest_source
            except (ValueError, OSError, KeyError, TypeError) as exc:
                print(json.dumps({'ok': False, 'error': str(exc) if isinstance(exc, ValueError) else type(exc).__name__}))
                return 1
        print(json.dumps(preview, indent=2))
        return 0
    if not (args.manifest or args.corpus_manifest) or not args.report:
        p.error('One of --manifest/--corpus-manifest and --report are required for live verification')
    report_path = None
    budget = None
    results = []
    try:
        # Validate report destination first so preflight failures still produce
        # external machine-readable evidence without contacting the endpoint.
        report_path = ops.external_path(args.report)
        if report_path.exists():
            raise ValueError('Report path already exists; never overwrite verification evidence')
        manifest, manifest_source = load_expected_manifest(args)
        budget = Budget(limit)
        opener = urllib.request.build_opener(NoRedirect())
        deadline = time.monotonic() + args.max_seconds
        results = []
        for exercise in exercises:
            if budget.remaining <= 0 or time.monotonic() >= deadline:
                break
            results.append(verify_one(exercise, opener, budget, manifest, args.timeout, deadline))
        okay = len(results) == len(exercises) and all(r['ok'] for r in results)
        report = {'ok': okay, 'mode': args.mode, 'planned_object_get_bytes': planned, 'manifest_source': manifest_source,
                  'byte_budget': limit, 'transferred_body_bytes': budget.used,
                  'budget_accounting': 'All actual body reads including failed HTTP responses; excludes HTTP/TLS headers and server-side traffic after close.',
                  'global_deadline_seconds': args.max_seconds, 'exercise_count': len(exercises),
                  'completed_exercise_count': len(results), 'results': results,
                  'scope': 'This verifier only; operator must aggregate with browser/client/other deployment traffic against the shared 2GB approval.'}
        ops.private_json(report_path, report)
        print(json.dumps({'ok': okay, 'report': str(report_path), 'transferred_body_bytes': budget.used,
                          'completed_exercise_count': len(results), 'exercise_count': len(exercises)}))
        return 0 if okay else 1
    except (ValueError, OSError, KeyError, TypeError) as exc:
        failure = {'ok': False, 'error': str(exc) if isinstance(exc, ValueError) else type(exc).__name__,
                   'mode': args.mode, 'transferred_body_bytes': budget.used if budget is not None else 0,
                   'completed_exercise_count': len(results)}
        if report_path is not None and not report_path.exists():
            try:
                ops.private_json(report_path, failure)
                failure['report'] = str(report_path)
            except (OSError, ValueError):
                failure['report_write_failed'] = True
        print(json.dumps(failure))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
