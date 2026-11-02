"""Archive (NAS) settings, availability via a sentinel file, and per-recording media resolution."""
import json, os, re, shutil, threading, time, uuid
from dataclasses import dataclass
from pathlib import Path
from storage_policy import atomic_json
from video_sources import STORED_KINDS

MEDIA_KINDS = STORED_KINDS
# Videos first, the original log last: it is the only input for reconversion.
ARCHIVE_ORDER = ('fcamera.mp4', 'ecamera.mp4', 'camera.mp4', 'fcamera.hevc', 'ecamera.hevc', 'qcamera.ts', 'rlog.zst')
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
    def reason(self): return self._check()[1]
    def available(self): return self.state() == 'connected'
    def invalidate(self): self.cached = None
    def path_for(self, id, kind): return self.settings.path / id / _kind(kind)

    def usage(self):
        if not self.available(): return 0, 0
        try:
            used = 0
            for top, dirs, files in os.walk(self.settings.path, onerror=_raise):
                used += sum(os.lstat(os.path.join(top, name)).st_size for name in files)
            return used, shutil.disk_usage(self.settings.path).free
        except OSError: return 0, 0

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
        try: rows = json.loads(self.path.read_text(encoding='utf-8'))
        except (OSError, ValueError): return []
        if not isinstance(rows, list): return []
        # Only well-formed entries: the id and kinds become paths on the share.
        return [{'id': r['id'], 'kinds': [k for k in r['kinds'] if k in MEDIA_KINDS]} for r in rows
                if isinstance(r, dict) and isinstance(r.get('id'), str) and RECORDING_ID.fullmatch(r['id']) and isinstance(r.get('kinds'), list)]

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

    def process(self, store):
        # Returns the number of archived files removed. An entry stays until all its files are gone.
        if not store.available(): return 0
        total = 0
        with self.lock:
            rows, left = self._load(), []
            for row in rows:
                removed, failed = delete_archived(store, row['id'], row['kinds'])
                total += removed
                if failed: left.append({'id': row['id'], 'kinds': failed})
            if left != rows: self._save(left)
        return total
