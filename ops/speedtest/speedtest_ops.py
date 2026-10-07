"""Pure renderer, literal contract model and private fixture utilities (stdlib only)."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import tempfile

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
SIZES = [0, 100000, 1000000, 10000000, 25000000, 100000000, 250000000]
OWNED_PREFIX = 'bella_speedtest_'


def load_contract():
    c = json.loads((HERE / 'contract.json').read_text())
    required = {'account_id': 'a8f49ad6ebe26d6d38841a5e1d49ce6d',
                'zone_id': 'fe78766bf0bcad4c3858ae957b0d4041',
                'bucket': 'totob12-speedtest', 'data_host': 'data.totob12.com',
                'origin_host': 'speed-origin.totob12.com', 'path': '/__down',
                'sizes': SIZES, 'methods': ['GET', 'HEAD', 'OPTIONS'],
                'queries': [f'bytes={n}' for n in SIZES] + ['during=idle&bytes=0', 'during=download&bytes=0'],
                'total_fixture_bytes': 386100000, 'max_verification_bytes': 2000000000}
    if any(c.get(k) != v for k, v in required.items()):
        raise ValueError('Contract differs from approved resource/byte allowlist')
    return c


def match_download(host, raw_path, raw_query, method, headers=None):
    """Literal model, not CF validation; headers use CF's lowercase Map<Array>."""
    c = load_contract()
    if host != c['data_host'] or raw_path != c['path'] or method not in c['methods'] or raw_query not in c['queries']:
        return None
    if method == 'OPTIONS':
        headers = headers or {}
        origins = headers.get('origin', [])
        requested = headers.get('access-control-request-method', [])
        if (len(origins) != 1 or not origins[0] or len(requested) != 1
                or requested[0] not in ('GET', 'HEAD')):
            return None
    return int(raw_query.rsplit('bytes=', 1)[1])


def literals(values):
    return '{' + ' '.join(json.dumps(v) for v in values) + '}'


def data_scope(c, queries=None, methods=None):
    if methods is None:
        # Missing values compare ne "" as true in the Rules language. Require
        # singleton arrays before checking values; duplicate headers fail closed.
        gate = ('(http.request.method in {"GET" "HEAD"} or '
                '(http.request.method eq "OPTIONS" '
                'and len(http.request.headers["origin"]) eq 1 '
                'and len(http.request.headers["origin"][0]) gt 0 '
                'and len(http.request.headers["access-control-request-method"]) eq 1 '
                'and http.request.headers["access-control-request-method"][0] in {"GET" "HEAD"}))')
    else:
        gate = f'http.request.method in {literals(methods)}'
    return (f'(http.host eq "{c["data_host"]}" and raw.http.request.uri.path eq "{c["path"]}" '
            f'and raw.http.request.uri.query in {literals(c["queries"] if queries is None else queries)} '
            f'and {gate})')


def origin_scope(c):
    paths = [f'/speedtest/{n}.bin' for n in c['sizes']]
    return (f'(http.host eq "{c["origin_host"]}" and raw.http.request.uri.path in {literals(paths)} '
            'and raw.http.request.uri.query eq "" and http.request.method in {"GET" "HEAD"})')


