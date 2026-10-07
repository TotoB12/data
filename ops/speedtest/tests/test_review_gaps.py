"""Offline regressions for the five spec-review gaps; no account access."""
import copy
from email.message import Message
import http.client
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock
import urllib.error

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import deploy
import speedtest_ops as ops
import test_contract


class MissingResourceTests(unittest.TestCase):
    def request_error(self, path, payload, status=404, optional=True, method='GET'):
        raw = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
        stream = io.BytesIO(raw)
        error = urllib.error.HTTPError(deploy.BASE + path, status, 'untrusted', Message(), stream)
        api = object.__new__(deploy.API)
        api._token, api.timeout = 'offline-test-only', 1
        api.opener = Mock()
        api.opener.open.side_effect = error
        try:
            return api.request(method, path, optional=optional)
        finally:
            self.assertTrue(stream.closed)

    def missing(self, phase):
        return {'success': False, 'errors': [{'code': 10003, 'message':
            f'could not find entrypoint ruleset in the {phase} phase'}]}

    def test_only_exact_approved_missing_entrypoints_are_optional(self):
        _, zone = deploy.paths()
        routes = [(zone + '/cloud_connector/rules', 'http_request_cloud_connector')]
        routes += [(zone + f'/rulesets/phases/{phase}/entrypoint', phase)
                   for phase in ops.render_rules()['phases']]
        for route, phase in routes:
            with self.subTest(route=route):
                self.assertIsNone(self.request_error(route, self.missing(phase)))

    def test_missing_connector_snapshot_normalizes_only_none_to_empty_array(self):
        bucket, zone = deploy.paths()
        def response(method, path, body=None, optional=False):
            if path == zone + '/cloud_connector/rules':
                self.assertTrue(optional)
                return None
            if path == bucket:
                return None
            if '/dns_records?' in path:
                return []
            return None
        api = Mock()
        api.request.side_effect = response
        self.assertEqual(deploy.snapshot(api)['connectors'], [])
        api.request.side_effect = lambda *a, **kw: {} if 'cloud_connector' in a[1] else response(*a, **kw)
        with self.assertRaises(ValueError):
            deploy.snapshot(api)

    def test_generic_wrong_phase_wrong_route_and_permissions_never_optional(self):
        _, zone = deploy.paths()
        route = zone + '/cloud_connector/rules'
        cases = [(route, {'success': False, 'errors': [{'code': 10003, 'message': 'not found'}]}, 404),
                 (route, self.missing('http_request_transform'), 404),
                 (zone + '/dns_records', self.missing('http_request_cloud_connector'), 404),
                 (zone + '/rulesets/phases/not_approved/entrypoint', self.missing('not_approved'), 404),
                 (route, self.missing('http_request_cloud_connector'), 403),
                 (route, self.missing('http_request_cloud_connector'), 400)]
        for path, payload, status in cases:
            with self.subTest(path=path, payload=payload, status=status), self.assertRaises(deploy.APIError):
                self.request_error(path, payload, status)
        for optional, method in [(False, 'GET'), (True, 'PUT')]:
            with self.assertRaises(deploy.APIError):
                self.request_error(route, self.missing('http_request_cloud_connector'), optional=optional, method=method)

    def test_bucket_missing_code_is_scoped_to_exact_bucket_get(self):
        bucket, _ = deploy.paths()
        missing = {'success': False, 'errors': [{'code': 10006, 'message': 'The specified bucket does not exist.'}]}
        self.assertIsNone(self.request_error(bucket, missing))
        for path, payload, status in [(bucket + '/cors', missing, 404),
                                     (bucket + '-other', missing, 404),
                                     (bucket, self.missing('http_request_cloud_connector'), 404),
                                     (bucket, missing, 403)]:
            with self.subTest(path=path, status=status), self.assertRaises(deploy.APIError):
                self.request_error(path, payload, status)

    def test_optional_error_json_is_bounded_and_malformed_fails_closed(self):
        _, zone = deploy.paths()
        route = zone + '/cloud_connector/rules'
        good = self.missing('http_request_cloud_connector')
        multiple = copy.deepcopy(good)
        multiple['errors'].append({'code': 9109, 'message': 'permission denied'})
        for payload in [b'not-json SECRET', b'[]', b'null', {}, multiple,
                        dict(good, success=True), dict(good, errors=[None]),
                        json.dumps(good).encode() + b' ' * (64 * 1024)]:
            with self.subTest(payload_type=type(payload).__name__):
                with self.assertRaises(deploy.APIError) as error:
                    self.request_error(route, payload)
                self.assertNotIn('SECRET', str(error.exception))

    def test_missing_connector_prewrite_is_empty_not_concurrent_drift(self):
        _, zone = deploy.paths()
        desired = [ops.render_rules()['connector']]
        operation = {'method': 'PUT', 'path': zone + '/cloud_connector/rules', 'body': desired,
                     'read_path': zone + '/cloud_connector/rules', 'before': [],
                     'check': 'connectors', 'desired': desired}
        api = Mock()
        api.request.side_effect = [None, desired, [dict(desired[0], id='assigned')]]
        with tempfile.TemporaryDirectory() as directory:
            deploy.apply_plan(api, [operation], Path(directory))
        self.assertEqual(api.request.call_count, 3)

    def test_partial_error_body_read_is_bounded_closed_and_sanitized(self):
        _, zone = deploy.paths()
        stream = Mock()
        stream.read.side_effect = http.client.IncompleteRead(b'SECRET', 1)
        error = urllib.error.HTTPError(deploy.BASE + zone + '/cloud_connector/rules', 404, 'untrusted', Message(), stream)
        api = object.__new__(deploy.API)
        api._token, api.timeout, api.opener = 'offline-test-only', 1, Mock()
        api.opener.open.side_effect = error
        with self.assertRaises(deploy.APIError) as caught:
            api.request('GET', zone + '/cloud_connector/rules', optional=True)
        self.assertNotIn('SECRET', str(caught.exception))
        stream.read.assert_called_once_with(64 * 1024 + 1)
        stream.close.assert_called_once()


