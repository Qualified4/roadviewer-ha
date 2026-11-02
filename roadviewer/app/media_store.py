"""Archive (NAS) settings, availability via a sentinel file, per-recording media resolution and the archiver."""
import hashlib, json, os, re, shutil, threading, time, uuid
from dataclasses import dataclass
from pathlib import Path
from storage_policy import atomic_json
from video_sources import STORED_KINDS

MEDIA_KINDS = STORED_KINDS
# Videos first, the original log last: it is the only input for reconversion.
ARCHIVE_ORDER = ('fcamera.mp4', 'ecamera.mp4', 'camera.mp4', 'fcamera.hevc', 'ecamera.hevc', 'qcamera.ts', 'rlog.zst')
VIDEO_KINDS = ARCHIVE_ORDER[:-1]
SENTINEL = '.roadviewer-storage.json'
LOCAL_COPY = '.archive.json'
CACHE_SECONDS = 10
SHARE_PATH = re.compile(r'^/share/[A-Za-z0-9_]+(/[A-Za-z0-9_.-]+)*$')
MB = 2**20

def valid_path(value):
    if not isinstance(value, str) or not value: return False
    if any(part in ('.', '..') for part in value.split('/')): return False
    # Tests point the archive at temporary directories; production never sets this.
    if os.environ.get('RV_ARCHIVE_ALLOW_ANY_PATH') == '1': return os.path.isabs(value)
    return bool(SHARE_PATH.fullmatch(value))

def _int(options, key, default, lo, hi=None):
    # Supervisor validates the schema, but a hand-edited options.json must not crash startup.
    try: value = int(options.get(key, default))
    except (TypeError, ValueError): value = default
    return max(lo, value if hi is None else min(hi, value))

def _bool(value): return value is True or isinstance(value, str) and value.lower() in ('true', '1')

def _kind(kind):
    if kind not in MEDIA_KINDS: raise ValueError(f'unknown media kind: {kind!r}')
    return kind

def _bytes(e):
    value = e.get('bytes', 0)
    return value if type(value) is int and value >= 0 else 0

@dataclass(frozen=True)
class ArchiveSettings:
    enabled: bool = False
    path: Path | None = None
    local_threshold_bytes: int = 0
    min_age_seconds: int = 86400
    interval_seconds: int = 600
    batch: int = 4
    nas_max_bytes: int = 0
    nas_margin_bytes: int = 1024 * MB
    error: str | None = None

    @classmethod
    def from_options(cls, options):
        enabled, raw = _bool(options.get('archive_enabled', False)), options.get('archive_path', '')
        ok, error = valid_path(raw), None
        if raw and not ok or enabled and not ok: enabled, error = False, 'invalid_archive_path'
        return cls(enabled=enabled, path=Path(raw) if ok else None, error=error,
                   local_threshold_bytes=_int(options, 'archive_local_threshold_mb', 0, 0) * MB,
                   min_age_seconds=_int(options, 'archive_min_age_hours', 24, 0, 8760) * 3600,
                   interval_seconds=_int(options, 'archive_interval_minutes', 10, 1, 1440) * 60,
                   batch=_int(options, 'archive_batch', 4, 1, 64),
                   nas_max_bytes=_int(options, 'archive_nas_max_mb', 0, 0) * MB,
                   nas_margin_bytes=_int(options, 'archive_nas_margin_mb', 1024, 0) * MB)

