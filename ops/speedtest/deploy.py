#!/usr/bin/env python3
"""Fail-closed staged deployment. Offline rendering never contacts an account."""
from __future__ import annotations

import argparse
import copy
import http.client
import json
import os
from pathlib import Path
import re
import urllib.error
import urllib.request

import speedtest_ops as ops

BASE = 'https://api.cloudflare.com/client/v4'
RULE_FIELDS = ('ref', 'description', 'enabled', 'action', 'expression', 'action_parameters')
CONNECTOR_FIELDS = ('id', 'description', 'enabled', 'expression', 'provider', 'parameters')
ERROR_BODY_LIMIT = 64 * 1024


def expected_missing(path, raw):
    """Only exact approved resource-absence errors; never generic/permission 404s."""
    if len(raw) > ERROR_BODY_LIMIT:
        return False
    try:
        envelope = json.loads(raw)
    except (ValueError, TypeError, RecursionError):
        return False
    if not isinstance(envelope, dict) or envelope.get('success') is not False:
        return False
    errors = envelope.get('errors')
    if not isinstance(errors, list) or len(errors) != 1 or not isinstance(errors[0], dict):
        return False
    error = errors[0]
    bucket, zone = paths()
    if path == bucket:
        # R2 NoSuchBucket, not the Rulesets missing-entrypoint code.
        return error.get('code') == 10006
    phases = {zone + f'/rulesets/phases/{phase}/entrypoint': phase
              for phase in ops.render_rules()['phases']}
    phases[zone + '/cloud_connector/rules'] = 'http_request_cloud_connector'
    phase = phases.get(path)
    return (phase is not None and error.get('code') == 10003
            and error.get('message') == f'could not find entrypoint ruleset in the {phase} phase')


class APIError(RuntimeError):
    def __init__(self, status, _untrusted_body=None):
        self.status = status
        super().__init__(f'Cloudflare API request failed (HTTP {status}); response omitted to protect credentials')


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class API:
    def __init__(self, timeout=30):
        token = os.environ.get('CLOUDFLARE_API_TOKEN')
        if not token:
            raise ValueError('Set CLOUDFLARE_API_TOKEN in the environment; no CLI/file credential inputs are supported')
        self._token = token
        self.timeout = timeout
        self.opener = urllib.request.build_opener(NoRedirect())

    def request(self, method, path, body=None, optional=False):
        c = ops.load_contract()
        if not any(path.startswith(prefix) for prefix in (f'/accounts/{c["account_id"]}/r2/buckets', f'/zones/{c["zone_id"]}/')):
            raise ValueError('API path outside approved account/zone')
        request = urllib.request.Request(BASE + path, method=method,
            data=None if body is None else json.dumps(body).encode(),
            headers={'Authorization': 'Bearer ' + self._token, 'Content-Type': 'application/json'})
        try:
            with self.opener.open(request, timeout=self.timeout) as response:
                raw = response.read(16 * 1024 * 1024 + 1)
                if len(raw) > 16 * 1024 * 1024:
                    raise APIError(response.status)
        except urllib.error.HTTPError as exc:
            try:
                if optional and method == 'GET' and exc.code == 404:
                    try:
                        error_raw = exc.read(ERROR_BODY_LIMIT + 1)
                    except (OSError, ValueError, TimeoutError, http.client.HTTPException):
                        raise APIError(exc.code) from None
                    if expected_missing(path, error_raw):
                        return None
            finally:
                exc.close()
            raise APIError(exc.code) from None
        except (urllib.error.URLError, TimeoutError, OSError, http.client.HTTPException):
            raise APIError('transport') from None
        try:
            envelope = json.loads(raw)
        except (ValueError, TypeError):
            raise APIError('invalid-json') from None
        if not isinstance(envelope, dict) or envelope.get('success') is not True or 'result' not in envelope:
            raise APIError('unsuccessful')
        # Do not print API error messages or request headers, even under failures.
        return envelope['result']


def paths():
    c = ops.load_contract()
    return f'/accounts/{c["account_id"]}/r2/buckets/{c["bucket"]}', f'/zones/{c["zone_id"]}'


