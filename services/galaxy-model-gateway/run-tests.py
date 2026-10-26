"""Run existing Gateway modules in separate processes (LiteLLM state is global)."""
import argparse
import os
from pathlib import Path
import subprocess
import sys

SERVICE = Path(__file__).resolve().parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--upstream', type=Path, help='Fixed SOURCE.json checkout, when testing directly from source')
    args = parser.parse_args()
    environment = dict(os.environ)
    paths = [str(SERVICE / 'src'), str(SERVICE / 'tests')]
    if args.upstream:
        import json
        import tomllib
        source = json.loads((SERVICE / 'SOURCE.json').read_text(encoding='utf-8'))
        project = tomllib.loads((args.upstream / 'pyproject.toml').read_text(encoding='utf-8'))
        if project['project']['version'] != source['sourceVersion']:
            raise ValueError('Fixed upstream version mismatch')
        paths.append(str(args.upstream.resolve()))
    paths.append(environment.get('PYTHONPATH', ''))
    environment['PYTHONPATH'] = os.pathsep.join(paths)
    environment.update(LITELLM_LOCAL_MODEL_COST_MAP='True', LITELLM_TELEMETRY_DISABLED='true', DO_NOT_TRACK='1')
    failed = []
    modules = sorted((SERVICE / 'tests').glob('test_*.py'))
    for path in modules:
        print('Gateway module: ' + path.stem, flush=True)
        result = subprocess.run([sys.executable, '-m', 'unittest', path.stem, '-v'],
                                cwd=SERVICE, env=environment)
        if result.returncode:
            failed.append(path.stem)
    print(f'Gateway: {len(modules)} modules; failed={failed}', flush=True)
    return bool(failed)


if __name__ == '__main__':
    sys.exit(main())
