"""The remote (Google Drive) video being watched, held in memory so seeks do not wait on Google.

Opening a remote video starts one background download of the whole file into memory. Ranges inside the part
already received are served from it; the rest still comes from the backend. Only one video is held: opening
another drops it, and nobody watching for IDLE_SECONDS frees it. Nothing is written to disk. A file larger than
MAX_BYTES is not held, and a finished copy whose SHA-256 differs from the index's is thrown away."""
import hashlib, logging, threading, time

MAX_BYTES = 256 * 2**20
IDLE_SECONDS = 600
RETRY_SECONDS = 60  # A copy that failed is not tried again for this long (the video still streams).
BLOCK = 2**16
log = logging.getLogger(__name__)


class _Entry:
    def __init__(self, key, size, sha256, now):
        self.key, self.size, self.sha256 = key, size, sha256
        self.buf, self.done, self.complete, self.used = bytearray(size), 0, False, now


class PlaybackCache:
    def __init__(self, max_bytes=MAX_BYTES, idle_seconds=IDLE_SECONDS, clock=time.monotonic, janitor=True):
        self.max_bytes, self.idle_seconds, self.clock = max_bytes, idle_seconds, clock
        self.lock, self.entry, self.failed_at = threading.Lock(), None, {}
        if janitor: threading.Thread(target=self._janitor, name='playback-idle', daemon=True).start()

    @staticmethod
    def key(ref):
        return f'{ref.backend}:{ref.file_id}:{ref.sha256 or ""}'

    def ensure(self, ref, size, open_remote):
        """Holds this remote file (dropping any other) unless it is held already; open_remote() returns its blocks."""
        if not ref.file_id or size <= 0 or size > self.max_bytes: return
        key, now = self.key(ref), self.clock()
        with self.lock:
            if self.entry and self.entry.key == key:
                self.entry.used = now; return
            if now - self.failed_at.get(key, float('-inf')) < RETRY_SECONDS: return
            entry = self.entry = _Entry(key, size, ref.sha256, now)  # The previous video is dropped here.
        threading.Thread(target=self._fill, args=(entry, open_remote), name='playback-copy', daemon=True).start()

    def _fill(self, entry, open_remote):
        digest = hashlib.sha256()
        try:
            blocks = open_remote()
            try:
                for block in blocks:
                    with self.lock:
                        if self.entry is not entry: return  # Another video was opened, or it went idle.
                        if entry.done + len(block) > entry.size: raise ValueError('longer than indexed')
                        entry.buf[entry.done:entry.done + len(block)] = block; entry.done += len(block)
                    digest.update(block)
            finally:
                if hasattr(blocks, 'close'): blocks.close()
            ok = entry.done == entry.size and (not entry.sha256 or digest.hexdigest() == entry.sha256)
            with self.lock:
                if self.entry is not entry: return
                if ok: entry.complete = True
                else:
                    log.warning('A playback copy did not match its index (%d of %d bytes); it is not used', entry.done, entry.size)
                    self._fail(entry)
        except Exception as e:  # The backend's errors: the video keeps streaming from the backend.
            log.warning('Playback copy stopped: %s', type(e).__name__)
            with self.lock:
                if self.entry is entry: self._fail(entry)

    def _fail(self, entry):
        # Under the lock.
        self.failed_at[entry.key] = self.clock(); self.entry = None

    def expire(self):
        # Frees the held video when nobody has watched it for idle_seconds.
        with self.lock:
            if self.entry and self.clock() - self.entry.used >= self.idle_seconds: self.entry = None

    def _janitor(self):
        while True:
            time.sleep(30); self.expire()

    def wait_range(self, ref, start, end, timeout=30, step=.1):
        """Like local_range, but while the held copy of this file is still filling, waits (up to timeout) for it to
        reach start. None when it is not held (failed, dropped, too big) or does not get there in time."""
        deadline = self.clock() + timeout
        while True:
            found = self.local_range(ref, start, end)
            if found: return found
            with self.lock:
                entry = self.entry
                filling = entry is not None and entry.key == self.key(ref) and not entry.complete
            if not filling or self.clock() >= deadline: return None
            time.sleep(step)

    def local_range(self, ref, start, end):
        """(entry, end) when the held copy already has start..; end is lowered to what it has. None otherwise."""
        if not ref.file_id: return None
        with self.lock:
            entry = self.entry
            if not entry or entry.key != self.key(ref) or start >= entry.done: return None
            entry.used = self.clock()
            return entry, min(end, entry.done - 1)

    @staticmethod
    def blocks(entry, start, end):
        # The bytes below `done` never change, so reading them needs no lock (and survives the entry being dropped).
        view = memoryview(entry.buf)
        for i in range(start, end + 1, BLOCK): yield bytes(view[i:min(i + BLOCK, end + 1)])