class CorsAndPreflightTests(unittest.TestCase):
    def test_cors_has_stable_approved_id_and_exact_readback(self):
        desired = ops.render_rules()['cors']
        self.assertEqual(desired['rules'][0]['id'], 'bella-speedtest-public-downloads')
        deploy.verify_readback({'check': 'cors', 'desired': desired}, copy.deepcopy(desired), None)
        for key, value in [('id', 'unexpected'), ('unknownWritable', True)]:
            drift = copy.deepcopy(desired)
            drift['rules'][0][key] = value
            with self.assertRaises(ValueError):
                deploy.verify_readback({'check': 'cors', 'desired': desired}, drift, None)

    def test_connector_readback_ignores_only_new_assigned_id_not_writable_drift(self):
        desired = [ops.render_rules()['connector']]
        operation = {'check': 'connectors', 'desired': desired}
        actual = [dict(desired[0], id='assigned')]
        deploy.verify_readback(operation, actual, [])
        actual[0]['unknownWritable'] = True
        with self.assertRaises(ValueError):
            deploy.verify_readback(operation, actual, [])

    def test_plain_options_and_incomplete_or_post_preflight_remain_pages(self):
        cases = [{}, {'access-control-request-method': ['GET']}, {'origin': ['https://arbitrary.example']},
                 {'origin': [''], 'access-control-request-method': ['GET']},
                 {'origin': ['null'], 'access-control-request-method': ['POST']},
                 {'origin': ['null'], 'access-control-request-method': ['get']},
                 {'origin': ['null'], 'access-control-request-method': ['GET, HEAD']},
                 {'origin': ['null', 'https://another.example'], 'access-control-request-method': ['GET']},
                 {'origin': ['null'], 'access-control-request-method': ['GET', 'HEAD']}]
        for headers in cases:
            with self.subTest(headers=headers):
                self.assertIsNone(ops.match_download('data.totob12.com', '/__down', 'bytes=0', 'OPTIONS', headers))

    def test_preflight_single_nonempty_origin_and_exact_get_head_only(self):
        for method in ('GET', 'HEAD'):
            for origin in ('https://arbitrary.example', 'null'):
                headers = {'origin': [origin], 'access-control-request-method': [method]}
                for query in ops.load_contract()['queries']:
                    self.assertIsNotNone(ops.match_download('data.totob12.com', '/__down', query, 'OPTIONS', headers))
                self.assertIsNone(ops.match_download('data.totob12.com', '/__down', 'bytes=00', 'OPTIONS', headers))
                self.assertIsNone(ops.match_download('data.totob12.com', '/__down/', 'bytes=0', 'OPTIONS', headers))
                self.assertIsNone(ops.match_download('speed-origin.totob12.com', '/speedtest/0.bin', '', 'OPTIONS', headers))
        for method in ('GET', 'HEAD'):
            self.assertEqual(ops.match_download('data.totob12.com', '/__down', 'bytes=0', method), 0)

    def test_all_noncache_data_scopes_share_cardinality_guard_no_regex(self):
        rendered = ops.render_rules()
        expressions = [rendered['connector']['expression']]
        expressions += [rule['expression'] for phase, rules in rendered['phases'].items()
                        if phase != 'http_request_cache_settings' for rule in rules]
        for expression in expressions:
            self.assertIn('len(http.request.headers["origin"]) eq 1', expression)
            self.assertIn('len(http.request.headers["origin"][0]) gt 0', expression)
            self.assertIn('len(http.request.headers["access-control-request-method"]) eq 1', expression)
            self.assertIn('http.request.headers["access-control-request-method"][0] in {"GET" "HEAD"}', expression)
            self.assertNotIn('matches', expression)
        self.assertNotIn('OPTIONS', rendered['phases']['http_request_cache_settings'][0]['expression'])