def snapshot(api):
    bucket, zone = paths()
    state = {'bucket': api.request('GET', bucket, optional=True), 'phases': {},
             'connectors': api.request('GET', zone + '/cloud_connector/rules', optional=True), 'dns': []}
    if state['connectors'] is None:
        state['connectors'] = []
    if not isinstance(state['connectors'], list):
        raise ValueError('Unexpected connector list response')
    for phase in ops.render_rules()['phases']:
        state['phases'][phase] = api.request('GET', zone + f'/rulesets/phases/{phase}/entrypoint', optional=True)
    for name in ('domains', 'managed', 'cors'):
        suffix = {'domains': '/domains/custom', 'managed': '/domains/managed', 'cors': '/cors'}[name]
        state[name] = api.request('GET', bucket + suffix, optional=True) if state['bucket'] else None
    # Save complete current DNS state, paginated, never write DNS directly.
    page = 1
    while True:
        records = api.request('GET', zone + f'/dns_records?per_page=100&page={page}')
        if not isinstance(records, list):
            raise ValueError('Unexpected DNS list response')
        state['dns'].extend(records)
        if len(records) < 100:
            break
        page += 1
        if page > 1000:
            raise ValueError('DNS pagination exceeded safety limit')
    return state


def projected(rule, fields=RULE_FIELDS):
    return {key: rule[key] for key in fields if key in rule}


def same_rule(actual, desired):
    # Only documented read-only fields may differ. Do not hide unexpected
    # writable settings (e.g. logging) from collision/readback checks.
    readonly = {'id', 'version', 'last_updated'}
    return {k: v for k, v in actual.items() if k not in readonly} == {k: v for k, v in desired.items() if k not in readonly}


def provably_other_host(expression, contract):
    """Conservative proof only: false or a single literal unrelated host equality."""
    expression = expression.strip()
    if expression == 'false':
        return True
    if expression.startswith('(') and expression.endswith(')'):
        expression = expression[1:-1].strip()
    host = re.fullmatch(r'http\.host\s+eq\s+"([A-Za-z0-9.-]+)"', expression)
    return bool(host and host[1].lower() not in (contract['data_host'], contract['origin_host']))


def legacy_rewrite_replacement(current_rules, desired):
    """Return a lossless seven-to-one rule list only for exact approved v1 state.

    Caller must explicitly authorize migration. Never treat an owned prefix as
    permission to remove rules, and never repair partial/drifted legacy state.
    """
    expected = {r['ref']: r for r in ops.legacy_rewrite_rules()}
    legacy = [r for r in current_rules if r.get('ref') in expected]
    if not legacy:
        return None
    if (len(legacy) != len(expected) or {r['ref'] for r in legacy} != set(expected)
            or any(r.get('ref') == desired['ref'] for r in current_rules)
            or any(not same_rule(r, expected[r['ref']]) for r in legacy)):
        raise ValueError('Legacy rewrite migration requires all seven exact approved static rules and no dynamic rule')
    ids = [r.get('id') for r in current_rules]
    if (any(not isinstance(rule_id, str) or not rule_id for rule_id in ids)
            or len(ids) != len(set(ids))):
        raise ValueError('Legacy migration requires unique nonempty IDs for every existing rule')
    result, inserted = [], False
    for old in current_rules:
        if old.get('ref') in expected:
            if not inserted:
                result.append(copy.deepcopy(desired))
                inserted = True
        else:
            # Keep IDs and ALL writable configuration; only server-managed
            # version/timestamp fields are removed from the update payload.
            result.append({k: copy.deepcopy(v) for k, v in old.items()
                           if k not in {'version', 'last_updated'}})
    return result


