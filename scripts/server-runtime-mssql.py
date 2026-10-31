"""One synthetic current-backend MSSQL proof on A; preserves all archives, databases and holds."""
import hashlib
import json
import os
import pathlib
import secrets
import shutil
import subprocess
import threading
import time

ROOT = pathlib.Path('/opt/steelkeep-mssql-runtime-20261031')
SOURCE = pathlib.Path('/opt/steelkeep/releases/ef8bae643ac1')
OLD = pathlib.Path('/opt/steelkeep-mssql-proof-20261031/.steelkeep/mssql-proof')
RUNTIME = 'sha256:cf3d84df5261bc00b40e907f6ca431c1f589662f041755f18b15dbf986d69b6d'
NETWORK = 'steelkeep-mssql-proof_proof'
METADATA = 'steelkeep-mssql-proof-metadata-1'
SQL_OLD = 'steelkeep-mssql-proof-mssql-fixture-1'
DATABASE = 'steelkeep_mssql_runtime_20261031'
PURPOSE = 'steelkeep-mssql-runtime-proof'
SOFT = 8858370048
names = []
done = threading.Event()
minimum = shutil.disk_usage('/opt').free
soft_stop = False


def output(args, **kwargs):
    return subprocess.check_output(args, text=True, **kwargs).strip()


def inspect(name):
    return json.loads(output(['docker', 'inspect', name]))[0]


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def psql(text, database='steelkeep_mssql_proof'):
    return output(['docker', 'exec', '-i', METADATA, 'psql', '-U', 'steelkeep', '-d', database,
                   '-Atq', '-v', 'ON_ERROR_STOP=1'], input=text)


def private(path, data):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'wb') as file:
        file.write(data)
    os.chown(path, 10001, 10001)


