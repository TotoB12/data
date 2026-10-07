#!/usr/bin/env python3
"""Generate the seven unencoded raw-random fixtures OUTSIDE every repository."""
import argparse
import json
from pathlib import Path

from speedtest_ops import generate_fixtures, load_contract, validate_manifest


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--output-dir', required=True, type=Path, help='Absolute EXTERNAL private directory; never a Pages/public/repository directory')
    p.add_argument('--chunk-bytes', type=int, default=1024 * 1024)
    p.add_argument('--validate-only', action='store_true', help='Stream-hash existing fixtures against manifest, write nothing')
    args = p.parse_args(argv)
    try:
        if args.chunk_bytes <= 0:
            raise ValueError('--chunk-bytes must be positive')
        manifest = validate_manifest(args.output_dir) if args.validate_only else generate_fixtures(args.output_dir, chunk_size=args.chunk_bytes)
        print(json.dumps({'ok': True, 'object_count': len(manifest['objects']),
                          'total_bytes': manifest['total_bytes'], 'manifest': str(args.output_dir / 'manifest.json'),
                          'expected_total_bytes': load_contract()['total_fixture_bytes']}))
        return 0
    except (ValueError, OSError, KeyError, TypeError) as exc:
        print(json.dumps({'ok': False, 'error': str(exc) if isinstance(exc, ValueError) else type(exc).__name__}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
