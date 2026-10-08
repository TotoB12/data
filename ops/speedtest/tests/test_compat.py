"""Expanded finite contract and audited migration regressions; offline only."""
import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import speedtest_ops as ops
import deploy
import verify
import test_contract

LEGACY = [0, 100000, 1000000, 10000000, 25000000, 100000000, 250000000]
CLIENT = [n * 1024 ** 2 for n in range(8, 97, 8)] + [100 * 1024 ** 2]


def legacy_rules():
    """Independent reproduction of the approved version-1 static payload."""
    result = []
    for n in LEGACY:
        queries = [f'bytes={n}']
        if n == 0:
            queries += ['during=idle&bytes=0', 'during=download&bytes=0']
        expression = ('(http.host eq "data.totob12.com" and raw.http.request.uri.path eq "/__down" '
                      f'and raw.http.request.uri.query in {ops.literals(queries)} '
                      'and (http.request.method in {"GET" "HEAD"} or '
                      '(http.request.method eq "OPTIONS" '
                      'and len(http.request.headers["origin"]) eq 1 '
                      'and len(http.request.headers["origin"][0]) gt 0 '
                      'and len(http.request.headers["access-control-request-method"]) eq 1 '
                      'and http.request.headers["access-control-request-method"][0] in {"GET" "HEAD"})))')
        ref = f'bella_speedtest_rewrite_{n}'
        result.append({'id': f'legacy-{n}', 'version': '1', 'last_updated': 'readonly',
                       'ref': ref, 'description': ref, 'enabled': True, 'action': 'rewrite',
                       'expression': expression, 'action_parameters': {'uri': {
                           'path': {'value': f'/speedtest/{n}.bin'}, 'query': {'value': ''}}}})
    return result


class CompatTests(unittest.TestCase):
    def test_union_contract(self):
        c = ops.load_contract()
        self.assertEqual(c['version'], 2)
        self.assertEqual(c['legacy_sizes'], LEGACY)
        self.assertEqual(c['client_sizes'], CLIENT)
        self.assertEqual(c['sizes'], sorted(set(LEGACY + CLIENT)))
        self.assertEqual(len(c['sizes']), 20)
        self.assertEqual(c['total_fixture_bytes'], sum(set(LEGACY + CLIENT)))

    def test_optional_cb_and_during_in_every_order(self):
        for n in sorted(set(LEGACY + CLIENT)):
            for query in (f'bytes={n}', f'bytes={n}&cb=abc', f'cb=abc&bytes={n}',
                          f'cb={"x" * 128}&bytes={n}'):
                for method in ('GET', 'HEAD', 'OPTIONS'):
                    headers = {'origin': ['null'], 'access-control-request-method': ['HEAD']}
                    self.assertEqual(ops.match_download('data.totob12.com', '/__down', query, method, headers), n)
        import itertools
        for during in ('idle', 'download'):
            for parts in itertools.permutations(['bytes=0', f'during={during}', 'cb=1']):
                self.assertEqual(ops.match_download('data.totob12.com', '/__down', '&'.join(parts), 'GET'), 0)

    def test_noncanonical_unknown_duplicate_and_bad_optional_values(self):
        bad = ['bytes=00', 'bytes=%30', 'bytes=-1', 'bytes=+0', 'bytes=0.0', 'bytes= 0',
               'bytes=123', 'bytes=999999999', 'bytes=', 'bytes', '', 'Bytes=0', '%62ytes=0',
               'bytes=0&bytes=0', 'bytes=0&cb=', 'bytes=0&cb', 'bytes=0&cb=1&cb=2',
               'bytes=0&cb=' + 'x' * 129, 'bytes=0&during=', 'bytes=0&during=IDLE',
               'bytes=100000&during=idle', 'bytes=0&during=idle&during=idle',
               'bytes=0&measId=x', 'bytes=0&CB=1', 'bytes=0&%63b=1', 'bytes=0&',
               'bytes=0&&cb=1', 'bytes=0;cb=1', 'during=%69dle&bytes=0']
        for query in bad:
            with self.subTest(query=query):
                self.assertIsNone(ops.match_download('data.totob12.com', '/__down', query, 'GET'))

    def test_compact_rewrite_and_structural_scope(self):
        rules = ops.render_rules()
        rewrite, = rules['phases']['http_request_transform']
        self.assertEqual(rewrite['ref'], 'bella_speedtest_rewrite')
        self.assertEqual(rewrite['action_parameters']['uri'], {
            'path': {'expression': 'concat("/speedtest/", http.request.uri.args["bytes"][0], ".bin")'},
            'query': {'value': ''}})
        scope = rules['connector']['expression']
        for fragment in ('len(raw.http.request.uri.args["bytes"]) eq 1',
                         'all(raw.http.request.uri.args.names[*] in {"bytes" "cb" "during"})',
                         'not (len(raw.http.request.uri.args["cb"]) ge 0)',
                         'len(raw.http.request.uri.args["cb"][0]) le 128',
                         'not (len(raw.http.request.uri.args["during"]) ge 0)'):
            self.assertIn(fragment, scope)
        for n in CLIENT:
            self.assertIn(f'"{n}"', scope)
        self.assertNotIn('matches', scope)
        self.assertNotIn('raw.http.request.uri.query in', scope)

    def test_full_plan_hashes_each_known_size_once_and_only_warms_small(self):
        full = verify.exercise_plan('full')
        c = ops.load_contract()
        primary = [e for e in full if e['host'] == c['data_host'] and e['method'] == 'GET'
                   and e['kind'] == 'object' and e['query'] == f'bytes={e["bytes"]}'
                   and e.get('origin') and not e.get('warm')]
        self.assertEqual(sorted(e['bytes'] for e in primary), c['sizes'])
        self.assertTrue(all(e['bytes'] <= 1000000 for e in full
                            if e.get('warm') or e['host'] == c['origin_host']))
        planned = sum(e['bytes'] for e in full if e['method'] == 'GET' and not e.get('expect_html'))
        self.assertLess(planned, c['max_verification_bytes'])
        for e in full:
            if e['kind'] != 'fallback' and e['host'] == c['data_host']:
                headers = {'origin': ['null'], 'access-control-request-method': ['GET']}
                self.assertIsNotNone(ops.match_download(e['host'], e['path'], e['query'], e['method'], headers))