def render_rules():
    c = load_contract()
    scope = f'({data_scope(c)} or {origin_scope(c)})'
    cache_scope = f'({data_scope(c, methods=["GET", "HEAD"])} or {origin_scope(c)})'
    def rule(ref, action, expression, parameters):
        return {'ref': OWNED_PREFIX + ref, 'description': OWNED_PREFIX + ref,
                'enabled': True, 'action': action, 'expression': expression,
                'action_parameters': parameters}
    rewrite = []
    for n in c['sizes']:
        queries = [f'bytes={n}']
        if n == 0:
            queries += c['queries'][-2:]
        rewrite.append(rule(f'rewrite_{n}', 'rewrite', data_scope(c, queries=queries),
                            {'uri': {'path': {'value': f'/speedtest/{n}.bin'}, 'query': {'value': ''}}}))
    headers = {name: {'operation': 'set', 'value': value} for name, value in {
        'cache-control': c['cache_control'], 'access-control-allow-origin': '*',
        'timing-allow-origin': '*', 'access-control-expose-headers': ', '.join(c['expose_headers'])}.items()}
    return {
        'schema_version': 1,
        'phases': {
            'http_request_transform': rewrite,
            'http_request_cache_settings': [rule('cache', 'set_cache_settings', cache_scope, {
                'cache': True, 'edge_ttl': {'mode': 'override_origin', 'default': c['edge_ttl_seconds'],
                    'status_code_ttl': [
                        {'status_code_range': {'to': 199}, 'value': -1},
                        {'status_code': 200, 'value': c['edge_ttl_seconds']},
                        {'status_code_range': {'from': 201}, 'value': -1}]},
                'browser_ttl': {'mode': 'respect_origin'}})],
            'http_response_headers_transform': [rule('headers', 'rewrite', scope, {'headers': headers})],
            'http_response_compression': [rule('compression', 'compress_response', scope, {'algorithms': [{'name': 'none'}]})],
            'http_config_settings': [rule('ssl', 'set_config', scope, {'ssl': 'strict'})]},
        'connector': {'provider': 'cloudflare_r2', 'parameters': {'host': c['origin_host']},
                      'description': OWNED_PREFIX + 'connector', 'expression': data_scope(c), 'enabled': True},
        'cors': {'rules': [{'id': 'bella-speedtest-public-downloads',
                            'allowed': {'origins': ['*'], 'methods': ['GET', 'HEAD'], 'headers': ['*']},
                            'exposeHeaders': c['expose_headers'], 'maxAgeSeconds': 86400}]}}


def external_path(path):
    path = Path(path)
    if not path.is_absolute():
        raise ValueError('An explicit absolute EXTERNAL path is required')
    resolved = path.resolve()
    if resolved == REPO or REPO in resolved.parents:
        raise ValueError('Fixture/audit/report output must never be in this repository')
    for parent in [resolved, *resolved.parents]:
        if (parent / '.git').exists() or parent.name.lower() in {'public', 'www', 'htdocs', 'dist', 'build', 'pages'}:
            raise ValueError('Output must not be a repository or public/Pages deployment directory')
    # Reject symlinks rather than following an operator-supplied public alias.
    for parent in [path, *path.parents]:
        if parent.is_symlink():
            raise ValueError('Symlink output paths are not allowed')
    return resolved


def private_json(path, value):
    path = external_path(path)
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as out:
        json.dump(value, out, indent=2, sort_keys=True)
        out.write('\n')
        out.flush()
        os.fsync(out.fileno())


def hash_file(path, chunk_size=1024 * 1024):
    h = hashlib.sha256()
    size = 0
    with Path(path).open('rb') as f:
        while chunk := f.read(chunk_size):
            size += len(chunk)
            h.update(chunk)
    return size, h.hexdigest()


def validate_manifest(directory, sizes=None, verify_files=True):
    directory = external_path(directory)
    sizes = load_contract()['sizes'] if sizes is None else sizes
    manifest_path = directory / 'manifest.json'
    if manifest_path.is_symlink():
        raise ValueError('Manifest may not be a symlink')
    m = json.loads(manifest_path.read_text())
    if m.get('schema_version') != 1 or m.get('total_bytes') != sum(sizes) or len(m.get('objects', [])) != len(sizes):
        raise ValueError('Invalid fixture manifest totals/schema')
    for n, entry in zip(sizes, m['objects']):
        if entry.get('key') != f'speedtest/{n}.bin' or entry.get('bytes') != n:
            raise ValueError('Invalid manifest object key/size/order')
        digest = entry.get('sha256', '')
        if len(digest) != 64 or any(x not in '0123456789abcdef' for x in digest):
            raise ValueError('Invalid manifest SHA-256')
        path = directory / entry['key']
        if path.is_symlink() or (directory / 'speedtest').is_symlink():
            raise ValueError('Fixture symlinks are forbidden')
        if verify_files and hash_file(path) != (n, digest):
            raise ValueError(f'Fixture does not match manifest: {entry["key"]}')
    return m