def build_plan(state, stage='all', update_owned=False, migrate_legacy_rewrites=False):
    if stage not in ('all', 'bucket', 'origin', 'rules'):
        raise ValueError('Unknown deployment stage')
    c, rendered = ops.load_contract(), ops.render_rules()
    bucket, zone = paths()
    plan = []
    def add(method, path, body, read_path, before, check, desired):
        plan.append({'method': method, 'path': path, 'body': body, 'read_path': read_path,
                     'before': copy.deepcopy(before), 'check': check, 'desired': copy.deepcopy(desired)})
    b = state['bucket']
    if b is not None and (b.get('name') != c['bucket'] or b.get('storage_class', b.get('storageClass')) != 'Standard'):
        raise ValueError('Existing bucket name/storage class collision; manual review required')
    if stage in ('bucket', 'all') and b is None:
        body = {'name': c['bucket'], 'storageClass': 'Standard', 'locationHint': 'weur'}
        add('POST', bucket.rsplit('/', 1)[0], body, bucket, None, 'bucket', body)
    if stage == 'origin' and b is None:
        raise ValueError('Create bucket first using --stage bucket')
    if stage in ('rules', 'all'):
        domains = (state['domains'] or {}).get('domains', [])
        ready = [d for d in domains if d.get('domain') == c['origin_host']
                 and d.get('enabled') is True and d.get('zoneId') == c['zone_id']
                 and d.get('minTLS') == '1.2' and d.get('status', {}).get('ownership') == 'active'
                 and d.get('status', {}).get('ssl') == 'active']
        if b is None or len(ready) != 1 or (state['managed'] or {}).get('enabled') is not False or state['cors'] != rendered['cors']:
            raise ValueError('Rules require an existing Standard bucket, active attached TLS1.2 origin, r2.dev disabled, and exact CORS. Run bucket/origin stages first; wait for activation; upload/verify all objects before routing.')
    if stage in ('origin', 'all'):
        domain_result = state['domains']
        domains = [] if domain_result is None else domain_result.get('domains', [])
        matching = [d for d in domains if d.get('domain') == c['origin_host']]
        if len(matching) > 1:
            raise ValueError('Duplicate custom domain collision')
        if matching:
            d = matching[0]
            if d.get('enabled') is not True or d.get('zoneId') != c['zone_id'] or d.get('minTLS') != '1.2':
                raise ValueError('Existing origin custom domain configuration drift; manual review required')
        else:
            # Attachment may create a DNS record. Never steal an existing record.
            if any(d.get('name') == c['origin_host'] for d in state.get('dns', [])):
                raise ValueError('Origin DNS record exists without this bucket attachment; manual review required')
            body = {'domain': c['origin_host'], 'zoneId': c['zone_id'], 'enabled': True, 'minTLS': '1.2'}
            add('POST', bucket + '/domains/custom', body, bucket + '/domains/custom', domain_result, 'domain', body)
        if state['managed'] is None or state['managed'].get('enabled') is not False:
            add('PUT', bucket + '/domains/managed', {'enabled': False}, bucket + '/domains/managed', state['managed'], 'managed', {'enabled': False})
        if state['cors'] != rendered['cors']:
            if state['cors'] not in (None, {'rules': []}) and not update_owned:
                raise ValueError('Existing dedicated bucket CORS drift; use --update-owned only after reviewing the snapshot')
            add('PUT', bucket + '/cors', rendered['cors'], bucket + '/cors', state['cors'], 'cors', rendered['cors'])
    if stage not in ('rules', 'all'):
        return plan
    # Only append past the existing enabled catchall cache:false; never replace it.
    cache_state = state['phases']['http_request_cache_settings']
    cache_rules = [] if cache_state is None else cache_state['rules']
    catchalls = [i for i, rule in enumerate(cache_rules) if rule.get('expression') == 'true'
                 and rule.get('enabled', True) and rule.get('action') == 'set_cache_settings'
                 and rule.get('action_parameters', {}).get('cache') is False]
    if not catchalls:
        raise ValueError('Expected existing enabled expression:true cache:false catchall missing; no rules written')
    for phase, desired_rules in rendered['phases'].items():
        current = state['phases'][phase]
        current_rules = [] if current is None else current['rules']
        allowed_refs = {r['ref'] for r in desired_rules}
        refs = [r.get('ref') for r in current_rules if r.get('ref')]
        if len(refs) != len(set(refs)):
            raise ValueError('Duplicate ruleset ref collision')
        replacement = None
        legacy_refs = set()
        if phase == 'http_request_transform' and migrate_legacy_rewrites:
            replacement = legacy_rewrite_replacement(current_rules, desired_rules[0])
            if replacement is not None:
                legacy_refs = {r['ref'] for r in ops.legacy_rewrite_rules()}
        for old in current_rules:
            ref, expression = old.get('ref', ''), old.get('expression', '')
            if ref in legacy_refs:
                continue
            if ref.startswith(ops.OWNED_PREFIX) and ref not in allowed_refs:
                raise ValueError('Unknown speedtest-owned ref in phase; manual review required')
            if ref not in allowed_refs and old.get('enabled', True) and any(host in expression for host in (c['data_host'], c['origin_host'])):
                raise ValueError('Non-owned rule mentioning endpoint host; review overlap manually before deployment')
        if replacement is not None:
            if current is None:
                raise ValueError('Legacy migration requires an existing ruleset')
            # Explicit audited whole-ruleset update is the only removal path.
            # Unrelated rules retain their IDs, settings and relative order.
            body = {'rules': replacement}
            add('PUT', zone + f'/rulesets/{current["id"]}', body,
                zone + f'/rulesets/phases/{phase}/entrypoint', current,
                'rewrite_migration', replacement)
            continue
        if current is None:
            body = {'name': ops.OWNED_PREFIX + phase, 'kind': 'zone', 'phase': phase, 'rules': desired_rules}
            add('POST', zone + '/rulesets', body, zone + f'/rulesets/phases/{phase}/entrypoint', None, 'ruleset', desired_rules)
            continue
        for desired in desired_rules:
            matching = [old for old in current_rules if old.get('ref') == desired['ref']]
            if matching:
                old = matching[0]
                if phase == 'http_request_cache_settings' and current_rules.index(old) <= max(catchalls):
                    raise ValueError('Owned cache rule is not after existing catchall; manual review required')
                if phase == 'http_config_settings':
                    for later in current_rules[current_rules.index(old) + 1:]:
                        settings = later.get('action_parameters', {})
                        if (later.get('enabled', True) and later.get('action') == 'set_config'
                                and 'ssl' in settings and settings['ssl'] != 'strict'
                                and not provably_other_host(later.get('expression', ''), c)):
                            raise ValueError('Later SSL rule may override owned strict SSL; manual review required')
                if not same_rule(old, desired):
                    if not update_owned or not old.get('id'):
                        raise ValueError('Owned rule drift; review snapshot and explicitly request --update-owned')
                    add('PATCH', zone + f'/rulesets/{current["id"]}/rules/{old["id"]}', desired,
                        zone + f'/rulesets/phases/{phase}/entrypoint', current, 'rule', desired)
            else:
                add('POST', zone + f'/rulesets/{current["id"]}/rules', desired,
                    zone + f'/rulesets/phases/{phase}/entrypoint', current, 'rule', desired)
    connectors = state['connectors']
    desired = rendered['connector']
    marker = desired['description']
    matching = [r for r in connectors if r.get('description') == marker]
    if len(matching) > 1:
        raise ValueError('Duplicate owned connector description')
    for old in connectors:
        if old.get('description') != marker and (old.get('parameters', {}).get('host') == c['origin_host'] or
                                                c['data_host'] in old.get('expression', '') or
                                                c['origin_host'] in old.get('expression', '')):
            raise ValueError('Non-owned connector collision; manual review required')
        if set(old) - set(CONNECTOR_FIELDS):
            raise ValueError('Unknown connector fields; refusing lossy replacement')
    if matching and projected(matching[0], CONNECTOR_FIELDS[1:]) != desired:
        if not update_owned:
            raise ValueError('Owned connector drift; explicit --update-owned required')
        new = [dict(desired, **({'id': old['id']} if 'id' in old else {})) if old.get('description') == marker else copy.deepcopy(old) for old in connectors]
    elif matching:
        new = None
    else:
        new = copy.deepcopy(connectors) + [desired]
    if new is not None:
        add('PUT', zone + '/cloud_connector/rules', new, zone + '/cloud_connector/rules', connectors, 'connectors', new)
    # Keep the existing cache:false catchall in force until origin routing,
    # headers, compression and SSL are configured. Otherwise transient Pages
    # HTML 200 responses could poison the newly enabled long-lived cache key.
    ordered = ['http_config_settings', 'http_response_compression',
               'http_response_headers_transform', 'http_request_transform',
               'cloud_connector', 'http_request_cache_settings']
    def priority(operation):
        return next((i for i, phase in enumerate(ordered) if phase in operation['read_path']), -1)
    return sorted(plan, key=priority)


