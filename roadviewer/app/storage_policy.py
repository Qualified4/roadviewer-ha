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
        s.app.register_error_handler(StorageError, self.error)

    def error(self, error):
        messages = {'storage_limit_exceeded': '설정한 저장공간 제한을 초과합니다.', 'insufficient_disk_space': '예약·임시 파일과 안전 여유 공간을 제외하면 디스크 공간이 부족합니다. 기존 기록은 보존합니다.',
                    'no_deletable_logs': '고정되었거나 사용 중이거나 Drive 파일이 있는 기록을 제외하면 확보할 공간이 없습니다.'}
        return jsonify(error=error.code, message=messages[error.code]), 507

    def protected_routes(self, incoming_files):
        files = list(incoming_files)
        for p in self.s.UPLOADS.iterdir():
            manifest = p / 'manifest.json'
            if manifest.is_file(): files.extend(json.loads(manifest.read_text()))
        routes = set()
        for f in files:
            match = self.s.FLAT.fullmatch(f['name'].replace('\\', '/').rsplit('/', 1)[-1])
            if match: routes.add(match['route'])
        return routes

    def request_reclaim(self, extra, incoming_files, protected_ids, reservation_id=None):
        # One coalesced goal in the existing archiver, never a new queue or network
        # wait under the admission locks. Accepted uploads become reservations before
        # the worker takes lock; extra is used only for a request rejected for disk space.
        s, archiver = self.s, self.s.archiver
        settings = archiver.settings
        if not settings.enabled or settings.effective_mode != 'move': return
        incoming_files, protected_ids = list(incoming_files), set(protected_ids)
        def enough():
            with s.lock:
                reserved = self.reserved(exclude=(reservation_id,) if reservation_id else ())
                targets = [v for v in (self.settings['max_bytes'], settings.local_threshold_bytes) if v > 0]
                return ((not targets or s.storage_used_bytes() + reserved + extra <= min(targets))
                        and shutil.disk_usage(s.ROOT).free >= reserved + extra + MARGIN)
        def eligible(meta):
            with s.lock:
                if self.pinned(meta) or meta['id'] in protected_ids or meta.get('status') != 'ready' or meta['id'] in s.processes: return False
                key = self.route_key(meta)
                if key in self.protected_routes(incoming_files): return False
                return not any(self.route_key(m) == key and (m.get('status') in ('queued', 'processing') or m['id'] in s.processes)
                               for p in s.recording_paths() for m in [s.read_meta(p)])
        archiver.start_cycle(reclaim=(enough, eligible))

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
                # A manual archive run decided what to delete with these settings: they stay until it ends.
                if self.s.archiver.manual_active: return jsonify(error='archive_running'), 409
                body = request.get_json(silent=True)
                if not isinstance(body, dict) or set(body) != {'max_bytes', 'policy'} or type(body['max_bytes']) is not int or not 0 <= body['max_bytes'] <= 2**53-1 or body['policy'] not in ('reject_new', 'delete_oldest'):
                    return jsonify(error='invalid_storage_settings'), 400
                self.settings.update(body); atomic_json(self.path, self.settings)
            snapshot = self.snapshot()
        # The share is probed and measured after both locks are released: a slow mount must not stall the server.
        return jsonify(dict(snapshot, archive=self.archive()))

    def archive(self):
        # Status of the video archive; editable preferences are served separately.
        s = self.s; store, settings = s.store, s.store.settings
        remote = s.remote_backend()
        if remote:
            # The panel polls: the state comes from the cache, refreshed in the background, never a probe here;
            # Drive's usage is the latest measurement (zero and unreliable until there is one), never asked here:
            # the archiver measures it each cycle, and the panel starts one in the background when there is no
            # recent figure (at most every 5 min).
            measuring = settings.enabled and s.backend.refresh_usage()
            (state, reason), usage = s.shown_archive_result(), s.backend.last_usage()
            used, free = (usage.used, usage.free or 0) if usage else (0, 0)
        else:
            state, reason = store.state(), store.reason()
            used, free = store.usage() if state == 'connected' else (0, 0)
        # Archiving off: nothing is read from disk for the block (the panel polls every few seconds).
        if remote: files, size, copies, copied, errors = store.index_totals(self.remote_totals) if settings.enabled else (0, 0, 0, 0, 0)
        else: files, size = store.index_totals(self.archived_totals) if settings.enabled else (0, 0)
        try: pending = s.media_store.PendingDeletes(s.ROOT).count() if settings.enabled else 0
        except (OSError, ValueError): pending = 0
        status = s.archiver.status()
        block = dict(enabled=settings.enabled, state=state, reason=reason, path_configured=settings.path is not None,
                     used_bytes=used, free_bytes=free, max_bytes=settings.nas_max_bytes, margin_bytes=settings.nas_margin_bytes,
                     last_cycle_at=status['last_cycle_at'], last_error=status['last_error'], consecutive_failures=status['consecutive_failures'],
                     running=status['running'], pending_deletes=pending, archived_files=files, archived_bytes=size,
                     missing_archived=status['missing_archived'], manual=status['manual'], manual_active=status['manual_active'])
        if s.archive_settings_error: block['settings_error'] = s.archive_settings_error
        if not remote: return block
        # Drive only (the NAS block is unchanged): the mode, local copies that have a Drive copy, files whose copy
        # did not verify (retry: POST /api/logs/<id>/archive/retry) and the connection. Never a token or secret.
        return dict(block, backend=settings.backend, mode=settings.mode, effective_mode=settings.effective_mode,
                    local_delete_allowed=settings.allow_local_delete, usage_reliable=bool(usage and usage.reliable),
                    usage_known=usage is not None, usage_measuring=bool(measuring),
                    remote_copies_files=copies, remote_copies_bytes=copied, archive_errors={'remote_mismatch': errors},
                    gdrive=s.gdrive_status(reason))

    def archived_totals(self):
        # (files, bytes) on the archive according to every recording's index.
        s = self.s; files = size = 0
        for p in s.recording_paths():
            try: m = s.read_meta(p)
            except (OSError, ValueError): continue
            if not isinstance(m, dict): continue
            files += sum(s.media_store.is_archived_location(s.media_store.location(m, k)) for k in s.media_store.MEDIA_KINDS)
            size += s.media_store.archived_bytes(m)
        return files, size

    def remote_totals(self):
        # As archived_totals, plus the verified remote copies of local files and the files whose copy did not verify.
        s = self.s; ms = s.media_store; files = size = copies = copied = errors = 0
        for p in s.recording_paths():
            try: m = s.read_meta(p)
            except (OSError, ValueError): continue
            if not isinstance(m, dict): continue
            files += sum(ms.is_archived_location(ms.location(m, k)) for k in ms.MEDIA_KINDS)
            size += ms.archived_bytes(m)
            n, b = ms.remote_copy_totals(m); copies += n; copied += b
            errors += sum(ms.entry(m, k).get('error') == 'remote_mismatch' for k in ms.MEDIA_KINDS)
        return files, size, copies, copied, errors

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

    def reserved(self, exclude=()):
        # Usage already includes received chunks. Reserve only the remaining peak:
        # the originals still to arrive (plus a staging copy for multipart uploads) and metadata.
        total = 0
        for p in self.s.UPLOADS.iterdir():
            if p.name in exclude: continue
            f = p / 'reservation.json'
            if f.is_file(): total += max(0, json.loads(f.read_text())['bytes'] - self.s.storage_used_bytes(p))
        return total

    def admit(self, total, incoming_files, *, commit=False, protected_ids=(), staging=True, reservation_id=None):
        # Caller holds registration_lock then lock through admission AND session creation.
        # Multipart uploads are copied once more while registering; finished chunks are moved instead.
        needed = total * (2 if staging else 1) + 65536
        limit = self.settings['max_bytes']
        used = self.s.storage_used_bytes(); reserved = 0 if commit else self.reserved(); free = shutil.disk_usage(self.s.ROOT).free
        # Unreceived reservations may reserve reclaimable quota, never physical disk.
        # At commit, other upload intentions must not trigger extra eviction.
        drive_move = self.s.archiver.settings.backend == 'gdrive' and self.s.archiver.settings.effective_mode == 'move'
        if drive_move:
            reserved = self.reserved(exclude=(reservation_id,) if commit and reservation_id else ())
            # The quota is a MOVE trigger, not a reason to discard data/refuse an
            # otherwise safe upload. Reservations cover outstanding bytes, not bytes
            # already included in used/free. Multipart's second copy is in needed.
            disk_full = free < reserved + needed + MARGIN
            threshold = self.s.archiver.settings.local_threshold_bytes
            if disk_full or limit and used + reserved + needed >= limit or threshold > 0 and used + reserved + needed >= threshold:
                self.request_reclaim(needed if disk_full else 0, incoming_files, protected_ids, reservation_id if commit else None)
            if disk_full: raise StorageError('insufficient_disk_space')
            return needed
        if free < reserved + needed + MARGIN: raise StorageError('insufficient_disk_space')
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
        # A recording with archived files is not evicted while the share is unreachable: its files there
        # could not be removed with it. The lock is held, so the share is not probed: only a recent
        # "connected" result (callers refresh it before locking) makes such a recording evictable.
        reachable = None
        def evictable(m):
            nonlocal reachable
            # A Drive file/copy is part of this recording, never an eviction orphan.
            if self.s.media_store.remote_refs(m, copies=True): return False
            if not self.s.archived(m): return True
            if reachable is None: reachable = self.s.archive_last_state() == 'connected'
            return reachable
        for key, rows in groups.items():
            if key in protected or any(m['id'] in protected_ids or m['status'] in ('queued', 'processing') for _, m in rows): continue
            deletable = [(p, m) for p, m in rows if not self.pinned(m) and evictable(m)]
            if deletable: candidates.append((min(m.get('uploaded', 0) for _, m in rows), key, deletable))
        candidates.sort(key=lambda row: (row[0], row[1]))
        # Preflight prevents deleting existing data when even all candidates cannot help.
        reclaim = sum(self.s.storage_used_bytes(p) for _, _, rows in candidates for p, _ in rows)
        if (limit and used - reclaim + reserved + needed > limit) or free + reclaim < reserved + needed + MARGIN:
            raise StorageError('no_deletable_logs')
        if not commit: return needed
        for _, _, rows in candidates:
            for p, _ in rows: self.s.delete_recording(p.name)
            used = self.s.storage_used_bytes(); free = shutil.disk_usage(self.s.ROOT).free
            if enough(): return needed
        raise StorageError('no_deletable_logs')