def validate_corpus_manifest(path):
    """Validate an operator's known-hash/HeadObject receipt, NOT remote bodies.

    Unlike generated manifests, no local copies of all seven objects are assumed.
    This permits verification of a conditionally copied existing corpus without
    regenerating/re-uploading it or mistaking multipart ETags for body SHA-256.
    """
    path = external_path(path)
    c = load_contract()
    m = json.loads(path.read_text())
    if (m.get('bucket') != c['bucket'] or m.get('count') != 7
            or m.get('total_bytes') != c['total_fixture_bytes']
            or len(m.get('objects', [])) != 7 or not isinstance(m.get('method'), str)):
        raise ValueError('Invalid operator corpus receipt bucket/count/totals/provenance')
    for n, entry in zip(c['sizes'], m['objects']):
        digest = entry.get('sha256', '')
        if (entry.get('key') != f'speedtest/{n}.bin' or entry.get('bytes') != n
                or len(digest) != 64 or any(x not in '0123456789abcdef' for x in digest)
                or entry.get('ContentType') != c['content_type']
                or entry.get('CacheControl') != c['cache_control']
                or 'ContentEncoding' not in entry or entry['ContentEncoding'] is not None
                or entry.get('metadata_verified') is not True):
            raise ValueError('Invalid operator corpus receipt exact key/size/hash/HTTP metadata')
        if n == 0 and digest != hashlib.sha256(b'').hexdigest():
            raise ValueError('Zero-byte corpus SHA-256 is invalid')
    return m


def generate_fixtures(output_dir, sizes=None, chunk_size=1024 * 1024):
    output_dir = external_path(output_dir)
    sizes = load_contract()['sizes'] if sizes is None else sizes
    if chunk_size <= 0 or any(type(n) is not int or n < 0 for n in sizes) or len(set(sizes)) != len(sizes):
        raise ValueError('Invalid sizes/chunk size')
    if (output_dir / 'manifest.json').exists():
        return validate_manifest(output_dir, sizes=sizes)
    output_dir.mkdir(parents=True, mode=0o700, exist_ok=True)
    objects_dir = output_dir / 'speedtest'
    if objects_dir.is_symlink():
        raise ValueError('Fixture directory symlink forbidden')
    objects_dir.mkdir(mode=0o700, exist_ok=True)
    # An interrupted generation must be explicitly inspected, never overwritten.
    if any((objects_dir / f'{n}.bin').exists() for n in sizes):
        raise ValueError('Unmanifested fixture exists; inspect it before retrying')
    objects = []
    for n in sizes:
        destination = objects_dir / f'{n}.bin'
        fd, temporary = tempfile.mkstemp(prefix='.fixture-', dir=objects_dir)
        try:
            h = hashlib.sha256()
            with os.fdopen(fd, 'wb') as f:
                remaining = n
                while remaining:
                    chunk = os.urandom(min(chunk_size, remaining))
                    f.write(chunk)
                    h.update(chunk)
                    remaining -= len(chunk)
                f.flush()
                os.fsync(f.fileno())
            # link is atomic and fails on any existing destination, unlike replace.
            os.link(temporary, destination)
            objects.append({'key': f'speedtest/{n}.bin', 'bytes': n, 'sha256': h.hexdigest()})
        finally:
            os.unlink(temporary)
    manifest = {'schema_version': 1, 'total_bytes': sum(sizes), 'objects': objects,
                'content_type': load_contract()['content_type'], 'cache_control': load_contract()['cache_control'],
                'content_encoding': None}
    private_json(output_dir / 'manifest.json', manifest)
    return validate_manifest(output_dir, sizes=sizes)


def main():
    p = argparse.ArgumentParser(description='Deterministic offline Cloudflare payload renderer; no account API calls.')
    p.add_argument('--check', action='store_true', help='Fail if checked-in cloudflare-rules.json has drifted')
    args = p.parse_args()
    rendered = render_rules()
    if args.check:
        if json.loads((HERE / 'cloudflare-rules.json').read_text()) != rendered:
            p.exit(1, 'Renderer drift: regenerate cloudflare-rules.json\n')
        print('Renderer drift check: OK')
    else:
        print(json.dumps(rendered, indent=2))


if __name__ == '__main__':
    main()