class ArchiveStore:
    def __init__(self, settings, root, clock=time.monotonic):
        self.settings, self.root, self.clock = settings, Path(root), clock
        self.lock = threading.Lock()
        self.cached = None  # (checked_at, state, reason)
        self.usage_cached = None  # (measured_at, (used, free))

    def local_id(self):
        try: return json.loads((self.root / LOCAL_COPY).read_text())['storage_id']
        except (OSError, ValueError, KeyError, TypeError): return None

    def _probe(self):
        path = self.settings.path
        try:
            if not path.is_dir(): return 'unavailable', 'path_missing'
            try:
                with (path / SENTINEL).open(encoding='utf-8') as f: sentinel = json.load(f)
            except FileNotFoundError: return 'unavailable', 'sentinel_missing'
            except ValueError: return 'unavailable', 'sentinel_invalid'
        except OSError: return 'unavailable', 'os_error'
        local = self.local_id()
        if local is None or not isinstance(sentinel, dict) or sentinel.get('storage_id') != local: return 'unavailable', 'storage_id_mismatch'
        return 'connected', None

    def _check(self):
        if not self.settings.enabled: return 'disabled', self.settings.error
        cached = self.cached
        if cached and self.clock() - cached[0] < CACHE_SECONDS: return cached[1:]
        # Never block requests on a hung mount. A stale result is not trusted while the
        # probe is stuck: "connected" from minutes ago must not outlive a dead mount.
        if not self.lock.acquire(blocking=False): return 'checking', 'probe_pending'
        try:
            cached = self.cached
            if cached and self.clock() - cached[0] < CACHE_SECONDS: return cached[1:]
            result = self._probe()
            self.cached = (self.clock(), *result)
            return result
        finally: self.lock.release()

    def state(self): return self._check()[0]
    def last_state(self):
        # The latest probe result without probing, for callers holding the server lock; None when stale.
        if not self.settings.enabled: return 'disabled'
        cached = self.cached
        return cached[1] if cached and self.clock() - cached[0] < CACHE_SECONDS else None
    def reason(self): return self._check()[1]
    def available(self): return self.state() == 'connected'
    def invalidate(self): self.cached = self.usage_cached = None
    def forget_usage(self): self.usage_cached = None
    def path_for(self, id, kind): return self.settings.path / id / _kind(kind)

    def usage(self):
        # Walks the share's tree, so a result is reused for CACHE_SECONDS (the settings panel polls it).
        # Callers deciding on removals call forget_usage() first. A read error returns (0, 0) and is not cached.
        if not self.available(): return 0, 0
        cached = self.usage_cached
        if cached and self.clock() - cached[0] < CACHE_SECONDS: return cached[1]
        try:
            used = 0
            for top, dirs, files in os.walk(self.settings.path, onerror=_raise):
                used += sum(os.lstat(os.path.join(top, name)).st_size for name in files)
            result = used, shutil.disk_usage(self.settings.path).free
        except OSError: return 0, 0
        self.usage_cached = (self.clock(), result)
        return result

    def activate(self):
        # Create the sentinel only on a fresh setup (no local copy, no sentinel). If either
        # exists, only verify: an empty unmounted directory or another instance's share must
        # never be claimed.
        if not self.settings.enabled: return
        self.invalidate()
        if self.local_id() is None and self.reason() == 'sentinel_missing':
            try:
                storage_id = uuid.uuid4().hex
                atomic_json(self.settings.path / SENTINEL, {'storage_id': storage_id, 'created_at': time.time(), 'owner': 'roadviewer'})
                atomic_json(self.root / LOCAL_COPY, {'storage_id': storage_id})
            except OSError: pass  # stays unavailable; the next probe reports why
        self.invalidate()

def _raise(error): raise error

def entry(meta, kind):
    storage = meta.get('storage')
    value = storage.get(kind) if isinstance(storage, dict) else None
    return value if isinstance(value, dict) and value.get('location') else {'location': 'local'}

def location(meta, kind): return entry(meta, kind)['location']

def set_location(meta, kind, **fields):
    if not isinstance(meta.get('storage'), dict): meta['storage'] = {}
    meta['storage'][kind] = fields

def archived_bytes(meta):
    return sum(_bytes(e) for e in (entry(meta, k) for k in MEDIA_KINDS) if e['location'] == 'nas')

def resolve(p, meta, kind, store):
    e = entry(meta, _kind(kind))
    where = e['location']
    if where == 'removed': return None, 'missing'
    if where == 'nas':
        if store.state() == 'checking': return None, 'checking'
        if not store.available(): return None, 'storage_unavailable'
        path = store.path_for(Path(p).name, kind)
    else: path = Path(p) / kind
    try:
        if not path.is_file(): return None, 'missing'
    except OSError:
        return (None, 'storage_unavailable') if where == 'nas' else (None, 'missing')
    return (path, 'corrupt') if e.get('error') else (path, 'available')

