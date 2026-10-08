"""Mock transport tests. These do not validate Cloudflare account/API behavior."""
import copy
import hashlib
import http.client
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import urllib.error

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import speedtest_ops as ops
import deploy
import verify


class MemoryAPI:
    def __init__(self, operation, mutate=False):
        self.operation = operation
        self.state = copy.deepcopy(operation['before'])
        self.writes = []
        self.mutate = mutate

    def request(self, method, path, body=None, optional=False):
        if method == 'GET':
            return copy.deepcopy(self.state)
        self.writes.append((method, path, copy.deepcopy(body)))
        if self.operation['check'] == 'rule':
            self.state['rules'].append(dict(body, id='created'))
            self.state['version'] = '2'
            if self.mutate:
                self.state['rules'][0]['action_parameters']['cache'] = True
        elif self.operation['check'] == 'connectors':
            self.state = copy.deepcopy(body)
            self.state[-1]['id'] = 'new-connector'
        return copy.deepcopy(self.state)


class TransportTests(unittest.TestCase):
    def cache_operation(self):
        c = ops.render_rules()['phases']['http_request_cache_settings'][0]
        before = {'id': 'cacheid', 'version': '1', 'rules': [{'id': 'original', 'ref': 'unrelated',
            'enabled': True, 'expression': 'true', 'action': 'set_cache_settings', 'action_parameters': {'cache': False}}]}
        return {'method': 'POST', 'path': '/cache/rules', 'body': c,
                'read_path': '/cache', 'before': before, 'check': 'rule', 'desired': c}

    def test_apply_reads_exact_target_before_and_after_and_preserves_unrelated(self):
        operation = self.cache_operation()
        api = MemoryAPI(operation)
        with tempfile.TemporaryDirectory() as d:
            deploy.apply_plan(api, [operation], Path(d))
            self.assertTrue((Path(d) / 'readback-000.json').exists())
        self.assertEqual(len(api.writes), 1)
        self.assertFalse(api.state['rules'][0]['action_parameters']['cache'])

    def test_bad_readback_stops_without_rollback(self):
        operation = self.cache_operation()
        api = MemoryAPI(operation, mutate=True)
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(ValueError):
                deploy.apply_plan(api, [operation, operation], Path(d))
        self.assertEqual(len(api.writes), 1)

    def test_concurrent_change_refused_before_any_write(self):
        operation = self.cache_operation()
        api = MemoryAPI(operation)
        api.state['version'] = '999'
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(ValueError):
                deploy.apply_plan(api, [operation], Path(d))
        self.assertEqual(api.writes, [])

    def test_fullarray_connector_readback_preserves_ids(self):
        old = {'id': 'keep-id', 'description': 'unrelated', 'provider': 'aws_s3',
               'parameters': {'host': 'other.example'}, 'expression': 'false', 'enabled': True}
        desired = [old, ops.render_rules()['connector']]
        operation = {'method': 'PUT', 'path': '/connectors', 'body': desired, 'read_path': '/connectors',
                     'before': [old], 'check': 'connectors', 'desired': desired}
        with tempfile.TemporaryDirectory() as d:
            deploy.apply_plan(MemoryAPI(operation), [operation], Path(d))

    def test_partial_failed_read_counts_body_bytes(self):
        class Partial:
            def read(self, n):
                raise http.client.IncompleteRead(b'abc', 2)
        budget = verify.Budget(100)
        with self.assertRaises(http.client.IncompleteRead):
            verify.stream_body(Partial(), budget)
        self.assertEqual(budget.used, 3)

    def test_http_error_body_counts_towards_budget(self):
        error = urllib.error.HTTPError('https://data.totob12.com/__down?bytes=0', 500, 'error', {}, io.BytesIO(b'bad-body'))
        class Opener:
            def open(self, request, timeout):
                raise error
        budget = verify.Budget(100)
        exercise = {'host': 'data.totob12.com', 'path': '/__down', 'query': 'bytes=0', 'method': 'GET', 'bytes': 0, 'origin': True, 'kind': 'object'}
        report = verify.verify_one(exercise, Opener(), budget, {'objects': [{'bytes': 0, 'sha256': hashlib.sha256(b'').hexdigest()}]})
        self.assertFalse(report['ok'])
        self.assertEqual(budget.used, 8)
        self.assertEqual(report['transferred_body_bytes'], 8)

    def test_redirect_handler_does_not_follow(self):
        self.assertIsNone(verify.NoRedirect().redirect_request(None, None, 301, '', {}, 'https://evil.example'))
        self.assertIsNone(deploy.NoRedirect().redirect_request(None, None, 301, '', {}, 'https://evil.example'))

    def test_manifest_includes_raw_unencoded_metadata(self):
        with tempfile.TemporaryDirectory() as d:
            m = ops.generate_fixtures(Path(d), sizes=[0, 32])
            self.assertEqual(m['content_type'], 'application/octet-stream')
            self.assertEqual(m['cache_control'], 'no-store, no-transform')
            self.assertIsNone(m['content_encoding'])
            self.assertEqual((Path(d) / 'manifest.json').stat().st_mode & 0o777, 0o600)

    def test_symlink_output_refused(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d)
            (path / 'real').mkdir()
            (path / 'alias').symlink_to(path / 'real')
            with self.assertRaises(ValueError):
                ops.generate_fixtures(path / 'alias', sizes=[0])

    def test_offline_has_no_token_or_api_requirement(self):
        with patch.dict(os.environ, {}, clear=True), patch('deploy.API', side_effect=AssertionError('Account API forbidden')), patch('sys.stdout', new_callable=io.StringIO) as output:
            self.assertEqual(deploy.main(['--dry-run', '--offline']), 0)
        self.assertEqual(json.loads(output.getvalue())['mode'], 'offline-render')

    def test_apply_offline_is_rejected(self):
        with patch('sys.stderr', new_callable=io.StringIO), self.assertRaises(SystemExit):
            deploy.main(['--apply', '--offline'])

    def test_owned_comparison_does_not_ignore_unexpected_writable_fields(self):
        desired = ops.render_rules()['phases']['http_config_settings'][0]
        actual = dict(desired, logging={'enabled': True})
        self.assertFalse(deploy.same_rule(actual, desired))

    def test_failed_manifest_validation_writes_external_failure_report_without_http(self):
        with tempfile.TemporaryDirectory() as d:
            directory = Path(d)
            report = directory / 'failed-report.json'
            with patch('verify.urllib.request.build_opener', side_effect=AssertionError('No HTTP expected')), patch('sys.stdout', new_callable=io.StringIO):
                code = verify.main(['--manifest', str(directory / 'missing/manifest.json'), '--report', str(report)])
            self.assertEqual(code, 1)
            self.assertTrue(report.exists())
            self.assertFalse(json.loads(report.read_text())['ok'])

    def corpus_receipt(self):
        c = ops.load_contract()
        return {'bucket': c['bucket'], 'total_bytes': c['total_fixture_bytes'], 'count': len(c['sizes']),
                'method': 'Offline test receipt: not a real Cloudflare validation',
                'objects': [{'key': f'speedtest/{n}.bin', 'bytes': n,
                             'sha256': hashlib.sha256(b'').hexdigest() if n == 0 else 'a' * 64,
                             'ContentType': c['content_type'], 'CacheControl': c['cache_control'],
                             'ContentEncoding': None, 'metadata_verified': True} for n in c['sizes']]}

    def test_operator_corpus_receipt_validates_without_local_fixture_files(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / 'r2-corpus-manifest.json'
            path.write_text(json.dumps(self.corpus_receipt()))
            manifest = ops.validate_corpus_manifest(path)
            self.assertEqual(len(manifest['objects']), len(ops.SIZES))
            self.assertEqual(manifest['total_bytes'], sum(ops.SIZES))

    def test_operator_corpus_receipt_rejects_wrong_bucket_length_or_metadata(self):
        for change in ('bucket', 'length', 'encoding', 'cache', 'hash'):
            receipt = self.corpus_receipt()
            if change == 'bucket': receipt['bucket'] = 'unapproved'
            elif change == 'length': receipt['objects'][-1]['bytes'] = 134210688
            elif change == 'encoding': receipt['objects'][-1]['ContentEncoding'] = 'gzip'
            elif change == 'cache': receipt['objects'][0]['CacheControl'] = None
            elif change == 'hash': receipt['objects'][0]['sha256'] = 'a' * 64
            with tempfile.TemporaryDirectory() as d:
                path = Path(d) / 'r2-corpus-manifest.json'
                path.write_text(json.dumps(receipt))
                with self.assertRaises(ValueError):
                    ops.validate_corpus_manifest(path)

    def test_corpus_plan_reads_receipt_no_http_or_body_equality_claim(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / 'r2-corpus-manifest.json'
            path.write_text(json.dumps(self.corpus_receipt()))
            with patch('verify.urllib.request.build_opener', side_effect=AssertionError('No HTTP expected')), patch('sys.stdout', new_callable=io.StringIO) as output:
                self.assertEqual(verify.main(['--plan', '--corpus-manifest', str(path)]), 0)
            source = json.loads(output.getvalue())['manifest_source']
            self.assertEqual(source['kind'], 'operator-corpus-receipt')
            self.assertFalse(source['local_file_hashes_verified'])
            self.assertFalse(source['remote_body_hashes_verified_before_http'])

    def test_body_proof_fails_even_when_head_like_headers_match(self):
        c = ops.load_contract()
        headers = {'Content-Type': c['content_type'], 'Content-Length': '0', 'Accept-Ranges': 'bytes',
                   'Cache-Control': c['cache_control'], 'Access-Control-Allow-Origin': '*',
                   'Timing-Allow-Origin': '*', 'Access-Control-Expose-Headers': ', '.join(c['expose_headers'])}
        exercise = {'kind': 'object', 'method': 'GET', 'bytes': 0}
        manifest = {'objects': [{'bytes': 0, 'sha256': hashlib.sha256(b'').hexdigest()}]}
        errors = verify.validate_response(exercise, 200, headers, 1, hashlib.sha256(b'x').hexdigest(), b'x', manifest)
        self.assertIn('Streamed body length mismatch', errors)
        self.assertIn('Streamed SHA-256 mismatch', errors)


if __name__ == '__main__':
    unittest.main()
