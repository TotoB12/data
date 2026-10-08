"""Offline tests: the matcher is a contract model, NOT Cloudflare validation."""
import copy
import hashlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import speedtest_ops as ops
import deploy
import verify


class ContractTests(unittest.TestCase):
    def test_fixed_contract(self):
        c = ops.load_contract()
        self.assertEqual(c['legacy_sizes'], [0, 100000, 1000000, 10000000, 25000000, 100000000, 250000000])
        self.assertEqual(c['sizes'], sorted(set(c['legacy_sizes'] + c['client_sizes'])))
        self.assertEqual(sum(c['sizes']), 1145269024)
        self.assertEqual(len(c['queries']), 22)
        self.assertEqual(c['queries'][-2:], ['during=idle&bytes=0', 'during=download&bytes=0'])

    def test_model_accepts_canonical_get_head_and_valid_preflight(self):
        for method in ('GET', 'HEAD', 'OPTIONS'):
            for query in ops.load_contract()['queries']:
                headers = {'origin': ['null'], 'access-control-request-method': ['GET']} if method == 'OPTIONS' else None
                self.assertIsNotNone(ops.match_download('data.totob12.com', '/__down', query, method, headers))

    def test_literal_model_rejects_normalization_aliases(self):
        for path, query in [('/__DOWN', 'bytes=0'), ('/%5f_down', 'bytes=0'),
                            ('//__down', 'bytes=0'), ('/__down/', 'bytes=0'),
                            ('/__down', 'bytes=00'), ('/__down', 'bytes=%30'),
                            ('/__down', 'bytes=100000&during=idle'), ('/__down', 'bytes=0&bytes=0'),
                            ('/__down', 'during=IDLE&bytes=0'), ('/__down', 'bytes=0&cb='),
                            ('/__down', 'bytes=0&measId=x'), ('/__down', 'Bytes=0')]:
            with self.subTest(path=path, query=query):
                self.assertIsNone(ops.match_download('data.totob12.com', path, query, 'GET'))
        for method in ('POST', 'PUT', 'DELETE', 'get'):
            self.assertIsNone(ops.match_download('data.totob12.com', '/__down', 'bytes=0', method))
        self.assertIsNone(ops.match_download('other.totob12.com', '/__down', 'bytes=0', 'GET'))

    def test_renderer_exact_rewrites_and_scopes(self):
        r = ops.render_rules()
        rewrites = r['phases']['http_request_transform']
        self.assertEqual(len(rewrites), 1)
        rule = rewrites[0]
        self.assertEqual(rule['action_parameters']['uri'], {
            'path': {'expression': 'concat("/speedtest/", http.request.uri.args["bytes"][0], ".bin")'},
            'query': {'value': ''}})
        self.assertIn('raw.http.request.uri.path', rule['expression'])
        self.assertIn('raw.http.request.uri.args', rule['expression'])
        self.assertIn('"OPTIONS"', rule['expression'])
        self.assertEqual(r['connector']['provider'], 'cloudflare_r2')
        self.assertEqual(r['connector']['parameters']['host'], 'speed-origin.totob12.com')
        cache = r['phases']['http_request_cache_settings'][0]
        self.assertNotIn('OPTIONS', cache['expression'])
        self.assertIn('raw.http.request.uri.query eq ""', cache['expression'])
        p = cache['action_parameters']
        self.assertEqual(p['edge_ttl']['default'], 2592000)
        self.assertEqual(p['browser_ttl'], {'mode': 'respect_origin'})
        self.assertEqual([x['value'] for x in p['edge_ttl']['status_code_ttl']], [-1, 2592000, -1])
        self.assertEqual(p['edge_ttl']['status_code_ttl'][0]['status_code_range'], {'to': 199})
        self.assertEqual(p['edge_ttl']['status_code_ttl'][2]['status_code_range'], {'from': 201})
        self.assertEqual(r['phases']['http_response_compression'][0]['action_parameters'], {'algorithms': [{'name': 'none'}]})
        self.assertEqual(r['phases']['http_config_settings'][0]['action_parameters'], {'ssl': 'strict'})
        headers = r['phases']['http_response_headers_transform'][0]['action_parameters']['headers']
        self.assertEqual(headers['cache-control']['value'], 'no-store, no-transform')
        self.assertEqual(headers['access-control-allow-origin']['value'], '*')
        self.assertEqual(headers['timing-allow-origin']['value'], '*')
        self.assertEqual(r['cors']['rules'][0]['allowed']['methods'], ['GET', 'HEAD'])

    def test_checked_in_renderer_has_no_drift(self):
        expected = json.loads((ops.HERE / 'cloudflare-rules.json').read_text())
        self.assertEqual(expected, ops.render_rules())


