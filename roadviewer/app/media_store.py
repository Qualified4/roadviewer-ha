"""Archive (NAS) settings, availability via a sentinel file, per-recording media resolution and the archiver."""
import hashlib, json, logging, os, re, shutil, threading, time, uuid
from dataclasses import dataclass, field
from pathlib import Path
from storage_policy import atomic_json
from video_sources import STORED_KINDS

MEDIA_KINDS = STORED_KINDS
log = logging.getLogger(__name__)  # For code without the server's logger (PendingDeletes).
# Videos first, the original log last: it is the only input for reconversion.
ARCHIVE_ORDER = ('fcamera.mp4', 'ecamera.mp4', 'camera.mp4', 'fcamera.hevc', 'ecamera.hevc', 'qcamera.ts', 'rlog.zst')
VIDEO_KINDS = ARCHIVE_ORDER[:-1]
SENTINEL = '.roadviewer-storage.json'
LOCAL_COPY = '.archive.json'
CACHE_SECONDS = 10
# A folder inside a share (/share/<name>/...): the share's root is where an unmounted share leaves an empty directory.
SHARE_PATH = re.compile(r'^/share/[A-Za-z0-9_]+(/[A-Za-z0-9_.-]+)+$')
MB = 2**20
BACKENDS = ('smb', 'gdrive')
MODES = ('move', 'copy')
DEFAULT_FOLDER = 'Road Viewer'
# Index locations whose file lives on the archive instead of locally.
REMOTE_LOCATIONS = ('nas', 'gdrive')
# Backends whose files are addressed by a file id (not a path derived from the recording id).
REMOTE_BACKENDS = ('gdrive',)
# The index's fields for a remote copy and for an upload in progress (§2.4). The pending upload records the
# file's hash and size: a session created for other content is never resumed.
REMOTE_FIELDS = ('backend', 'file_id', 'bytes', 'sha256', 'md5', 'uploaded_at', 'verified_by')
REMOTE_PENDING_FIELDS = ('backend', 'session', 'started_at', 'bytes_sent', 'sha256', 'size')

def _any_path(): return os.environ.get('RV_ARCHIVE_ALLOW_ANY_PATH') == '1'

def valid_path(value):
    if not isinstance(value, str) or not value: return False
    if any(part in ('.', '..') for part in value.split('/')): return False
    # Tests point the archive at temporary directories; production never sets this.
    if _any_path(): return os.path.isabs(value)
    return bool(SHARE_PATH.fullmatch(value))

def _int(options, key, default, lo, hi=None):
    # Supervisor validates the schema, but a hand-edited options.json must not crash startup.
    try: value = int(options.get(key, default))
    except (TypeError, ValueError): value = default
    return max(lo, value if hi is None else min(hi, value))

def _bool(value): return value is True or isinstance(value, str) and value.lower() in ('true', '1')

def _text(options, key):
    value = options.get(key, '')
    return value if isinstance(value, str) else ''

def _kind(kind):
    if kind not in MEDIA_KINDS: raise ValueError(f'unknown media kind: {kind!r}')
    return kind

def _bytes(e):
    value = e.get('bytes', 0)
    return value if type(value) is int and value >= 0 else 0

def _same(a, b):
    # The same archived copy: flags added to its entry meanwhile (removing, error) do not make it another one.
    return all(a.get(k) == b.get(k) for k in ('location', 'sha256', 'bytes'))

def _kept(e):
    # A removal keeps what identified the copy, so a wrongly recorded removal can be checked against the share.
    return {k: e[k] for k in ('sha256', 'bytes') if k in e}

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
    backend: str = 'smb'
    mode: str = 'move'
    allow_local_delete: bool = False
    gdrive_client_id: str = ''
    gdrive_client_secret: str = field(default='', repr=False)
    gdrive_folder_name: str = DEFAULT_FOLDER

    @classmethod
    def from_options(cls, options):
        enabled, raw = _bool(options.get('archive_enabled', False)), options.get('archive_path', '')
        backend = options.get('archive_backend', 'smb')
        ok, error = valid_path(raw), None
        # The share path belongs to SMB; Drive does not need one.
        if backend != 'gdrive' and (raw and not ok or enabled and not ok): enabled, error = False, 'invalid_archive_path'
        if backend not in BACKENDS: backend, enabled, error = 'smb', False, 'invalid_backend'
        mode = options.get('archive_mode', 'move')
        folder = _text(options, 'archive_gdrive_folder_name').strip()
        return cls(enabled=enabled, path=Path(raw) if ok else None, error=error,
                   local_threshold_bytes=_int(options, 'archive_local_threshold_mb', 0, 0) * MB,
                   min_age_seconds=_int(options, 'archive_min_age_hours', 24, 0, 8760) * 3600,
                   interval_seconds=_int(options, 'archive_interval_minutes', 10, 1, 1440) * 60,
                   batch=_int(options, 'archive_batch', 4, 1, 64),
                   nas_max_bytes=_int(options, 'archive_nas_max_mb', 0, 0) * MB,
                   nas_margin_bytes=_int(options, 'archive_nas_margin_mb', 1024, 0) * MB,
                   backend=backend, mode=mode if mode in MODES else 'move',
                   allow_local_delete=_bool(options.get('archive_allow_local_delete', False)),
                   gdrive_client_id=_text(options, 'archive_gdrive_client_id').strip(),
                   gdrive_client_secret=_text(options, 'archive_gdrive_client_secret').strip(),
                   gdrive_folder_name=folder or DEFAULT_FOLDER)

    @property
    def effective_mode(self):
        # Drive keeps the local original unless deleting it was explicitly allowed as well.
        if self.backend != 'gdrive': return self.mode
        return 'move' if self.mode == 'move' and self.allow_local_delete else 'copy'

    @property
    def requires_client(self):
        # The backend signs in with an OAuth client (archive_gdrive_client_id/secret).
        return self.backend == 'gdrive'

class ArchiveStore:
    def __init__(self, settings, root, clock=time.monotonic):
        self.settings, self.root, self.clock = settings, Path(root), clock
        self.lock = threading.Lock()
        self.cached = None  # (checked_at, state, reason)
        self.usage_cached = None  # (measured_at, (used, free))
        self.index_cached = None  # (scanned_at, (archived files, archived bytes))

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
    def invalidate(self): self.cached = self.usage_cached = self.index_cached = None
    def forget_usage(self): self.usage_cached = None
    def forget_index(self): self.index_cached = None

    def index_totals(self, scan):
        # scan() reads every recording's index; the settings panel polls, so a result is reused for CACHE_SECONDS.
        cached = self.index_cached
        if cached and self.clock() - cached[0] < CACHE_SECONDS: return cached[1]
        result = scan()
        self.index_cached = (self.clock(), result)
        return result
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

    def mounted(self):
        # The share (/share/<name>) is a mount point. Without it the folder below is a local directory.
        if _any_path(): return True
        parts = self.settings.path.parts
        return len(parts) > 2 and parts[1] == 'share' and os.path.ismount(os.path.join('/share', parts[2]))

    def activate(self):
        # Create the sentinel only on a fresh setup (no local copy, no sentinel) with the share mounted.
        # If either file exists, only verify: an empty unmounted directory or another instance's share
        # must never be claimed.
        if not self.settings.enabled: return
        self.invalidate()
        if self.local_id() is None and self.reason() == 'sentinel_missing' and self.mounted():
            try:
                storage_id = uuid.uuid4().hex
                atomic_json(self.settings.path / SENTINEL, {'storage_id': storage_id, 'created_at': time.time(), 'owner': 'roadviewer'})
                # Merged: another backend's id in the local copy (gdrive_storage_id) survives a switch.
                try: kept = json.loads((self.root / LOCAL_COPY).read_text())
                except (OSError, ValueError): kept = {}
                atomic_json(self.root / LOCAL_COPY, {**(kept if isinstance(kept, dict) else {}), 'storage_id': storage_id})
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