class ConnectorReadbackTests(unittest.TestCase):
    def desired(self):
        owned = dict(ops.render_rules()['connector'], id='b14c252ed97a44d593209952f03dd064')
        unrelated = dict(owned, id='keep-id', description='unrelated', expression='false',
                         parameters={'host': 'other.example'})
        unknown = dict(unrelated, id='unknown-id', description='bella_speedtest_connector_other')
        return [unrelated, owned, unknown]

    def verify(self, desired, actual):
        deploy.verify_readback({'check': 'connectors', 'desired': desired}, actual, desired)

    def test_owned_put_regenerates_id_on_disable_and_restore(self):
        desired = self.desired()
        for enabled, assigned in [(False, 'fb0e1e7910054f578dfce99badb33eed'),
                                  (True, '25f74eeede2a455a947014f7a946e6d8')]:
            with self.subTest(enabled=enabled):
                desired[1]['enabled'] = enabled
                actual = copy.deepcopy(desired)
                actual[1]['id'] = assigned
                self.verify(desired, actual)
                desired = actual

    def test_owned_assigned_id_must_be_nonempty_string(self):
        for existing in (False, True):
            desired = self.desired()
            if not existing:
                del desired[1]['id']
            for assigned in (None, '', 123, False, []):
                with self.subTest(existing=existing, assigned=assigned):
                    actual = copy.deepcopy(desired)
                    actual[1]['id'] = assigned
                    with self.assertRaises(ValueError):
                        self.verify(desired, actual)
            actual = copy.deepcopy(desired)
            actual[1].pop('id', None)
            with self.subTest(existing=existing, assigned='missing'), self.assertRaises(ValueError):
                self.verify(desired, actual)

    def test_nonowned_and_unknown_marker_ids_remain_exact(self):
        desired = self.desired()
        for index in (0, 2):
            for assigned in ('regenerated', None):
                with self.subTest(index=index, assigned=assigned):
                    actual = copy.deepcopy(desired)
                    if assigned is None:
                        del actual[index]['id']
                    else:
                        actual[index]['id'] = assigned
                    with self.assertRaises(ValueError):
                        self.verify(desired, actual)

    def test_all_config_including_unknown_writable_fields_remains_exact(self):
        desired = self.desired()
        desired[1]['unknownWritable'] = {'keep': True}
        actual = copy.deepcopy(desired)
        self.verify(desired, actual)
        for key, value in [('enabled', False), ('description', 'bella_speedtest_connector_other'),
                           ('expression', 'false'), ('provider', 'aws_s3'),
                           ('parameters', {'host': 'other.example'}),
                           ('unknownWritable', {'keep': False}), ('extraWritable', True)]:
            with self.subTest(key=key):
                actual = copy.deepcopy(desired)
                actual[1][key] = value
                with self.assertRaises(ValueError):
                    self.verify(desired, actual)
        for index, rule in enumerate(desired):
            for key in rule.keys() - {'id'}:
                with self.subTest(index=index, missing=key):
                    actual = copy.deepcopy(desired)
                    del actual[index][key]
                    with self.assertRaises(ValueError):
                        self.verify(desired, actual)

    def test_full_array_length_order_and_rule_shape_remain_exact(self):
        desired = self.desired()
        for actual in (None, {}, desired[:-1], desired + [desired[0]],
                       list(reversed(desired)), [desired[1], desired[0], desired[2]],
                       [desired[0], None, desired[2]]):
            with self.subTest(actual=actual), self.assertRaises(ValueError):
                self.verify(desired, actual)


