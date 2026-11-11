from pathlib import Path
import base64
import gzip
import hashlib
import json
import os

output = Path(os.environ['OO_E2E_OUTPUT'])
output.mkdir(parents=True, exist_ok=True)
transport = ''.join(p.read_text().strip() for p in sorted(Path('audit').glob('patch-*.b64')))
repairs = Path('audit/transport-repairs.json')
if repairs.exists():
    for repair in json.loads(repairs.read_text()):
        start, end = repair['start'], repair['end']
        assert hashlib.sha256(transport[start:end].encode()).hexdigest() == repair['old_sha256']
        transport = transport[:start] + repair['new'] + transport[end:]
patch = gzip.decompress(base64.b64decode(transport, validate=True))
digest = hashlib.sha256(patch).hexdigest()
assert digest == '624a596be8945ec7831411518de09c79a837c8e74a848bb37759be887bc4cc9c'
(output / 'patch-sha256.txt').write_text(digest)
Path(os.environ['RUNNER_TEMP'], 'stability.patch').write_bytes(patch)
