"""Package only authenticated vendor client binaries and their observed Linux library closure on CI."""
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import tarfile

assert platform.system() == 'Linux' and platform.machine() == 'x86_64'
assert os.environ.get('GITHUB_ACTIONS') == 'true' and os.environ.get('STEELKEEP_POSTGRES_ACCEPTANCE') == 'github-native-17-18'
out = Path('output/postgres-native-ci')
root = out / 'postgres18-client'
assert not root.exists(), 'Never replace an existing bundle.'
for directory in ['bin', 'lib', 'wrappers']:
    (root / directory).mkdir(parents=True, mode=0o755)

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

libraries = set()
for name in ['pg_dump', 'pg_restore']:
    source = Path('/usr/lib/postgresql/18/bin') / name
    version = subprocess.check_output([str(source), '--version'], text=True).strip()
    assert re.fullmatch(r'pg_(dump|restore) \(PostgreSQL\) 18\.\d+(?: .*)?', version), 'Only the installed PGDG PostgreSQL18 client is permitted.'
    shutil.copy2(source, root / 'bin' / name)
    linkage = subprocess.check_output(['ldd', str(source)], text=True)
    assert 'not found' not in linkage
    for line in linkage.splitlines():
        match = re.search(r'(?:=>\s+)?(/[^\s]+)\s+\(', line)
        if match:
            libraries.add(Path(match.group(1)))
for library in sorted(libraries):
    target = root / 'lib' / library.name
    if target.exists():
        assert sha(target) == sha(library.resolve()), 'Conflicting library basenames.'
    else:
        shutil.copy2(library.resolve(), target)
loader = root / 'lib' / 'ld-linux-x86-64.so.2'
assert loader.is_file()
for name in ['pg_dump', 'pg_restore']:
    wrapper = root / 'wrappers' / (name + '18')
    wrapper.write_text('#!/bin/sh\nset -eu\nbase=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)\nexec "$base/lib/ld-linux-x86-64.so.2" --inhibit-cache --library-path "$base/lib" "$base/bin/' + name + '" "$@"\n')
    wrapper.chmod(0o755)
packages = subprocess.check_output(['dpkg-query', '-W', '-f=${Package}\t${Version}\t${Architecture}\n', 'postgresql-client-18', 'libpq5', 'libc6'], text=True)
(root / 'package-provenance.tsv').write_text(packages)
manifest = {str(path.relative_to(root)): {'bytes': path.stat().st_size, 'sha256': sha(path)} for path in sorted(root.rglob('*')) if path.is_file()}
(root / 'manifest.json').write_text(json.dumps({'commit': os.environ['GITHUB_SHA'], 'origin': 'PGDG signed noble-pgdg APT metadata and package hashes; base dependency closure from Ubuntu24.04 GitHub runner', 'architecture': 'linux-amd64', 'installation': '/opt/steelkeep-pg18 with wrappers added to trusted PATH; PG17 PATH entries preserved', 'files': manifest}, indent=2) + '\n')
archive = out / 'steelkeep-postgres18-linux-amd64.tar.gz'
with tarfile.open(archive, 'w:gz') as tar:
    tar.add(root, arcname='postgres18-client', recursive=True)
(out / 'client-bundle.json').write_text(json.dumps({'archive': archive.name, 'bytes': archive.stat().st_size, 'sha256': sha(archive), 'unpackedBytes': sum(path.stat().st_size for path in root.rglob('*') if path.is_file()), 'packages': packages.strip().splitlines()}, indent=2) + '\n')
print(json.dumps({'archive': archive.name, 'bytes': archive.stat().st_size, 'sha256': sha(archive)}))