def is_archived_location(where): return where in REMOTE_LOCATIONS

def _block(meta, kind, key):
    value = entry(meta, kind).get(key)
    return value if isinstance(value, dict) else None

def remote(meta, kind): return _block(meta, kind, 'remote')
def remote_pending(meta, kind): return _block(meta, kind, 'remote_pending')

def _editable(meta, kind):
    # The entry to add a block to; a missing or legacy entry becomes a local one.
    if not isinstance(meta.get('storage'), dict): meta['storage'] = {}
    e = meta['storage'].get(kind)
    if not (isinstance(e, dict) and e.get('location')): e = meta['storage'][kind] = {'location': 'local'}
    return e

def _fields(fields, allowed):
    unknown = set(fields) - set(allowed)
    if unknown: raise ValueError(f'unknown index fields: {sorted(unknown)}')
    return dict(fields)

def set_remote(meta, kind, **fields): _editable(meta, kind)['remote'] = _fields(fields, REMOTE_FIELDS)
def set_remote_pending(meta, kind, **fields): _editable(meta, kind)['remote_pending'] = _fields(fields, REMOTE_PENDING_FIELDS)

def clear_remote_pending(meta, kind):
    storage = meta.get('storage')
    e = storage.get(kind) if isinstance(storage, dict) else None
    if isinstance(e, dict): e.pop('remote_pending', None)

def remote_refs(meta, copies=True):
    # The remote backend's files a recording's index refers to (moved files and, with `copies`, verified copies),
    # for deleting them with the recording. NAS files are listed by kind (PendingDeletes' `kinds`).
    refs = []
    for kind in MEDIA_KINDS:
        e = entry(meta, kind)
        block = e if e['location'] == 'gdrive' else remote(meta, kind) if e['location'] == 'local' and copies else None
        name = 'gdrive' if e['location'] == 'gdrive' else block.get('backend') if block else None
        if name in REMOTE_BACKENDS and isinstance(block.get('file_id'), str) and block['file_id']:
            sha256 = block.get('sha256')
            refs.append({'kind': kind, 'backend': name, 'file_id': block['file_id'], 'bytes': _bytes(block),
                         'sha256': sha256 if isinstance(sha256, str) else None})
    return refs

PRIVATE_FIELDS = ('remote_pending', 'file_id')

def public_storage(storage):
    # The index as API responses show it: an upload's session URI is a credential (it accepts data without a
    # token) and remote file ids are not needed by the UI, so neither leaves the add-on.
    if not isinstance(storage, dict): return storage
    out = {}
    for kind, e in storage.items():
        if isinstance(e, dict):
            e = {k: v for k, v in e.items() if k not in PRIVATE_FIELDS}
            if isinstance(e.get('remote'), dict): e['remote'] = {k: v for k, v in e['remote'].items() if k not in PRIVATE_FIELDS}
        out[kind] = e
    return out

def archived_bytes(meta):
    return sum(_bytes(e) for e in (entry(meta, k) for k in MEDIA_KINDS) if is_archived_location(e['location']))

def remote_copy_totals(meta):
    # Local files that also have a verified remote copy: (files, bytes).
    blocks = [remote(meta, k) for k in MEDIA_KINDS if location(meta, k) == 'local']
    blocks = [b for b in blocks if b is not None]
    return len(blocks), sum(_bytes(b) for b in blocks)

@dataclass
class RemoteFile:
    # A file only the remote backend has; not a Path, so consumers branch with isinstance.
    backend_kind: str
    ref: 'archive_backends.RemoteRef'
    kind: str
    size: int
    etag: str

def _resolve_remote(block, backend_kind, kind, backend, corrupt):
    # Asks the backend once for the file's metadata. Nothing in the index changes: unreachable or gone
    # files are dynamic states.
    # Only the backend the file was stored with can answer for it (another kind may be active after a switch).
    if backend is None or getattr(getattr(backend, 'caps', None), 'kind', None) != backend_kind: return None, 'storage_unavailable'
    state = backend.probe()[0]
    if state == 'checking': return None, 'checking'
    if state != 'connected': return None, 'storage_unavailable'
    from archive_backends import BackendError, RemoteRef  # archive_backends imports this module.
    file_id = block.get('file_id')
    if not isinstance(file_id, str) or not file_id: return None, 'missing'
    sha256, md5 = block.get('sha256'), block.get('md5')
    ref = RemoteRef(backend_kind, file_id, _bytes(block), sha256 if isinstance(sha256, str) else None, md5 if isinstance(md5, str) else None)
    try: stat = backend.stat(ref)
    except BackendError: return None, 'storage_unavailable'
    if stat is None or stat.trashed or not stat.exists: return None, 'missing'
    # The file must still be the one that was verified: a size or hash other than the index's is corrupt
    # (dynamically; the index is not rewritten). Served sizes are the index's.
    if ref.bytes > 0 and stat.bytes != ref.bytes: corrupt = True
    if ref.sha256 and stat.sha256 and stat.sha256 != ref.sha256: corrupt = True
    rf = RemoteFile(backend_kind, ref, kind, ref.bytes if ref.bytes > 0 else stat.bytes, f'"{file_id}:{(ref.sha256 or "")[:16]}"')
    return rf, 'corrupt' if corrupt else 'available'

def _local_file(p, kind):
    try: return (Path(p) / kind).is_file()
    except OSError: return False

def resolve(p, meta, kind, store, backend=None):
    # Touches the share or the remote backend: never call it while holding the server lock.
    # Returns (Path | RemoteFile | None, state); a local file always wins over a remote copy.
    e = entry(meta, _kind(kind))
    where = e['location']
    if where == 'removed': return None, 'missing'
    if where == 'gdrive': return _resolve_remote(e, 'gdrive', kind, backend, e.get('error'))
    if where == 'local' and remote(meta, kind) and not _local_file(p, kind):
        block = remote(meta, kind)
        name = block.get('backend')
        return _resolve_remote(block, name if isinstance(name, str) and name else 'gdrive', kind, backend, e.get('error'))
    if where == 'nas':
        if store.state() == 'checking': return None, 'checking'
        if not store.available(): return None, 'storage_unavailable'
        path = store.path_for(Path(p).name, kind)
    else: path = Path(p) / kind
    try:
        if not path.is_file():
            if where != 'nas': return None, 'missing'
            # A share that dropped during the lookup looks the same: only a reachable share confirms missing.
            store.invalidate()
            if store.state() == 'checking': return None, 'checking'
            return (None, 'missing') if store.available() else (None, 'storage_unavailable')
    except OSError:
        return (None, 'storage_unavailable') if where == 'nas' else (None, 'missing')
    # A copy that did not verify (remote_mismatch) says nothing about the local file, which is played as before.
    if where == 'local' and e.get('error') == 'remote_mismatch': return path, 'available'
    return (path, 'corrupt') if e.get('error') else (path, 'available')