class SafetyTests(unittest.TestCase):
    def test_repo_output_refused(self):
        for p in (ops.REPO, ops.REPO / 'public' / 'fixtures', ops.HERE):
            with self.assertRaises(ValueError):
                ops.external_path(p)
        with self.assertRaises(ValueError):
            ops.external_path(Path('relative'))

    def test_fixture_atomic_nonoverwrite_and_manifest(self):
        with tempfile.TemporaryDirectory() as d:
            out = Path(d) / 'fixtures'
            manifest = ops.generate_fixtures(out, sizes=[0, 1234], chunk_size=71)
            raw = (out / 'speedtest/1234.bin').read_bytes()
            self.assertEqual(len(raw), 1234)
            self.assertEqual(manifest['objects'][1]['sha256'], hashlib.sha256(raw).hexdigest())
            self.assertEqual(ops.generate_fixtures(out, sizes=[0, 1234]), manifest)
            self.assertEqual((out / 'speedtest/1234.bin').read_bytes(), raw)
            (out / 'speedtest/1234.bin').write_bytes(b'bad')
            with self.assertRaises(ValueError):
                ops.generate_fixtures(out, sizes=[0, 1234])

    def test_existing_unmanifested_fixture_refused(self):
        with tempfile.TemporaryDirectory() as d:
            out = Path(d)
            (out / 'speedtest').mkdir()
            (out / 'speedtest/0.bin').touch()
            with self.assertRaises(ValueError):
                ops.generate_fixtures(out, sizes=[0])

    def test_budget_includes_error_reads_and_stops_at_limit(self):
        b = verify.Budget(7)
        body = io.BytesIO(b'123456789')
        with self.assertRaises(verify.BudgetExceeded):
            verify.stream_body(body, b, chunk_size=3)
        self.assertEqual(b.used, 7)
        self.assertEqual(body.tell(), 7)

    def test_stream_hash_and_length(self):
        b = verify.Budget(100)
        n, digest, prefix = verify.stream_body(io.BytesIO(b'abc'), b)
        self.assertEqual((n, digest, prefix), (3, hashlib.sha256(b'abc').hexdigest(), b'abc'))
        self.assertEqual(b.used, 3)

    def test_quick_selection_never_large_automatic_get(self):
        requests = verify.exercise_plan('quick')
        self.assertTrue(all(x['bytes'] <= 1000000 for x in requests if x['method'] == 'GET'))
        self.assertTrue(any(x.get('expect_html') for x in requests))
        self.assertTrue(any(x['method'] == 'OPTIONS' for x in requests))
        self.assertTrue(any(x['host'] == 'speed-origin.totob12.com' for x in requests))
        self.assertLessEqual(sum(x['bytes'] for x in verify.exercise_plan('full') if x['method'] == 'GET'), 2000000000)