class MigrationTests(unittest.TestCase):
    def state(self):
        state = test_contract.DeploymentTests().snapshot()
        unrelated = {'id': 'keep-before', 'ref': 'other-before', 'description': 'keep',
                     'enabled': True, 'action': 'rewrite', 'expression': 'false',
                     'action_parameters': {'uri': {'query': {'value': 'unchanged'}}},
                     'logging': {'enabled': True}, 'version': '3'}
        middle = dict(copy.deepcopy(unrelated), id='keep-middle', ref='other-middle')
        after = dict(copy.deepcopy(unrelated), id='keep-after', ref='other-after')
        old = legacy_rules()
        state['phases']['http_request_transform'] = {'id': 'transform', 'name': 'existing',
            'kind': 'zone', 'phase': 'http_request_transform', 'version': '4',
            'rules': [unrelated, old[0], middle, *old[1:], after]}
        oliver = {'id': 'oliver', 'ref': 'oliver', 'enabled': True, 'action': 'set_config',
                  'expression': '(http.host eq "oliver.totob12.com")', 'action_parameters': {'ssl': 'strict'}}
        owned = dict(ops.render_rules()['phases']['http_config_settings'][0], id='speed-ssl')
        state['phases']['http_config_settings'] = {'id': 'config', 'rules': [oliver, owned]}
        return state

    def operation(self, state):
        plan = deploy.build_plan(state, stage='rules', migrate_legacy_rewrites=True)
        return next(op for op in plan if op['check'] == 'rewrite_migration')

    def test_requires_explicit_migration_even_update_owned(self):
        for update in (False, True):
            with self.assertRaises(ValueError):
                deploy.build_plan(self.state(), stage='rules', update_owned=update)

    def test_approved_legacy_helper_matches_independent_previous_payload(self):
        self.assertEqual([deploy.projected(r) for r in legacy_rules()], ops.legacy_rewrite_rules())

    def test_one_audited_put_preserves_unrelated_configuration_ids_and_order(self):
        state = self.state()
        original = copy.deepcopy(state)
        op = self.operation(state)
        self.assertEqual(op['method'], 'PUT')
        self.assertTrue(op['path'].endswith('/rulesets/transform'))
        self.assertEqual(op['before'], state['phases']['http_request_transform'])
        self.assertEqual([r['ref'] for r in op['body']['rules']],
                         ['other-before', 'bella_speedtest_rewrite', 'other-middle', 'other-after'])
        for rule in op['body']['rules']:
            if rule['ref'] != 'bella_speedtest_rewrite':
                old = next(r for r in op['before']['rules'] if r.get('id') == rule['id'])
                self.assertTrue(deploy.same_rule(rule, old))
        self.assertEqual(state, original)
        actual = dict(copy.deepcopy(op['before']), rules=copy.deepcopy(op['body']['rules']))
        actual['rules'][1]['id'] = 'new-rewrite'
        deploy.verify_readback(op, actual, op['before'])
        state['phases']['http_request_transform'] = actual
        self.assertFalse(any(op['check'] == 'rewrite_migration' for op in
                             deploy.build_plan(state, stage='rules', migrate_legacy_rewrites=True)))

    def test_partial_duplicate_mixed_unknown_drift_and_no_ids_refused(self):
        for change in ('partial', 'duplicate', 'mixed', 'unknown', 'expression', 'path', 'query',
                       'disabled', 'description', 'extra-writable', 'missing-id', 'duplicate-id'):
            with self.subTest(change=change):
                state = self.state()
                rules = state['phases']['http_request_transform']['rules']
                old = rules[1]
                if change == 'partial': rules.pop(1)
                elif change == 'duplicate': rules.append(copy.deepcopy(old))
                elif change == 'mixed': rules.append(copy.deepcopy(ops.render_rules()['phases']['http_request_transform'][0]))
                elif change == 'unknown': rules.append(dict(old, ref='bella_speedtest_rewrite_unknown'))
                elif change == 'expression': old['expression'] += ' or true'
                elif change == 'path': old['action_parameters']['uri']['path']['value'] = '/other'
                elif change == 'query': old['action_parameters']['uri']['query']['value'] = 'x=1'
                elif change == 'disabled': old['enabled'] = False
                elif change == 'description': old['description'] = 'drift'
                elif change == 'extra-writable': old['logging'] = {'enabled': True}
                elif change == 'missing-id': old.pop('id')
                elif change == 'duplicate-id': old['id'] = rules[0]['id']
                with self.assertRaises(ValueError):
                    self.operation(state)

    def test_readback_rejects_loss_reorder_extra_legacy_and_unrelated_id_config_drift(self):
        op = self.operation(self.state())
        good = dict(copy.deepcopy(op['before']), rules=copy.deepcopy(op['body']['rules']))
        good['rules'][1]['id'] = 'new-rewrite'
        for change in ('loss', 'order', 'extra', 'legacy', 'unrelated-id', 'config', 'owned-id', 'owned-config', 'ruleset-id'):
            with self.subTest(change=change):
                actual = copy.deepcopy(good)
                if change == 'loss': actual['rules'].pop()
                elif change == 'order': actual['rules'].reverse()
                elif change == 'extra': actual['rules'].append(dict(actual['rules'][0], id='extra', ref='extra'))
                elif change == 'legacy': actual['rules'].append(legacy_rules()[0])
                elif change == 'unrelated-id': actual['rules'][0]['id'] = 'recreated'
                elif change == 'config': actual['rules'][0]['logging']['enabled'] = False
                elif change == 'owned-id': actual['rules'][1].pop('id')
                elif change == 'owned-config': actual['rules'][1]['enabled'] = False
                elif change == 'ruleset-id': actual['id'] = 'other-ruleset'
                with self.assertRaises(ValueError):
                    deploy.verify_readback(op, actual, op['before'])

    def test_readback_rejects_malformed_arrays_and_ruleset_metadata_drift(self):
        op = self.operation(self.state())
        good = dict(copy.deepcopy(op['before']), rules=copy.deepcopy(op['body']['rules']))
        good['rules'][1]['id'] = 'new-rewrite'
        variants = [None, {}, dict(good, rules=None), dict(good, rules=[None] * 4),
                    dict(good, name='changed'), dict(good, kind='root'), dict(good, phase='changed')]
        bad_id = copy.deepcopy(good)
        bad_id['rules'][1]['id'] = ['unhashable']
        variants.append(bad_id)
        for actual in variants:
            with self.subTest(actual=actual), self.assertRaises(ValueError):
                deploy.verify_readback(op, actual, op['before'])

    def test_prewrite_concurrency_refused_and_postwrite_receipt_checked(self):
        op = self.operation(self.state())
        good = dict(copy.deepcopy(op['before']), rules=copy.deepcopy(op['body']['rules']))
        good['rules'][1]['id'] = 'new-rewrite'
        api = Mock()
        api.request.side_effect = [copy.deepcopy(op['before']), {}, good]
        with tempfile.TemporaryDirectory() as directory:
            deploy.apply_plan(api, [op], Path(directory))
            receipt = json.loads((Path(directory) / 'readback-000.json').read_text())
            self.assertEqual(receipt['operation']['check'], 'rewrite_migration')
        self.assertEqual(api.request.call_count, 3)
        api = Mock()
        drift = copy.deepcopy(op['before'])
        drift['version'] = 'concurrent'
        api.request.return_value = drift
        with tempfile.TemporaryDirectory() as directory, self.assertRaises(ValueError):
            deploy.apply_plan(api, [op], Path(directory))
        self.assertEqual(api.request.call_count, 1)


