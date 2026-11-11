from pathlib import Path
import base64
import gzip
import hashlib
import json
import os

output = Path(os.environ['OO_E2E_OUTPUT'])
output.mkdir(parents=True, exist_ok=True)
transport = ''.join(p.read_text().strip() for p in sorted(Path('audit').glob('patch-*.b64')))
(output / 'transport.b64').write_text(transport)
repairs = Path('audit/transport-repairs.json')
if repairs.exists():
    for repair in json.loads(repairs.read_text()):
        start, end = repair['start'], repair['end']
        assert transport[start:end] == repair['old']
        transport = transport[:start] + repair['new'] + transport[end:]
patch = gzip.decompress(base64.b64decode(transport, validate=True))
assert hashlib.sha256(patch).hexdigest() == '624a596be8945ec7831411518de09c79a837c8e74a848bb37759be887bc4cc9c'
Path(os.environ['RUNNER_TEMP'], 'stability.patch').write_bytes(patch)