def verify_readback(operation, after, before):
    check, desired = operation['check'], operation['desired']
    if check == 'bucket':
        okay = after and after.get('name') == desired['name'] and after.get('storage_class', after.get('storageClass')) == 'Standard'
    elif check == 'domain':
        domains = after.get('domains', []) if after else []
        okay = any(all(d.get(k) == v for k, v in desired.items()) for d in domains)
        okay = okay and all(d in domains for d in (before or {}).get('domains', []))
    elif check in ('managed', 'cors'):
        okay = after == desired if check == 'cors' else after and after.get('enabled') is False
    elif check == 'connectors':
        okay = isinstance(after, list) and len(after) == len(desired)
        if okay:
            for actual, want in zip(after, desired):
                # Only the exact owned marker may regenerate an existing ID on PUT.
                owned = want.get('description') == 'bella_speedtest_connector'
                ignore_id = owned or 'id' not in want
                okay = okay and isinstance(actual, dict) and (
                    not owned or (isinstance(actual.get('id'), str) and bool(actual['id']))) and {
                    k: v for k, v in actual.items() if k != 'id' or not ignore_id} == {
                    k: v for k, v in want.items() if k != 'id' or not ignore_id}
    elif check == 'rewrite_migration':
        rules = after.get('rules', []) if isinstance(after, dict) else []
        unchanged_fields = lambda value: {k: v for k, v in (value or {}).items()
                                          if k not in {'rules', 'version', 'last_updated'}}
        okay = (isinstance(after, dict) and unchanged_fields(after) == unchanged_fields(before)
                and isinstance(rules, list) and len(rules) == len(desired)
                and all(isinstance(r, dict) and isinstance(r.get('id'), str) and r['id'] for r in rules))
        if okay:
            for actual, want in zip(rules, desired):
                okay = okay and same_rule(actual, want)
                if want.get('ref') != 'bella_speedtest_rewrite':
                    okay = okay and actual.get('id') == want.get('id')
            ids = [r['id'] for r in rules]
            okay = okay and len(ids) == len(set(ids))
    elif check in ('rule', 'ruleset'):
        rules = (after or {}).get('rules', [])
        wanted = desired if check == 'ruleset' else [desired]
        okay = all(len([r for r in rules if r.get('ref') == d['ref'] and same_rule(r, d)]) == 1 for d in wanted)
        previous = (before or {}).get('rules', [])
        for old in previous:
            if check == 'rule' and old.get('ref') == desired['ref']:
                continue
            okay = okay and any(r.get('id') == old.get('id') and same_rule(r, old) for r in rules)
        # Append-only new rules, preserve order and quantity of all unrelated rules.
        old_refs = [r.get('id') for r in previous if check != 'rule' or r.get('ref') != desired['ref']]
        new_refs = [r.get('id') for r in rules if check != 'rule' or r.get('ref') != desired['ref']]
        if check == 'rule':
            okay = okay and old_refs == new_refs
            if operation['method'] == 'POST':
                okay = okay and rules[-1].get('ref') == desired['ref']
        else:
            okay = okay and len(rules) == len(wanted)
    else:
        raise ValueError('Unknown readback check')
    if not okay:
        raise ValueError('Exact target readback did not match; stop and inspect private audit, no automatic rollback')