def media_size(p, meta, kind, store):
    e = entry(meta, kind)
    if e['location'] == 'nas': return _bytes(e)
    if e['location'] == 'removed': return 0
    try: return (Path(p) / kind).stat().st_size
    except OSError: return 0

def delete_archived(store, id, kinds):
    # Removes the recording's files from the share. Returns (removed count, kinds that could not be removed).
    if not store.available(): return 0, list(kinds)
    removed, failed = 0, []
    for kind in kinds:
        try:
            path = store.path_for(id, kind)
            if path.is_file(): path.unlink(); removed += 1
        except OSError: failed.append(kind)
    if not failed:
        # The recording's folder, once empty; anything else left there is kept rather than guessed at.
        try: (store.settings.path / id).rmdir()
        except OSError: pass
    return removed, failed

PENDING_DELETES = '.pending-nas-deletes.json'
RECORDING_ID = re.compile(r'^[a-f0-9]{32}$')

class PendingDeletes:
    """Archived files of deleted recordings that could not be removed yet because the share was unreachable."""
    lock = threading.Lock()  # One file shared by deletion requests and the archiver.

    def __init__(self, root): self.path = Path(root) / PENDING_DELETES

    def _load(self):
        # Caller holds self.lock. Any other read error propagates: the list must never be overwritten blind.
        try: rows = json.loads(self.path.read_text(encoding='utf-8'))
        except FileNotFoundError: return []
        except ValueError: rows = None
        # Only well-formed entries: the id and kinds become paths on the share.
        valid = [{'id': r['id'], 'kinds': [k for k in r['kinds'] if k in MEDIA_KINDS]} for r in rows
                 if isinstance(r, dict) and isinstance(r.get('id'), str) and RECORDING_ID.fullmatch(r['id']) and isinstance(r.get('kinds'), list)] if isinstance(rows, list) else []
        if not isinstance(rows, list) or valid != rows:
            # Unreadable content is kept aside for inspection instead of being replaced by the next save.
            self.path.replace(self.path.with_name(f'.pending-nas-deletes.corrupt-{int(time.time())}.json'))
            if valid: atomic_json(self.path, valid)
        return valid

    def _save(self, rows):
        if rows: atomic_json(self.path, rows)
        else: self.path.unlink(missing_ok=True)

    def add(self, id, kinds):
        with self.lock:
            rows = self._load()
            row = next((r for r in rows if r['id'] == id), None)
            if row is None: rows.append({'id': id, 'kinds': list(kinds)})
            else: row['kinds'] += [k for k in kinds if k not in row['kinds']]
            self._save(rows)

    def count(self):
        # Archived files still waiting to be removed.
        with self.lock: return sum(len(r['kinds']) for r in self._load())

    def process(self, store):
        # Returns the number of archived files removed. An entry stays until all its files are gone.
        # The share is touched outside the lock; entries added meanwhile are kept by the merge.
        if not store.available(): return 0
        with self.lock: rows = self._load()
        total, done = 0, {}
        for row in rows:
            removed, failed = delete_archived(store, row['id'], row['kinds'])
            total += removed
            done[row['id']] = set(row['kinds']) - set(failed)
        if done:
            with self.lock:
                current = self._load()
                left = [{'id': r['id'], 'kinds': [k for k in r['kinds'] if k not in done.get(r['id'], ())]} for r in current]
                left = [r for r in left if r['kinds']]
                if left != current: self._save(left)
        return total

CHUNK = MB
NAS_RESERVE = 100 * MB
FAILURES = ('storage_unavailable', 'nas_full', 'hash_mismatch', 'os_error')

def _sha256(path):
    with open(path, 'rb') as f: return hashlib.file_digest(f, 'sha256').hexdigest()

class _Hashing:
    # Hashes what is written, so the source is read only once.
    def __init__(self, f): self.f, self.h = f, hashlib.sha256()
    def write(self, data): self.h.update(data); return self.f.write(data)