class SslOrderingTests(unittest.TestCase):
    def state(self, later):
        state = test_contract.DeploymentTests().snapshot()
        owned = dict(ops.render_rules()['phases']['http_config_settings'][0], id='owned')
        state['phases']['http_config_settings'] = {'id': 'config', 'rules': [owned, later]}
        return state

    def later(self, expression='true', ssl='flexible', enabled=True):
        return {'id': 'unrelated', 'ref': 'unrelated', 'enabled': enabled, 'expression': expression,
                'action': 'set_config', 'action_parameters': {'ssl': ssl}}

    def test_later_global_or_unprovable_non_strict_override_is_rejected(self):
        for expression in ('true', 'http.host contains "totob12"', 'not (http.host eq "other.example")'):
            for ssl in ('flexible', 'full', 'off'):
                for update in (False, True):
                    with self.subTest(expression=expression, ssl=ssl, update=update), self.assertRaises(ValueError):
                        deploy.build_plan(self.state(self.later(expression, ssl)), stage='rules', update_owned=update)

    def test_disabled_strict_or_provably_other_host_preserved(self):
        cases = [self.later(enabled=False), self.later(ssl='strict'),
                 self.later(expression='(http.host eq "oliver.totob12.com")'), self.later(expression='false')]
        for later in cases:
            state = self.state(later)
            before = copy.deepcopy(state)
            plan = deploy.build_plan(state, stage='rules')
            self.assertEqual(state, before)
            self.assertFalse(any('/config/' in op['path'] for op in plan))

    def test_existing_global_flexible_before_new_owned_rule_is_not_rewritten(self):
        state = self.state(self.later())
        state['phases']['http_config_settings']['rules'].pop(0)
        before = copy.deepcopy(state)
        plan = deploy.build_plan(state, stage='rules')
        config = [op for op in plan if op['path'].endswith('/config/rules')]
        self.assertEqual(len(config), 1)
        self.assertEqual(config[0]['method'], 'POST')
        self.assertEqual(state, before)


if __name__ == '__main__':
    unittest.main()
