"""Archive settings, NAS availability via the sentinel, and media path resolution."""
import json, os, sys, tempfile, threading, unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'roadviewer/app'))
import media_store as m
from video_sources import STORED_KINDS

ID = 'a'*32

class Clock:
 def __init__(self): self.t = 1000.0
 def __call__(self): return self.t

class MediaStoreTests(unittest.TestCase):
 def setUp(self):
  tmp = tempfile.TemporaryDirectory(); self.addCleanup(tmp.cleanup)
  self.root = Path(tmp.name)/'data'; self.root.mkdir()
  self.nas = Path(tmp.name)/'share'; self.nas.mkdir()
  self.rec = self.root/ID; self.rec.mkdir()
  self.clock = Clock()
 def store(self, enabled=True):
  return m.ArchiveStore(m.ArchiveSettings(enabled=enabled, path=self.nas), self.root, clock=self.clock)
 def connected(self):
  store = self.store(); store.activate(); self.assertEqual(store.state(), 'connected'); return store

 def test_from_options_defaults_off(self):
  s = m.ArchiveSettings.from_options({})
  self.assertEqual((s.enabled, s.path, s.error), (False, None, None))
  self.assertEqual((s.local_threshold_bytes, s.min_age_seconds, s.interval_seconds, s.batch, s.nas_max_bytes, s.nas_margin_bytes), (0, 86400, 600, 4, 0, 1024*2**20))
  s = m.ArchiveSettings.from_options({'archive_enabled': True, 'archive_path': '/share/nas/roadviewer', 'archive_local_threshold_mb': 2, 'archive_min_age_hours': 1, 'archive_interval_minutes': 5, 'archive_batch': 8, 'archive_nas_max_mb': 3, 'archive_nas_margin_mb': 0})
  self.assertEqual((s.enabled, s.path, s.error), (True, Path('/share/nas/roadviewer'), None))
  self.assertEqual((s.local_threshold_bytes, s.min_age_seconds, s.interval_seconds, s.batch, s.nas_max_bytes, s.nas_margin_bytes), (2*2**20, 3600, 300, 8, 3*2**20, 0))
  self.assertEqual(set(m.ARCHIVE_ORDER), set(STORED_KINDS)); self.assertEqual(m.ARCHIVE_ORDER[-1], 'rlog.zst'); self.assertIs(m.MEDIA_KINDS, STORED_KINDS)

 def test_from_options_rejects_bad_path(self):
  with patch.dict(os.environ, {'RV_ARCHIVE_ALLOW_ANY_PATH': ''}):
   for path in ['/data/x', '/share', '/share/', '/share/nas/../data', '/share/nas/./x', 'share/nas', '/share/n as', '', str(self.nas)]:
    s = m.ArchiveSettings.from_options({'archive_enabled': True, 'archive_path': path})
    self.assertFalse(s.enabled, path); self.assertIsNone(s.path, path); self.assertTrue(s.error, path)
   self.assertTrue(m.ArchiveSettings.from_options({'archive_enabled': True, 'archive_path': '/share/nas_1/road.viewer-2'}).enabled)
  with patch.dict(os.environ, {'RV_ARCHIVE_ALLOW_ANY_PATH': '1'}):
   s = m.ArchiveSettings.from_options({'archive_enabled': True, 'archive_path': str(self.nas)})
   self.assertEqual((s.enabled, s.path, s.error), (True, self.nas, None))
   self.assertFalse(m.ArchiveSettings.from_options({'archive_enabled': True, 'archive_path': str(self.nas/'..'/'x')}).enabled)

 def test_disabled_store_resolves_local_only(self):
  store = self.store(enabled=False); meta = {'id': ID}
  self.assertEqual((store.state(), store.available(), store.usage()), ('disabled', False, (0, 0)))
  self.assertEqual(m.resolve(self.rec, meta, 'rlog.zst', store), (None, 'missing'))
  (self.rec/'rlog.zst').write_bytes(b'log')
  self.assertEqual(m.resolve(self.rec, meta, 'rlog.zst', store), (self.rec/'rlog.zst', 'available'))
  self.assertEqual(m.media_size(self.rec, meta, 'rlog.zst', store), 3)
  # A NAS entry left over from an earlier enabled run is unreachable, never "missing".
  m.set_location(meta, 'fcamera.mp4', location='nas', bytes=9)
  self.assertEqual(m.resolve(self.rec, meta, 'fcamera.mp4', store), (None, 'storage_unavailable'))
  store.activate(); self.assertFalse((self.nas/m.SENTINEL).exists()); self.assertFalse((self.root/m.LOCAL_COPY).exists())

 def test_empty_mount_dir_is_unavailable(self):
  store = self.connected(); meta = {'id': ID}
  m.set_location(meta, 'fcamera.mp4', location='nas', bytes=5)
  (self.nas/m.SENTINEL).unlink(); store.invalidate()
  self.assertEqual((store.state(), store.reason(), store.available()), ('unavailable', 'sentinel_missing', False))
  self.assertEqual(m.resolve(self.rec, meta, 'fcamera.mp4', store), (None, 'storage_unavailable'))
  self.assertEqual(store.usage(), (0, 0))
  # Activation must not re-create a sentinel inside an empty (unmounted) directory.
  store.activate(); self.assertFalse((self.nas/m.SENTINEL).exists()); self.assertEqual(store.state(), 'unavailable')
  self.nas.rmdir(); store.invalidate()
  self.assertEqual((store.state(), store.reason()), ('unavailable', 'path_missing'))
  self.nas.mkdir(); (self.nas/m.SENTINEL).write_text('{not json'); store.invalidate()
  self.assertEqual((store.state(), store.reason()), ('unavailable', 'sentinel_invalid'))
  with patch.object(m.Path, 'is_dir', side_effect=OSError(5, 'EIO')):
   store.invalidate(); self.assertEqual((store.state(), store.reason()), ('unavailable', 'os_error'))

 def test_storage_id_mismatch_is_unavailable(self):
  store = self.connected()
  sentinel = json.loads((self.nas/m.SENTINEL).read_text())
  self.assertEqual(sentinel['owner'], 'roadviewer'); self.assertEqual(len(sentinel['storage_id']), 32)
  self.assertEqual(json.loads((self.root/m.LOCAL_COPY).read_text()), {'storage_id': sentinel['storage_id']})
  (self.nas/m.SENTINEL).write_text(json.dumps(dict(sentinel, storage_id='b'*32))); store.invalidate()
  self.assertEqual((store.state(), store.reason()), ('unavailable', 'storage_id_mismatch'))
  # Verify only: an existing foreign sentinel is never overwritten.
  store.activate(); self.assertEqual(json.loads((self.nas/m.SENTINEL).read_text())['storage_id'], 'b'*32)
  # A share already claimed by another instance is not adopted by a fresh install.
  (self.root/m.LOCAL_COPY).unlink(); store.activate()
  self.assertFalse((self.root/m.LOCAL_COPY).exists()); self.assertEqual((store.state(), store.reason()), ('unavailable', 'storage_id_mismatch'))
  # A sentinel without an id never matches a missing local copy.
  (self.nas/m.SENTINEL).write_text('{"owner": "roadviewer"}'); store.invalidate()
  self.assertEqual((store.state(), store.reason()), ('unavailable', 'storage_id_mismatch'))

 def test_connected_resolves_nas_file(self):
  store = self.connected(); meta = {'id': ID}
  self.assertEqual(store.path_for(ID, 'fcamera.mp4'), self.nas/ID/'fcamera.mp4')
  (self.nas/ID).mkdir(); (self.nas/ID/'fcamera.mp4').write_bytes(b'video')
  m.set_location(meta, 'fcamera.mp4', location='nas', bytes=5, sha256='x', archived_at=1.0)
  self.assertEqual(m.location(meta, 'fcamera.mp4'), 'nas'); self.assertEqual(m.location(meta, 'rlog.zst'), 'local')
  self.assertEqual(m.entry(meta, 'camera.mp4'), {'location': 'local'})
  self.assertEqual(m.resolve(self.rec, meta, 'fcamera.mp4', store), (self.nas/ID/'fcamera.mp4', 'available'))
  self.assertEqual(m.media_size(self.rec, meta, 'fcamera.mp4', store), 5)
  self.assertEqual(m.archived_bytes(meta), 5)
  used, free = store.usage(); self.assertEqual(used, 5 + (self.nas/m.SENTINEL).stat().st_size); self.assertGreater(free, 0)
  m.set_location(meta, 'fcamera.mp4', location='nas', bytes=5, error='sha256_mismatch')
  self.assertEqual(m.entry(meta, 'fcamera.mp4'), {'location': 'nas', 'bytes': 5, 'error': 'sha256_mismatch'})
  self.assertEqual(m.resolve(self.rec, meta, 'fcamera.mp4', store), (self.nas/ID/'fcamera.mp4', 'corrupt'))

 def test_missing_nas_file_is_missing_not_unavailable(self):
  store = self.connected(); meta = {'id': ID}
  m.set_location(meta, 'ecamera.mp4', location='nas', bytes=7)
  self.assertEqual(m.resolve(self.rec, meta, 'ecamera.mp4', store), (None, 'missing'))

 def test_availability_cached_10s(self):
  store = self.connected()
  (self.nas/m.SENTINEL).unlink()
  self.clock.t += 9.9; self.assertTrue(store.available())
  self.clock.t += 0.1; self.assertFalse(store.available())
  store.activate()  # local copy present: verify only, no new sentinel
  self.assertFalse((self.nas/m.SENTINEL).exists())

 def test_first_probe_in_progress_is_checking(self):
  store = self.store(); store.activate(); store.invalidate()
  entered, release = threading.Event(), threading.Event()
  probe = store._probe
  def slow(): entered.set(); release.wait(5); return probe()
  meta = {'id': ID}; m.set_location(meta, 'fcamera.mp4', location='nas', bytes=1)
  with patch.object(store, '_probe', side_effect=slow):
   t = threading.Thread(target=store.available); t.start(); entered.wait(5)
   self.assertEqual(store.state(), 'checking'); self.assertEqual(m.resolve(self.rec, meta, 'fcamera.mp4', store), (None, 'checking'))
   release.set(); t.join(5)
  self.assertEqual(store.state(), 'connected')

 def test_stale_connected_not_served_while_probe_hangs(self):
  store = self.connected()
  self.clock.t += 10
  entered, release = threading.Event(), threading.Event()
  probe = store._probe
  def hung(): entered.set(); release.wait(5); return probe()
  with patch.object(store, '_probe', side_effect=hung):
   t = threading.Thread(target=store.available); t.start(); entered.wait(5)
   self.assertEqual((store.state(), store.reason()), ('checking', 'probe_pending')); self.assertFalse(store.available())
   release.set(); t.join(5)
  self.assertTrue(store.available())

 def test_from_options_coerces_and_clamps(self):
  for value, expected in [(True, True), ('true', True), ('TRUE', True), ('1', True), ('false', False), ('0', False), ('', False), (None, False), (1, False), ('yes', False)]:
   self.assertEqual(m.ArchiveSettings.from_options({'archive_enabled': value, 'archive_path': '/share/nas/rv'}).enabled, expected, value)
  s = m.ArchiveSettings.from_options({'archive_local_threshold_mb': 'abc', 'archive_min_age_hours': None, 'archive_interval_minutes': '0', 'archive_batch': 0, 'archive_nas_max_mb': -5, 'archive_nas_margin_mb': [1]})
  self.assertEqual((s.local_threshold_bytes, s.min_age_seconds, s.interval_seconds, s.batch, s.nas_max_bytes, s.nas_margin_bytes), (0, 86400, 60, 1, 0, 1024*2**20))
  s = m.ArchiveSettings.from_options({'archive_local_threshold_mb': '7', 'archive_min_age_hours': 9999, 'archive_interval_minutes': 5000, 'archive_batch': '100', 'archive_nas_margin_mb': -1})
  self.assertEqual((s.local_threshold_bytes, s.min_age_seconds, s.interval_seconds, s.batch, s.nas_margin_bytes), (7*2**20, 8760*3600, 1440*60, 64, 0))

 def test_unknown_kind_rejected(self):
  store = self.connected(); meta = {'id': ID}
  for kind in ['../x', 'meta.json', '']:
   with self.assertRaises(ValueError): store.path_for(ID, kind)
   with self.assertRaises(ValueError): m.resolve(self.rec, meta, kind, store)

 def test_bad_index_bytes_count_as_zero(self):
  store = self.store(); meta = {'id': ID}
  for value in ['abc', None, True, -3, [1]]:
   m.set_location(meta, 'fcamera.mp4', location='nas', bytes=value); m.set_location(meta, 'ecamera.mp4', location='nas', bytes=4)
   self.assertEqual(m.media_size(self.rec, meta, 'fcamera.mp4', store), 0, value); self.assertEqual(m.archived_bytes(meta), 4, value)
  m.set_location(meta, 'fcamera.mp4', location='nas')
  self.assertEqual(m.media_size(self.rec, meta, 'fcamera.mp4', store), 0); self.assertEqual(m.archived_bytes(meta), 4)

 def test_removed_is_missing(self):
  store = self.connected(); meta = {'id': ID}
  (self.rec/'fcamera.mp4').write_bytes(b'stale')
  m.set_location(meta, 'fcamera.mp4', location='removed', removed_at=1.0, reason='nas_full')
  self.assertEqual(m.resolve(self.rec, meta, 'fcamera.mp4', store), (None, 'missing'))
  self.assertEqual(m.media_size(self.rec, meta, 'fcamera.mp4', store), 0)
  self.assertEqual(m.archived_bytes(meta), 0)

if __name__ == '__main__':
 unittest.main()
