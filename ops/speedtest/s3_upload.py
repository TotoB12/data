"""Optional direct S3 object stage. boto3 is imported ONLY for live object work."""
from __future__ import annotations

import copy
import logging
import os
from pathlib import Path

import speedtest_ops as ops

OWNER = 'bella_speedtest_fixture_v1'
MULTIPART_THRESHOLD = 64 * 1024 * 1024
MULTIPART_CHUNK = 32 * 1024 * 1024
HEAD_FIELDS = ('ContentLength', 'ContentType', 'CacheControl', 'ContentEncoding', 'StorageClass', 'Metadata', 'ETag', 'VersionId', 'LastModified')


class MissingObject(Exception):
    """Test double / normalized not-found exception, never a credentials error."""


def client_and_transfer(timeout=60):
    access, secret = os.environ.get('R2_ACCESS_KEY_ID'), os.environ.get('R2_SECRET_ACCESS_KEY')
    if not access or not secret:
        raise ValueError('Object stage needs R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY environment variables (bucket-scoped Object Read & Write only)')
    try:
        import boto3
        from botocore.config import Config
        from boto3.s3.transfer import TransferConfig
    except ImportError:
        raise ValueError('Optional S3 dependency missing: install ops/speedtest/requirements-s3.txt in a private venv; CI does not need it') from None
    # Never enable SDK wire/header logging; exceptions are sanitized below.
    for name in ('boto3', 'botocore', 's3transfer', 'urllib3'):
        logging.getLogger(name).setLevel(logging.WARNING)
    c = ops.load_contract()
    client = boto3.client('s3', endpoint_url=f'https://{c["account_id"]}.r2.cloudflarestorage.com',
                          aws_access_key_id=access, aws_secret_access_key=secret, region_name='auto',
                          config=Config(signature_version='s3v4', connect_timeout=timeout, read_timeout=timeout,
                                        retries={'total_max_attempts': 1}, s3={'addressing_style': 'path'},
                                        request_checksum_calculation='when_required', response_checksum_validation='when_required'))
    transfer = TransferConfig(multipart_threshold=MULTIPART_THRESHOLD, multipart_chunksize=MULTIPART_CHUNK,
                              max_concurrency=2, use_threads=True, preferred_transfer_client='classic')
    return client, transfer


def extra_args(entry):
    digest = entry.get('sha256', '')
    if len(digest) != 64 or any(x not in '0123456789abcdef' for x in digest):
        raise ValueError('Object manifest has invalid SHA-256')
    if 'key' in entry:
        n = entry.get('bytes')
        if type(n) is not int or n not in ops.SIZES or entry['key'] != f'speedtest/{n}.bin':
            raise ValueError('Object key is outside exact manifest namespace')
    c = ops.load_contract()
    return {'ContentType': c['content_type'], 'CacheControl': c['cache_control'], 'StorageClass': 'STANDARD',
            'Metadata': {'sha256': digest, 'owner': OWNER}}


def head_object(client, key):
    try:
        head = client.head_object(Bucket=ops.load_contract()['bucket'], Key=key)
    except MissingObject:
        return None
    except Exception as exc:
        response = getattr(exc, 'response', {})
        if response.get('Error', {}).get('Code') in ('404', 'NoSuchKey', 'NotFound'):
            return None
        raise ValueError('S3 HeadObject failed; details omitted to protect credentials (not treated as object absence)') from None
    result = {k: copy.deepcopy(head[k]) for k in HEAD_FIELDS if k in head}
    if 'LastModified' in result:
        result['LastModified'] = str(result['LastModified'])
    return result


def head_matches(head, entry):
    if head is None:
        return False
    args = extra_args(entry)
    return (head.get('ContentLength') == entry['bytes']
            and head.get('ContentType') == args['ContentType']
            and head.get('CacheControl') == args['CacheControl']
            and head.get('ContentEncoding') in (None, '')
            and head.get('StorageClass', 'STANDARD') == 'STANDARD'
            and head.get('Metadata', {}) == args['Metadata'])


def build_object_plan(client, manifest, sizes=None, replace_existing=False):
    entries = manifest['objects']
    selected = {e['bytes'] for e in entries} if sizes is None else set(sizes)
    if not selected or not selected <= {e['bytes'] for e in entries}:
        raise ValueError('Selected object size not present in validated manifest')
    plan = []
    for entry in entries:
        if entry['bytes'] not in selected:
            continue
        extra_args(entry)
        before = head_object(client, entry['key'])
        if head_matches(before, entry):
            continue
        if before is not None and not replace_existing:
            raise ValueError('Existing selected object differs in size/hash metadata/cache metadata; inspect snapshot and explicitly authorize --replace-existing-objects')
        plan.append({'entry': copy.deepcopy(entry), 'before': before, 'extra_args': extra_args(entry),
                     'operation': 'replace-approved-key' if before else 'create-approved-key',
                     'multipart': entry['bytes'] >= MULTIPART_THRESHOLD})
    return plan