class DeploymentTests(unittest.TestCase):
    def snapshot(self):
        phases = {phase: None for phase in ops.render_rules()['phases']}
        phases['http_request_cache_settings'] = {'id': 'cacheid', 'rules': [
            {'id': 'existing', 'ref': 'unrelated', 'expression': 'true', 'action': 'set_cache_settings', 'action_parameters': {'cache': False}, 'enabled': True}]}
        c = ops.load_contract()
        return {'bucket': {'name': c['bucket'], 'storage_class': 'Standard'},
                'domains': {'domains': [{'domain': c['origin_host'], 'enabled': True, 'zoneId': c['zone_id'], 'minTLS': '1.2', 'status': {'ownership': 'active', 'ssl': 'active'}}]},
                'managed': {'enabled': False}, 'cors': ops.render_rules()['cors'],
                'phases': phases, 'connectors': [], 'dns': []}

    def test_appends_not_replaces_unrelated_cache(self):
        s = self.snapshot()
        original = copy.deepcopy(s)
        plan = deploy.build_plan(s, stage='rules')
        cache = [x for x in plan if x['path'].endswith('/cacheid/rules')]
        self.assertEqual(len(cache), 1)
        self.assertEqual(cache[0]['method'], 'POST')
        self.assertNotIn('rules', cache[0]['body'])
        self.assertEqual(s, original)

    def test_initial_cache_eligibility_enabled_only_after_connector(self):
        plan = deploy.build_plan(self.snapshot(), stage='rules')
        self.assertIn('http_request_cache_settings', plan[-1]['read_path'])
        connector = next(i for i, op in enumerate(plan) if 'cloud_connector' in op['path'])
        cache = next(i for i, op in enumerate(plan) if isinstance(op['body'], dict) and op['body'].get('action') == 'set_cache_settings')
        self.assertLess(connector, cache)

    def test_matching_owned_rules_are_idempotent(self):
        s = self.snapshot()
        r = ops.render_rules()
        for phase, rules in r['phases'].items():
            if s['phases'][phase] is None:
                s['phases'][phase] = {'id': phase, 'rules': []}
            s['phases'][phase]['rules'].extend(copy.deepcopy(rules))
        s['connectors'] = [copy.deepcopy(r['connector'])]
        self.assertEqual(deploy.build_plan(s, stage='rules'), [])

    def test_owned_drift_and_nonowned_collision_refused(self):
        for owned in (True, False):
            s = self.snapshot()
            rule = copy.deepcopy(ops.render_rules()['phases']['http_config_settings'][0])
            if owned:
                rule['action_parameters']['ssl'] = 'flexible'
            else:
                rule['ref'] = 'someone_else'
            s['phases']['http_config_settings'] = {'id': 'x', 'rules': [rule]}
            with self.assertRaises(ValueError):
                deploy.build_plan(s, stage='rules')

    def test_connector_preserves_other_rules(self):
        s = self.snapshot()
        old = {'provider': 'aws_s3', 'parameters': {'host': 'another.example'}, 'expression': 'http.host eq "other.example"', 'description': 'other', 'enabled': True}
        s['connectors'] = [old]
        put = [x for x in deploy.build_plan(s, stage='rules') if 'cloud_connector' in x['path']][0]
        self.assertEqual(put['body'][0], old)
        self.assertEqual(len(put['body']), 2)

    def test_missing_catchall_refused(self):
        s = self.snapshot()
        s['phases']['http_request_cache_settings'] = None
        with self.assertRaises(ValueError):
            deploy.build_plan(s, stage='rules')

    def test_resource_stages_have_no_object_upload(self):
        initial = self.snapshot()
        initial['bucket'] = None
        initial['domains'] = initial['managed'] = initial['cors'] = None
        p = deploy.build_plan(initial, stage='bucket')
        self.assertEqual(len(p), 1)
        self.assertEqual(p[0]['body'], {'name': 'totob12-speedtest', 'storageClass': 'Standard', 'locationHint': 'weur'})
        s = self.snapshot()
        s['bucket'] = {'name': 'totob12-speedtest', 'storageClass': 'Standard'}
        s['domains'] = s['managed'] = s['cors'] = None
        p = deploy.build_plan(s, stage='origin')
        self.assertEqual(len(p), 3)
        self.assertTrue(all('/objects/' not in x['path'] for x in p))

    def test_rules_stage_requires_ready_origin_and_bucket(self):
        for missing in ('bucket', 'domains'):
            state = self.snapshot()
            state[missing] = None
            with self.assertRaises(ValueError):
                deploy.build_plan(state, stage='rules')

    def test_api_errors_do_not_echo_token(self):
        self.assertNotIn('SUPERSECRET', str(deploy.APIError(403, 'SUPERSECRET')))


if __name__ == '__main__':
    unittest.main()
