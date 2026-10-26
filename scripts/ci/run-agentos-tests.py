"""Run existing AgentOS modules with their dedicated PostgreSQL test schemas."""
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
SERVICE = ROOT / 'services/galaxy-operations-agentos'
P13_SCHEMAS = {
    'test_p13_strategies': 'galaxy_p13_check_20261023',
    'test_p13_continuation': 'galaxy_p13_continuation_check_20261023',
}


def main():
    environment = dict(os.environ)
    environment['PYTHONPATH'] = os.pathsep.join((str(SERVICE / 'src'), str(SERVICE / 'tests'),
                                               environment.get('PYTHONPATH', '')))
    failed = []
    modules = sorted((SERVICE / 'tests').glob('test_*.py'))
    for path in modules:
        selected = dict(environment)
        # Both old fixed-version P13 contracts use the same variable, but have
        # different authorized schemas. Never silently substitute SQLite.
        selected.pop('GALAXY_P13_CHECK_SCHEMA', None)
        if path.stem in P13_SCHEMAS:
            selected['GALAXY_P13_CHECK_SCHEMA'] = P13_SCHEMAS[path.stem]
        print('AgentOS module: ' + path.stem, flush=True)
        result = subprocess.run([sys.executable, '-m', 'unittest', path.stem, '-v'],
                                cwd=ROOT, env=selected)
        if result.returncode:
            failed.append(path.stem)
    print(f'AgentOS: {len(modules)} modules; failed={failed}', flush=True)
    return bool(failed)


if __name__ == '__main__':
    sys.exit(main())
