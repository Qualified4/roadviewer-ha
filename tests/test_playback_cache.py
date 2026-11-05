"""The scratch copy of remote videos being watched (roadviewer/app/playback_cache.py)."""
import hashlib, os, sys, tempfile, threading, time, unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'roadviewer/app'))
import playback_cache as pc


def ref(file_id, data): return SimpleNamespace(backend='gdrive', file_id=file_id, sha256=hashlib.sha256(data).hexdigest())


class PlaybackCacheTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(); self.addCleanup(temp.cleanup)
        self.dir = Path(temp.name) / 'cache'; self.now = 0.0
        self.cache = pc.PlaybackCache(self.dir, max_bytes=1000, disk_margin=0, clock=lambda: self.now)

    def wait(self, r, done=None, timeout=5):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            with self.cache.lock:
                e = self.cache.entries.get(self.cache.key(r))
                if e is None or e.complete or done is not None and e.done >= done: return e
            time.sleep(0.01)
        self.fail('the copy did not progress')

    def test_starts_empty_and_serves_the_written_part(self):
        (self.dir / 'old').write_bytes(b'x'); cache = pc.PlaybackCache(self.dir, max_bytes=1000, disk_margin=0)
        self.assertEqual(list(self.dir.iterdir()), [])  # Emptied on start.
        data = os.urandom(300); r = ref('F1', data); gate = threading.Event()
        def blocks():
            yield data[:100]; gate.wait(5); yield data[100:]
        self.assertIsNone(cache.local_range(r, 0, 299))
        cache.ensure(r, 300, blocks); self.cache = cache
        self.wait(r, done=100)
        path, end = cache.local_range(r, 10, 299)
        self.assertEqual(end, 99)  # Shortened to what is written.
        self.assertEqual(b''.join(cache.blocks(path, 10, end)), data[10:100])
        self.assertIsNone(cache.local_range(r, 100, 299))  # Beyond it: the backend answers.
        gate.set(); self.assertTrue(self.wait(r).complete)
        path, end = cache.local_range(r, 250, 299)
        self.assertEqual((end, b''.join(cache.blocks(path, 250, end))), (299, data[250:]))
        cache.ensure(r, 300, lambda: self.fail('a second copy'))  # One copy per file.

    def test_copy_that_does_not_match_is_dropped_and_not_retried_at_once(self):
        data = os.urandom(200); r = ref('F2', data); calls = []
        def damaged():
            calls.append(1); yield bytes(200)
        self.cache.ensure(r, 200, damaged); self.assertIsNone(self.wait(r))
        self.assertIsNone(self.cache.local_range(r, 0, 10)); self.assertEqual(list(self.dir.iterdir()), [])
        self.cache.ensure(r, 200, damaged); self.assertEqual(len(calls), 1)  # Within RETRY_SECONDS.
        self.now += pc.RETRY_SECONDS
        self.cache.ensure(r, 200, lambda: iter([data])); self.assertTrue(self.wait(r).complete)

    def test_backend_failure_drops_the_copy(self):
        data = os.urandom(200); r = ref('F3', data)
        def broken():
            yield data[:50]; raise OSError('gone')
        self.cache.ensure(r, 200, broken); self.assertIsNone(self.wait(r))
        self.assertIsNone(self.cache.local_range(r, 0, 10)); self.assertEqual(list(self.dir.iterdir()), [])

    def test_least_recently_watched_copy_makes_room(self):
        a, b, c = os.urandom(400), os.urandom(400), os.urandom(400)
        ra, rb, rc = ref('A', a), ref('B', b), ref('C', c)
        self.cache.ensure(ra, 400, lambda: iter([a])); self.wait(ra)
        self.now += 1; self.cache.ensure(rb, 400, lambda: iter([b])); self.wait(rb)
        self.now += 1; self.cache.local_range(ra, 0, 1)  # A watched again: B is now the oldest.
        self.now += 1; self.cache.ensure(rc, 400, lambda: iter([c])); self.wait(rc)
        self.assertIsNotNone(self.cache.local_range(ra, 0, 1)); self.assertIsNone(self.cache.local_range(rb, 0, 1))
        self.assertIsNotNone(self.cache.local_range(rc, 0, 1))
        self.assertEqual(sorted(p.name for p in self.dir.iterdir()), sorted([self.cache.key(ra), self.cache.key(rc)]))

    def test_too_large_or_disk_low_is_not_copied(self):
        data = os.urandom(100)
        self.cache.ensure(ref('BIG', data), 1001, lambda: self.fail('larger than the cache'))
        self.cache.disk_margin = 10**18
        self.cache.ensure(ref('LOW', data), 100, lambda: self.fail('would leave too little disk'))
        self.assertEqual(self.cache.entries, {})


if __name__ == '__main__':
    unittest.main()
