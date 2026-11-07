"""Archive settings, NAS availability via the sentinel, and media path resolution."""
import json, os, sys, tempfile, threading, unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'roadviewer/app'))
os.environ['RV_ARCHIVE_ALLOW_ANY_PATH'] = '1'  # Temporary directories stand in for the share.
import media_store as m
from archive_backends import BackendError, RemoteRef, RemoteStat
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
  self.assertEqual((s.local_threshold_bytes, s.min_age_seconds, s.interval_seconds, s.batch, s.nas_max_bytes, s.nas_margin_bytes), (0, 86400, 86400, 4, 0, 1024*2**20))
  s = m.ArchiveSettings.from_options({'archive_enabled': True, 'archive_path': '/share/nas/roadviewer', 'archive_local_threshold_mb': 2, 'archive_min_age_hours': 1, 'archive_interval_minutes': 5, 'archive_batch': 8, 'archive_nas_max_mb': 3, 'archive_nas_margin_mb': 0})
  self.assertEqual((s.enabled, s.path, s.error), (True, Path('/share/nas/roadviewer'), None))
  self.assertEqual((s.local_threshold_bytes, s.min_age_seconds, s.interval_seconds, s.batch, s.nas_max_bytes, s.nas_margin_bytes), (2*2**20, 3600, 300, 8, 3*2**20, 0))
  self.assertEqual(set(m.ARCHIVE_ORDER), set(STORED_KINDS)); self.assertEqual(m.ARCHIVE_ORDER[-1], 'rlog.zst'); self.assertIs(m.MEDIA_KINDS, STORED_KINDS)

 def test_from_options_rejects_bad_path(self):
  with patch.dict(os.environ, {'RV_ARCHIVE_ALLOW_ANY_PATH': ''}):
   # The share's root itself is refused: a sub-folder is required.
   for path in ['/data/x', '/share', '/share/', '/share/nas', '/share/nas/', '/share/nas/../data', '/share/nas/./x', 'share/nas', '/share/n as', '/share/nas/a b', '', str(self.nas)]:
    s = m.ArchiveSettings.from_options({'archive_enabled': True, 'archive_path': path})
    self.assertFalse(s.enabled, path); self.assertIsNone(s.path, path); self.assertTrue(s.error, path)
   self.assertTrue(m.ArchiveSettings.from_options({'archive_enabled': True, 'archive_path': '/share/nas_1/road.viewer-2'}).enabled)
   self.assertTrue(m.ArchiveSettings.from_options({'archive_enabled': True, 'archive_path': '/share/nas/a/b'}).enabled)
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

 def test_first_activation_requires_mounted_share(self):
  # A fresh setup claims the folder only while /share/<name> is a mount point: an unmounted share is an empty directory.
  settings = m.ArchiveSettings(enabled=True, path=Path('/share/nas/roadviewer'))
  store = m.ArchiveStore(settings, self.root, clock=self.clock)
  with patch.dict(os.environ, {'RV_ARCHIVE_ALLOW_ANY_PATH': ''}), patch.object(m.os.path, 'ismount', return_value=False) as ismount:
   self.assertFalse(store.mounted()); ismount.assert_called_once_with('/share/nas')
  with patch.dict(os.environ, {'RV_ARCHIVE_ALLOW_ANY_PATH': ''}), patch.object(m.os.path, 'ismount', return_value=True):
   self.assertTrue(store.mounted())
  # The same with a real folder: not mounted, nothing is written; mounted, the sentinel and local copy appear.
  store = self.store()
  with patch.object(store, 'mounted', return_value=False):
   store.activate()
  self.assertFalse((self.nas/m.SENTINEL).exists()); self.assertFalse((self.root/m.LOCAL_COPY).exists())
  self.assertEqual((store.state(), store.reason()), ('unavailable', 'sentinel_missing'))
  with patch.object(store, 'mounted', return_value=True):
   store.activate()
  self.assertEqual(store.state(), 'connected')
  # Once set up, the mount is not asked again: verification is by the storage id.
  with patch.object(store, 'mounted', side_effect=AssertionError('asked again')):
   store.activate()
  self.assertEqual(store.state(), 'connected')

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

 def test_lookup_miss_rechecks_the_share(self):
  """Reproducible with a mock filesystem: an archived file not found is confirmed against the sentinel. A share
  that dropped during the lookup is unavailable, one being probed is checking; only a reachable share says
  missing. A real unmount between the two calls requires a real SMB mount."""
  meta = {'id': ID}; m.set_location(meta, 'ecamera.mp4', location='nas', bytes=7)
  store = self.connected()  # Sentinel present: the file is really not there.
  self.assertEqual(m.resolve(self.rec, meta, 'ecamera.mp4', store), (None, 'missing'))
  (self.nas/m.SENTINEL).rename(self.nas/'sentinel')  # Dropped after the cached "connected".
  self.assertTrue(store.available())
  self.assertEqual(m.resolve(self.rec, meta, 'ecamera.mp4', store), (None, 'storage_unavailable'))
  (self.nas/'sentinel').rename(self.nas/m.SENTINEL); store.invalidate(); self.assertTrue(store.available())
  real = store.invalidate
  def probing():
   real()
   self.assertTrue(store.lock.acquire(blocking=False)); self.addCleanup(store.lock.release)  # Another probe runs.
  with patch.object(store, 'invalidate', side_effect=probing):
   self.assertEqual(m.resolve(self.rec, meta, 'ecamera.mp4', store), (None, 'checking'))

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

 def test_usage_is_cached_and_invalidated(self):
  # The settings panel polls every few seconds; the share's tree is walked at most every 10 s.
  store = self.connected(); first = store.usage()
  (self.nas/ID).mkdir(); (self.nas/ID/'fcamera.mp4').write_bytes(b'video')
  self.clock.t += 9.9; self.assertEqual(store.usage(), first)
  self.clock.t += 0.1; self.assertEqual(store.usage()[0], first[0] + 5)
  (self.nas/ID/'fcamera.mp4').write_bytes(b'videovideo')
  store.forget_usage(); self.assertEqual(store.usage()[0], first[0] + 10)
  (self.nas/ID/'fcamera.mp4').unlink(); store.invalidate(); self.assertEqual(store.usage()[0], first[0])
  # Never served from the cache once the share is gone, and a read error is not cached.
  (self.nas/m.SENTINEL).rename(self.nas/'aside'); store.invalidate(); self.assertEqual(store.usage(), (0, 0))
  (self.nas/'aside').rename(self.nas/m.SENTINEL); store.invalidate()
  with patch.object(m.os, 'walk', side_effect=OSError(5, 'EIO')): self.assertEqual(store.usage(), (0, 0))
  self.assertEqual(store.usage()[0], first[0])

 def test_from_options_backend_and_effective_mode(self):
  s = m.ArchiveSettings.from_options({})
  self.assertEqual((s.backend, s.mode, s.allow_local_delete, s.effective_mode, s.requires_client), ('smb', 'move', False, 'move', False))
  self.assertEqual((s.gdrive_client_id, s.gdrive_client_secret, s.gdrive_folder_name), ('', '', 'Road Viewer'))
  self.assertEqual(m.ArchiveSettings.from_options({'archive_mode': 'copy'}).effective_mode, 'copy')
  base = {'archive_enabled': True, 'archive_backend': 'gdrive'}
  for extra, expected in [({}, 'copy'), ({'archive_mode': 'move'}, 'copy'), ({'archive_allow_local_delete': True}, 'move'),
                          ({'archive_mode': 'copy', 'archive_allow_local_delete': True}, 'copy'), ({'archive_mode': 'move', 'archive_allow_local_delete': 'true'}, 'move')]:
   s = m.ArchiveSettings.from_options({**base, **extra})
   self.assertEqual((s.backend, s.effective_mode, s.requires_client), ('gdrive', expected, True), extra)
  # Unknown values fall back to the defaults; the folder name is never empty.
  s = m.ArchiveSettings.from_options({**base, 'archive_mode': 'mirror', 'archive_allow_local_delete': 'yes', 'archive_gdrive_client_id': 'cid', 'archive_gdrive_client_secret': 'sec', 'archive_gdrive_folder_name': '  '})
  self.assertEqual((s.mode, s.allow_local_delete, s.gdrive_client_id, s.gdrive_client_secret, s.gdrive_folder_name), ('move', False, 'cid', 'sec', 'Road Viewer'))
  s = m.ArchiveSettings.from_options({**base, 'archive_gdrive_client_id': 5, 'archive_gdrive_folder_name': 'Dashcam'})
  self.assertEqual((s.gdrive_client_id, s.gdrive_folder_name), ('', 'Dashcam'))
  # An unknown backend never archives anywhere.
  for value in ['ftp', '', None, 'GDRIVE']:
   s = m.ArchiveSettings.from_options({'archive_enabled': True, 'archive_path': str(self.nas), 'archive_backend': value})
   self.assertEqual((s.backend, s.enabled, s.error), ('smb', False, 'invalid_backend'), value)
  # The secret never appears in the settings' repr.
  self.assertNotIn('s3cr3t', repr(m.ArchiveSettings.from_options({'archive_gdrive_client_secret': 's3cr3t'})))

 def test_gdrive_without_path_is_enabled(self):
  with patch.dict(os.environ, {'RV_ARCHIVE_ALLOW_ANY_PATH': ''}):
   for path in ['', '/data/x', None]:
    s = m.ArchiveSettings.from_options({'archive_enabled': True, 'archive_backend': 'gdrive', 'archive_path': path})
    self.assertEqual((s.enabled, s.path, s.error), (True, None, None), path)
   self.assertFalse(m.ArchiveSettings.from_options({'archive_backend': 'gdrive'}).enabled)
   # SMB still requires a valid path.
   s = m.ArchiveSettings.from_options({'archive_enabled': True, 'archive_backend': 'smb', 'archive_path': ''})
   self.assertEqual((s.enabled, s.error), (False, 'invalid_archive_path'))

 def remote_block(self, **kw): return {'backend': 'gdrive', 'file_id': 'F1', 'bytes': 7, 'sha256': 'ab'*32, 'md5': 'cd'*16, 'uploaded_at': 1.0, 'verified_by': 'sha256', **kw}

 def test_resolve_local_preferred_over_remote_copy(self):
  meta = {'id': ID}; backend = FakeBackend()
  m.set_location(meta, 'fcamera.mp4', location='local'); m.set_remote(meta, 'fcamera.mp4', **self.remote_block())
  (self.rec/'fcamera.mp4').write_bytes(b'video!!')
  self.assertEqual(m.resolve(self.rec, meta, 'fcamera.mp4', None, backend), (self.rec/'fcamera.mp4', 'available'))
  self.assertEqual(backend.calls, [])  # The local copy is used without asking the backend.
  self.assertEqual(m.indexed_state(self.rec, meta, 'fcamera.mp4', 'unavailable'), 'available')
  self.assertEqual(m.media_size(self.rec, meta, 'fcamera.mp4', None), 7)
  # Without the local file the remote copy is used.
  (self.rec/'fcamera.mp4').unlink()
  rf, state = m.resolve(self.rec, meta, 'fcamera.mp4', None, backend)
  self.assertEqual(state, 'available'); self.assertIsInstance(rf, m.RemoteFile)
  self.assertEqual((rf.backend_kind, rf.kind, rf.size, rf.ref.file_id, rf.ref.bytes, rf.ref.sha256, rf.ref.md5, rf.etag), ('gdrive', 'fcamera.mp4', 7, 'F1', 7, 'ab'*32, 'cd'*16, '"F1:' + 'ab'*8 + '"'))
  self.assertEqual(m.media_size(self.rec, meta, 'fcamera.mp4', None), 7)
  self.assertEqual(m.resolve(self.rec, meta, 'fcamera.mp4', None, None), (None, 'storage_unavailable'))
  for share, expected in [('connected', 'available'), ('unavailable', 'storage_unavailable'), ('disabled', 'storage_unavailable'), ('checking', 'checking'), (None, 'checking')]:
   self.assertEqual(m.indexed_state(self.rec, meta, 'fcamera.mp4', share), expected, share)
  # The remote copy is checked against its index too, and only by a backend of its own kind.
  rf, state = m.resolve(self.rec, meta, 'fcamera.mp4', None, FakeBackend(result=FakeBackend.stat_of(8)))
  self.assertEqual((state, rf.size), ('corrupt', 7))
  rf, state = m.resolve(self.rec, meta, 'fcamera.mp4', None, FakeBackend(result=FakeBackend.stat_of(7, sha256='99'*32)))
  self.assertEqual(state, 'corrupt')
  smb = FakeBackend(kind='smb')
  self.assertEqual(m.resolve(self.rec, meta, 'fcamera.mp4', None, smb), (None, 'storage_unavailable')); self.assertEqual(smb.calls, [])
  backend.result = None; self.assertEqual(m.resolve(self.rec, meta, 'fcamera.mp4', None, backend), (None, 'missing'))
  # A local entry without a remote copy stays missing; the backend is not asked.
  calls = len(backend.calls); m.set_location(meta, 'ecamera.mp4', location='local')
  self.assertEqual(m.resolve(self.rec, meta, 'ecamera.mp4', None, backend), (None, 'missing'))
  self.assertEqual(m.indexed_state(self.rec, meta, 'ecamera.mp4', 'connected'), 'missing')
  self.assertEqual(len(backend.calls), calls)

 def test_resolve_gdrive_states(self):
  meta = {'id': ID}; kind = 'rlog.zst'
  m.set_location(meta, kind, location='gdrive', file_id='F2', bytes=12, sha256='ef'*32, md5='01'*16, archived_at=1.0)
  (self.rec/kind).write_bytes(b'left behind')  # A gdrive entry never resolves to a local leftover.
  self.assertEqual(m.resolve(self.rec, meta, kind, None), (None, 'storage_unavailable'))
  self.assertEqual(m.resolve(self.rec, meta, kind, None, FakeBackend('checking')), (None, 'checking'))
  for state in ['unavailable', 'disabled']: self.assertEqual(m.resolve(self.rec, meta, kind, None, FakeBackend(state)), (None, 'storage_unavailable'))
  self.assertEqual(m.resolve(self.rec, meta, kind, None, FakeBackend(result=None)), (None, 'missing'))
  self.assertEqual(m.resolve(self.rec, meta, kind, None, FakeBackend(result=FakeBackend.stat_of(12, trashed=True))), (None, 'missing'))
  self.assertEqual(m.resolve(self.rec, meta, kind, None, FakeBackend(error=BackendError('unavailable', retryable=True))), (None, 'storage_unavailable'))
  backend = FakeBackend(result=FakeBackend.stat_of(12))
  rf, state = m.resolve(self.rec, meta, kind, None, backend)
  self.assertEqual(state, 'available')
  self.assertEqual(rf, m.RemoteFile('gdrive', RemoteRef('gdrive', 'F2', 12, 'ef'*32, '01'*16), kind, 12, '"F2:' + 'ef'*8 + '"'))
  self.assertEqual(backend.calls, [('probe',), ('stat', RemoteRef('gdrive', 'F2', 12, 'ef'*32, '01'*16))])
  # A backend with read_state (Drive: trusts a recent 'connected', else waits for a running probe) is asked that.
  waiting = FakeBackend(result=FakeBackend.stat_of(12))
  waiting.read_state = lambda: (waiting.calls.append(('read_state',)), ('connected', None))[1]
  self.assertEqual(m.resolve(self.rec, meta, kind, None, waiting)[1], 'available')
  self.assertEqual(waiting.calls[0], ('read_state',))
  # The remote file must be the one the index verified: a different size or hash is corrupt (dynamic only).
  stored = json.dumps(meta)
  for result in [FakeBackend.stat_of(13), FakeBackend.stat_of(12, sha256='00'*32)]:
   rf, state = m.resolve(self.rec, meta, kind, None, FakeBackend(result=result))
   self.assertEqual((state, rf.size, rf.ref.bytes), ('corrupt', 12, 12), result)
  self.assertEqual(json.dumps(meta), stored)
  rf, state = m.resolve(self.rec, meta, kind, None, FakeBackend(result=FakeBackend.stat_of(12, sha256='ef'*32)))
  self.assertEqual((state, rf.size), ('available', 12))
  # Index without a size: the remote's size is used and not compared.
  m.set_location(meta, kind, location='gdrive', file_id='F2', sha256='ef'*32)
  rf, state = m.resolve(self.rec, meta, kind, None, FakeBackend(result=FakeBackend.stat_of(30)))
  self.assertEqual((state, rf.size), ('available', 30))
  # A backend of another kind is never asked about a Drive file.
  smb = FakeBackend(kind='smb')
  self.assertEqual(m.resolve(self.rec, meta, kind, None, smb), (None, 'storage_unavailable')); self.assertEqual(smb.calls, [])
  m.set_location(meta, kind, location='gdrive', file_id='F2', bytes=12, sha256='ef'*32, error='remote_mismatch')
  rf, state = m.resolve(self.rec, meta, kind, None, backend); self.assertEqual((state, rf.ref.file_id), ('corrupt', 'F2'))
  # No sha256 in the index: the etag still has the file id.
  m.set_location(meta, kind, location='gdrive', file_id='F3', bytes=12)
  self.assertEqual(m.resolve(self.rec, meta, kind, None, backend)[0].etag, '"F3:"')
  # An entry without a file id has nothing to stat.
  m.set_location(meta, kind, location='gdrive', bytes=12); calls = len(backend.calls)
  self.assertEqual(m.resolve(self.rec, meta, kind, None, backend), (None, 'missing')); self.assertEqual(len(backend.calls), calls + 1)
  # removed and nas are unchanged by a backend.
  m.set_location(meta, kind, location='removed', removed_at=1.0)
  self.assertEqual(m.resolve(self.rec, meta, kind, None, backend), (None, 'missing'))
  store = self.connected(); m.set_location(meta, kind, location='nas', bytes=3)
  self.assertEqual(m.resolve(self.rec, meta, kind, store, backend), (None, 'missing'))
  (self.nas/ID).mkdir(); (self.nas/ID/kind).write_bytes(b'log')
  self.assertEqual(m.resolve(self.rec, meta, kind, store, backend), (self.nas/ID/kind, 'available'))

 def test_indexed_state_gdrive(self):
  meta = {'id': ID}; kind = 'fcamera.mp4'
  m.set_location(meta, kind, location='gdrive', file_id='F1', bytes=9)
  for share, expected in [('connected', 'available'), ('unavailable', 'storage_unavailable'), ('disabled', 'storage_unavailable'), ('checking', 'checking'), (None, 'checking')]:
   self.assertEqual(m.indexed_state(self.rec, meta, kind, share), expected, share)
  meta['storage'][kind]['error'] = 'remote_mismatch'
  self.assertEqual(m.indexed_state(self.rec, meta, kind, 'connected'), 'corrupt')
  self.assertEqual(m.media_size(self.rec, meta, kind, None), 9)
  self.assertEqual((m.archived_bytes(meta), m.remote_copy_totals(meta)), (9, (0, 0)))

 def test_remote_index_helpers(self):
  meta = {'id': ID}; kind = 'camera.mp4'
  # Legacy recordings: no storage block at all, or entries without remote fields.
  for legacy in [{'id': ID}, {'id': ID, 'storage': None}, {'id': ID, 'storage': {kind: {'location': 'local'}}}, {'id': ID, 'storage': {kind: 'junk'}}]:
   self.assertEqual((m.remote(legacy, kind), m.remote_pending(legacy, kind), m.remote_copy_totals(legacy), m.archived_bytes(legacy)), (None, None, (0, 0), 0), legacy)
   before = json.dumps(legacy); m.clear_remote_pending(legacy, kind); self.assertEqual(json.dumps(legacy), before)
  self.assertEqual(m.REMOTE_LOCATIONS, ('nas', 'gdrive'))
  self.assertEqual([m.is_archived_location(w) for w in ['nas', 'gdrive', 'local', 'removed', None]], [True, True, False, False, False])
  m.set_remote_pending(meta, kind, backend='gdrive', session='https://upload/x', started_at=1.0, bytes_sent=0, sha256='ab'*32, size=10)
  self.assertEqual(meta['storage'][kind], {'location': 'local', 'remote_pending': {'backend': 'gdrive', 'session': 'https://upload/x', 'started_at': 1.0, 'bytes_sent': 0, 'sha256': 'ab'*32, 'size': 10}})
  self.assertEqual(m.remote_pending(meta, kind)['size'], 10); self.assertIsNone(m.remote(meta, kind))
  with self.assertRaises(ValueError): m.set_remote_pending(meta, kind, sesion='typo')
  with self.assertRaises(ValueError): m.set_remote(meta, kind, fileid='typo')
  m.set_remote_pending(meta, kind, backend='gdrive', session='https://upload/x', started_at=1.0, bytes_sent=4, sha256='ab'*32, size=10)
  self.assertEqual(m.remote_pending(meta, kind)['bytes_sent'], 4)
  m.set_remote(meta, kind, **self.remote_block(bytes=10)); m.clear_remote_pending(meta, kind)
  self.assertEqual(meta['storage'][kind], {'location': 'local', 'remote': self.remote_block(bytes=10)})
  self.assertEqual(m.location(meta, kind), 'local')
  m.clear_remote_pending(meta, kind)  # Nothing pending: no change.
  self.assertEqual(meta['storage'][kind], {'location': 'local', 'remote': self.remote_block(bytes=10)})
  # Other fields of the entry are kept.
  m.set_location(meta, 'rlog.zst', location='local', error='recovery_mismatch'); m.set_remote(meta, 'rlog.zst', **self.remote_block(bytes=5))
  self.assertEqual(meta['storage']['rlog.zst']['error'], 'recovery_mismatch')
  m.set_location(meta, 'fcamera.mp4', location='gdrive', file_id='F', bytes=20); m.set_location(meta, 'ecamera.mp4', location='nas', bytes=3)
  m.set_remote(meta, 'qcamera.ts', **self.remote_block(bytes='bad'))
  self.assertEqual((m.archived_bytes(meta), m.remote_copy_totals(meta)), (23, (3, 15)))
  # A remote block on an archived entry is not a remote copy.
  meta['storage']['fcamera.mp4']['remote'] = self.remote_block()
  self.assertEqual(m.remote_copy_totals(meta), (3, 15))

 def test_media_size_remote_copy_without_local(self):
  meta = {'id': ID}; kind = 'ecamera.mp4'
  m.set_remote(meta, kind, **self.remote_block(bytes=42))
  self.assertEqual(m.media_size(self.rec, meta, kind, None), 42)
  (self.rec/kind).write_bytes(b'abc'); self.assertEqual(m.media_size(self.rec, meta, kind, None), 3)
  (self.rec/kind).unlink(); m.set_remote(meta, kind, **self.remote_block(bytes=-1))
  self.assertEqual(m.media_size(self.rec, meta, kind, None), 0)

 def test_nas_activation_keeps_drive_storage_id(self):
  # Switching backends never removes the other backend's id from the local copy.
  (self.root/m.LOCAL_COPY).write_text(json.dumps({'gdrive_storage_id': 'g1'}))
  store = self.connected()
  data = json.loads((self.root/m.LOCAL_COPY).read_text())
  self.assertEqual((data['gdrive_storage_id'], data['storage_id']), ('g1', store.local_id()))
  self.assertEqual(json.loads((self.nas/m.SENTINEL).read_text())['storage_id'], store.local_id())

 def test_config_yaml_has_gdrive_options(self):
  import re
  text = (Path(__file__).resolve().parents[1]/'roadviewer/config.yaml').read_text(encoding='utf-8')
  options = text.split('\noptions:\n', 1)[1].split('\nschema:\n', 1)[0]; schema = text.split('\nschema:\n', 1)[1].split('\nurl:', 1)[0]
  expected = {'archive_backend': ('smb', 'list(smb|gdrive)'), 'archive_mode': ('move', 'list(move|copy)'), 'archive_allow_local_delete': ('false', 'bool'),
              'archive_gdrive_client_id': ('""', 'str'), 'archive_gdrive_client_secret': ('""', 'password'), 'archive_gdrive_folder_name': ('"Road Viewer"', 'str')}
  for key, (default, rule) in expected.items():
   credential = key in ('archive_gdrive_client_id', 'archive_gdrive_client_secret')
   if credential: self.assertRegex(options, rf'(?m)^  {key}: {re.escape(default)}$', key)
   else: self.assertNotRegex(options, rf'(?m)^  {key}:', key)
   self.assertRegex(schema, rf'(?m)^  {key}: {re.escape(rule)}' + ('' if credential else r'\?') + '$', key)
  # The defaults parse to the archiving-off settings.
  defaults = {k: (False if v == 'false' else v.strip('"')) for k, (v, _) in expected.items()}
  s = m.ArchiveSettings.from_options(defaults)
  self.assertEqual((s.enabled, s.backend, s.effective_mode, s.gdrive_folder_name, s.error), (False, 'smb', 'move', 'Road Viewer', None))

class FakeBackend:
 def __init__(self, state='connected', result=..., error=None, kind='gdrive'):
  self.state, self.error, self.calls = state, error, []
  self.caps = SimpleNamespace(kind=kind)
  self.result = FakeBackend.stat_of(7) if result is ... else result
 @staticmethod
 def stat_of(size, trashed=False, sha256=None): return RemoteStat(not trashed, size, sha256, None, trashed)
 def last_state(self): self.calls.append(('last_state',)); return self.state
 def probe(self): self.calls.append(('probe',)); return self.state, None
 def stat(self, ref):
  self.calls.append(('stat', ref))
  if self.error: raise self.error
  return self.result

if __name__ == '__main__':
 unittest.main()
