"""Capture or verify a local, uncommitted Brick 3/4 source candidate."""

import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import zipfile


ROOT = Path(__file__).resolve().parents[1]
LOCAL = ROOT / '.local'


def git(*args, cwd=ROOT):
    return subprocess.run(['git', '--no-optional-locks', *args], cwd=cwd,
                          capture_output=True, check=True).stdout.decode('utf-8')


def digest(data):
    return hashlib.sha256(data).hexdigest()


def source_inventory(cwd=ROOT):
    entries = git('status', '--porcelain=v1', '-z', '--untracked-files=all', cwd=cwd).split('\0')
    changes = {}
    for entry in filter(None, entries):
        status, name = entry[:2], entry[3:]
        if status not in {' M', '??'}:
            raise ValueError('Staged changes, removals and renames require a separate inventory review')
        changes[name] = status
    tracked = set(git('ls-files', '-z', '--cached', cwd=cwd).split('\0')) - {''}
    names = sorted(tracked | set(changes))
    return changes, names


def read_source(name, root=ROOT):
    path = root / name
    if path.is_symlink() or not path.resolve().is_relative_to(root) or not path.is_file():
        raise ValueError(f'Invalid source member: {name}')
    return path.read_bytes()


def worktree_inventory(records, head):
    for record in git('worktree', 'list', '--porcelain', '-z').split('\0\0'):
        fields = dict(field.partition(' ')[::2] for field in record.split('\0') if field)
        if 'worktree' not in fields:
            continue
        root = Path(fields['worktree']).resolve()
        if root == ROOT:
            continue
        worktree_head = fields['HEAD']
        behind, ahead = (int(count) for count in git('rev-list', '--left-right', '--count',
                                                     f'{head}...{worktree_head}').split())
        item = {'worktree': str(root), 'branch': fields.get('branch'), 'head': worktree_head,
                'behind': behind, 'ahead': ahead}
        try:
            changes, _ = source_inventory(root)
        except (subprocess.CalledProcessError, ValueError):
            yield {**item, 'status': 'UNVERIFIED'}
            continue
        compared = {}
        for name in changes:
            if name not in records:
                compared[name] = 'SIBLING_ONLY'
            else:
                try:
                    compared[name] = 'MATCHES' if digest(read_source(name, root)) == records[name]['sha256'] else 'DIVERGES'
                except (OSError, ValueError):
                    compared[name] = 'UNVERIFIED'
        yield {**item, 'status': 'OBSERVED', 'changes': compared}


def evidence_inventory(paths):
    records = {}
    for path in paths:
        resolved = path.resolve()
        if path.is_symlink() or not resolved.is_relative_to(LOCAL) or not resolved.is_file():
            raise ValueError('Evidence must be a file within repository .local')
        contents = resolved.read_bytes()
        records[resolved.relative_to(ROOT).as_posix()] = {'bytes': len(contents), 'sha256': digest(contents)}
    return records


def capture(include_worktrees, evidence):
    changes, names = source_inventory()
    head = git('rev-parse', 'HEAD').strip()
    branch = git('branch', '--show-current').strip()
    generated = git('ls-files', '-z', '-o', '-i', '--exclude-standard', '--',
                    ':(glob)apps/*/dist/**', ':(glob)apps/*/dist-test/**',
                    ':(glob)packages/*/dist/**', ':(glob)packages/*/dist-test/**',
                    ':(glob)apps/ai-service/src/**/__pycache__/**',
                    ':(glob)apps/ai-service/tests/**/__pycache__/**',
                    'packages/provider-contracts/src').split('\0')
    LOCAL.mkdir(exist_ok=True)
    if LOCAL.resolve() != LOCAL:
        raise ValueError('Candidate directory must be local to this repository')
    folder = Path(tempfile.mkdtemp(prefix='brick34-source-', dir=LOCAL))
    print(folder, flush=True)
    records = {}
    with zipfile.ZipFile(folder / 'source.zip', 'x', zipfile.ZIP_DEFLATED) as archive:
        for name in names:
            contents = read_source(name)
            records[name] = {'sha256': digest(contents), 'bytes': len(contents),
                             'status': changes.get(name, 'tracked')}
            item = zipfile.ZipInfo(name)
            archive.writestr(item, contents, compress_type=zipfile.ZIP_DEFLATED)
    (folder / 'manifest.json').write_text(json.dumps({
        'branch': branch, 'head': head, 'files': records,
        'archiveSha256': digest((folder / 'source.zip').read_bytes()),
        'generatedIgnoredPaths': sorted(filter(None, set(generated))),
        'worktrees': list(worktree_inventory(records, head)) if include_worktrees else [],
        'evidence': evidence_inventory(evidence),
    }, indent=2) + '\n', encoding='utf-8')
    verify(folder / 'manifest.json')


def verify(manifest, integrated=False):
    candidate = json.loads(manifest.read_text(encoding='utf-8'))
    changes, names = source_inventory()
    records = candidate['files']
    expected_git_state = not changes if integrated else candidate['head'] == git('rev-parse', 'HEAD').strip()
    if names != sorted(records) or not expected_git_state:
        raise ValueError('Candidate source inventory or base commit changed')
    archive_path = manifest.with_name('source.zip')
    if digest(archive_path.read_bytes()) != candidate['archiveSha256']:
        raise ValueError('Candidate archive digest differs')
    with zipfile.ZipFile(archive_path) as archive:
        if archive.namelist() != names:
            raise ValueError('Candidate archive inventory differs')
        for name in names:
            contents = read_source(name)
            record = records[name]
            if (record['sha256'] != digest(contents) or record['bytes'] != len(contents)
                    or (not integrated and record['status'] != changes.get(name, 'tracked'))
                    or archive.read(name) != contents):
                raise ValueError(f'Candidate bytes or Git status differ: {name}')
    evidence = candidate.get('evidence', {})
    if evidence_inventory([ROOT / name for name in evidence]) != evidence:
        raise ValueError('Candidate verification evidence differs')
    print(f'Verified {len(names)} source files and {len(changes)} individual changes against the archive.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--verify', type=Path, metavar='MANIFEST')
    parser.add_argument('--integrated', action='store_true', help='Verify identical bytes in a clean Git worktree')
    parser.add_argument('--compare-worktrees', action='store_true', help='Classify sibling changes without changing Git state')
    parser.add_argument('--evidence', type=Path, action='append', default=[], metavar='FILE')
    options = parser.parse_args()
    if options.verify:
        if options.compare_worktrees or options.evidence:
            parser.error('Worktree comparison and evidence inputs apply to capture only')
        verify(options.verify, options.integrated)
    else:
        if options.integrated:
            parser.error('--integrated requires --verify')
        capture(options.compare_worktrees, options.evidence)
