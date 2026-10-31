#!/usr/bin/env python3
"""Private server-only APT download/extraction; never installs host packages."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import urllib.request

THREAD = '01a18e0d-1fd7-7340-ae3e-64dd9b2f270b'
IMAGE = 'sha256:cf3d84df5261bc00b40e907f6ca431c1f589662f041755f18b15dbf986d69b6d'
MYSQL = '8.0.46-0ubuntu0.24.04.4'
MARIA = '1:11.4.13+maria~ubu2404'
MARIA_KEY_SHA = '403e0403df51273fbf5613e5644959d3f85923ef7d8f92e7d83eafe289093af4'

def run(args, **kwargs):
    result = subprocess.run(args, text=True, capture_output=True, **kwargs)
    if result.returncode:
        raise RuntimeError(json.dumps({'command': args, 'exit': result.returncode, 'stdout': result.stdout[-5000:], 'stderr': result.stderr[-5000:]}))
    return result.stdout

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def floor(root, reserve=8.25):
    free = shutil.disk_usage(root).free
    if free < reserve * 1024**3:
        raise RuntimeError('Disk floor: ' + str(free))
    return free

def metadata(root):
    floor(root.parent)
    marker = root / 'owned.json'
    if marker.exists():
        assert json.loads(marker.read_text())['thread'] == THREAD
    else:
        root.mkdir(parents=True, exist_ok=False)
        marker.write_text(json.dumps({'thread': THREAD, 'purpose': 'private-signed-sqlclients', 'runtimeImage': IMAGE}))
    proof = root / 'provenance'
    proof.mkdir(exist_ok=True)
    keys = root / '.apt/keys'
    keys.mkdir(parents=True, exist_ok=True)
    gpg_home = root / '.apt/gnupg'
    gpg_home.mkdir(mode=0o700, exist_ok=True)
    name = 'steelkeep-sqlclients-image-inspect'
    assert subprocess.run(['docker', 'inspect', name], capture_output=True).returncode != 0
    run(['docker', 'create', '--name', name, '--label', 'steelkeep.thread=' + THREAD, '--network', 'none', '--entrypoint', '/bin/true', IMAGE])
    try:
        for source, dest in [('/usr/share/keyrings/ubuntu-archive-keyring.gpg', keys / 'ubuntu.gpg'), ('/var/lib/dpkg/status', proof / 'runtime-dpkg-status'), ('/etc/os-release', proof / 'runtime-os-release')]:
            if dest.is_symlink():
                dest.unlink()
            run(['docker', 'cp', '-L', name + ':' + source, str(dest)])
    finally:
        run(['docker', 'rm', name])
    assert 'VERSION_CODENAME=noble' in (proof / 'runtime-os-release').read_text()
    ubuntu_keys = run(['gpg', '--homedir', str(gpg_home), '--batch', '--show-keys', '--with-colons', str(keys / 'ubuntu.gpg')])
    assert 'F6ECB3762474EDA9D21B7022871920D1991BC93C' in ubuntu_keys
    (proof / 'ubuntu-key-fingerprints.txt').write_text(ubuntu_keys)
    request = urllib.request.Request('https://supplychain.mariadb.com/mariadb-keyring-2025.gpg', headers={'User-Agent': 'steelkeep-private-runtime/1'})
    with urllib.request.urlopen(request, timeout=30) as response:
        data = response.read(1024 * 1024 + 1)
    assert len(data) <= 1024 * 1024 and hashlib.sha256(data).hexdigest() == MARIA_KEY_SHA
    (keys / 'mariadb.gpg').write_bytes(data)
    (proof / 'mariadb-key-fingerprints.txt').write_text(run(['gpg', '--homedir', str(gpg_home), '--batch', '--show-keys', '--with-colons', str(keys / 'mariadb.gpg')]))
    apt = root / '.apt'
    for p in ['etc', 'state/lists/partial', 'cache/archives/partial']:
        (apt / p).mkdir(parents=True, exist_ok=True)
    (apt / 'etc/sources.list').write_text('\n'.join([
        f'deb [arch=amd64 signed-by={keys}/ubuntu.gpg] https://archive.ubuntu.com/ubuntu noble main',
        f'deb [arch=amd64 signed-by={keys}/ubuntu.gpg] https://archive.ubuntu.com/ubuntu noble-updates main',
        f'deb [arch=amd64 signed-by={keys}/ubuntu.gpg] https://security.ubuntu.com/ubuntu noble-security main',
        f'deb [arch=amd64 signed-by={keys}/mariadb.gpg] https://dlm.mariadb.com/repo/mariadb-server/11.4/repo/ubuntu noble main',
    ]) + '\n')
    config = apt / 'apt.conf'
    config.write_text(f'''Dir "{apt}";
Dir::State "{apt}/state";
Dir::State::status "{proof}/runtime-dpkg-status";
Dir::Cache "{apt}/cache";
Dir::Cache::archives "{apt}/cache/archives";
Dir::Etc "{apt}/etc";
Dir::Etc::sourcelist "sources.list";
Dir::Etc::sourceparts "-";
Dir::Etc::parts "-";
Dir::Etc::trusted "-";
Dir::Etc::trustedparts "-";
APT::Architecture "amd64";
APT::Architectures {{ "amd64"; }};
APT::Sandbox::User "root";
Acquire::Languages "none";
Acquire::GzipIndexes "true";
Acquire::AllowInsecureRepositories "false";
Acquire::AllowDowngradeToInsecureRepositories "false";
Acquire::https::Verify-Peer "true";
Acquire::https::Verify-Host "true";
APT::Get::AllowUnauthenticated "false";
''')
    env = dict(os.environ, APT_CONFIG=str(config))
    result = subprocess.run(['apt-get', 'update'], env=env, capture_output=True, text=True, timeout=180)
    (proof / 'apt-update.log').write_text(result.stdout + result.stderr)
    assert result.returncode == 0, result.stdout + result.stderr
    assert not any(x in result.stderr for x in ['NO_PUBKEY', 'not signed', 'Failed to fetch', 'Some index files failed'])
    releases = sorted((apt / 'state/lists').glob('*InRelease'))
    assert len(releases) == 4, [str(p) for p in releases]
    signatures = []
    for release in releases:
        key = keys / ('mariadb.gpg' if 'mariadb' in release.name else 'ubuntu.gpg')
        result = subprocess.run(['gpgv', '--status-fd', '1', '--keyring', str(key), str(release)], capture_output=True, text=True)
        assert result.returncode == 0 and '[GNUPG:] VALIDSIG ' in result.stdout, result.stdout + result.stderr
        shutil.copy2(release, proof / release.name)
        signatures.append({'file': release.name, 'sha256': digest(release), 'keyringSha256': digest(key), 'status': result.stdout})
    (proof / 'release-signatures.json').write_text(json.dumps(signatures, indent=2))
    print(json.dumps({'stage': 'metadata', 'verifiedSignedReleases': len(signatures), 'freeBytes': floor(root), 'privateBytes': sum(p.stat().st_size for p in root.rglob('*') if p.is_file())}), flush=True)

def package(root, spec):
    env = dict(os.environ, APT_CONFIG=str(root / '.apt/apt.conf'))
    text = run(['apt-cache', 'show', spec], env=env)
    stanzas = []
    for stanza in text.split('\n\n'):
        values = {}
        for line in stanza.splitlines():
            if line and not line.startswith(' ') and ': ' in line:
                k, v = line.split(': ', 1)
                values[k] = v
        if 'Package' in values:
            stanzas.append(values)
    if '=' in spec:
        name, version = spec.split('=', 1)
        stanzas = [p for p in stanzas if p['Package'] == name and p['Version'] == version]
    assert stanzas, spec
    item = stanzas[0]
    assert item['Architecture'] in ['amd64', 'all'] and 'SHA256' in item and 'Filename' in item
    return {k: item.get(k) for k in ['Package', 'Version', 'Architecture', 'Depends', 'Installed-Size', 'Size', 'SHA256', 'Filename']}

def plan(root):
    specs = ['mysql-client-core-8.0=' + MYSQL, 'mariadb-client-core=' + MARIA, 'mariadb-client=' + MARIA, 'sqlite3', 'libsqlite3-0', 'mysql-server-core-8.0=' + MYSQL, 'mysql-common', 'mariadb-server-core=' + MARIA, 'mariadb-server=' + MARIA, 'libaio1t64', 'libnuma1', 'liburing2', 'libprotobuf-lite32t64', 'libicu74', 'libpcre2-8-0', 'libreadline8t64', 'libedit2']
    result = []
    for spec in specs:
        try:
            result.append(package(root, spec))
        except Exception as error:
            result.append({'requested': spec, 'error': str(error)})
    (root / 'provenance/package-plan.json').write_text(json.dumps(result, indent=2))
    print(json.dumps({'stage': 'package-plan', 'packages': result, 'freeBytes': floor(root)}), flush=True)

def extract_package(root, spec, vendor):
    floor(root)
    item = package(root, spec)
    downloads = root / '.downloads'
    downloads.mkdir(exist_ok=True)
    archive = next((p for p in downloads.glob('*.deb') if digest(p) == item['SHA256']), None)
    if archive is None:
        env = dict(os.environ, APT_CONFIG=str(root / '.apt/apt.conf'))
        run(['apt-get', 'download', item['Package'] + '=' + item['Version']], cwd=downloads, env=env, timeout=90)
        archive = next((p for p in downloads.glob('*.deb') if digest(p) == item['SHA256']), None)
    assert archive and archive.stat().st_size == int(item['Size']), item
    dest = root / vendor
    dest.mkdir(exist_ok=True)
    run(['dpkg-deb', '--extract', str(archive), str(dest)])
    item.update({'vendorPrefix': vendor, 'downloadVerifiedSha256': digest(archive), 'downloadBytes': archive.stat().st_size})
    ledger = root / 'provenance/extracted-packages.json'
    items = json.loads(ledger.read_text()) if ledger.exists() else []
    items = [p for p in items if (p['Package'], p['Version'], p['vendorPrefix']) != (item['Package'], item['Version'], vendor)] + [item]
    ledger.write_text(json.dumps(items, indent=2))
    return item

def clients(root):
    assert json.loads((root / 'owned.json').read_text())['thread'] == THREAD
    wanted = [('mysql-client-core-8.0=' + MYSQL, 'mysql8'), ('mariadb-client-core=' + MARIA, 'mariadb11'), ('mariadb-client=' + MARIA, 'mariadb11'), ('sqlite3', 'sqlite'), ('libsqlite3-0', 'sqlite')]
    result = [extract_package(root, spec, vendor) for spec, vendor in wanted]
    wrappers(root)
    print(json.dumps({'stage': 'clients-extracted', 'packages': result, 'freeBytes': floor(root), 'prefixBytes': sum(p.stat().st_size for p in root.rglob('*') if p.is_file())}), flush=True)

def wrappers(root):
    (root / 'bin').mkdir(exist_ok=True)
    for binary, vendor in [('mysql', 'mysql8'), ('mysqldump', 'mysql8'), ('mariadb', 'mariadb11'), ('mariadb-dump', 'mariadb11'), ('sqlite3', 'sqlite')]:
        path = root / 'bin' / binary
        assert (root / vendor / 'usr/bin' / binary).is_file(), binary
        path.write_text(f'''#!/bin/sh
# Verified official vendor binary; no MySQL/MariaDB command aliases.
prefix=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
exec /lib64/ld-linux-x86-64.so.2 --library-path "$prefix/{vendor}/usr/lib/x86_64-linux-gnu:$prefix/{vendor}/lib/x86_64-linux-gnu:$prefix/common/usr/lib/x86_64-linux-gnu:$prefix/common/lib/x86_64-linux-gnu" "$prefix/{vendor}/usr/bin/{binary}" "$@"
''')
        path.chmod(0o755)

def library(root, spec):
    item = extract_package(root, spec, 'common')
    print(json.dumps({'stage': 'library', 'package': item, 'freeBytes': floor(root)}), flush=True)

def check_clients(root):
    floor(root)
    script = r'''
const prefix='/opt/steelkeep-sqlclients';const results=[];
for(const [binary,vendor] of [['mysql','mysql8'],['mysqldump','mysql8'],['mariadb','mariadb11'],['mariadb-dump','mariadb11'],['sqlite3','sqlite']]){
 const env={PATH:prefix+'/bin:/usr/bin:/bin',LANG:'C.UTF-8',LC_ALL:'C.UTF-8',TZ:'UTC'};
 const libs=prefix+'/'+vendor+'/usr/lib/x86_64-linux-gnu:'+prefix+'/'+vendor+'/lib/x86_64-linux-gnu:'+prefix+'/common/usr/lib/x86_64-linux-gnu:'+prefix+'/common/lib/x86_64-linux-gnu';
 const list=Bun.spawnSync(['/lib64/ld-linux-x86-64.so.2','--library-path',libs,'--list',prefix+'/'+vendor+'/usr/bin/'+binary],{env});
 const version=Bun.spawnSync(['prlimit','--fsize=16777216','--',binary,'--version'],{env});
 results.push({binary,vendor,loader:{exit:list.exitCode,stdout:list.stdout.toString(),stderr:list.stderr.toString()},version:{exit:version.exitCode,stdout:version.stdout.toString(),stderr:version.stderr.toString()}});
}
console.log(JSON.stringify({uid:process.getuid(),results}));
'''
    command = ['docker', 'run', '--rm', '--label', 'steelkeep.thread=' + THREAD, '--network', 'none', '--user', '10001:10001', '--cpus', '1', '--memory', '256m', '--pids-limit', '64', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--tmpfs', '/tmp:rw,nosuid,nodev,size=32m', '--mount', 'type=bind,src=' + str(root) + ',dst=/opt/steelkeep-sqlclients,readonly', '--entrypoint', '/usr/local/bin/bun', IMAGE, '-e', script]
    result = json.loads(run(command, timeout=45))
    result.update({'runtimeImage': IMAGE, 'network': 'none', 'mountTarget': '/opt/steelkeep-sqlclients', 'passed': all(r['loader']['exit'] == 0 and r['version']['exit'] == 0 for r in result['results'])})
    (root / 'provenance/client-runtime-check.json').write_text(json.dumps(result, indent=2))
    print(json.dumps(result), flush=True)

def fixtures(root):
    wanted = [('mysql-server-core-8.0=' + MYSQL, 'mysql8'), ('mariadb-server-core=' + MARIA, 'mariadb11'), ('mariadb-server=' + MARIA, 'mariadb11'), ('mariadb-common=' + MARIA, 'mariadb11'), ('libmariadb3', 'mariadb11')]
    result = [extract_package(root, spec, vendor) for spec, vendor in wanted]
    for name in ['libaio1t64', 'libnuma1', 'liburing2', 'libprotobuf-lite32t64', 'libmecab2', 'libevent-core-2.1-7t64', 'libevent-pthreads-2.1-7t64', 'libtirpc3t64', 'libgssapi-krb5-2', 'libkrb5-3', 'libk5crypto3', 'libkrb5support0', 'libcom-err2', 'libkeyutils1', 'libsystemd0']:
        result.append(extract_package(root, name, 'common'))
    print(json.dumps({'stage': 'fixture-packages-extracted', 'packages': result, 'freeBytes': floor(root), 'prefixBytes': sum(p.stat().st_size for p in root.rglob('*') if p.is_file())}), flush=True)

def seeds(root):
    source = Path('/opt/steelkeep-platform-checks-20261031/source-ef8bae643ac1')
    dest = root / 'fixtures'
    dest.mkdir(exist_ok=True)
    mysql = (source / 'infra/mysql8-fixture.sql').read_text() + r'''
CREATE DATABASE restore_mysql8_mcp CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE USER 'mcp_restore'@'%' IDENTIFIED WITH caching_sha2_password BY 'synthetic-mysql8-mcp-writer';
GRANT SELECT, INSERT, CREATE, ALTER, INDEX, REFERENCES, SHOW VIEW, TRIGGER, EVENT, EXECUTE, LOCK TABLES ON `restore\_mysql8\_mcp`.* TO 'mcp_restore'@'%';
'''
    maria = 'SET NAMES utf8mb4;\n' + (source / 'infra/mysql-fixture.sql').read_text() + r'''
ALTER TABLE source_mysql.entries ADD COLUMN binary_value VARBINARY(16) NULL, ADD COLUMN optional_text VARCHAR(32) NULL;
UPDATE source_mysql.entries SET binary_value=X'00FF7F0041' WHERE id=1;
INSERT INTO source_mysql.projects(name) VALUES('Unicode проект 🚀');
INSERT INTO source_mysql.entries(project_id,body,amount,binary_value,optional_text) VALUES(2,'Русский текст, café, 🚀',4.25,X'FF00800102','');
ALTER TABLE source_mysql.projects AUTO_INCREMENT=51;
CREATE DATABASE restore_mariadb11_mcp;
CREATE USER 'mcp_restore'@'%' IDENTIFIED BY 'synthetic-mariadb11-mcp-writer';
GRANT SELECT, INSERT, CREATE, ALTER, INDEX, REFERENCES, SHOW VIEW, TRIGGER, EVENT, EXECUTE, LOCK TABLES ON `restore\_mariadb11\_mcp`.* TO 'mcp_restore'@'%';
'''
    for engine, text in [('mysql', mysql), ('mariadb', maria)]:
        (dest / (engine + '.sql')).write_text(text)
    descriptor = {'purpose': 'synthetic-only', 'nonce': '14bafed8114d2c726a31e7040b155f28', 'image': IMAGE, 'hostPorts': [], 'data': '256MiB tmpfs, destroyed with owned fixture container', 'fixtures': {
        'mysql': {'container': 'steelkeep-sqlclients-mysql8-fixture', 'host': 'sqlclients-mysql8', 'version': MYSQL, 'source': 'source_mysql8', 'directTarget': 'restore_mysql8', 'mcpTarget': 'restore_mysql8_mcp', 'reader': 'backup_reader', 'readerPassword': 'local-mysql8-reader-only', 'directWriter': 'restore_writer', 'directPassword': 'local-mysql8-writer-only', 'mcpWriter': 'mcp_restore', 'mcpPassword': 'synthetic-mysql8-mcp-writer'},
        'mariadb': {'container': 'steelkeep-sqlclients-mariadb11-fixture', 'host': 'sqlclients-mariadb11', 'version': MARIA, 'source': 'source_mysql', 'directTarget': 'restore_mysql', 'mcpTarget': 'restore_mariadb11_mcp', 'reader': 'backup_reader', 'readerPassword': 'local-mysql-reader-only', 'directWriter': 'restore_writer', 'directPassword': 'local-mysql-writer-only', 'mcpWriter': 'mcp_restore', 'mcpPassword': 'synthetic-mariadb11-mcp-writer'},
    }}
    (root / 'provenance/fixture-descriptors.json').write_text(json.dumps(descriptor, indent=2))

def fixture_start(root, engine):
    assert engine in ['mysql', 'mariadb']
    floor(root)
    core = Path('/opt/steelkeep-runtime-core-20261031')
    assert json.loads((core / 'stand.json').read_text())['nonce'] == '14bafed8114d2c726a31e7040b155f28'
    seeds(root)
    descriptor = json.loads((root / 'provenance/fixture-descriptors.json').read_text())['fixtures']
    for item in descriptor.values():
        assert subprocess.run(['docker', 'inspect', item['container']], capture_output=True).returncode != 0, 'SQL fixtures must be sequential and explicitly cleaned'
    item = descriptor[engine]
    script = Path('/opt/steelkeep-platform-checks-20261031/browser-tooling/server-runtime-sqlclients.fixture.sh')
    command = ['docker', 'run', '-d', '--name', item['container'], '--label', 'steelkeep.thread=' + THREAD, '--label', 'steelkeep.purpose=sqlclients-synthetic-fixture', '--label', 'steelkeep.nonce=14bafed8114d2c726a31e7040b155f28', '--network', 'steelkeep-runtime-core_default', '--network-alias', item['host'], '--user', '10001:10001', '--cpus', '1', '--memory', '1536m', '--memory-swap', '1536m', '--pids-limit', '256', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--tmpfs', '/data:rw,nosuid,nodev,size=256m,uid=10001,gid=10001,mode=0700', '--tmpfs', '/tmp:rw,nosuid,nodev,size=128m,uid=10001,gid=10001,mode=1777', '--env', 'HOME=/tmp', '--env', 'LANG=C.UTF-8', '--env', 'LC_ALL=C.UTF-8', '--env', 'TZ=UTC', '--env', 'STEELKEEP_SQLCLIENTS_FIXTURE=synthetic-core-14bafed8114d2c726a31e7040b155f28', '--mount', 'type=bind,src=' + str(root) + ',dst=/opt/steelkeep-sqlclients,readonly', '--mount', 'type=bind,src=' + str(root / 'fixtures') + ',dst=/fixtures,readonly', '--mount', 'type=bind,src=' + str(script) + ',dst=/fixture.sh,readonly', '--entrypoint', '/bin/sh', IMAGE, '/fixture.sh', engine]
    print(json.dumps({'stage': 'fixture-started', 'engine': engine, 'host': item['host'], 'container': item['container'], 'id': run(command).strip(), 'freeBytes': floor(root)}), flush=True)

def fixture_stop(root, engine):
    descriptor = json.loads((root / 'provenance/fixture-descriptors.json').read_text())['fixtures'][engine]
    name = descriptor['container']
    state = json.loads(run(['docker', 'inspect', name]))[0]
    assert state['Config']['Labels']['steelkeep.thread'] == THREAD and state['Config']['Labels']['steelkeep.nonce'] == '14bafed8114d2c726a31e7040b155f28'
    if state['State']['Running']:
        run(['docker', 'stop', '--time', '20', name], timeout=30)
    (root / 'provenance' / (engine + '-fixture.log')).write_text(run(['docker', 'logs', name]))
    (root / 'provenance' / (engine + '-fixture-state.json')).write_text(run(['docker', 'inspect', '--format', '{{json .State}}', name]))
    run(['docker', 'rm', name])
    print(json.dumps({'stage': 'fixture-removed', 'engine': engine, 'freeBytes': floor(root)}), flush=True)

def cleanup_servers(root):
    assert json.loads((root / 'owned.json').read_text())['thread'] == THREAD
    for name in ['steelkeep-sqlclients-mysql8-fixture', 'steelkeep-sqlclients-mariadb11-fixture']:
        assert subprocess.run(['docker', 'inspect', name], capture_output=True).returncode != 0, 'Remove owned fixtures before pruning server-only files'
    ledger = json.loads((root / 'provenance/extracted-packages.json').read_text())
    archives = {digest(p): p for p in (root / '.downloads').glob('*.deb')}
    server_packages = {'mysql-server-core-8.0', 'mariadb-server-core', 'mariadb-server'}
    protected, server_files, server_archives = set(), set(), set()
    for item in ledger:
        archive = archives[item['downloadVerifiedSha256']]
        process = subprocess.Popen(['dpkg-deb', '--fsys-tarfile', str(archive)], stdout=subprocess.PIPE)
        paths = set()
        with tarfile.open(fileobj=process.stdout, mode='r|') as stream:
            for member in stream:
                if not (member.isfile() or member.issym() or member.islnk()):
                    continue
                relative = Path(member.name.removeprefix('./'))
                assert not relative.is_absolute() and '..' not in relative.parts
                paths.add(root / item['vendorPrefix'] / relative)
        assert process.wait() == 0
        if item['Package'] in server_packages:
            server_files.update(paths)
            server_archives.add(archive)
        else:
            protected.update(paths)
    removed, bytes_removed = [], 0
    for path in sorted(server_files - protected):
        assert root.resolve() in path.parent.resolve().parents or path.parent.resolve() == root.resolve()
        if path.is_symlink() or path.is_file():
            bytes_removed += path.lstat().st_size
            path.unlink()
            removed.append(str(path.relative_to(root)))
    for path in server_archives:
        bytes_removed += path.stat().st_size
        path.unlink()
    hashes = {}
    for binary, vendor in [('mysql', 'mysql8'), ('mysqldump', 'mysql8'), ('mariadb', 'mariadb11'), ('mariadb-dump', 'mariadb11'), ('sqlite3', 'sqlite')]:
        elf = root / vendor / 'usr/bin' / binary
        wrapper = root / 'bin' / binary
        assert elf.is_file() and wrapper.is_file()
        hashes[binary] = {'vendor': vendor, 'elfSha256': digest(elf), 'wrapperSha256': digest(wrapper), 'elfBytes': elf.stat().st_size}
    result = {'serverOnlyFilesRemoved': removed, 'serverPackageArchivesRemoved': len(server_archives), 'bytesRemoved': bytes_removed, 'clientFilesProtectedByPackageInventory': len(protected), 'nativeClients': hashes, 'remainingPrefixBytes': sum(p.stat().st_size for p in root.rglob('*') if p.is_file()), 'freeBytes': floor(root)}
    (root / 'provenance/server-cleanup.json').write_text(json.dumps(result, indent=2))
    print(json.dumps({k: v for k, v in result.items() if k != 'serverOnlyFilesRemoved'}), flush=True)

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, default=Path('/opt/steelkeep/native-sqlclients'))
    parser.add_argument('stage', choices=['metadata', 'plan', 'clients', 'library', 'wrappers', 'check', 'fixtures', 'fixture-start', 'fixture-stop', 'cleanup-servers'])
    parser.add_argument('--package')
    parser.add_argument('--engine', choices=['mysql', 'mariadb'])
    args = parser.parse_args()
    assert str(args.root) == '/opt/steelkeep/native-sqlclients', 'Use only the owned server prefix'
    if args.stage == 'metadata':
        metadata(args.root)
    elif args.stage == 'plan':
        plan(args.root)
    elif args.stage == 'clients':
        clients(args.root)
    elif args.stage == 'wrappers':
        wrappers(args.root)
    elif args.stage == 'check':
        check_clients(args.root)
    elif args.stage == 'fixtures':
        fixtures(args.root)
    elif args.stage == 'fixture-start':
        fixture_start(args.root, args.engine)
    elif args.stage == 'fixture-stop':
        fixture_stop(args.root, args.engine)
    elif args.stage == 'cleanup-servers':
        cleanup_servers(args.root)
    else:
        assert args.package
        library(args.root, args.package)