def apply_object_plan(client, plan, fixture_dir, audit_dir, transfer_config):
    fixture_dir, audit_dir = ops.external_path(fixture_dir), ops.external_path(audit_dir)
    result = {'uploaded_objects': 0, 'logical_upload_bytes': 0, 'head_metadata_verified': False,
              'remote_body_hash_verified': False,
              'note': 'HeadObject size/metadata only: user metadata SHA-256 is NOT remote body proof. Run verify.py for streamed public body hashes. Multipart ETag is not a SHA-256.'}
    for index, operation in enumerate(plan):
        entry = operation['entry']
        extra_args(entry)
        local = fixture_dir / entry['key']
        if ops.hash_file(local) != (entry['bytes'], entry['sha256']):
            raise ValueError('Local fixture changed after manifest validation; stop before upload')
        before = head_object(client, entry['key'])
        if before != operation['before']:
            raise ValueError('S3 object changed since snapshot; stop before upload')
        # upload_file streams from disk; above 64MiB it uses 32MiB multipart parts,
        # never marshals a 250MB value through JSON/MCP. No ContentEncoding argument.
        try:
            client.upload_file(Filename=str(local), Bucket=ops.load_contract()['bucket'], Key=entry['key'],
                               ExtraArgs=operation['extra_args'], Config=transfer_config)
        except Exception:
            ops.private_json(audit_dir / f'object-failed-{index:03d}.json', {'key': entry['key'], 'ok': False,
                'error': 'S3 upload raised; inspect provider state. No automatic object deletion/rollback.'})
            raise ValueError('S3 upload failed; details omitted to protect credentials. No automatic object rollback.') from None
        after = head_object(client, entry['key'])
        okay = head_matches(after, entry)
        ops.private_json(audit_dir / f'object-readback-{index:03d}.json', {'key': entry['key'], 'expected': entry, 'before': before, 'after': after,
            'head_metadata_verified': okay, 'remote_body_hash_verified': False})
        if not okay:
            raise ValueError('S3 success did NOT pass exact HeadObject length/type/cache/encoding/hash-metadata readback; stop, no automatic deletion')
        result['uploaded_objects'] += 1
        result['logical_upload_bytes'] += entry['bytes']
    result['head_metadata_verified'] = True
    ops.private_json(audit_dir / 'objects-result.json', result)
    return result


def run_stage(args):
    if not args.fixture_dir:
        raise ValueError('--stage objects requires --fixture-dir outside the repository')
    fixture_dir = ops.external_path(args.fixture_dir)
    manifest = ops.validate_manifest(fixture_dir)
    sizes = args.size or ops.load_contract()['sizes']
    if not set(sizes) <= set(ops.load_contract()['sizes']):
        raise ValueError('Only the approved known object sizes can be selected')
    if args.offline:
        return {'mode': 'offline-object-plan', 'objects': [e for e in manifest['objects'] if e['bytes'] in sizes],
                'remote_state_checked': False, 'credential_required': 'R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY only for live object work'}
    if not args.audit_dir:
        raise ValueError('--audit-dir is required for S3 dry-run/apply')
    audit = ops.external_path(args.audit_dir)
    audit.mkdir(parents=True, mode=0o700, exist_ok=False)
    os.chmod(audit, 0o700)
    client, transfer = client_and_transfer(args.timeout)
    # Snapshot all approved touched-namespace objects before ANY write, not just a
    # planned subset. Never list/delete/mutate unrelated bucket keys.
    snapshot = {e['key']: head_object(client, e['key']) for e in manifest['objects']}
    ops.private_json(audit / 'objects-before.json', snapshot)
    plan = build_object_plan(client, manifest, sizes, args.replace_existing_objects)
    ops.private_json(audit / 'objects-plan.json', plan)
    result = {'mode': 's3-apply' if args.apply else 's3-dry-run', 'operation_count': len(plan),
              'logical_planned_upload_bytes': sum(x['entry']['bytes'] for x in plan), 'audit_dir': str(audit),
              'remote_body_hash_verified': False}
    if args.apply:
        result.update(apply_object_plan(client, plan, fixture_dir, audit, transfer))
        after = {e['key']: head_object(client, e['key']) for e in manifest['objects']}
        ops.private_json(audit / 'objects-after.json', after)
        if build_object_plan(client, manifest, sizes, False):
            raise ValueError('S3 final snapshot is not idempotent')
        for key, old in snapshot.items():
            if int(key.removeprefix('speedtest/').removesuffix('.bin')) not in sizes and after[key] != old:
                raise ValueError('Unselected approved object changed during this run; investigate concurrency, no automatic rollback')
    return result