def apply_plan(api, plan, audit_dir):
    current_by_path = {}
    for index, operation in enumerate(plan):
        read_path = operation['read_path']
        expected_before = current_by_path.get(read_path, operation['before'])
        before = api.request('GET', read_path, optional=True)
        if operation['check'] == 'connectors' and before is None:
            before = []
        # A freshly created bucket has empty subresources rather than nonexistent
        # endpoints; adopt ONLY the expected empty/default state, never arbitrary state.
        if expected_before is None and operation['check'] == 'domain' and before == {'domains': []}:
            expected_before = before
        if expected_before is None and operation['check'] == 'cors' and before == {'rules': []}:
            expected_before = before
        if expected_before is None and operation['check'] == 'managed' and isinstance(before, dict) and before.get('enabled') is False:
            expected_before = before
        if before != expected_before:
            raise ValueError('Concurrent/current state differs from snapshot; no further writes performed')
        api.request(operation['method'], operation['path'], operation['body'])
        after = api.request('GET', read_path, optional=True)
        ops.private_json(audit_dir / f'readback-{index:03d}.json', {'operation': operation, 'before': before, 'after': after})
        verify_readback(operation, after, before)
        current_by_path[read_path] = after


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--apply', action='store_true', help='Explicitly authorize writes; default is read-only dry-run')
    p.add_argument('--dry-run', action='store_true', help='Explicit read-only default')
    p.add_argument('--offline', action='store_true', help='Render only or plan against --snapshot-input; no token/API')
    p.add_argument('--snapshot-input', type=Path, help='Private external snapshot for offline plan/diff')
    p.add_argument('--audit-dir', type=Path, help='Required NEW absolute external private directory for live operations')
    p.add_argument('--stage', choices=('bucket', 'origin', 'objects', 'rules', 'all'), default='all', help='objects is a SEPARATE direct-S3 stage; all covers account configuration only')
    p.add_argument('--fixture-dir', type=Path, help='External validated fixtures for --stage objects')
    p.add_argument('--size', action='append', type=int, help='Object size selection (repeatable); default all approved known sizes')
    p.add_argument('--replace-existing-objects', action='store_true', help='Explicit permission to replace only selected approved object keys after reviewing the S3 snapshot')
    p.add_argument('--update-owned', action='store_true', help='Allow PATCH of exact owned rule refs/connector and dedicated CORS after reviewing drift')
    p.add_argument('--migrate-legacy-rewrites', action='store_true',
                   help='Explicitly replace only the complete exact seven approved v1 static rewrites with one v2 rule; verify all fixtures first')
    p.add_argument('--corpus-manifest', type=Path,
                   help='External combined v2 known-hash/HeadObject receipt; required for live legacy migration, not remote body proof')
    p.add_argument('--timeout', type=float, default=30)
    args = p.parse_args(argv)
    if args.apply and (args.offline or args.dry_run):
        p.error('--apply is incompatible with --offline/--dry-run')
    if args.timeout <= 0:
        p.error('--timeout must be positive')
    if (args.migrate_legacy_rewrites or args.corpus_manifest) and args.stage not in ('rules', 'all'):
        p.error('Migration/combined corpus receipt flags require --stage rules or all')
    if args.migrate_legacy_rewrites and not args.offline and not args.corpus_manifest:
        p.error('Live legacy migration requires --corpus-manifest for all approved v2 objects; verify fixtures before routing')
    try:
        if args.stage == 'objects':
            if args.snapshot_input or args.update_owned:
                p.error('S3 objects stage does not accept account snapshot/--update-owned flags')
            import s3_upload
            print(json.dumps(s3_upload.run_stage(args), indent=2))
            return 0
        if args.fixture_dir or args.size or args.replace_existing_objects:
            p.error('Object fixture/selection/replacement flags require --stage objects')
        corpus = ops.validate_corpus_manifest(args.corpus_manifest) if args.corpus_manifest else None
        if args.offline:
            if args.snapshot_input:
                state = json.loads(ops.external_path(args.snapshot_input).read_text())
                print(json.dumps({'mode': 'offline-plan', 'operations': build_plan(state, args.stage, args.update_owned, args.migrate_legacy_rewrites)}, indent=2))
            else:
                print(json.dumps({'mode': 'offline-render', 'stage': args.stage, 'rules': ops.render_rules()}, indent=2))
            return 0
        if args.snapshot_input:
            p.error('--snapshot-input is for offline use only; live deployment always takes a fresh snapshot')
        if not args.audit_dir:
            p.error('--audit-dir is required for live dry-run/apply')
        audit = ops.external_path(args.audit_dir)
        audit.mkdir(mode=0o700, parents=True, exist_ok=False)
        os.chmod(audit, 0o700)
        if corpus is not None:
            ops.private_json(audit / 'corpus-receipt.json', corpus)
        api = API(args.timeout)
        state = snapshot(api)
        ops.private_json(audit / 'before.json', state)
        plan = build_plan(state, args.stage, args.update_owned, args.migrate_legacy_rewrites)
        ops.private_json(audit / 'plan.json', plan)
        print(json.dumps({'mode': 'apply' if args.apply else 'live-dry-run', 'operation_count': len(plan), 'audit_dir': str(audit)}))
        if args.apply:
            apply_plan(api, plan, audit)
            final = snapshot(api)
            ops.private_json(audit / 'after.json', final)
            if build_plan(final, args.stage, args.update_owned, args.migrate_legacy_rewrites):
                raise ValueError('Final fresh snapshot is not idempotent; inspect audit')
            print(json.dumps({'verified': True, 'writes': len(plan)}))
        return 0
    except (APIError, ValueError, OSError, KeyError, TypeError) as exc:
        # Avoid arbitrary exception values originating from API payloads.
        message = str(exc) if isinstance(exc, (APIError, ValueError)) else type(exc).__name__
        print(json.dumps({'ok': False, 'error': message}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
