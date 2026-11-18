"""Generates the release manifest + SHA-256 checksum file from the ACTUAL release ZIP (never from the working tree).
Usage: python scripts/generate-manifest.py [path/to/release.zip]
Default: release/autotask-ai-v<package.json version without .N>.zip  (v1.1.7-rc -> release/autotask-ai-v1.1.7-rc.zip)
Outputs: <zip>.sha256 ("<hash> *<name>") and <zip without .zip>.manifest.json
"""
import hashlib, json, os, re, sys, zipfile, datetime

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
FORBIDDEN = [r'(^|/)\.private(/|$)', r'(^|/)node_modules(/|$)', r'(^|/)dist(/|$)', r'(^|/)\.git(/|$)', r'(^|/)reports(/|$)',
             r'(^|/)artifacts(/|$)', r'(^|/)__pycache__(/|$)', r'\.pyc$', r'(^|/)\.env', r'\.pem$', r'\.zip$', r'(^|/)chromium-profile(/|$)']
BASELINE = 'release/autotask-ai-v1.1.6-ai-primary-advanced-moodle-candidate.zip'
BASELINE_SHA = 'f0017eb7b27331ca20e5844efbc8d0b2a88e56a33d01fb3c46b21fbf16d91481'


def main():
    pkg = json.load(open(os.path.join(ROOT, 'package.json'), encoding='utf-8'))
    base_version = re.sub(r'\.\d+$', '', pkg['version'])
    candidates = [
        'release/autotask-ai-v' + pkg['version'] + '.zip',
        'release/autotask-ai-v' + base_version + '.zip'
    ]
    default = next((c for c in candidates if os.path.isfile(os.path.join(ROOT, c))), candidates[0])
    zip_path = os.path.abspath(os.path.join(ROOT, sys.argv[1] if len(sys.argv) > 1 else default))
    if not os.path.isfile(zip_path):
        print(f'ERROR: release zip not found: {zip_path}'); sys.exit(1)
    data = open(zip_path, 'rb').read()
    sha = hashlib.sha256(data).hexdigest()
    zf = zipfile.ZipFile(zip_path)
    bad_crc = zf.testzip()
    entries = []
    for info in sorted(zf.infolist(), key=lambda i: i.filename):
        if info.filename.endswith('/'):
            continue
        entries.append({'path': info.filename, 'size': info.file_size, 'crc32': f'{info.CRC:08x}', 'sha256': hashlib.sha256(zf.read(info.filename)).hexdigest()})
    backslashes = [e['path'] for e in entries if '\\' in e['path']]
    forbidden = [e['path'] for e in entries if any(re.search(p, e['path']) for p in FORBIDDEN)]
    manifest = {
        'archive': os.path.basename(zip_path), 'version': pkg['version'], 'archiveSize': len(data), 'archiveSha256': sha,
        'entryCount': len(entries), 'generatedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'baselineLocked': {'archive': os.path.basename(BASELINE), 'sha256': BASELINE_SHA, 'note': 'v1.1.6 candidate kept unmodified for comparison; its checksum is NOT reused'},
        'checks': {'zipCrc': 'PASS' if bad_crc is None else f'FAIL ({bad_crc})', 'backslashPaths': backslashes, 'forbiddenEntries': forbidden},
        'entries': entries,
    }
    base = os.path.splitext(zip_path)[0]
    json.dump(manifest, open(base + '.manifest.json', 'w', encoding='utf-8', newline='\n'), indent=2)
    open(zip_path + '.sha256', 'w', encoding='ascii', newline='\n').write(f'{sha} *{os.path.basename(zip_path)}\n')
    print(f'archive={zip_path}\nsha256={sha}\nsize={len(data)}\nentries={len(entries)}\nforbidden={len(forbidden)} backslash={len(backslashes)} crc={manifest["checks"]["zipCrc"]}')
    sys.exit(0 if (not forbidden and not backslashes and bad_crc is None) else 2)


if __name__ == '__main__':
    main()
