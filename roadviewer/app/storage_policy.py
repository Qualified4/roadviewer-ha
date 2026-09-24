"""Storage admission and segment pinning for the single-worker upload engine."""
import json, shutil, re
from flask import request, jsonify

MARGIN = 100 * 1024 * 1024
ROUTE = re.compile(r'^(?:[0-9a-fA-F]{8}--[0-9a-fA-F]{10}|\d{4}-\d{2}-\d{2}--\d{2}-\d{2}-\d{2})$')

def atomic_json(path, value):
    temp = path.with_suffix('.tmp')
    with temp.open('w', encoding='utf-8') as f:
        import os
        os.chmod(temp, 0o600)
        json.dump(value, f, ensure_ascii=False)
        f.flush(); os.fsync(f.fileno())
    temp.replace(path)

class StorageError(Exception):
    def __init__(self, code): self.code = code

class StoragePolicy:
    def __init__(self, s):
        self.s = s
        self.path = s.ROOT / '.storage-settings.json'
        self.settings = json.loads(self.path.read_text()) if self.path.exists() else {'max_bytes': 0, 'policy': 'reject_new', 'pinned_logs': []}
        self.migrate_pins()
        s.app.add_url_rule('/api/settings/storage', 'storage_settings', self.api, methods=['GET', 'POST'])
        s.app.add_url_rule('/api/logs/<id>/pin', 'pin_log', self.pin, methods=['POST'])
        s.app.register_error_handler(StorageError, lambda e: (jsonify(error=e.code, message={'storage_limit_exceeded':'설정한 저장공간 제한을 초과합니다.', 'insufficient_disk_space':'디스크 여유 공간이 부족합니다.', 'no_deletable_logs':'고정되었거나 사용 중인 로그를 제외하면 확보할 공간이 없습니다.'}[e.code]), 507))

    def route_key(self, meta):
        # Existing flat filenames are authoritative; never group by shortened UI text.
        name = meta.get('files', {}).get('rlog.zst', '')
        match = self.s.FLAT.fullmatch(name)
        if match: return match['route']
        name = meta.get('name', '').split(' / 구간 ', 1)[0]
        return name if ROUTE.fullmatch(name) else 'log:' + meta['id']

    def migrate_pins(self):
        # Preserve existing protection, without pinning segments uploaded later.
        if 'pinned_routes' not in self.settings: return
        routes = set(self.settings['pinned_routes'])
        pins = set(self.settings.get('pinned_logs', []))
        for p in self.s.recording_paths():
            meta = self.s.read_meta(p)
            if self.route_key(meta) in routes: pins.add(meta['id'])
        settings = dict(self.settings, pinned_logs=sorted(pins))
        del settings['pinned_routes']
        atomic_json(self.path, settings)
        self.settings = settings

    def pinned(self, meta): return meta['id'] in self.settings['pinned_logs']

    def snapshot(self):
        return dict(max_bytes=self.settings['max_bytes'], policy=self.settings['policy'], used_bytes=self.s.storage_used_bytes(), free_bytes=shutil.disk_usage(self.s.ROOT).free, reserved_bytes=self.reserved())

    def api(self):
        with self.s.registration_lock, self.s.lock:
            if request.method == 'POST':
                body = request.get_json(silent=True)
                if not isinstance(body, dict) or set(body) != {'max_bytes', 'policy'} or type(body['max_bytes']) is not int or not 0 <= body['max_bytes'] <= 2**53-1 or body['policy'] not in ('reject_new', 'delete_oldest'):
                    return jsonify(error='invalid_storage_settings'), 400
                self.settings.update(body); atomic_json(self.path, self.settings)
            return jsonify(self.snapshot())

    def pin(self, id):
        with self.s.registration_lock, self.s.lock:
            body = request.get_json(silent=True)
            if not isinstance(body, dict) or type(body.get('pinned')) is not bool: return jsonify(error='invalid_pin'), 400
            key = self.s.read_meta(self.s.folder(id))['id']
            pins = set(self.settings['pinned_logs'])
            if body['pinned']: pins.add(key)
            else: pins.discard(key)
            self.settings['pinned_logs'] = sorted(pins); atomic_json(self.path, self.settings)
        return jsonify(pinned=body['pinned'])

    def reserved(self):
        # Usage already includes received chunks. Reserve only the remaining peak:
        # originals plus the staging copy needed by register_files, and metadata.
        total = 0
        for p in self.s.UPLOADS.iterdir():
            f = p / 'reservation.json'
            if f.is_file(): total += max(0, json.loads(f.read_text())['bytes'] - self.s.storage_used_bytes(p))
        return total

    def admit(self, total, incoming_files):
        # Caller holds registration_lock then lock through admission AND session creation.
        needed = total * 2 + 65536
        limit = self.settings['max_bytes']
        used = self.s.storage_used_bytes(); reserved = self.reserved(); free = shutil.disk_usage(self.s.ROOT).free
        def enough(): return (not limit or used + reserved + needed <= limit) and free >= reserved + needed + MARGIN
        if enough(): return needed
        code = 'storage_limit_exceeded' if limit and used + reserved + needed > limit else 'insufficient_disk_space'
        if self.settings['policy'] != 'delete_oldest': raise StorageError(code)
        if limit and needed > limit: raise StorageError('storage_limit_exceeded')
        protected = set()
        files = list(incoming_files)
        for p in self.s.UPLOADS.iterdir():
            manifest = p / 'manifest.json'
            if manifest.is_file(): files.extend(json.loads(manifest.read_text()))
        for f in files:
            match = self.s.FLAT.fullmatch(f['name'].replace('\\', '/').rsplit('/', 1)[-1])
            if match: protected.add(match['route'])
        groups = {}
        for p in self.s.recording_paths():
            m = self.s.read_meta(p); key = self.route_key(m)
            groups.setdefault(key, []).append((p, m))
        candidates = []
        for key, rows in groups.items():
            if key in protected or any(m['status'] in ('queued', 'processing') for _, m in rows): continue
            deletable = [(p, m) for p, m in rows if not self.pinned(m)]
            if deletable: candidates.append((min(m.get('uploaded', 0) for _, m in rows), key, deletable))
        candidates.sort(key=lambda row: (row[0], row[1]))
        # Preflight prevents deleting existing data when even all candidates cannot help.
        reclaim = sum(self.s.storage_used_bytes(p) for _, _, rows in candidates for p, _ in rows)
        if (limit and used - reclaim + reserved + needed > limit) or free + reclaim < reserved + needed + MARGIN:
            raise StorageError('no_deletable_logs')
        for _, _, rows in candidates:
            for p, _ in rows: self.s.delete_recording(p.name)
            used = self.s.storage_used_bytes(); free = shutil.disk_usage(self.s.ROOT).free
            if enough(): return needed
        raise StorageError('no_deletable_logs')