class Archiver:
    """Moves files of converted recordings from local storage to the share, one verified copy at a time.
    The share is only touched outside the server lock; the lock guards the index commit and the local unlink."""

    def __init__(self, server, store, settings):
        self.server, self.store, self.settings = server, store, settings
        self.cycle = threading.Lock()  # One cycle (or recovery) at a time.
        self.thread = None
        self.running, self.last_cycle_at, self.last_error, self.consecutive_failures = False, None, None, 0
        self.archived_files_total, self.requeued_deferred, self.removed_files_total = 0, 0, 0
        # What triggered the last share cleanup (None, 'nas_max', 'nas_margin') and why it could not finish.
        self.cleanup_last_reason, self.cleanup_error = None, None
        self.recovered = False  # Crash recovery completed once with the share reachable.
        # Why the last archive_file returned False; None when the recording changed meanwhile.
        # Shared state: archive_file must only be called from run_cycle (which holds self.cycle).
        self.reason = None

    def status(self):
        return {'last_cycle_at': self.last_cycle_at, 'last_error': self.last_error, 'consecutive_failures': self.consecutive_failures,
                'running': self.running, 'archived_files_total': self.archived_files_total, 'requeued_deferred': self.requeued_deferred,
                'removed_files_total': self.removed_files_total, 'cleanup_last_reason': self.cleanup_last_reason}

    def start(self):
        if not self.settings.enabled or self.thread: return
        self.thread = threading.Thread(target=self._loop, name='archiver', daemon=True)
        self.thread.start()

    def _loop(self):
        # Recovery runs here rather than at import: hashing copies on a slow share must not delay startup.
        try: self.recover_startup()
        except Exception: self.server.app.logger.exception('Archive recovery failed')
        while not self.server.cleanup_stop.wait(self.settings.interval_seconds):
            try: self.run_cycle()
            except Exception: self.server.app.logger.exception('Archive cycle failed')

    def run_cycle(self):
        result = {'archived': 0, 'bytes': 0, 'stopped': None}
        if not self.settings.enabled: return {**result, 'stopped': 'disabled'}
        if not self.cycle.acquire(blocking=False): return {**result, 'stopped': 'busy'}
        try:
            self.running = True
            result['stopped'] = self._cycle(result)
        finally:
            self.running = False
            self.cycle.release()
        return result

    def _cycle(self, result):
        s = self.server
        if not self.store.available(): return self._failed('storage_unavailable')
        self.last_cycle_at = time.time()
        # Recovery skipped at startup (share down) or requested by a commit whose local unlink failed.
        if not self.recovered: self._recover()
        try: PendingDeletes(s.ROOT).process(self.store)
        except (OSError, ValueError): s.app.logger.exception('Pending archive deletions failed')
        self.cleanup_nas()
        self.requeue_deferred()
        # Nothing more is moved to a share that is still over its limit.
        if self.cleanup_error: return self._failed(self.cleanup_error)
        if s.upload_receiving(): return 'uploading'
        with s.lock: busy = bool(s.processes)
        if busy: return 'processing'
        if s.storage_used_bytes() <= self.settings.local_threshold_bytes: return 'below_threshold'
        reason = self._archive(result)
        if reason in FAILURES: return self._failed(reason)
        self.consecutive_failures, self.last_error = 0, None
        return reason

    def _failed(self, reason):
        self.last_error = reason
        self.consecutive_failures += 1
        return reason

    def _archive(self, result):
        s = self.server
        for p, meta in self.candidates():
            for kind in ARCHIVE_ORDER:
                if result['archived'] >= self.settings.batch: return None
                if location(meta, kind) != 'local': continue
                try: size = (p / kind).stat().st_size
                except FileNotFoundError: continue
                except OSError: return 'os_error'
                if not self.archive_file(p, meta, kind):
                    if self.reason: return self.reason
                    break  # The recording changed meanwhile: its other files wait for the next cycle.
                result['archived'] += 1
                result['bytes'] += size
                self.archived_files_total += 1
                # Uploads come first: the file in progress is finished, then the cycle ends.
                if s.upload_receiving(): return 'uploading'
                if s.cleanup_stop.is_set(): return 'shutdown'
        return None

    def _over(self, used, free):
        if self.settings.nas_max_bytes and used > self.settings.nas_max_bytes: return 'nas_max'
        if free < self.settings.nas_margin_bytes: return 'nas_margin'
        return None

    def cleanup_nas(self):
        # Design 5.2: when the share is over its limit, archived videos of unpinned recordings go first,
        # oldest first; the original logs only after every video. Local files, meta.json and prepared/
        # are never touched. Returns the number of files removed; sets cleanup_error when the share
        # stays over its limit. The share is touched outside the server lock. Caller holds self.cycle.
        self.cleanup_last_reason, self.cleanup_error = None, None
        if not self.settings.enabled: return 0
        self.store.forget_usage()
        used, free = self.store.usage()
        if not used and not free:
            # (0, 0) from a reachable share is a read error (a real share holds at least the sentinel).
            if self.store.available(): self.cleanup_error = 'os_error'
            return 0
        if not used: return 0  # Nothing on it: nothing to decide on.
        self.cleanup_last_reason = self._over(used, free)
        if not self.cleanup_last_reason: return 0
        rows, removed, left, measured = self._cleanup_candidates(), 0, False, True
        for kinds in (VIDEO_KINDS, ('rlog.zst',)):
            if not measured:
                # The estimate below may be off (sizes from the index): the irreplaceable logs are only
                # considered against a fresh measurement.
                self.store.forget_usage()
                used, free = self.store.usage()
                measured = True
                if not used and not free:
                    self.cleanup_error = 'os_error' if self.store.available() else 'storage_unavailable'
                    return removed
            for p, m in rows:
                if not self._over(used, free):
                    left = True
                    break
                for kind in kinds:
                    e = entry(m, kind)
                    if e['location'] != 'nas': continue
                    # An index without a size would leave the estimate unchanged: measure the file instead.
                    size = _bytes(e) or self._nas_size(p, kind)
                    done = self._remove_archived(p, kind, e)
                    if done is None: return removed  # cleanup_error is set.
                    if done:
                        removed += 1
                        self.removed_files_total += 1
                        used, free, measured = used - size, free + size, False
            if left: break
        if not measured:
            self.store.forget_usage()
            used, free = self.store.usage()
        if used and self._over(used, free): self.cleanup_error = 'nas_full' if left else 'nas_full_no_candidates'
        return removed

    def _nas_size(self, p, kind):
        # Outside the server lock: the share may be slow.
        try: return self.store.path_for(p.name, kind).stat().st_size
        except OSError: return 0

    def _cleanup_candidates(self):
        s, rows = self.server, []
        for p in s.recording_paths():
            try: m = s.read_meta(p)
            except (OSError, ValueError): continue
            if isinstance(m, dict) and any(location(m, kind) == 'nas' for kind in ARCHIVE_ORDER): rows.append((p, m))
        with s.lock: rows = [(p, m) for p, m in rows if not s.storage_policy.pinned(m)]
        uploaded = lambda m: m['uploaded'] if isinstance(m.get('uploaded'), (int, float)) else 0
        return sorted(rows, key=lambda row: (uploaded(row[1]), row[0].name))

    def _removable(self, p, kind, e, guarded=True):
        # Caller holds the server lock. The indexed copy is still the one chosen; before the unlink also
        # nothing protects (pinned) or reads it (conversion).
        s = self.server
        try: current = s.read_meta(p)
        except (OSError, ValueError): return None
        if not isinstance(current, dict) or guarded and (s.storage_policy.pinned(current) or p.name in s.processes): return None
        now = entry(current, kind)
        same = now['location'] == 'nas' and now.get('sha256') == e.get('sha256') and now.get('bytes') == e.get('bytes')
        return current if same else None

    def _remove_archived(self, p, kind, e):
        # True when removed and indexed as removed, False when skipped, None when cleanup must stop (cleanup_error set).
        s = self.server
        with s.lock:
            if self._removable(p, kind, e) is None: return False
        try: self.store.path_for(p.name, kind).unlink()
        except FileNotFoundError:
            # Already gone counts as removed, but an unmounted share looks the same: confirm it first.
            self.store.invalidate()
            if not self.store.available():
                self.cleanup_error = 'storage_unavailable'
                return None
        except OSError:
            s.app.logger.exception('Removing archived %s/%s failed', p.name, kind)
            self.store.invalidate()
            self.cleanup_error = 'os_error'
            return None
        with s.lock:
            current = self._removable(p, kind, e, guarded=False)
            if current is None: return False  # Changed meanwhile: its new entry is not recorded as removed.
            set_location(current, kind, location='removed', removed_at=time.time(), reason='nas_full')
            try: s.save_meta(p, current)
            except OSError:
                s.app.logger.exception('Index of %s not saved', p.name)
                self.cleanup_error = 'os_error'
                return None
        return True

    def candidates(self):
        s = self.server
        now, rows = time.time(), []
        with s.lock: active = set(s.processes)
        for p in s.recording_paths():
            try: m = s.read_meta(p)
            except (OSError, ValueError): continue
            if not isinstance(m, dict) or m.get('status') != 'ready' or p.name in active: continue
            uploaded = m.get('uploaded')
            if not isinstance(uploaded, (int, float)) or now - uploaded < self.settings.min_age_seconds: continue
            # Pinned recordings are archived too: pinning protects from deletion, not from moving.
            if any(location(m, kind) == 'local' and (p / kind).is_file() for kind in ARCHIVE_ORDER): rows.append((p, m))
        return sorted(rows, key=lambda row: (row[1]['uploaded'], row[0].name))

    def requeue_deferred(self):
        # Conversions deferred while the share was unreachable (run_job marks them), now that it answers.
        s, ids = self.server, []
        with s.lock:
            rows = []
            for p in s.recording_paths():
                try: m = s.read_meta(p)
                except (OSError, ValueError): continue
                if (isinstance(m, dict) and m.get('deferred') == 'storage' and m.get('status') == 'unconverted' and not m.get('auto_excluded')
                        and (s.auto_convert or m.get('manual_conversion'))): rows.append((p, m))
            rows.sort(key=lambda row: (row[1].get('uploaded', 0), row[0].name))
            for p, m in rows:
                m.update(status='queued', error=None)  # The deferral message is shown regardless of status.
                m.pop('deferred', None)
                s.save_meta(p, m)
                ids.append(p.name)
        for id in ids: s.submit(id)
        self.requeued_deferred += len(ids)
        return len(ids)

    def _fail(self, reason):
        self.reason = reason
        if reason in ('storage_unavailable', 'os_error'): self.store.invalidate()
        return False

    def archive_file(self, p, meta, kind):
        # Steps (design 5.1): hash, copy to .part + fsync, re-read and compare, rename, commit the index, unlink.
        # Until the index is committed the local file is the only trusted copy and is never touched.
        s, self.reason, p = self.server, None, Path(p)
        source, revision = p / kind, meta.get('conversion_revision', 0)
        target = self.store.path_for(p.name, kind)
        part = target.with_name(kind + '.part')
        try:
            if not self.store.available(): return self._fail('storage_unavailable')
            stat = source.stat()
            hashes = meta.get('content_hashes')
            known = hashes.get(kind) if isinstance(hashes, dict) else None
            known = known.get('sha256') if isinstance(known, dict) and known.get('size') == stat.st_size and known.get('mtime_ns') == stat.st_mtime_ns else None
            target.parent.mkdir(exist_ok=True)
            digest = None
            # A copy left by a crash before its index was written is reused when it is identical.
            if target.is_file() and target.stat().st_size == stat.st_size:
                expected = known or _sha256(source)
                if _sha256(target) == expected: digest = expected
            if digest is None:
                if shutil.disk_usage(target.parent).free < stat.st_size + NAS_RESERVE: return self._fail('nas_full')
                with source.open('rb') as src, part.open('wb') as dst:
                    writer = _Hashing(dst)
                    shutil.copyfileobj(src, writer, CHUNK)
                    dst.flush()
                    os.fsync(dst.fileno())
                digest = writer.h.hexdigest()
                # The bytes read must match the recorded hash, and the copy on the share the bytes read.
                if known and digest != known or _sha256(part) != digest:
                    part.unlink(missing_ok=True)
                    return self._fail('hash_mismatch')
                os.replace(part, target)
        except OSError:
            s.app.logger.exception('Archiving %s/%s failed', p.name, kind)
            try: part.unlink(missing_ok=True)
            except OSError: pass
            return self._fail('os_error')
        with s.lock:
            try:
                current = s.read_meta(p) if (p / 'meta.json').is_file() else None
                now = source.stat() if current is not None else None
            except (OSError, ValueError): current = now = None
            changed = (not isinstance(current, dict) or current.get('status') != 'ready' or current.get('conversion_revision', 0) != revision
                       or location(current, kind) != 'local' or (now.st_size, now.st_mtime_ns) != (stat.st_size, stat.st_mtime_ns))
            if not changed:
                set_location(current, kind, location='nas', bytes=stat.st_size, sha256=digest, archived_at=time.time())
                try: s.save_meta(p, current)
                except OSError:
                    s.app.logger.exception('Index of %s not saved', p.name)
                    return self._fail('os_error')  # The copy on the share is an orphan, reused next time.
                try: source.unlink()
                except OSError:
                    s.app.logger.exception('Archived %s/%s stays local until the next recovery', p.name, kind)
                    self.recovered = False  # The next cycle's recovery removes it.
                return True
        # Converted again, deleted or replaced meanwhile: no index refers to the copy.
        if not isinstance(current, dict) or location(current, kind) != 'nas':
            try: target.unlink(missing_ok=True)
            except OSError: pass
        return False

    def recover_startup(self):
        # After a crash: half-written copies go; a local file whose verified copy is indexed goes;
        # a copy without its index stays for the next cycle. Nothing is done while the share is unreachable.
        # Until it completes once, every connected cycle runs it first.
        if not self.settings.enabled: return
        with self.cycle: self._recover()

    def _recover(self):
        # Caller holds self.cycle. Sets self.recovered only when every recording was checked with the share reachable.
        if not self.store.available(): return
        s = self.server
        try:
            with os.scandir(self.settings.path) as tops:
                for top in tops:
                    if not (RECORDING_ID.fullmatch(top.name) and top.is_dir(follow_symlinks=False)): continue
                    with os.scandir(top.path) as files:
                        for f in files:
                            if f.name.endswith('.part') and f.is_file(follow_symlinks=False): os.unlink(f.path)
        except OSError:
            s.app.logger.exception('Archive recovery could not remove partial copies')
            self.store.invalidate()
            return
        for p in s.recording_paths():
            try: m = s.read_meta(p)
            except (OSError, ValueError): continue
            if not isinstance(m, dict): continue
            for kind in MEDIA_KINDS:
                e = entry(m, kind)
                if e['location'] != 'nas' or e.get('error') or not isinstance(e.get('sha256'), str) or not (p / kind).is_file(): continue
                target = self.store.path_for(p.name, kind)
                try: same = target.is_file() and _sha256(target) == e['sha256']
                except OSError:
                    self.store.invalidate()
                    return
                if same:
                    with s.lock:
                        try:
                            if entry(s.read_meta(p), kind) == e: (p / kind).unlink()
                        except (OSError, ValueError): pass
                    continue
                # The share copy is missing or differs. A local file identical to the indexed content is the
                # good copy: the index goes back to local and the next cycle replaces the share copy.
                try:
                    local = p / kind
                    stat, digest = local.stat(), _sha256(local)
                except OSError: continue
                hashes = m.get('content_hashes')
                known = hashes.get(kind) if isinstance(hashes, dict) else None
                recorded = isinstance(known, dict) and known.get('size') == stat.st_size and known.get('mtime_ns') == stat.st_mtime_ns and known.get('sha256') == digest
                restore = digest == e['sha256'] or recorded
                # A missing file on an unmounted share looks the same: confirm the share before changing the index.
                self.store.invalidate()
                if not self.store.available(): return
                s.app.logger.warning('Archived %s/%s is missing or does not match its index; %s', p.name, kind,
                                     'the local copy is used again' if restore else 'marked corrupt')
                with s.lock:
                    try:
                        current = s.read_meta(p)
                        if entry(current, kind) != e: continue
                        if restore:
                            current['storage'].pop(kind)
                            if not current['storage']: current.pop('storage')
                        else: current['storage'][kind]['error'] = 'recovery_mismatch'
                        s.save_meta(p, current)
                    except (OSError, ValueError): continue
        self.recovered = True