def indexed_state(p, meta, kind, share):
    # The state for the library list: archived files by their index and the share's state (one check per
    # request), so the list never stats the share per file. Playback and downloads use resolve().
    # A remote backend's files (gdrive, or a remote copy whose local file is gone) follow the same rule with
    # the active backend's state as `share`.
    e = entry(meta, _kind(kind))
    if e['location'] == 'removed': return 'missing'
    remote_only = e['location'] == 'local' and remote(meta, kind) is not None and not _local_file(p, kind)
    if not is_archived_location(e['location']) and not remote_only: return resolve(p, meta, kind, None)[1]
    if share == 'connected': return 'corrupt' if e.get('error') else 'available'
    return 'storage_unavailable' if share in ('unavailable', 'disabled') else 'checking'

def media_size(p, meta, kind, store):
    e = entry(meta, kind)
    if e['location'] == 'nas': return _bytes(e)
    if e['location'] == 'gdrive': return _bytes(e)
    if e['location'] == 'removed': return 0
    try: return (Path(p) / kind).stat().st_size
    except OSError:
        # A remote copy whose local file is gone: its size is the index's.
        block = remote(meta, kind) if e['location'] == 'local' else None
        return _bytes(block) if block else 0

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
REF_KEYS = {'kind', 'backend', 'file_id', 'bytes', 'sha256'}

def _valid_ref(r):
    return (isinstance(r, dict) and set(r) == REF_KEYS and r['kind'] in MEDIA_KINDS and r['backend'] in REMOTE_BACKENDS
            and isinstance(r['file_id'], str) and bool(r['file_id']) and type(r['bytes']) is int and (r['sha256'] is None or isinstance(r['sha256'], str)))

def _valid_row(r):
    # A row lists NAS files by kind and a remote backend's files by reference (`refs`, absent in older rows).
    row = {'id': r['id'], 'kinds': [k for k in r['kinds'] if k in MEDIA_KINDS]}
    if 'refs' in r: row['refs'] = [dict(x) for x in r['refs'] if _valid_ref(x)] if isinstance(r['refs'], list) else []
    return row

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
        valid = [_valid_row(r) for r in rows
                 if isinstance(r, dict) and isinstance(r.get('id'), str) and RECORDING_ID.fullmatch(r['id']) and isinstance(r.get('kinds'), list)] if isinstance(rows, list) else []
        if not isinstance(rows, list) or valid != rows:
            # Unreadable content is kept aside for inspection instead of being replaced by the next save.
            self.path.replace(self.path.with_name(f'.pending-nas-deletes.corrupt-{int(time.time())}.json'))
            if valid: atomic_json(self.path, valid)
        return valid

    def _save(self, rows):
        if rows: atomic_json(self.path, rows)
        else: self.path.unlink(missing_ok=True)

    def add(self, id, kinds, refs=None):
        # refs: remote files ({kind, backend, file_id, bytes, sha256}); a row gets the field only when it has some.
        with self.lock:
            rows = self._load()
            row = next((r for r in rows if r['id'] == id), None)
            if row is None: rows.append({'id': id, 'kinds': list(kinds)}); row = rows[-1]
            else: row['kinds'] += [k for k in kinds if k not in row['kinds']]
            if refs:
                known = {r['file_id'] for r in row.setdefault('refs', [])}
                row['refs'] += [dict(r) for r in refs if r['file_id'] not in known]
            self._save(rows)

    def count(self):
        # Archived files still waiting to be removed.
        with self.lock: return sum(len(r['kinds']) + len(r.get('refs', ())) for r in self._load())

    def process(self, backend):
        # Returns the number of archived files removed. An entry stays until all its files are gone.
        # The archive is touched outside the lock; entries added meanwhile are kept by the merge.
        # `backend`: the NAS (an ArchiveStore, or the SmbBackend around one) removes the rows' kinds as before;
        # a remote backend removes the rows' refs of its kind through backend.delete.
        caps = getattr(backend, 'caps', None)
        if caps is not None and caps.kind != 'smb': return self._process_remote(backend)
        store = backend.store if caps is not None else backend
        if not store.available(): return 0
        with self.lock: rows = self._load()
        total, done = 0, {}
        for row in rows:
            # A deletion stopped between recording the files and removing the recording: it still uses them.
            # The entry stays until the recording is gone.
            if (self.path.parent / row['id'] / 'meta.json').exists(): continue
            if not row['kinds'] and row.get('refs'): continue  # Only a remote backend's files: none on the share.
            removed, failed = delete_archived(store, row['id'], row['kinds'])
            total += removed
            done[row['id']] = set(row['kinds']) - set(failed)
        if done: self._merge(done, {})
        return total

    def _process_remote(self, backend):
        from archive_backends import BackendError, RemoteRef  # archive_backends imports this module.
        if backend.probe()[0] != 'connected': return 0
        with self.lock: rows = self._load()
        total, done = 0, {}
        for row in rows:
            refs = [r for r in row.get('refs', ()) if r['backend'] == backend.caps.kind]
            if not refs or (self.path.parent / row['id'] / 'meta.json').exists(): continue
            gone = set()
            for r in refs:
                try:
                    # True: deleted or already gone (confirmed); False: unsure, tried again next time.
                    if backend.delete(RemoteRef(r['backend'], r['file_id'], r['bytes'], r['sha256'], None)):
                        gone.add(r['file_id']); total += 1
                except BackendError as e:
                    if e.reason != 'foreign_file': continue  # Kept: tried again next time.
                    # Not ours (another instance's file, the folder itself): never deleted, and not tried again.
                    log.warning('Pending Google Drive deletion of %s/%s (%s) skipped: not a file of this instance', row['id'], r['kind'], r['file_id'])
                    gone.add(r['file_id'])
            done[row['id']] = gone
        if done: self._merge({}, done)
        return total

    def _merge(self, kinds, refs):
        # Drops what was removed (kinds, and ref file ids, per recording) from the current list.
        with self.lock:
            current, left = self._load(), []
            for r in current:
                row = {**r, 'kinds': [k for k in r['kinds'] if k not in kinds.get(r['id'], ())]}
                if 'refs' in r: row['refs'] = [x for x in r['refs'] if x['file_id'] not in refs.get(r['id'], ())]
                if row['kinds'] or row.get('refs'): left.append(row)
            if left != current: self._save(left)

CHUNK = MB
NAS_RESERVE = 100 * MB
FAILURES = ('storage_unavailable', 'nas_full', 'hash_mismatch', 'os_error', 'auth_expired', 'rate_limited', 'remote_full')
# A remote backend's error codes as cycle failures (design §2.10).
REMOTE_ERRORS = {'unavailable': 'storage_unavailable', 'auth_expired': 'auth_expired', 'rate_limited': 'rate_limited',
                 'quota_exceeded': 'remote_full', 'mismatch': 'hash_mismatch', 'io': 'os_error', 'not_found': 'os_error'}
# An upload in progress is recorded when its session starts, then at most once per this many bytes or seconds.
PROGRESS_BYTES, PROGRESS_SECONDS = 8 * MB, 30

class _Changed(Exception):
    """The recording changed while its file was being uploaded: the upload stops, nothing is committed."""

