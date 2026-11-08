"""The in-memory copy of the remote video being watched (roadviewer/app/playback_cache.py)."""
import hashlib, os, sys, threading, time, unittest
from pathlib import Path
from types import SimpleNamespace
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'roadviewer/app'))
import playback_cache as pc


def ref(file_id, data): return SimpleNamespace(backend='gdrive', file_id=file_id, sha256=hashlib.sha256(data).hexdigest())


class PlaybackCacheTests(unittest.TestCase):
    def setUp(self):
        self.now = 0.0
        self.cache = pc.PlaybackCache(max_bytes=1000, idle_seconds=600, clock=lambda: self.now, janitor=False)

    def wait(self, done=None, timeout=5):
        # The held entry once complete (or past `done` bytes), or None once it is gone.
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            with self.cache.lock:
                e = self.cache.entry
                if e is None or e.complete or done is not None and e.done >= done: return e
            time.sleep(0.01)
        self.fail('the copy did not progress')

    def test_serves_the_received_part(self):
        data = os.urandom(300); r = ref('F1', data); gate = threading.Event()
        def blocks():
            yield data[:100]; gate.wait(5); yield data[100:]
        self.assertIsNone(self.cache.local_range(r, 0, 299))
        self.cache.ensure(r, 300, blocks); self.wait(done=100)
        entry, end = self.cache.local_range(r, 10, 299)
        self.assertEqual(end, 99)  # Shortened to what is received.
        self.assertEqual(b''.join(self.cache.blocks(entry, 10, end)), data[10:100])
        self.assertIsNone(self.cache.local_range(r, 100, 299))  # Beyond it: the backend answers.
        gate.set(); self.assertTrue(self.wait().complete)
        entry, end = self.cache.local_range(r, 250, 299)
        self.assertEqual((end, b''.join(self.cache.blocks(entry, 250, end))), (299, data[250:]))
        self.cache.ensure(r, 300, lambda: self.fail('a second copy'))  # Held already.

    def test_wait_range_waits_for_the_filling_copy(self):
        data = os.urandom(300); r = ref('W1', data); gate = threading.Event()
        def blocks():
            yield data[:100]; gate.wait(5); yield data[100:]
        cache = pc.PlaybackCache(max_bytes=1000, janitor=False)  # Real clock: wait_range times out on it.
        self.assertIsNone(cache.wait_range(r, 0, 299, timeout=.2), 'not held: no wait')
        cache.ensure(r, 300, blocks)
        threading.Timer(.2, gate.set).start()
        entry, end = cache.wait_range(r, 150, 299, timeout=5)  # Beyond what has arrived: waits for it.
        self.assertEqual(b''.join(cache.blocks(entry, 150, end)), data[150:end + 1])
        gate2 = threading.Event(); other = os.urandom(300); r2 = ref('W2', other)
        def stuck():
            yield other[:10]; gate2.wait(5); yield other[10:]
        cache.ensure(r2, 300, stuck)
        started = time.monotonic()
        self.assertIsNone(cache.wait_range(r2, 200, 299, timeout=.3), 'gives up after the timeout')
        self.assertLess(time.monotonic() - started, 2); gate2.set()

    def test_only_the_video_being_watched_is_held(self):
        a, b = os.urandom(400), os.urandom(400); ra, rb = ref('A', a), ref('B', b)
        self.cache.ensure(ra, 400, lambda: iter([a])); self.wait()
        held = self.cache.local_range(ra, 0, 399)[0]
        self.cache.ensure(rb, 400, lambda: iter([b])); self.wait()
        self.assertIsNone(self.cache.local_range(ra, 0, 1), 'opening another video drops the previous one')
        self.assertIsNotNone(self.cache.local_range(rb, 0, 1))
        self.assertEqual(b''.join(self.cache.blocks(held, 0, 399)), a, 'a response already reading it is not cut')

    def test_a_copy_overtaken_by_another_video_stops(self):
        a, b = os.urandom(300), os.urandom(300); ra, rb = ref('A', a), ref('B', b); gate, pulled = threading.Event(), []
        def slow():
            yield a[:100]; gate.wait(5); pulled.append(1); yield a[100:]
        self.cache.ensure(ra, 300, slow); self.wait(done=100)
        self.cache.ensure(rb, 300, lambda: iter([b])); self.wait()
        gate.set(); time.sleep(0.1)
        self.assertEqual(self.cache.entry.key, self.cache.key(rb)); self.assertIsNone(self.cache.local_range(ra, 0, 1))

    def test_idle_video_is_freed(self):
        data = os.urandom(200); r = ref('F', data)
        self.cache.ensure(r, 200, lambda: iter([data])); self.wait()
        self.now += 599; self.cache.local_range(r, 0, 1)  # Watched: the idle clock restarts.
        self.now += 599; self.cache.expire(); self.assertIsNotNone(self.cache.entry)
        self.now += 1; self.cache.expire(); self.assertIsNone(self.cache.entry)

    def test_copy_that_does_not_match_is_dropped_and_not_retried_at_once(self):
        data = os.urandom(200); r = ref('F2', data); calls = []
        def damaged():
            calls.append(1); yield bytes(200)
        self.cache.ensure(r, 200, damaged); self.assertIsNone(self.wait())
        self.assertIsNone(self.cache.local_range(r, 0, 10))
        self.cache.ensure(r, 200, damaged); self.assertEqual(len(calls), 1)  # Within RETRY_SECONDS.
        self.now += pc.RETRY_SECONDS
        self.cache.ensure(r, 200, lambda: iter([data])); self.assertTrue(self.wait().complete)

    def test_backend_failure_or_too_large(self):
        data = os.urandom(200); r = ref('F3', data)
        def broken():
            yield data[:50]; raise OSError('gone')
        self.cache.ensure(r, 200, broken); self.assertIsNone(self.wait())
        self.assertIsNone(self.cache.local_range(r, 0, 10))
        self.cache.ensure(ref('BIG', data), 1001, lambda: self.fail('larger than max_bytes'))
        self.assertIsNone(self.cache.entry)


if __name__ == '__main__':
    unittest.main()
