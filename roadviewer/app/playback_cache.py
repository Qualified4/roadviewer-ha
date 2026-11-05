"""A temporary local copy of remote (Google Drive) videos being watched, so seeks do not wait on Google.

Opening a remote video starts one background download of the whole file into a scratch folder. Ranges inside the
part already written are served from it; the rest still comes from the backend. The folder is emptied when the
add-on starts, holds at most MAX_BYTES (least recently watched files go first), never fills the disk below
DISK_MARGIN, and a finished copy whose SHA-256 differs from the index's is thrown away. Nothing here is part of the
recording's storage: it is never archived, counted against the storage limit or kept across restarts."""
import hashlib, logging, os, shutil, threading, time
from pathlib import Path

MAX_BYTES = 2**30
DISK_MARGIN = 2 * 2**30
BLOCK = 2**16
RETRY_SECONDS = 60  # A copy that failed is not tried again for this long (the video still streams).
log = logging.getLogger(__name__)


class _Entry:
    def __init__(self, path, size, sha256):
        self.path, self.size, self.sha256 = path, size, sha256
        self.done, self.complete, self.failed, self.used = 0, False, False, time.monotonic()


class PlaybackCache:
    def __init__(self, root, max_bytes=MAX_BYTES, disk_margin=DISK_MARGIN, clock=time.monotonic):
        self.root, self.max_bytes, self.disk_margin, self.clock = Path(root), max_bytes, disk_margin, clock
        self.lock, self.entries, self.failed_at = threading.Lock(), {}, {}
        shutil.rmtree(self.root, ignore_errors=True)  # Never kept across restarts.
        self.root.mkdir(parents=True, exist_ok=True)

    @staticmethod
    def key(ref):
        return hashlib.sha256(f'{ref.backend}:{ref.file_id}:{ref.sha256 or ""}'.encode()).hexdigest()[:40]

    def ensure(self, ref, size, open_remote):
        """Starts the background copy of a remote file unless there is one; open_remote() returns its blocks."""
        if not ref.file_id or size <= 0 or size > self.max_bytes: return
        key = self.key(ref)
        with self.lock:
            entry = self.entries.get(key)
            if entry and not entry.failed:
                entry.used = self.clock(); return
            if self.clock() - self.failed_at.get(key, float('-inf')) < RETRY_SECONDS: return
            if not self._make_room(size): return
            entry = self.entries[key] = _Entry(self.root / key, size, ref.sha256)
            entry.used = self.clock()
        threading.Thread(target=self._fill, args=(key, entry, open_remote), name='playback-cache', daemon=True).start()

    def _make_room(self, size):
        # Under the lock. Drops the least recently watched copies not being written until size fits.
        def total(): return sum(e.size for e in self.entries.values() if not e.failed)
        for key, entry in sorted(self.entries.items(), key=lambda item: item[1].used):
            if total() + size <= self.max_bytes: break
            if entry.complete or entry.failed: self._drop(key)
        if total() + size > self.max_bytes: return False
        try: free = shutil.disk_usage(self.root).free
        except OSError: return False
        return free - size >= self.disk_margin

    def _fail(self, key, entry):
        # Under the lock.
        entry.failed = True; self.failed_at[key] = self.clock(); self._drop(key)

    def _drop(self, key):
        entry = self.entries.pop(key, None)
        if entry:
            try: entry.path.unlink()
            except FileNotFoundError: pass
            except OSError as e: log.warning('Could not remove a playback copy: %s', type(e).__name__)

    def _fill(self, key, entry, open_remote):
        digest = hashlib.sha256()
        try:
            with open(entry.path, 'wb') as f:
                blocks = open_remote()
                try:
                    for block in blocks:
                        f.write(block); f.flush(); digest.update(block)
                        with self.lock:
                            if self.entries.get(key) is not entry: return  # Dropped meanwhile.
                            entry.done += len(block)
                finally:
                    if hasattr(blocks, 'close'): blocks.close()
            ok = entry.done == entry.size and (not entry.sha256 or digest.hexdigest() == entry.sha256)
            with self.lock:
                if self.entries.get(key) is not entry: return
                if ok: entry.complete = True
                else:
                    log.warning('A playback copy did not match its index (%d of %d bytes); it is not used', entry.done, entry.size)
                    self._fail(key, entry)
        except Exception as e:  # The backend's errors, a full disk: the video keeps streaming from the backend.
            log.warning('Playback copy stopped: %s', type(e).__name__)
            with self.lock:
                if self.entries.get(key) is entry: self._fail(key, entry)

    def local_range(self, ref, start, end):
        """(path, end) when the copy already holds start..; end is lowered to what it holds. None otherwise."""
        if not ref.file_id: return None
        with self.lock:
            entry = self.entries.get(self.key(ref))
            if not entry or entry.failed or start >= entry.done: return None
            entry.used = self.clock()
            return entry.path, min(end, entry.done - 1)

    def blocks(self, path, start, end):
        with open(path, 'rb') as f:
            f.seek(start); left = end - start + 1
            while left > 0:
                data = f.read(min(BLOCK, left))
                if not data: return
                left -= len(data); yield data