def _digests(path):
    # sha256 and md5 in one read.
    h256, hmd5 = hashlib.sha256(), hashlib.md5()
    with open(path, 'rb') as f:
        while data := f.read(CHUNK): h256.update(data); hmd5.update(data)
    return h256.hexdigest(), hmd5.hexdigest()

def _sha256(path):
    with open(path, 'rb') as f: return hashlib.file_digest(f, 'sha256').hexdigest()

class _Hashing:
    # Hashes what is written, so the source is read only once.
    def __init__(self, f): self.f, self.h = f, hashlib.sha256()
    def write(self, data): self.h.update(data); return self.f.write(data)

class Archiver:
    """Moves files of converted recordings from local storage to the share, one verified copy at a time.
    The share is only touched outside the server lock; the lock guards the index commit and the local unlink."""

    def __init__(self, server, store, settings, backend=None):
        self.server, self.store, self.settings = server, store, settings
        if backend is None:
            import archive_backends  # archive_backends imports this module.
            backend = archive_backends.make_backend(settings, server.ROOT, store=store)
        self.backend = backend
        # Drive (design §2.6) takes archive_remote/_recover_remote; the NAS keeps its own path, always moving.
        self.remote = settings.backend == 'gdrive'
        self.remote_copies_total, self.last_auth_error = 0, None
        self.adopted = False  # Whether the last archive_remote found a copy to adopt.
        self.cycle = threading.Lock()  # One cycle (or recovery) at a time.
        self.thread = None
        self.manual = None  # The latest manual run (start_cycle).
        self.running, self.last_cycle_at, self.last_error, self.consecutive_failures = False, None, None, 0
        self.archived_files_total, self.requeued_deferred, self.removed_files_total = 0, 0, 0
        # What triggered the last share cleanup (None, 'nas_max', 'nas_margin') and why it could not finish.
        self.cleanup_last_reason, self.cleanup_error = None, None
        self.recovered = False  # Crash recovery completed once with the share reachable.
        # Recordings held by requeue_startup were checked once with the share reachable (recheck_held).
        self.held_checked, self.rechecked_held = False, 0
        # (recording path, kind) of archived files recovery did not find on the reachable share; their index is kept.
        self.missing = set()
        self.cycle_failed = False  # A failure was counted for the current cycle (counted once per cycle).
        # Why the last archive_file returned False; None when the recording changed meanwhile.
        # Shared state: archive_file must only be called from run_cycle (which holds self.cycle).
        self.reason = None

    def status(self):
        return {'last_cycle_at': self.last_cycle_at, 'last_error': self.last_error, 'consecutive_failures': self.consecutive_failures,
                'running': self.running, 'archived_files_total': self.archived_files_total, 'requeued_deferred': self.requeued_deferred,
                'removed_files_total': self.removed_files_total, 'cleanup_last_reason': self.cleanup_last_reason,
                'rechecked_held': self.rechecked_held, 'missing_archived': len(self.missing),
                'backend': self.settings.backend, 'effective_mode': self.settings.effective_mode,
                'remote_copies_total': self.remote_copies_total, 'last_auth_error': self.last_auth_error}

    def start(self):
        if not self.settings.enabled or self.thread: return
        self.thread = threading.Thread(target=self._loop, name='archiver', daemon=True)
        self.thread.start()

    def activate(self):
        # The first contact with the share (sentinel check, first-time setup) happens here rather than at import.
        if self.remote:
            self.backend.activate()
            state, reason = self.backend.probe()
            if state != 'connected': self.server.app.logger.warning('Video archive (Google Drive) is not connected: %s', reason)
            return
        self.store.activate()
        if not self.store.available(): self.server.app.logger.warning('Video archive is not connected: %s', self.store.reason())

    def _loop(self):
        # Activation and recovery run here rather than at import: a hung mount or hashing copies on a
        # slow share must not delay startup.
        try: self.activate()
        except Exception: self.server.app.logger.exception('Archive activation failed')
        try: self.recover_startup()
        except Exception: self.server.app.logger.exception('Archive recovery failed')
        while not self.server.cleanup_stop.wait(self.settings.interval_seconds):
            try: self.run_cycle()
            except Exception: self.server.app.logger.exception('Archive cycle failed')

    def run_cycle(self):
        result = {'archived': 0, 'bytes': 0, 'stopped': None}
        if not self.settings.enabled: return {**result, 'stopped': 'disabled'}
        if not self.cycle.acquire(blocking=False): return {**result, 'stopped': 'busy'}
        return self._run_locked()

    def start_cycle(self):
        # A manual run in the background: False when a cycle already runs. The lock is taken here and
        # handed to the thread, so there is no window between the check and the start.
        if not self.cycle.acquire(blocking=False): return False
        try:
            self.running = True
            self.manual = threading.Thread(target=self._run_background, name='archive-run', daemon=True)
            self.manual.start()
        except BaseException:
            self.running = False
            self.cycle.release()
            raise
        return True

    def _run_background(self):
        try: self._run_locked()
        except Exception: self.server.app.logger.exception('Archive cycle failed')

    def _run_locked(self):
        # Caller holds self.cycle; it is released here.
        result = {'archived': 0, 'bytes': 0, 'stopped': None}
        try:
            self.running = True
            result['stopped'] = self._cycle(result)
        finally:
            self.running = False
            self.store.forget_index()  # The cycle may have changed what the index says is archived.
            self.cycle.release()
        return result

    def _cycle(self, result):
        if self.remote: return self._remote_cycle(result)
        s, self.cycle_failed = self.server, False
        if not self.store.available(): return self._failed('storage_unavailable')
        self.last_cycle_at = time.time()
        self._startup()
        # The share lost during the startup checks: nothing else is decided on it this cycle.
        if not self.store.available(): return self._failed('storage_unavailable')
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
        # A recording the startup re-check could not process keeps its error until a cycle has none.
        if not self.cycle_failed: self.consecutive_failures, self.last_error = 0, None
        return reason

    def _failed(self, reason):
        self.last_error = reason
        if not self.cycle_failed: self.consecutive_failures += 1
        self.cycle_failed = True
        return reason

    def _archive(self, result):
        s = self.server
        for p, meta in self.candidates():
            for kind in ARCHIVE_ORDER:
                if result['archived'] >= self.settings.batch: return None
                if location(meta, kind) != 'local': continue
                if self.remote and self._done_remotely(meta, kind): continue
                try: size = (p / kind).stat().st_size
                except FileNotFoundError: continue
                except OSError: return 'os_error'
                if not (self.archive_remote(p, meta, kind) if self.remote else self.archive_file(p, meta, kind)):
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
        # Pinned recordings are protected; queued or converting ones still need their inputs.
        with s.lock: rows = [(p, m) for p, m in rows if not s.storage_policy.pinned(m) and m.get('status') not in ('queued', 'processing')]
        uploaded = lambda m: m['uploaded'] if isinstance(m.get('uploaded'), (int, float)) else 0
        return sorted(rows, key=lambda row: (uploaded(row[1]), row[0].name))

    def _removable(self, p, kind, e, guarded=True):
        # Caller holds the server lock. The indexed copy is still the one chosen; before the unlink also
        # nothing protects (pinned) or reads it (conversion running or queued).
        s = self.server
        try: current = s.read_meta(p)
        except (OSError, ValueError): return None
        if not isinstance(current, dict) or guarded and (s.storage_policy.pinned(current) or p.name in s.processes
                                                         or current.get('status') in ('queued', 'processing')): return None
        now = entry(current, kind)
        same = now['location'] == 'nas' and now.get('sha256') == e.get('sha256') and now.get('bytes') == e.get('bytes')
        return current if same else None

    def _remove_archived(self, p, kind, e):
        # True when removed and indexed as removed, False when skipped, None when cleanup must stop (cleanup_error set).
        # The intent is flushed to the index before the unlink: recovery confirms a removal only for an entry
        # carrying it whose file is gone. A removal that fails or cannot be confirmed withdraws it.
        s = self.server
        with s.lock:
            current = self._removable(p, kind, e)
            if current is None: return False
            set_location(current, kind, **{**entry(current, kind), 'removing': True})
            try: atomic_json(p / 'meta.json', current)
            except OSError:
                s.app.logger.exception('Index of %s not saved', p.name)
                self.cleanup_error = 'os_error'
                return None
        try: self.store.path_for(p.name, kind).unlink()
        except FileNotFoundError:
            # Already gone counts as removed, but an unmounted share looks the same: confirm it first.
            self.store.invalidate()
            if not self.store.available():
                self._withdraw(p, kind, e)
                self.cleanup_error = 'storage_unavailable'
                return None
        except OSError:
            s.app.logger.exception('Removing archived %s/%s failed', p.name, kind)
            self.store.invalidate()
            self._withdraw(p, kind, e)
            self.cleanup_error = 'os_error'
            return None
        with s.lock:
            current = self._removable(p, kind, e, guarded=False)
            if current is None: return False  # Changed meanwhile: its new entry is not recorded as removed.
            set_location(current, kind, location='removed', removed_at=time.time(), reason='nas_full', **_kept(e))
            # Committed together: a video flag left True would make the restart check see a stale result.
            current['video'] = s.has_video(p, current)
            try: s.save_meta(p, current)
            except OSError:
                s.app.logger.exception('Index of %s not saved', p.name)
                self.cleanup_error = 'os_error'
                return None
        return True

    def _withdraw(self, p, kind, e):
        # A cleanup's intent is withdrawn: the file stays (the removal failed, or the file is still on the share).
        # Returns the entry without it, or None when the entry changed meanwhile or could not be saved.
        s = self.server
        with s.lock:
            try:
                current = s.read_meta(p)
                now = entry(current, kind)
                if now['location'] != 'nas' or not _same(now, e): return None
                now = {k: v for k, v in now.items() if k != 'removing'}
                set_location(current, kind, **now)
                s.save_meta(p, current)
            except (OSError, ValueError, AttributeError):
                s.app.logger.exception('Index of %s not saved', p.name)
                return None
        return now

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
            if any(location(m, kind) == 'local' and (p / kind).is_file() and not (self.remote and self._done_remotely(m, kind))
                   for kind in ARCHIVE_ORDER): rows.append((p, m))
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
                # One recording that cannot be saved does not hold back the others; it stays deferred.
                try: s.save_meta(p, m)
                except OSError:
                    s.app.logger.exception('Requeueing deferred %s failed', p.name)
                    continue
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
                    # Drop the cached pages so the comparison below reads the copy back from the share,
                    # not from this machine's (SMB client) cache. Advisory: a refusal changes nothing.
                    if hasattr(os, 'posix_fadvise'):
                        try: os.posix_fadvise(dst.fileno(), 0, 0, os.POSIX_FADV_DONTNEED)
                        except OSError: pass
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
                # Flushed to disk before the local file goes: after a power loss the index must not still say local.
                try: atomic_json(p / 'meta.json', current)
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

    def _adopt(self, p, m):
        # A copy committed to the share whose index write was lost (power loss after the local unlink): the
        # index still says local, the local file is gone, and the share holds the recorded content. The index
        # is pointed at that copy. Returns False when the share failed (recovery stops).
        s, hashes = self.server, m.get('content_hashes')
        for kind in MEDIA_KINDS:
            known = hashes.get(kind) if isinstance(hashes, dict) else None
            if location(m, kind) != 'local' or not isinstance(known, dict) or not isinstance(known.get('sha256'), str): continue
            # An original replaced by its MP4 keeps its hash on purpose; it is not looked for.
            if kind in s.DERIVED and s.stored(p, m, s.DERIVED[kind]): continue
            if (p / kind).exists(): continue
            target = self.store.path_for(p.name, kind)
            try:
                if not target.is_file(): continue
                size = target.stat().st_size
                if known.get('size') not in (None, size) or _sha256(target) != known['sha256']: continue
            except OSError:
                self.store.invalidate()
                return False
            with s.lock:
                try:
                    current = s.read_meta(p)
                    if location(current, kind) != 'local' or (p / kind).exists(): continue
                    set_location(current, kind, location='nas', bytes=size, sha256=known['sha256'], archived_at=time.time())
                    s.save_meta(p, current)
                    m.clear(); m.update(current)
                except (OSError, ValueError): continue
            s.app.logger.warning('Archived %s/%s was not in the index; the copy on the share is used', p.name, kind)
        return True

    def _settle_missing(self, p, kind, e):
        # Caller holds self.cycle. The indexed copy was not found on the share (and, unless it is marked corrupt,
        # there is no local one). Only a cleanup that recorded its intent (and stopped before its index commit) is
        # confirmed as removed. Anything else may be a lookup that missed (an SMB reconnect, a stale cache): the
        # index is kept, the file reports missing while it stays away and is counted. Returns False when the
        # share failed (recovery stops).
        s = self.server
        # A missing file on an unmounted share looks the same: confirm the share first.
        self.store.invalidate()
        if not self.store.available(): return False
        if e.get('removing') is not True:
            self._note_missing(p, kind)
            return True
        with s.lock:
            try:
                current = s.read_meta(p)
                if entry(current, kind) != e or (p / kind).exists(): return True
                set_location(current, kind, location='removed', removed_at=time.time(), reason='nas_full', **_kept(e))
                current['video'] = s.has_video(p, current)  # As in _remove_archived.
                s.save_meta(p, current)
            except (OSError, ValueError):
                s.app.logger.exception('Index of %s not saved', p.name)
                return True
        s.app.logger.info('Archived %s/%s was removed by an interrupted cleanup; recorded as removed', p.name, kind)
        return True

    def _note_missing(self, p, kind):
        if (p, kind) not in self.missing:
            self.server.app.logger.warning('Archived %s/%s is not on the share; its index is kept', p.name, kind)
        self.missing.add((p, kind))

    def _recheck_missing(self):
        # Caller holds self.cycle. Files recovery did not find are looked for again each connected cycle, so the
        # count drops once they are visible again. The index is never changed here.
        for p, kind in list(self.missing):
            try: e = entry(self.server.read_meta(p), kind)
            except (OSError, ValueError, AttributeError): e = None  # Deleted meanwhile; recovery looks again next start.
            if e is None or e['location'] != 'nas':
                self.missing.discard((p, kind))
                continue
            try: present = self.store.path_for(p.name, kind).is_file()
            except OSError:
                self.store.invalidate()
                return
            if present: self.missing.discard((p, kind))

    def _recheck_error(self, p, kind, e, target):
        # Caller holds self.cycle. An entry marked corrupt whose copy on the share matches the index again (a read
        # that failed silently, a copy put back) is cleared. Returns False when the share failed (recovery stops).
        s = self.server
        try:
            if _sha256(target) != e['sha256']: return True
        except OSError:
            self.store.invalidate()
            return False
        with s.lock:
            try:
                current = s.read_meta(p)
                if entry(current, kind) != e: return True
                set_location(current, kind, **{k: v for k, v in e.items() if k != 'error'})
                s.save_meta(p, current)
            except (OSError, ValueError):
                s.app.logger.exception('Index of %s not saved', p.name)
                return True
        s.app.logger.warning('Archived %s/%s matches its index again; no longer marked corrupt', p.name, kind)
        return True

    def _restore_removed(self, p, m, kind, e):
        # Caller holds self.cycle. Earlier versions recorded a file they did not find on a reachable share as
        # removed (reason missing). When the share holds the recorded content, the index points at it again.
        # Returns False when the share failed (recovery stops).
        s, hashes = self.server, m.get('content_hashes')
        known = hashes.get(kind) if isinstance(hashes, dict) else None
        if not isinstance(known, dict) or not isinstance(known.get('sha256'), str) or (p / kind).exists(): return True
        target = self.store.path_for(p.name, kind)
        try:
            if not target.is_file(): return True
            size = target.stat().st_size
            if known.get('size') not in (None, size) or _sha256(target) != known['sha256']: return True
        except OSError:
            self.store.invalidate()
            return False
        with s.lock:
            try:
                current = s.read_meta(p)
                if entry(current, kind) != e or (p / kind).exists(): return True
                now = time.time()
                set_location(current, kind, location='nas', bytes=size, sha256=known['sha256'], archived_at=now, restored_at=now)
                current['video'] = s.has_video(p, current)  # The removal cleared it; as in _remove_archived.
                s.save_meta(p, current)
            except (OSError, ValueError):
                s.app.logger.exception('Index of %s not saved', p.name)
                return True
        s.app.logger.warning('Archived %s/%s was recorded as removed but is on the share; restored', p.name, kind)
        return True

    def recover_startup(self):
        # After a crash: half-written copies go; a local file whose verified copy is indexed goes;
        # a copy without its index stays for the next cycle. Nothing is done while the share is unreachable.
        # Until it completes once, every connected cycle runs it first.
        if not self.settings.enabled: return
        with self.cycle: self._startup()

    def _startup(self):
        # Caller holds self.cycle. Both run at the first connected cycle when skipped at startup (share down);
        # recovery also when requested by a commit whose local unlink failed.
        if not self._connected(): return
        if not self.held_checked and self.recheck_held() is None: self._failed('recheck_failed')
        if self.remote:
            if not self.recovered: self._recover_remote()
            elif self.missing: self._recheck_missing_remote()
            return
        if not self.recovered: self._recover()
        elif self.missing: self._recheck_missing()

    def _connected(self):
        # The active backend answers: the share's sentinel check for the NAS, the backend's probe otherwise.
        return self.backend.probe()[0] == 'connected' if self.remote else self.store.available()

    def recheck_held(self):
        # requeue_startup cannot check the share, so it keeps the results of recordings with archived files. Once
        # the share is connected the same stale rule applies to them, once: only when every archived input
        # resolves as available (a ready result is never discarded for a reconversion that could lose data).
        # The share is resolved outside the server lock; the index is re-read under it. A recording that fails
        # (local rmtree or meta write) is logged and skipped; the others go on. Returns the number queued, or
        # None when one failed: then it is tried again by the next connected cycle.
        s, rows, ids, unsure, failed = self.server, [], [], False, False
        for p in s.recording_paths():
            try: m = s.read_meta(p)
            except (OSError, ValueError): continue
            if not isinstance(m, dict) or m.get('status') != 'ready' or not s.archived(m): continue
            states = s.archived_states(p, m)
            unsure = unsure or any(state in ('storage_unavailable', 'checking') for state in states.values())
            if all(state == 'available' for state in states.values()) and s.reconvertible(m, states): rows.append((p, m, states))
        with s.lock:
            for p, before, states in rows:
                try: m = s.read_meta(p)
                except (OSError, ValueError): continue
                # The states belong to the index read above: a recording changed meanwhile waits for the next start.
                if (not isinstance(m, dict) or p.name in s.processes or m.get('storage') != before.get('storage')
                        or m.get('conversion_revision', 0) != before.get('conversion_revision', 0) or not s.stale_recording(p, m)): continue
                try:
                    if not s.invalidate_recording(p, m, states): continue
                    queued = not m.get('auto_excluded') and (s.auto_convert or m.get('manual_conversion'))
                    if queued: m['status'] = 'queued'
                    s.save_meta(p, m)
                except (OSError, ValueError):
                    s.app.logger.exception('Re-checking %s failed', p.name)
                    failed = True
                    continue
                if queued: ids.append(p.name)  # Submitted only once saved as queued.
                self.rechecked_held += 1
        for id in ids: s.submit(id)
        # A share lost meanwhile or a failed recording left some unchecked: the next connected cycle looks again.
        if not unsure and not failed: self.held_checked = True
        return None if failed else len(ids)

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
            if not self._adopt(p, m): return
            for kind in MEDIA_KINDS:
                e = entry(m, kind)
                if e['location'] == 'removed':
                    if e.get('reason') == 'missing' and not self._restore_removed(p, m, kind, e): return
                    continue
                if e['location'] != 'nas' or not isinstance(e.get('sha256'), str): continue
                target = self.store.path_for(p.name, kind)
                try: present = target.is_file()
                except OSError:
                    self.store.invalidate()
                    return
                if present:
                    self.missing.discard((p, kind))
                    if e.get('removing'):
                        # A cleanup stopped before its unlink: the file stays and so does its entry.
                        e = self._withdraw(p, kind, e)
                        if e is None: continue
                if not present and (e.get('error') or not (p / kind).exists()):
                    if not self._settle_missing(p, kind, e): return
                    continue
                if e.get('error'):
                    if not self._recheck_error(p, kind, e, target): return
                    continue
                if not (p / kind).is_file(): continue
                try: same = present and _sha256(target) == e['sha256']
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
                if not present and not restore:
                    # Neither copy is known good, but a missing lookup proves nothing wrong: the index stays.
                    self._note_missing(p, kind)
                    continue
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

    # --- A remote backend (Drive, design §2.6). Drive is only called outside the server lock; under it the index
    # is re-read and committed, and a local file goes only after its verified copy is committed (six conditions).

    def _remote_cycle(self, result):
        # As _cycle, with the backend's state instead of the share's. Drive has no automatic cleanup
        # (caps.remote_cleanup is False): a full Drive stops the cycle (remote_full), nothing is deleted.
        s, self.cycle_failed = self.server, False
        failure = self._remote_state()
        if failure: return self._failed(failure)
        self.last_cycle_at = time.time()
        self._startup()
        failure = self._remote_state()
        if failure: return self._failed(failure)
        try: PendingDeletes(s.ROOT).process(self.backend)
        except (OSError, ValueError): s.app.logger.exception('Pending archive deletions failed')
        self.cleanup_last_reason, self.cleanup_error = None, None
        self.requeue_deferred()
        if s.upload_receiving(): return 'uploading'
        with s.lock: busy = bool(s.processes)
        if busy: return 'processing'
        # Kept in copy mode too: copying starts once local storage passes the threshold (it frees nothing).
        if s.storage_used_bytes() <= self.settings.local_threshold_bytes: return 'below_threshold'
        reason = self._archive(result)
        if reason in FAILURES: return self._failed(reason)
        if not self.cycle_failed: self.consecutive_failures, self.last_error = 0, None
        return reason

    def _remote_state(self):
        # None when the backend is connected, else the cycle's failure.
        state, reason = self.backend.probe()
        if state == 'connected':
            self.last_auth_error = None
            return None
        if reason == 'auth_expired':
            self.last_auth_error = 'auth_expired'
            return 'auth_expired'
        return 'rate_limited' if reason == 'rate_limited' else 'storage_unavailable'

    def _remote_fail(self, error):
        # A BackendError as the reason archive_remote returns False.
        reason = REMOTE_ERRORS.get(error.code, 'os_error')
        self.server.app.logger.warning('Archiving to Google Drive failed: %s', error)  # Code and Google's token only.
        if reason == 'auth_expired': self.last_auth_error = error.reason or 'auth_expired'
        if reason in ('storage_unavailable', 'os_error', 'auth_expired'): self.backend.invalidate()
        self.reason = reason
        return False

    def _done_remotely(self, meta, kind):
        # A local file the remote path leaves alone: one whose upload did not verify waits for attention (it would
        # be uploaded again every cycle); in copy mode one with a verified copy is done; in move mode a pinned
        # recording keeps its local file next to its copy.
        if entry(meta, kind).get('error') == 'remote_mismatch': return True
        if remote(meta, kind) is None: return False
        if self.settings.effective_mode == 'copy': return True
        with self.server.lock: return bool(self.server.storage_policy.pinned(meta))

    def _ref(self, block):
        from archive_backends import RemoteRef  # archive_backends imports this module.
        file_id, sha256, md5 = block.get('file_id'), block.get('sha256'), block.get('md5')
        if not isinstance(file_id, str) or not file_id: return None
        return RemoteRef(self.backend.caps.kind, file_id, _bytes(block), sha256 if isinstance(sha256, str) else None, md5 if isinstance(md5, str) else None)

    def _verify(self, ref, sha256, size, md5):
        # ('ok' | 'mismatch', verified_by). Without a checksum from the backend the copy is read back and hashed.
        verdict = self.backend.verify(ref, sha256, size, md5)
        if verdict == 'ok': return 'ok', 'sha256' if sha256 and ref.sha256 else 'md5'
        if verdict == 'mismatch' or not sha256: return 'mismatch', None
        h = hashlib.sha256()
        for chunk in self.backend.open(ref): h.update(chunk)
        return ('ok', 'download') if h.hexdigest() == sha256 else ('mismatch', None)

    def _unchanged(self, p, kind, revision, stat=None):
        # Caller holds the server lock. The recording's current index when it is still the one archived from
        # (ready, same conversion, the file still local and, with `stat`, unchanged on disk); else None.
        s = self.server
        try:
            current = s.read_meta(p) if (p / 'meta.json').is_file() else None
            now = (p / kind).stat() if current is not None and stat is not None else None
        except (OSError, ValueError): return None
        if (not isinstance(current, dict) or current.get('status') != 'ready' or current.get('conversion_revision', 0) != revision
                or location(current, kind) != 'local'): return None
        if stat is not None and (now.st_size, now.st_mtime_ns) != (stat.st_size, stat.st_mtime_ns): return None
        return current

    def _progress(self, p, kind, revision, resume, pending):
        # on_progress for backend.upload: the session is recorded in the index (fsync'd) as soon as it exists,
        # before its first chunk, and its progress at most every PROGRESS_BYTES or PROGRESS_SECONDS.
        s = self.server
        last = {'session': resume.get('session'), 'bytes': resume.get('bytes_sent') or 0, 'at': time.monotonic()}
        started = {'session': resume.get('session'), 'at': (pending or {}).get('started_at') or time.time()}
        def on_progress(sent):
            session = resume.get('session')
            if not session or sent >= (resume.get('size') or 0) > 0: return  # Complete: the commit follows.
            if session == last['session'] and sent - last['bytes'] < PROGRESS_BYTES and time.monotonic() - last['at'] < PROGRESS_SECONDS: return
            if session != started['session']: started.update(session=session, at=time.time())
            with s.lock:
                current = self._unchanged(p, kind, revision)
                if current is None: raise _Changed()
                set_remote_pending(current, kind, backend=self.backend.caps.kind, session=session, started_at=started['at'],
                                   bytes_sent=sent, sha256=resume.get('sha256'), size=resume.get('size'))
                atomic_json(p / 'meta.json', current)
            last.update(session=session, bytes=sent, at=time.monotonic())
        return on_progress

    def archive_remote(self, p, meta, kind, adopt_only=False):
        # Design §2.6 steps 1-6. Caller holds self.cycle. Until the index is committed the local file is the only
        # trusted copy and is never touched; afterwards only in move mode with deleting explicitly allowed.
        # adopt_only (recovery): only a copy find() returns is verified and committed; nothing is uploaded, and
        # self.adopted tells whether one was found.
        from archive_backends import BackendError  # archive_backends imports this module.
        s, b, self.reason, self.adopted, p = self.server, self.backend, None, False, Path(p)
        source, revision = p / kind, meta.get('conversion_revision', 0)
        try:
            # 1. The local file's hashes: the recorded sha256 when the file is unchanged since (md5 then comes from
            #    the verified copy), else both from one read.
            stat = source.stat()
            size, hashes = stat.st_size, meta.get('content_hashes')
            known = hashes.get(kind) if isinstance(hashes, dict) else None
            known = known.get('sha256') if isinstance(known, dict) and known.get('size') == size and known.get('mtime_ns') == stat.st_mtime_ns else None
            sha256, md5 = (known, None) if isinstance(known, str) else _digests(source)
            # 2. A copy whose completion answer or index commit was lost is adopted instead of uploaded again.
            ref = next((r for r in b.find(p.name, kind) if r.sha256 == sha256 and r.bytes == size), None)
            self.adopted = ref is not None
            if ref is None and adopt_only: return False
            if ref is None:
                # 3. Resumable upload; the session is in the index before the first chunk (on_progress).
                pending = remote_pending(meta, kind)
                pending = pending if pending and pending.get('backend') == b.caps.kind else None
                resume = dict(pending) if pending else {}
                ref = b.upload(source, p.name, kind, sha256, md5, size, resume=resume, on_progress=self._progress(p, kind, revision, resume, pending))
            # 4. The copy must be the local file's content.
            verdict, verified_by = self._verify(ref, sha256, size, md5)
        except _Changed: return False
        except BackendError as e:
            if e.reason == 'local_changed': return False  # Changed while uploading: hashed again next cycle.
            # A completed upload whose file is gone (trashed after a crash) or is not the local content: the session
            # is dropped, or every later cycle would stop at the same file. Only a wrong content marks the entry.
            if e.code in ('not_found', 'mismatch'): self._drop_pending(p, kind, revision, mismatch=e.code == 'mismatch')
            return self._remote_fail(e)
        except OSError:
            s.app.logger.exception('Archiving %s/%s to Google Drive failed', p.name, kind)
            self.reason = 'os_error'
            return False
        if verdict != 'ok':
            # The copy stays on Drive (never deleted automatically) and the local file stays; the entry is marked.
            s.app.logger.warning('The Google Drive copy of %s/%s does not match the local file', p.name, kind)
            self._drop_pending(p, kind, revision, mismatch=True)
            self.reason = 'hash_mismatch'
            return False
        # 5./6. Under the lock: the recording is still the one hashed, the index is committed (fsync'd), and only
        # then, in move mode with deleting allowed and nothing protecting or reading it, the local file goes.
        # Otherwise only the copy is recorded (design §2.6: protected files are copied, not moved).
        with s.lock:
            current = self._unchanged(p, kind, revision, stat)
            if current is None: return False  # The copy on Drive is adopted by find() if the content comes back.
            move = (self.settings.effective_mode == 'move' and self.settings.allow_local_delete and current.get('status') == 'ready'
                    and p.name not in s.processes and not s.storage_policy.pinned(current))
            md5 = ref.md5 or md5
            if move: set_location(current, kind, location='gdrive', file_id=ref.file_id, bytes=size, sha256=sha256, md5=md5, archived_at=time.time())
            else:
                set_remote(current, kind, backend=b.caps.kind, file_id=ref.file_id, bytes=size, sha256=sha256, md5=md5,
                           uploaded_at=time.time(), verified_by=verified_by)
                clear_remote_pending(current, kind)
            # Flushed to disk before the local file goes: after a power loss the index must not still say local.
            try: atomic_json(p / 'meta.json', current)
            except OSError:
                s.app.logger.exception('Index of %s not saved', p.name)
                self.reason = 'os_error'
                return False
            if not move:
                self.remote_copies_total += 1
                return True
            try: source.unlink()
            except OSError:
                s.app.logger.exception('Archived %s/%s stays local until the next recovery', p.name, kind)
                self.recovered = False  # The next cycle's recovery removes it.
        return True

    def _drop_pending(self, p, kind, revision, mismatch):
        # Clears the upload in progress; with `mismatch` the entry is marked remote_mismatch (kept until attended).
        s = self.server
        with s.lock:
            current = self._unchanged(p, kind, revision)
            if current is None: return
            if mismatch: _editable(current, kind)['error'] = 'remote_mismatch'
            elif remote_pending(current, kind) is None: return
            clear_remote_pending(current, kind)
            try: atomic_json(p / 'meta.json', current)
            except OSError: s.app.logger.exception('Index of %s not saved', p.name)

    def _recover_remote(self):
        # Caller holds self.cycle. Uploads interrupted by a restart are resumed, adopted or dropped; a local file
        # left by a move that stopped before its unlink goes once its copy verifies (when allowed); files Drive
        # does not have are counted (missing_archived), their index is never changed. Copies (remote blocks) never
        # touch the local file. Sets self.recovered only when every recording was checked with Drive reachable.
        from archive_backends import BackendError  # archive_backends imports this module.
        s = self.server
        try:
            for p in s.recording_paths():
                try: m = s.read_meta(p)
                except (OSError, ValueError): continue
                if not isinstance(m, dict): continue
                for kind in MEDIA_KINDS:
                    e = entry(m, kind)
                    if e['location'] == 'gdrive': self._recover_moved(p, m, kind, e)
                    elif e['location'] == 'local':
                        pending = remote_pending(m, kind)
                        if pending and pending.get('backend') == self.backend.caps.kind and not self._recover_pending(p, m, kind, pending): return
                        block = remote(m, kind)
                        if block is not None: self._check_remote(p, kind, block)
        except BackendError as e:
            self._remote_fail(e)
            return
        self.recovered = True

    def _recover_pending(self, p, m, kind, pending):
        # False when recovery must stop (Drive failed).
        s, state = self.server, self.backend.session_status(pending)
        if state == 'incomplete': return True  # The next archiving of the file resumes it.
        if state == 'done':
            # Completed but not committed: the copy find() returns is verified and committed. Recovery never uploads:
            # without an adoptable copy the record goes and the normal cycle (with its upload, conversion and
            # threshold checks) archives the file.
            if self.archive_remote(p, m, kind, adopt_only=True): return True
            if self.reason is not None: return False
            if self.adopted: return True  # Found but the recording changed meanwhile.
        with s.lock:  # Expired (nothing was kept on Drive), or completed with nothing to adopt.
            try:
                current = s.read_meta(p)
                if remote_pending(current, kind) != pending: return True
                clear_remote_pending(current, kind)
                atomic_json(p / 'meta.json', current)
            except (OSError, ValueError): s.app.logger.exception('Index of %s not saved', p.name)
        return True

    def _check_remote(self, p, kind, block):
        # True when Drive has the file; otherwise it is counted as missing (the index is kept).
        ref = self._ref(block)
        found = self.backend.stat(ref) if ref else None
        if found is None or not found.exists:
            self._note_missing(p, kind)
            return False
        self.missing.discard((p, kind))
        return True

    def _recover_moved(self, p, m, kind, e):
        # A moved file (location gdrive) whose local file is still there: removed only when every condition holds,
        # and only when it is the content that was moved (a file put there since, e.g. by a re-upload, stays).
        s, local = self.server, p / kind
        if not self._check_remote(p, kind, e) or not _local_file(p, kind): return
        if not (self.settings.effective_mode == 'move' and self.settings.allow_local_delete and isinstance(e.get('sha256'), str) and _bytes(e) > 0): return
        # Outside the lock: the local file must be the indexed content (the recorded hash only while it is unchanged).
        try:
            stat = local.stat()
            if stat.st_size != _bytes(e): return
            hashes = m.get('content_hashes')
            known = hashes.get(kind) if isinstance(hashes, dict) else None
            recorded = (isinstance(known, dict) and known.get('size') == stat.st_size and known.get('mtime_ns') == stat.st_mtime_ns
                        and known.get('sha256') == e['sha256'])
            if not recorded and _sha256(local) != e['sha256']:
                s.app.logger.warning('Local %s/%s differs from its moved copy; it is kept', p.name, kind)
                return
        except OSError: return
        verdict, _ = self._verify(self._ref(e), e['sha256'], _bytes(e), e.get('md5'))
        if verdict != 'ok':
            s.app.logger.warning('The Google Drive copy of %s/%s does not match its index; the local file is kept', p.name, kind)
            return
        with s.lock:
            try:
                current, now = s.read_meta(p), local.stat()
                if ((now.st_size, now.st_mtime_ns) == (stat.st_size, stat.st_mtime_ns) and entry(current, kind) == e
                        and current.get('conversion_revision', 0) == m.get('conversion_revision', 0) and current.get('status') == 'ready'
                        and p.name not in s.processes and not s.storage_policy.pinned(current)): local.unlink()
            except (OSError, ValueError): pass

    def _recheck_missing_remote(self):
        # Caller holds self.cycle. As _recheck_missing, against the backend; the index is never changed here.
        from archive_backends import BackendError  # archive_backends imports this module.
        for p, kind in list(self.missing):
            try: m = self.server.read_meta(p)
            except (OSError, ValueError): m = None
            e = entry(m, kind) if isinstance(m, dict) else None
            block = None if e is None else e if e['location'] == 'gdrive' else remote(m, kind) if e['location'] == 'local' else None
            if block is None:
                self.missing.discard((p, kind))
                continue
            try: self._check_remote(p, kind, block)
            except BackendError:
                self.backend.invalidate()
                return
