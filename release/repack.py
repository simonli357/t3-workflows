"""The existing custom-release ASAR repack: replace dist, retain native entries."""
import copy
import hashlib
import json
from pathlib import Path
import struct


def repack(old, target, version, dist=None):
    with Path(old).open('rb') as source:
        words = struct.unpack('<4I', source.read(16))
        original = json.loads(source.read(words[3]))
        start = 8 + words[1]
        header = copy.deepcopy(original)
        bodies = {}

        def walk(tree, prefix=''):
            for name, entry in tree['files'].items():
                key = prefix + name
                if 'files' in entry:
                    yield from walk(entry, key + '/')
                else:
                    yield key, entry

        def replace(tree, name, data):
            tree['files'][name] = {'size': len(data), 'offset': '0', 'integrity': {
                'algorithm': 'SHA256', 'hash': hashlib.sha256(data).hexdigest(),
                'blockSize': 4194304, 'blocks': [hashlib.sha256(data[i:i+4194304]).hexdigest()
                                               for i in range(0, len(data), 4194304)]}}
        for key, entry in walk(original):
            if 'offset' in entry:
                bodies[key] = (int(entry['offset']), entry['size'])
        package = original['files']['package.json']
        source.seek(start + int(package['offset']))
        manifest = json.loads(source.read(package['size']))
        manifest['version'] = version
        if dist is None:
            manifest['buildVersion'] = version
        data = (json.dumps(manifest, indent=2) + '\n').encode()
        bodies['package.json'] = data
        replace(header, 'package.json', data)
        if dist is not None:
            tree = {'files': {}}
            for file in sorted(Path(dist).rglob('*')):
                if file.is_symlink():
                    raise RuntimeError('Unexpected symlink in server dist: ' + str(file))
                if not file.is_file():
                    continue
                relative = file.relative_to(dist)
                parent = tree
                for part in relative.parts[:-1]:
                    parent = parent['files'].setdefault(part, {'files': {}})
                data = file.read_bytes()
                replace(parent, relative.name, data)
                bodies['apps/server/dist/' + relative.as_posix()] = data
            header['files']['apps']['files']['server']['files']['dist'] = tree
        offset = 0
        for key, entry in walk(header):
            if 'offset' in entry:
                entry['offset'] = str(offset)
                offset += entry['size']
        # Keep all unpacked native dependencies and links exactly as installed.
        special = lambda h: {k: v for k, v in walk(h) if 'offset' not in v}
        if special(original) != special(header):
            raise RuntimeError('Repack changed native metadata')
        raw = json.dumps(header, separators=(',', ':'), ensure_ascii=False).encode()
        payload = struct.pack('<I', len(raw)) + raw
        payload += bytes((-len(payload)) % 4)
        pickle = struct.pack('<I', len(payload)) + payload
        with Path(target).open('xb') as output:
            output.write(struct.pack('<II', 4, len(pickle)) + pickle)
            for key, entry in walk(header):
                if 'offset' not in entry:
                    continue
                body = bodies[key]
                if isinstance(body, tuple):
                    source.seek(start + body[0])
                    data = source.read(body[1])
                    if len(data) != body[1]:
                        raise RuntimeError('Truncated original ASAR')
                else:
                    data = body
                output.write(data)


def read_file(archive, relative):
    with Path(archive).open('rb') as source:
        words = struct.unpack('<4I', source.read(16))
        entry = json.loads(source.read(words[3]))
        for part in relative.split('/'):
            entry = entry['files'][part]
        if entry.get('unpacked'):
            return Path(str(archive) + '.unpacked', relative).read_bytes()
        source.seek(8 + words[1] + int(entry['offset']))
        return source.read(entry['size'])
