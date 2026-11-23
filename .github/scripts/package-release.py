"""Package only the runtime inputs and the compiled bundle qualified on this runner."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import tempfile


def sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


assert os.environ.get('GITHUB_ACTIONS') == 'true', 'Use the isolated GitHub runner.'
assert os.environ.get('STEELKEEP_UI_ACCEPTANCE') == 'github-google-drive'
head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
assert head == os.environ.get('GITHUB_SHA'), 'Package the exact checked-out revision.'
proof_path = Path('output/playwright/google-drive-ui/results.json')
proof = json.loads(proof_path.read_text())
qualified_head = proof['commit']
assert re.fullmatch('[a-f0-9]{40}', qualified_head) and len(proof['cases']) == 4
assert all(case['uncaughtErrors'] == 0 for case in proof['cases'])
assert 'explicit-oauth-start-to-synthetic-google-boundary' in proof['checks']
assert Path('dist/server/server.js').is_file() and Path('dist/client').is_dir()

inputs = ['server', 'shared', 'package.json', 'bun.lock', 'scripts/setup-owner.ts', 'THIRD-PARTY-NOTICES.md', 'LICENSE']
qualification = os.environ.get('STEELKEEP_QUALIFIED_UI_RUN_FILE')
if qualification:
    run = json.loads(Path(qualification).read_text())
    assert run['conclusion'] == 'success' and run['headSha'] == qualified_head
    build_inputs = [*inputs, 'src', 'public', 'vite.config.ts', 'tsconfig.json']
    subprocess.run(['git', 'diff', '--exit-code', qualified_head, head, '--', *build_inputs], check=True)
else:
    assert qualified_head == head, 'A different source requires explicit successful unchanged-source qualification.'
subprocess.run(['git', 'diff', '--exit-code', 'HEAD', '--', *inputs], check=True)
output = Path(os.environ['RUNNER_TEMP']) / 'steelkeep-release'
output.mkdir(mode=0o700)
archive_path = output / f'steelkeep-{head}.tar.gz'
with tempfile.TemporaryDirectory(prefix='steelkeep-release-stage-', dir=os.environ['RUNNER_TEMP']) as temporary:
    stage = Path(temporary)
    source_tar = stage / 'tracked-source.tar'
    with source_tar.open('wb') as archive:
        subprocess.run(['git', 'archive', 'HEAD', '--', *inputs], stdout=archive, check=True)
    with tarfile.open(source_tar) as archive:
        for entry in archive.getmembers():
            assert not entry.issym() and not entry.islnk() and not Path(entry.name).is_absolute() and '..' not in Path(entry.name).parts
        archive.extractall(stage, filter='data')
    source_tar.unlink()
    assert not any(path.is_symlink() for path in Path('dist').rglob('*')), 'Compiled output must contain no external links.'
    shutil.copytree('dist', stage / 'dist')
    files = sorted(path for path in stage.rglob('*') if path.is_file())
    for path in files:
        assert not set(path.relative_to(stage).parts) & {'.git', 'node_modules', '.steelkeep', 'output'}
        assert path.name != '.env' and path.suffix not in {'.key', '.pem', '.dump'}
    manifest = {'gitHead': head, 'qualifiedUiCommit': qualified_head, 'bunLockSha256': sha256(stage / 'bun.lock'), 'uiProofSha256': sha256(proof_path), 'workflowRunId': os.environ['GITHUB_RUN_ID'], 'fileCount': len(files), 'bytes': sum(path.stat().st_size for path in files), 'files': {str(path.relative_to(stage)): sha256(path) for path in files}}
    (stage / 'release-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    with tarfile.open(archive_path, 'w:gz') as archive:
        for path in sorted(stage.iterdir()):
            archive.add(path, arcname=path.name)
manifest.update({'archiveName': archive_path.name, 'archiveSha256': sha256(archive_path), 'archiveBytes': archive_path.stat().st_size})
(output / 'release-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(json.dumps({key: manifest[key] for key in ['gitHead', 'fileCount', 'bytes', 'archiveName', 'archiveBytes', 'archiveSha256']}))