class ToolingTests(unittest.TestCase):
    def test_s3_namespace_accepts_every_exact_client_size_and_rejects_neighbor(self):
        import s3_upload
        from test_s3 import S3
        entries = [{'key': f'speedtest/{n}.bin', 'bytes': n, 'sha256': 'a' * 64} for n in CLIENT]
        plan = s3_upload.build_object_plan(S3(), {'objects': entries})
        self.assertEqual([op['entry']['bytes'] for op in plan], CLIENT)
        for n in (CLIENT[0] - 1, CLIENT[-1] + 1):
            with self.assertRaises(ValueError):
                s3_upload.extra_args({'key': f'speedtest/{n}.bin', 'bytes': n, 'sha256': 'a' * 64})

    def test_v2_corpus_requires_complete_sorted_union_not_legacy_only(self):
        import test_transport
        receipt = test_transport.TransportTests().corpus_receipt()
        for change in ('legacy-only', 'bad-count', 'reorder'):
            altered = copy.deepcopy(receipt)
            if change == 'legacy-only':
                altered['objects'] = [o for o in altered['objects'] if o['bytes'] in LEGACY]
                altered['count'] = len(LEGACY)
                altered['total_bytes'] = sum(LEGACY)
            elif change == 'bad-count':
                altered['count'] = 7
            else:
                altered['objects'].reverse()
            with tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / 'receipt.json'
                path.write_text(json.dumps(altered))
                with self.assertRaises(ValueError):
                    ops.validate_corpus_manifest(path)

    def test_migration_cli_requires_receipt_before_account_access(self):
        from unittest.mock import patch
        import io
        with patch('deploy.API', side_effect=AssertionError('No account access')), \
                patch('sys.stderr', new_callable=io.StringIO), self.assertRaises(SystemExit):
            deploy.main(['--stage', 'rules', '--migrate-legacy-rewrites', '--apply'])
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'receipt.json'
            path.write_text('{}')
            with patch('deploy.API', side_effect=AssertionError('No account access')), \
                    patch('sys.stdout', new_callable=io.StringIO):
                self.assertEqual(deploy.main(['--stage', 'rules', '--migrate-legacy-rewrites',
                                             '--apply', '--corpus-manifest', str(path)]), 1)

    def test_full_plan_budget_consent_ceiling_and_reserve_remain_enforced(self):
        from unittest.mock import patch
        import io
        planned = sum(e['bytes'] for e in verify.exercise_plan('full')
                      if e['method'] == 'GET' and not e.get('expect_html'))
        cases = [['--mode', 'full', '--budget-bytes', '1400000000'],
                 ['--mode', 'full', '--allow-large'],
                 ['--mode', 'full', '--allow-large', '--budget-bytes', '2000000001'],
                 ['--mode', 'full', '--allow-large', '--budget-bytes', str(planned)]]
        for args in cases:
            with patch('verify.urllib.request.build_opener', side_effect=AssertionError('No HTTP')), \
                    patch('sys.stderr', new_callable=io.StringIO), self.assertRaises(SystemExit):
                verify.main(['--plan', *args])


if __name__ == '__main__':
    unittest.main()
