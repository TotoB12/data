"""Offline S3 doubles, not a claim of live R2 compatibility."""
import copy
import io
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import speedtest_ops as ops
import s3_upload


class S3:
    def __init__(self, bad_size=False, omit_cache=False):
        self.objects = {}
        self.calls = []
        self.bad_size = bad_size
        self.omit_cache = omit_cache

    def head_object(self, Bucket, Key):
        if Key not in self.objects:
            raise s3_upload.MissingObject()
        return copy.deepcopy(self.objects[Key])

    def upload_file(self, Filename, Bucket, Key, ExtraArgs, Config):
        self.calls.append((Filename, Bucket, Key, copy.deepcopy(ExtraArgs), Config))
        self.objects[Key] = {'ContentLength': Path(Filename).stat().st_size,
                             'ContentType': ExtraArgs['ContentType'], 'CacheControl': ExtraArgs['CacheControl'],
                             'Metadata': ExtraArgs['Metadata'], 'StorageClass': ExtraArgs['StorageClass']}
        if self.bad_size:
            self.objects[Key]['ContentLength'] -= 1
        if self.omit_cache:
            del self.objects[Key]['CacheControl']


class S3UploadTests(unittest.TestCase):
    def test_missing_object_plans_upload_default_is_read_only(self):
        with tempfile.TemporaryDirectory() as d:
            directory = Path(d)
            manifest = ops.generate_fixtures(directory / 'fixtures', sizes=[0, 100000])
            s3 = S3()
            plan = s3_upload.build_object_plan(s3, manifest, sizes=[0, 100000])
            self.assertEqual(len(plan), 2)
            self.assertEqual(s3.calls, [])

    def test_metadata_is_explicit_no_encoding_and_standard(self):
        args = s3_upload.extra_args({'sha256': 'a' * 64})
        self.assertEqual(args['CacheControl'], 'no-store, no-transform')
        self.assertEqual(args['ContentType'], 'application/octet-stream')
        self.assertEqual(args['StorageClass'], 'STANDARD')
        self.assertNotIn('ContentEncoding', args)

    def test_existing_wrong_metadata_needs_explicit_replace(self):
        with tempfile.TemporaryDirectory() as d:
            manifest = ops.generate_fixtures(Path(d), sizes=[0])
            s3 = S3()
            s3.objects['speedtest/0.bin'] = {'ContentLength': 0, 'ContentType': 'application/octet-stream'}
            with self.assertRaises(ValueError):
                s3_upload.build_object_plan(s3, manifest, sizes=[0])
            self.assertEqual(len(s3_upload.build_object_plan(s3, manifest, sizes=[0], replace_existing=True)), 1)

    def test_small_upload_has_strict_head_readback_and_idempotence(self):
        with tempfile.TemporaryDirectory() as d:
            directory = Path(d)
            manifest = ops.generate_fixtures(directory / 'fixtures', sizes=[0, 100000])
            s3 = S3()
            plan = s3_upload.build_object_plan(s3, manifest, sizes=[0, 100000])
            result = s3_upload.apply_object_plan(s3, plan, directory / 'fixtures', directory / 'audit', transfer_config='multipart-policy')
            self.assertEqual(len(s3.calls), 2)
            self.assertTrue(result['head_metadata_verified'])
            self.assertFalse(result['remote_body_hash_verified'])
            self.assertEqual(s3_upload.build_object_plan(s3, manifest, sizes=[0, 100000]), [])

    def test_silent_truncation_or_missing_cache_is_not_success(self):
        for bad_size, omit_cache in ((True, False), (False, True)):
            with tempfile.TemporaryDirectory() as d:
                directory = Path(d)
                manifest = ops.generate_fixtures(directory / 'fixtures', sizes=[100000])
                s3 = S3(bad_size=bad_size, omit_cache=omit_cache)
                plan = s3_upload.build_object_plan(s3, manifest, sizes=[100000])
                with self.assertRaises(ValueError):
                    s3_upload.apply_object_plan(s3, plan, directory / 'fixtures', directory / 'audit', transfer_config='test')
                # Do not automatically delete/rollback an object or touch other keys.
                self.assertEqual(len(s3.calls), 1)

    def test_unauthorized_key_not_accepted(self):
        with self.assertRaises(ValueError):
            s3_upload.extra_args({'key': '../anything', 'sha256': 'bad'})

    def test_non_allowlisted_size_refused(self):
        with self.assertRaises(ValueError):
            s3_upload.extra_args({'key': 'speedtest/32.bin', 'bytes': 32, 'sha256': 'a' * 64})

    def test_largest_approved_object_plans_multipart(self):
        manifest = {'objects': [{'key': 'speedtest/250000000.bin', 'bytes': 250000000, 'sha256': 'a' * 64}]}
        self.assertTrue(s3_upload.build_object_plan(S3(), manifest)[0]['multipart'])

    def test_concurrent_head_change_stops_before_upload(self):
        with tempfile.TemporaryDirectory() as d:
            directory = Path(d)
            manifest = ops.generate_fixtures(directory / 'fixtures', sizes=[0])
            s3 = S3()
            plan = s3_upload.build_object_plan(s3, manifest, sizes=[0])
            s3.objects['speedtest/0.bin'] = {'ContentLength': 0}
            with self.assertRaises(ValueError):
                s3_upload.apply_object_plan(s3, plan, directory / 'fixtures', directory / 'audit', transfer_config='test')
            self.assertEqual(s3.calls, [])


if __name__ == '__main__':
    unittest.main()