def disk_guard():
    global minimum, soft_stop
    while not done.wait(1):
        minimum = min(minimum, shutil.disk_usage('/opt').free)
        if minimum < SOFT:
            soft_stop = True
            for name in list(names):
                subprocess.run(['docker', 'stop', '-t', '5', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            break


def common(name, worker=False, runner=False):
    args = ['docker', 'run', '--name', name, '--pull', 'never', '--network', NETWORK,
            '--label', 'steelkeep.purpose=' + PURPOSE, '--user', '10001:10001', '--read-only',
            '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '1g',
            '--memory-swap', '1g', '--cpus', '1', '--pids-limit', '256', '--workdir', '/work',
            '--env-file', str(ROOT / 'private/app.env'), '--log-opt', 'max-size=5m', '--log-opt', 'max-file=2']
    mounts = [(SOURCE, '/work'),
              (pathlib.Path('/opt/steelkeep-platform-checks-20261031/tooling/nodemailer'), '/app/node_modules/nodemailer'),
              (pathlib.Path('/opt/steelkeep-platform-checks-20261031/tooling/passwd'), '/etc/passwd'),
              (pathlib.Path('/opt/steelkeep-platform-checks-20261031/tooling/group'), '/etc/group'),
              (pathlib.Path('/opt/steelkeep/native-mssql/Steelkeep.DacFx.dll'), '/opt/steelkeep-dacfx/Steelkeep.DacFx.dll')]
    for item in ['key', 'token']:
        mounts.append((ROOT / 'private' / item, '/run/steelkeep/' + item))
    if runner:
        for item in ['runtime-nonce', 'old-proof-nonce', 'mssql-sa-password']:
            mounts.append((ROOT / 'private' / item, '/run/steelkeep/' + item))
        mounts.append((ROOT / 'server-runtime-mssql.proof.ts', '/work/scripts/seed-mssql-fixture.ts'))
    for source, target in mounts:
        args += ['--mount', f'type=bind,src={source},dst={target},readonly']
    if worker:
        args += ['--mount', f'type=bind,src={ROOT}/scratch,dst=/tmp']
    else:
        args += ['--tmpfs', '/tmp:rw,nosuid,nodev,size=128m,mode=1777']
    if runner:
        args += ['--mount', f'type=bind,src={ROOT}/state,dst=/run/steelkeep-proof', '-e', 'STEELKEEP_MSSQL_RUNTIME=synthetic-ef8b']
    return args


def foreground(name, args, timeout):
    names.append(name)
    with (ROOT / (name + '.log')).open('x') as log:
        outcome = subprocess.run(args, stdout=log, stderr=subprocess.STDOUT, timeout=timeout)
    facts = inspect(name)
    record = {'name': name, 'exitCode': facts['State']['ExitCode'], 'oomKilled': facts['State']['OOMKilled']}
    (ROOT / (name + '.json')).write_text(json.dumps(record))
    print(json.dumps(record), flush=True)
    if outcome.returncode or record['oomKilled'] or soft_stop:
        raise RuntimeError('Stopped at a real proof failure; preserve state and never replay a restore.')


assert minimum >= SOFT
assert ROOT.is_dir() and not (ROOT / 'private').exists()
snapshot = json.loads((SOURCE / 'source-snapshot.json').read_text())
assert snapshot['snapshot'] == 'ef8bae643ac1f87a2b19193db74ca9a91ddb112401872670905b23f7d7ad7cb8'
for relative, digest in snapshot['files'].items():
    assert sha(SOURCE / relative) == digest, 'Immutable product source drift'
assert sha(SOURCE / 'tools/Steelkeep.DacFx/Program.cs') == '2b4e3dcc365f34e1e475be08357650a97d6cb84a9514c0963272915b93c3c7e7'
assert sha(pathlib.Path('/opt/steelkeep/native-mssql/Steelkeep.DacFx.dll')) == 'df38390e28016e772ae8032c57fa739c5455c308091cf9634850658e4afa5bf3'
old = inspect(SQL_OLD)
assert old['State']['Status'] == 'exited'
assert old['Config']['Labels']['purpose'] == 'steelkeep-mssql-native-proof'
assert old['Config']['Labels']['com.docker.compose.project'] == 'steelkeep-mssql-proof'
assert inspect(METADATA)['State']['Status'] == 'running'
assert inspect('steelkeep-mssql-proof-s3-1')['State']['Status'] == 'running'
assert json.loads(output(['docker', 'network', 'inspect', NETWORK]))[0]['Internal']
volume = [mount['Name'] for mount in old['Mounts'] if mount['Destination'] == '/var/opt/mssql']
assert volume == ['steelkeep-mssql-proof_sql-data']
old_nonce = (OLD / 'proof-nonce').read_text().strip()
assert old['Config']['Labels']['org.steelkeep.proof.nonce'] == old_nonce
assert psql("SELECT nonce='" + old_nonce + "' AND singleton FROM steelkeep_mssql_proof_identity;") == 't'
assert psql("SELECT count(*) FROM pg_database WHERE datname='" + DATABASE + "';") == '0'
for folder in ['private', 'state', 'scratch']:
    (ROOT / folder).mkdir(mode=0o700)
    if folder != 'private':
        os.chown(ROOT / folder, 10001, 10001)
nonce = secrets.token_hex(32)
private(ROOT / 'private/key', secrets.token_bytes(32))
private(ROOT / 'private/token', secrets.token_hex(32).encode())
private(ROOT / 'private/runtime-nonce', nonce.encode())
private(ROOT / 'private/old-proof-nonce', old_nonce.encode())
password = (OLD / 'mssql-sa-password').read_bytes().strip()
private(ROOT / 'private/mssql-sa-password', password)
app_env = '\n'.join(['DATABASE_URL=postgres://steelkeep:local-metadata-only@metadata:5432/' + DATABASE,
                     'STEELKEEP_DATABASE_PASSWORD_FILE=', 'STEELKEEP_KEY_FILE=/run/steelkeep/key',
                     'STEELKEEP_TOKEN_FILE=/run/steelkeep/token', 'STEELKEEP_ALLOWED_HOSTS=mssql-runtime,s3,metadata',
                     'STEELKEEP_PUBLIC_HOSTS=mssql-runtime-api,127.0.0.1,localhost', 'STEELKEEP_ALLOWED_ORIGINS=http://127.0.0.1',
                     'STEELKEEP_DACFX_HELPER=/opt/steelkeep-dacfx/Steelkeep.DacFx.dll', 'HOST=0.0.0.0', 'PORT=4311',
                     'STEELKEEP_SECURE_COOKIE=false']) + '\n'
private(ROOT / 'private/app.env', app_env.encode())
private(ROOT / 'private/sql.env', b'ACCEPT_EULA=Y\nMSSQL_PID=Developer\nMSSQL_MEMORY_LIMIT_MB=2048\nMSSQL_SA_PASSWORD=' + password + b'\n')
(ROOT / 'provenance.json').write_text(json.dumps({'productSnapshot': snapshot['snapshot'], 'gitHead': snapshot['gitHead'],
    'runtimeImage': RUNTIME, 'sqlImage': old['Image'], 'helperSha256': sha(pathlib.Path('/opt/steelkeep/native-mssql/Steelkeep.DacFx.dll')),
    'proofScriptSha256': sha(ROOT / 'server-runtime-mssql.proof.ts'), 'oldSqlContainerUnchanged': True, 'freshMetadataDatabase': DATABASE}, indent=2))
threading.Thread(target=disk_guard, daemon=True).start()
try:
    name = 'steelkeep-mssql-runtime-syntax'
    syntax = common(name, runner=True) + [RUNTIME, 'bun', 'build', 'scripts/seed-mssql-fixture.ts', '--target', 'bun', '--external', '*', '--outfile', '/tmp/proof.js']
    foreground(name, syntax, 30)
    psql('CREATE DATABASE ' + DATABASE + ';')
    name = 'steelkeep-mssql-runtime-migrate'
    foreground(name, common(name) + [RUNTIME, 'bun', 'server/migrate.ts'], 150)
    psql("CREATE TABLE steelkeep_runtime_mssql_identity(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),nonce text NOT NULL);INSERT INTO steelkeep_runtime_mssql_identity(nonce) VALUES('" + nonce + "');", DATABASE)
    assert shutil.disk_usage('/opt').free >= SOFT
    name = 'steelkeep-mssql-runtime-sql'
    names.append(name)
    subprocess.run(['docker', 'run', '-d', '--name', name, '--pull', 'never', '--network', NETWORK,
        '--network-alias', 'mssql-runtime', '--hostname', old['Config']['Hostname'], '--label', 'steelkeep.purpose=' + PURPOSE,
        '--memory', '2560m', '--memory-swap', '2560m', '--cpus', '2', '--pids-limit', '512',
        '--env-file', str(ROOT / 'private/sql.env'), '--mount', 'type=volume,src=' + volume[0] + ',dst=/var/opt/mssql',
        '--log-opt', 'max-size=5m', '--log-opt', 'max-file=2', old['Image']], check=True, stdout=subprocess.DEVNULL)
    for role in ['api', 'worker']:
        name = 'steelkeep-mssql-runtime-' + role
        names.append(name)
        args = common(name, worker=role == 'worker')
        args.insert(2, '-d')
        if role == 'api':
            args += ['--network-alias', 'mssql-runtime-api']
        subprocess.run(args + [RUNTIME, 'bun', 'server/' + ('index.ts' if role == 'api' else 'worker.ts')], check=True, stdout=subprocess.DEVNULL)
    for _ in range(60):
        ready = subprocess.run(['docker', 'exec', 'steelkeep-mssql-runtime-api', 'bun', '-e', "const r=await fetch('http://127.0.0.1:4311/api/v1/health');if(!r.ok)process.exit(1)"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if ready.returncode == 0:
            break
        time.sleep(1)
    else:
        raise RuntimeError('API startup failed; preserve logs')
    name = 'steelkeep-mssql-runtime-runner'
    foreground(name, common(name, runner=True) + [RUNTIME, 'bun', 'scripts/seed-mssql-fixture.ts'], 570)
finally:
    done.set()
    for name in reversed(names):
        facts = inspect(name)
        assert facts['Config']['Labels']['steelkeep.purpose'] == PURPOSE
        if facts['State']['Running']:
            subprocess.run(['docker', 'stop', '-t', '30', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        facts = inspect(name)
        (ROOT / (name + '-final.json')).write_text(json.dumps({'exitCode': facts['State']['ExitCode'], 'oomKilled': facts['State']['OOMKilled'], 'memory': facts['HostConfig']['Memory'], 'nanoCpus': facts['HostConfig']['NanoCpus']}))
        with (ROOT / (name + '-final.log')).open('x') as log:
            subprocess.run(['docker', 'logs', name], stdout=log, stderr=subprocess.STDOUT)
        subprocess.run(['docker', 'rm', name], check=True, stdout=subprocess.DEVNULL)
    for relative, digest in snapshot['files'].items():
        assert sha(SOURCE / relative) == digest, 'Product source changed during the proof'
    resources = {'minimumAvailableBytes': minimum, 'availableBytesAfter': shutil.disk_usage('/opt').free, 'softStop': soft_stop,
                 'oldSqlContainerStatus': inspect(SQL_OLD)['State']['Status'], 'metadataAndS3Preserved': True, 'nativeDataVolumesRemoved': False}
    (ROOT / 'resources.json').write_text(json.dumps(resources, indent=2))
    print(json.dumps(resources), flush=True)
