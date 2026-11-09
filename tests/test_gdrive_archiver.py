"""The archiver with Google Drive (tests/fake_drive.py): copy mode by default, move only when deleting the local
file is explicitly allowed, resumable uploads across restarts, adoption of copies whose answer was lost, and
failures that stop the cycle without touching the index or any file."""
import hashlib, json, os, random, sys, tempfile, unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_media_integration import make_log, PEER, HEADERS  # Sets RV_DATA and imports the server module.
import server, media_store
import archive_backends as ab
from fake_drive import FakeDrive

DAY = 86400
KINDS = ['rlog.zst', 'fcamera.mp4']

class Crash(Exception): pass

class GdriveArchiverTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(); self.addCleanup(temp.cleanup); self.root = Path(temp.name)
        self.drive = FakeDrive().start(); self.addCleanup(self.drive.stop)
        for patcher in (patch.dict(os.environ, self.drive.env()), patch.object(server, 'ROOT', self.root),
                        patch.object(server, 'upload_receiving', return_value=False), patch.object(server, 'submit'),
                        patch.object(ab, 'UPLOAD_CHUNK', 2**20)):  # Resume tests count 1 MiB pieces.
            patcher.start(); self.addCleanup(patcher.stop)
        self.http = ab.Http(sleep=lambda seconds: None, rand=lambda: 0.0)
        auth = self.auth(); auth.start_device_flow(); self.assertEqual(auth.poll_once(), 'granted')
        self.make_backend().activate()
        self.assertEqual(self.backend.probe(), ('connected', None))

    def auth(self): return ab.DriveAuth(self.root / '.gdrive-auth.json', 'client-id', 'secret', self.http)

    def make_backend(self, **fields):
        # A new instance reads the token file again, as after a restart.
        self.settings = media_store.ArchiveSettings(**{'enabled': True, 'backend': 'gdrive', 'min_age_seconds': DAY, **fields})
        auth = self.auth()
        self.backend = ab.DriveBackend(self.settings, self.root, auth, ab.DriveClient(self.http, auth))
        patcher = patch.object(server, 'backend', self.backend); patcher.start(); self.addCleanup(patcher.stop)
        return self.backend

    def archiver(self, **fields):
        backend = self.make_backend(**fields)
        return media_store.Archiver(server, media_store.ArchiveStore(self.settings, self.root), self.settings, backend=backend)

    def log(self, id, kinds=KINDS, data=None, **fields):
        p = make_log(self.root, id, kinds, [])
        for kind, content in (data or {}).items(): (p / kind).write_bytes(content)
        m = server.read_meta(p); m.update({'uploaded': 1, **fields}); server.save_meta(p, m)
        return p

    def meta_bytes(self, p): return (p / 'meta.json').read_bytes()

    def files(self):
        with self.drive.lock: return {i: dict(f) for i, f in self.drive.files.items() if f['mimeType'] != 'application/vnd.google-apps.folder'}

    def requests(self, method=None):
        with self.drive.lock: return [r for r in self.drive.requests if method is None or r['method'] == method]

    def sessions_started(self):
        return [r for r in self.requests('POST') if r['path'].startswith('/upload/drive/v3/files') and 'upload_id' not in r['path']]

    def assert_copied(self, p, kind):
        m = server.read_meta(p); e = media_store.entry(m, kind); block = media_store.remote(m, kind)
        self.assertEqual(e['location'], 'local'); self.assertTrue((p / kind).is_file())
        self.assertIsNotNone(block); self.assertIsNone(media_store.remote_pending(m, kind))
        data = (p / kind).read_bytes()
        self.assertEqual((block['backend'], block['bytes'], block['sha256'], block['verified_by']), ('gdrive', len(data), hashlib.sha256(data).hexdigest(), 'sha256'))
        self.assertEqual(block['md5'], hashlib.md5(data).hexdigest())
        self.assertEqual(self.files()[block['file_id']]['content'], data)
        return block

    def test_startup_checks_use_one_folder_listing_and_report_progress(self):
        # After a restart the checks ask about every archived file. They come from one listing of the folder instead of
        # a request per file (about a thousand requests, minutes, delayed a manual run's first file), and the panel
        # sees their progress.
        paths = [self.log(c * 32) for c in 'abcd']
        first = self.archiver()
        while first.run_cycle()['archived']: pass  # A cycle archives a batch.
        self.assertTrue(all(media_store.remote(server.read_meta(p), kind) for p in paths for kind in KINDS))
        restarted, seen = self.archiver(), []
        recover = restarted._recover_remote
        def spy():
            seen.append(dict(restarted.checking)); recover()
            seen.append(dict(restarted.checking))
        restarted._recover_remote = spy
        since = len(self.requests())
        restarted.recover_startup()
        self.assertTrue(restarted.recovered)
        media = {media_store.remote(server.read_meta(p), kind)['file_id'] for p in paths for kind in KINDS}
        gets = [r['path'].split('?')[0] for r in self.requests()[since:] if r['method'] == 'GET']
        asked = [path.rsplit('/', 1)[-1] for path in gets]
        self.assertEqual([i for i in asked if i in media], [], 'no per-file metadata request')
        self.assertEqual(gets.count('/drive/v3/files'), 1, 'one listing')
        # Two passes (held results, recovery) over the four recordings.
        self.assertEqual(seen[0]['total'], 8); self.assertEqual(seen[-1], {'done': 8, 'total': 8})
        self.assertIsNone(restarted.checking); self.assertIsNone(restarted.status()['checking'])
        # A file the listing does not have is asked about by itself, never taken as gone.
        restarted.recovered = False
        with patch.object(self.backend, 'snapshot', return_value={}):
            restarted._recover_remote = recover; restarted.recover_startup()
        self.assertEqual(restarted.status()['missing_archived'], 0)

    def test_copy_mode_uploads_verifies_and_keeps_local(self):
        p = self.log('a' * 32)
        archiver = self.archiver()
        self.assertEqual(self.settings.effective_mode, 'copy')
        result = archiver.run_cycle()
        self.assertEqual((result['archived'], result['stopped']), (2, None))
        for kind in KINDS: self.assert_copied(p, kind)
        status = archiver.status()
        self.assertEqual((status['backend'], status['effective_mode'], status['remote_copies_total'], status['last_error'], status['last_auth_error']),
                         ('gdrive', 'copy', 2, None, None))
        # Done: the next cycle uploads nothing and the local files stay.
        before = len(self.sessions_started())
        self.assertEqual(archiver.run_cycle()['archived'], 0)
        self.assertEqual(len(self.sessions_started()), before); self.assertEqual(len(self.files()), 2)
        self.assertEqual(media_store.resolve(p, server.read_meta(p), 'fcamera.mp4', None, self.backend), (p / 'fcamera.mp4', 'available'))

    def test_copy_mode_never_unlinks_local(self):
        p = self.log('a' * 32)
        content = {kind: (p / kind).read_bytes() for kind in KINDS}
        self.archiver().run_cycle()
        # A recording deleted earlier left a remote file to delete; recovery and pending deletes run on a restart.
        other = self.log('c' * 32, ['qcamera.ts']); self.archiver().run_cycle()
        with server.registration_lock, server.lock:
            with patch.object(server, 'process_pending'): server.delete_recording(other.name, remote=True)
        archiver = self.archiver()
        unlinked = []
        real = Path.unlink
        def unlink(path, *args, **kwargs):
            unlinked.append(path); return real(path, *args, **kwargs)
        with patch.object(Path, 'unlink', unlink):
            archiver.recover_startup(); result = archiver.run_cycle()
        self.assertTrue(archiver.recovered); self.assertEqual(result['archived'], 0)
        self.assertFalse([u for u in unlinked if u.parent == p])
        for kind in KINDS:
            self.assertEqual((p / kind).read_bytes(), content[kind]); self.assert_copied(p, kind)
        self.assertEqual(media_store.PendingDeletes(self.root).count(), 0)
        self.assertEqual(len(self.files()), 2)  # The deleted recording's copy went; this one's stay.

    def test_move_requires_allow_flag(self):
        p = self.log('a' * 32)
        archiver = self.archiver(mode='move')
        self.assertEqual(archiver.status()['effective_mode'], 'copy')
        archiver.run_cycle()
        for kind in KINDS: self.assert_copied(p, kind)
        # Allowed now: the verified copies are adopted (no new upload) and only then the local files go.
        before = len(self.sessions_started())
        archiver = self.archiver(mode='move', allow_local_delete=True)
        self.assertEqual(archiver.run_cycle()['archived'], 2)
        self.assertEqual(len(self.sessions_started()), before)
        m = server.read_meta(p)
        for kind in KINDS:
            e = media_store.entry(m, kind)
            self.assertEqual(e['location'], 'gdrive'); self.assertFalse((p / kind).exists())
            self.assertEqual(set(e), {'location', 'file_id', 'bytes', 'sha256', 'md5', 'archived_at'})
            self.assertEqual(self.files()[e['file_id']]['sha256'], e['sha256'])
        # The NAS backend never takes this path: SMB settings ignore the Drive flags.
        smb = media_store.ArchiveSettings(enabled=True, mode='copy', allow_local_delete=True)
        self.assertEqual(smb.effective_mode, 'copy'); self.assertFalse(media_store.Archiver(server, media_store.ArchiveStore(smb, self.root), smb).remote)

    def test_move_unlinks_only_after_index_commit(self):
        p = self.log('a' * 32, ['fcamera.mp4'])
        # The commit fails: the local file and the index stay as they were.
        archiver = self.archiver(mode='move', allow_local_delete=True)
        before = self.meta_bytes(p)
        def failing(path, data):
            if media_store.location(data, 'fcamera.mp4') == 'gdrive': raise OSError('disk full')
            return real_json(path, data)
        real_json = media_store.atomic_json
        with patch.object(media_store, 'atomic_json', side_effect=failing):
            self.assertEqual(archiver.run_cycle()['stopped'], 'os_error')
        # Only the upload's session was recorded (before its first chunk); the file is still indexed as local.
        m, original = server.read_meta(p), json.loads(before)
        self.assertTrue((p / 'fcamera.mp4').is_file()); self.assertEqual(media_store.location(m, 'fcamera.mp4'), 'local')
        self.assertIsNone(media_store.remote(m, 'fcamera.mp4')); self.assertIsNotNone(media_store.remote_pending(m, 'fcamera.mp4'))
        self.assertEqual({k: v for k, v in m.items() if k != 'storage'}, original)
        # The unlink sees the committed (fsync'd) index.
        seen, real = [], Path.unlink
        def unlink(path, *args, **kwargs):
            if path == p / 'fcamera.mp4':
                self.assertTrue(server.lock._is_owned())
                seen.append(media_store.location(json.loads((p / 'meta.json').read_text()), 'fcamera.mp4'))
            return real(path, *args, **kwargs)
        commits = []
        def committed(path, data):
            commits.append(media_store.location(data, 'fcamera.mp4')); return real_json(path, data)
        with patch.object(Path, 'unlink', unlink), patch.object(media_store, 'atomic_json', side_effect=committed):
            self.assertEqual(archiver.run_cycle()['archived'], 1)
        self.assertEqual(seen, ['gdrive']); self.assertEqual(commits[-1], 'gdrive'); self.assertFalse((p / 'fcamera.mp4').exists())
        # Pinned or converting recordings are copied instead of moved.
        q = self.log('b' * 32, ['fcamera.mp4'])
        with patch.object(server.storage_policy, 'settings', {**server.storage_policy.settings, 'pinned_logs': [q.name]}):
            self.assertEqual(archiver.run_cycle()['archived'], 1)
        self.assert_copied(q, 'fcamera.mp4')

    def test_resume_after_restart_from_308(self):
        data = random.Random(1).randbytes(3 * 2**20 + 123)
        p = self.log('a' * 32, ['fcamera.mp4'], data={'fcamera.mp4': data})
        archiver = self.archiver()
        real, calls = archiver.backend.client.put_chunk, []
        def put_chunk(*args):
            calls.append(1)
            if len(calls) == 2: raise Crash()
            return real(*args)
        with patch.object(archiver.backend.client, 'put_chunk', side_effect=put_chunk), self.assertRaises(Crash):
            archiver.run_cycle()
        # The session was in the index before its first chunk.
        pending = media_store.remote_pending(server.read_meta(p), 'fcamera.mp4')
        self.assertEqual((pending['backend'], pending['bytes_sent'], pending['size'], pending['sha256']), ('gdrive', 0, len(data), hashlib.sha256(data).hexdigest()))
        self.assertIn('upload_id=', pending['session'])
        self.assertEqual(len(self.sessions_started()), 1)
        since = len(self.requests())
        archiver = self.archiver()  # Restart.
        archiver.recover_startup()
        self.assertIsNotNone(media_store.remote_pending(server.read_meta(p), 'fcamera.mp4'))  # Incomplete: kept.
        self.assertEqual(archiver.run_cycle()['archived'], 1)
        ranges = [r['headers'].get('Content-Range') for r in self.requests()[since:] if r['method'] == 'PUT']
        self.assertIn('bytes %d-%d/%d' % (2**20, 2 * 2**20 - 1, len(data)), ranges)
        self.assertNotIn('bytes 0-%d/%d' % (2**20 - 1, len(data)), ranges)
        self.assertEqual(len(self.sessions_started()), 1)
        self.assert_copied(p, 'fcamera.mp4'); self.assertEqual(len(self.files()), 1)

    def test_lost_completion_response_adopts_existing_copy(self):
        # The answer to the last chunk is lost: the session reports the file, which is committed once.
        p = self.log('a' * 32, ['fcamera.mp4'])
        self.drive.scenario.lose_completion_response = True
        self.assertEqual(self.archiver().run_cycle()['archived'], 1)
        self.assert_copied(p, 'fcamera.mp4'); self.assertEqual(len(self.files()), 1)
        # Uploaded before a crash, never committed: found by its appProperties, verified and adopted.
        q = self.log('b' * 32, ['fcamera.mp4'])
        sessions = len(self.sessions_started())
        content = (q / 'fcamera.mp4').read_bytes()
        backend = self.backend
        backend.upload(q / 'fcamera.mp4', q.name, 'fcamera.mp4', hashlib.sha256(content).hexdigest(), None, len(content))
        self.assertEqual(self.archiver().run_cycle()['archived'], 1)
        self.assert_copied(q, 'fcamera.mp4'); self.assertEqual(len(self.files()), 2)
        self.assertEqual(len(self.sessions_started()), sessions + 1)
        # A completed session still recorded as pending (crash before the commit): recovery adopts it.
        r = self.log('c' * 32, ['fcamera.mp4'])
        content = (r / 'fcamera.mp4').read_bytes(); sha = hashlib.sha256(content).hexdigest()
        resume = {}
        self.backend.upload(r / 'fcamera.mp4', r.name, 'fcamera.mp4', sha, None, len(content), resume=resume)
        m = server.read_meta(r)
        media_store.set_remote_pending(m, 'fcamera.mp4', backend='gdrive', session=resume['session'], started_at=1.0, bytes_sent=0, sha256=sha, size=len(content))
        server.save_meta(r, m)
        sessions = len(self.sessions_started())
        archiver = self.archiver(local_threshold_bytes=10**12)  # Below the threshold: only recovery acts.
        archiver.recover_startup()
        self.assertTrue(archiver.recovered); self.assert_copied(r, 'fcamera.mp4')
        self.assertEqual(len(self.sessions_started()), sessions); self.assertEqual(len(self.files()), 3)

    def test_mismatch_marks_error_keeps_both(self):
        p = self.log('a' * 32, ['fcamera.mp4'])
        archiver = self.archiver()
        with patch.object(archiver.backend, 'verify', return_value='mismatch'):
            self.assertEqual(archiver.run_cycle()['stopped'], 'hash_mismatch')
        m = server.read_meta(p); e = media_store.entry(m, 'fcamera.mp4')
        self.assertEqual((e['location'], e['error']), ('local', 'remote_mismatch'))
        self.assertIsNone(media_store.remote(m, 'fcamera.mp4')); self.assertIsNone(media_store.remote_pending(m, 'fcamera.mp4'))
        self.assertTrue((p / 'fcamera.mp4').is_file()); self.assertEqual(len(self.files()), 1)  # Both copies stay.
        self.assertEqual(archiver.status()['last_error'], 'hash_mismatch')
        # The local file still plays; the file is not uploaded again every cycle.
        self.assertEqual(media_store.resolve(p, m, 'fcamera.mp4', None, self.backend), (p / 'fcamera.mp4', 'available'))
        sessions = len(self.sessions_started())
        self.assertEqual(archiver.run_cycle()['archived'], 0); self.assertEqual(len(self.sessions_started()), sessions)

    def test_auth_expired_stops_cycle_without_changes(self):
        p = self.log('a' * 32)
        before = self.meta_bytes(p)
        archiver = self.archiver()
        # Expired during the cycle (the first Drive call after the probe).
        with patch.object(archiver.backend, 'find', side_effect=ab.BackendError('auth_expired', reason='invalid_grant')):
            self.assertEqual(archiver.run_cycle()['stopped'], 'auth_expired')
        self.assertEqual(self.meta_bytes(p), before); self.assertEqual(self.files(), {})
        self.assertEqual(archiver.status()['last_auth_error'], 'invalid_grant')
        # Revoked at Google: the probe fails and nothing is attempted.
        with self.drive.lock: self.drive.access_tokens.clear(); self.drive.refresh_tokens.clear()
        archiver = self.archiver()
        since = len(self.requests())
        self.assertEqual(archiver.run_cycle()['stopped'], 'auth_expired')
        self.assertEqual(self.sessions_started(), []); self.assertFalse([r for r in self.requests()[since:] if r['method'] in ('PUT', 'DELETE')])
        status = archiver.status()
        self.assertEqual((status['last_error'], status['consecutive_failures'], status['last_auth_error']), ('auth_expired', 1, 'auth_expired'))
        self.assertEqual(self.meta_bytes(p), before)
        for kind in KINDS: self.assertTrue((p / kind).is_file())
        self.assertNotIn('secret', json.dumps(status))

    def test_rate_limited_stops_cycle(self):
        p = self.log('a' * 32)
        before = self.meta_bytes(p)
        self.drive.scenario.fail_next('/drive/v3/files?', 429, times=5)
        archiver = self.archiver()
        self.assertEqual(archiver.run_cycle()['stopped'], 'rate_limited')
        self.assertEqual(self.meta_bytes(p), before); self.assertEqual(self.files(), {})
        self.assertEqual(archiver.status()['last_error'], 'rate_limited')
        self.assertEqual(archiver.run_cycle()['archived'], 2)  # Over once Google answers again.

    def test_quota_exceeded_remote_full_no_deletes(self):
        p = self.log('a' * 32)
        self.drive.scenario.quota_limit = 5
        archiver = self.archiver()
        self.assertEqual(archiver.run_cycle()['stopped'], 'remote_full')
        self.assertEqual(archiver.status()['last_error'], 'remote_full')
        self.assertEqual(self.requests('DELETE'), []); self.assertEqual(self.files(), {})
        m = server.read_meta(p)
        for kind in KINDS:
            self.assertTrue((p / kind).is_file()); self.assertEqual(media_store.location(m, kind), 'local'); self.assertIsNone(media_store.remote(m, kind))

    def test_remote_404_is_dynamic_missing_only(self):
        p = self.log('a' * 32, ['fcamera.mp4'])
        q = self.log('b' * 32, ['fcamera.mp4'])
        with patch.object(server.storage_policy, 'settings', {**server.storage_policy.settings, 'pinned_logs': [q.name]}):
            self.archiver(mode='move', allow_local_delete=True).run_cycle()
        self.assertEqual(media_store.location(server.read_meta(p), 'fcamera.mp4'), 'gdrive')  # Moved.
        self.assertIsNotNone(media_store.remote(server.read_meta(q), 'fcamera.mp4'))  # Pinned: copied.
        for file_id in self.files():  # Both gone from Drive (deleted by hand); the folder stays.
            with self.drive.lock: del self.drive.files[file_id]
        before = {r: self.meta_bytes(r) for r in (p, q)}
        archiver = self.archiver(mode='move', allow_local_delete=True)
        archiver.recover_startup()
        self.assertTrue(archiver.recovered); self.assertEqual(archiver.status()['missing_archived'], 2)
        self.assertEqual({r: self.meta_bytes(r) for r in (p, q)}, before)
        self.assertTrue((q / 'fcamera.mp4').is_file())
        self.assertEqual(media_store.resolve(p, server.read_meta(p), 'fcamera.mp4', None, self.backend)[1], 'missing')
        with patch.object(server.storage_policy, 'settings', {**server.storage_policy.settings, 'pinned_logs': [q.name]}):
            archiver.run_cycle()
        self.assertEqual({r: self.meta_bytes(r) for r in (p, q)}, before); self.assertEqual(archiver.status()['missing_archived'], 2)

    def test_pending_delete_uses_backend_delete_and_refuses_foreign(self):
        p = self.log('a' * 32)
        self.archiver().run_cycle()
        ids = {media_store.remote(server.read_meta(p), kind)['file_id'] for kind in KINDS}
        with server.registration_lock, server.lock:
            with patch.object(server, 'process_pending'): server.delete_recording(p.name, remote=True)
        pending = media_store.PendingDeletes(self.root)
        rows = json.loads(pending.path.read_text())
        self.assertEqual(rows[0]['kinds'], []); self.assertEqual({r['file_id'] for r in rows[0]['refs']}, ids)
        # Request handlers only queue them: Drive is never called from a request.
        since = len(self.requests())
        server.process_pending()
        self.assertEqual(self.requests()[since:], []); self.assertEqual(pending.count(), 2)
        # Any failure other than a foreign file keeps the refs for the next time.
        with patch.object(self.backend.client, 'delete', side_effect=ab.BackendError('unavailable', retryable=True)):
            self.assertEqual(pending.process(self.backend), 0)
        with patch.object(self.backend, 'delete', side_effect=ab.BackendError('auth_expired')):
            self.assertEqual(pending.process(self.backend), 0)
        self.assertEqual(pending.count(), 2); self.assertEqual(len(self.files()), 2)
        # Another instance's file, recorded for a deleted recording: never deleted.
        with self.drive.lock:
            self.drive.files['foreign'] = dict(name='x', mimeType='application/octet-stream', parents=[], appProperties={'rv_id': 'c' * 32, 'rv_storage_id': 'other'},
                                               content=b'x', trashed=False, md5='', sha256='')
        pending.add('c' * 32, [], [{'kind': 'fcamera.mp4', 'backend': 'gdrive', 'file_id': 'foreign', 'bytes': 1, 'sha256': None}], explicit=True)
        self.assertEqual(pending.count(), 3)
        # The archiver cycle removes them; the foreign file is skipped with a warning and dropped from the list.
        with self.assertLogs('media_store', 'WARNING') as logs:
            self.archiver().run_cycle()
        self.assertEqual(len([line for line in logs.output if 'foreign' in line and 'c' * 32 + '/fcamera.mp4' in line]), 1)
        self.assertEqual(set(self.files()), {'foreign'})
        deleted = {r['path'].split('?')[0].rsplit('/', 1)[-1] for r in self.requests('DELETE')}
        self.assertEqual(deleted, ids)
        self.assertEqual(pending.count(), 0); self.assertFalse(pending.path.exists())
        # Legacy rows (kinds only) still load unchanged next to rows with refs.
        pending.add('d' * 32, ['rlog.zst']); pending.add('e' * 32, [], [{'kind': 'rlog.zst', 'backend': 'gdrive', 'file_id': 'gone', 'bytes': 0, 'sha256': None}], explicit=True)
        self.assertEqual(json.loads(pending.path.read_text()), [{'id': 'd' * 32, 'kinds': ['rlog.zst']},
                         {'id': 'e' * 32, 'kinds': [], 'explicit': True, 'refs': [{'kind': 'rlog.zst', 'backend': 'gdrive', 'file_id': 'gone', 'bytes': 0, 'sha256': None}]}])
        self.assertEqual(list(self.root.glob('.pending-nas-deletes.corrupt-*')), [])
        self.assertEqual(media_store.PendingDeletes(self.root).process(self.backend), 1)  # Already gone counts as removed.
        self.assertEqual(json.loads(pending.path.read_text()), [{'id': 'd' * 32, 'kinds': ['rlog.zst']}])

    def moved_with_local(self, content=None):
        # A moved file whose local unlink did not happen (or a file put back since): index gdrive, local file present.
        p = self.log('a' * 32, ['fcamera.mp4'])
        original = (p / 'fcamera.mp4').read_bytes()
        self.archiver(mode='move', allow_local_delete=True).run_cycle()
        self.assertEqual(media_store.location(server.read_meta(p), 'fcamera.mp4'), 'gdrive')
        (p / 'fcamera.mp4').write_bytes(original if content is None else content)
        archiver = self.archiver(mode='move', allow_local_delete=True)
        archiver.held_checked = True  # Only recovery is under test (recheck_held is Task 5's).
        return p, archiver

    def test_recovery_never_unlinks_a_local_file_that_differs_from_index(self):
        original = b'fcamera.mp4' * 10
        for content in (b'X' * len(original), b'new camera file'):  # Same size, other bytes; another size.
            with self.subTest(size=len(content)):
                p, archiver = self.moved_with_local(content)
                archiver.recover_startup()
                self.assertTrue(archiver.recovered); self.assertEqual((p / 'fcamera.mp4').read_bytes(), content)
                for f in list(self.files()):
                    with self.drive.lock: del self.drive.files[f]
                server.delete_recording(p.name, remote=True)
        # The moved content itself goes once its copy verifies.
        p, archiver = self.moved_with_local()
        archiver.recover_startup()
        self.assertTrue(archiver.recovered); self.assertFalse((p / 'fcamera.mp4').exists())
        self.assertEqual(media_store.location(server.read_meta(p), 'fcamera.mp4'), 'gdrive')

    def test_recovery_keeps_local_file_when_protected_or_copy_mode(self):
        p, _ = self.moved_with_local()
        for fields, pinned in (({}, False), ({'mode': 'move'}, False), ({'mode': 'move', 'allow_local_delete': True}, True)):
            archiver = self.archiver(**fields); archiver.held_checked = True
            with patch.object(server.storage_policy, 'settings', {**server.storage_policy.settings, 'pinned_logs': [p.name] if pinned else []}):
                archiver.recover_startup()
            self.assertTrue(archiver.recovered); self.assertTrue((p / 'fcamera.mp4').is_file())

    def test_logs_never_expose_session_or_file_ids(self):
        data = random.Random(2).randbytes(2 * 2**20 + 7)
        p = self.log('a' * 32, ['fcamera.mp4'], data={'fcamera.mp4': data})
        q = self.log('b' * 32, ['fcamera.mp4'])
        # p's upload crashed after its session was recorded (a real session URI from Drive); q has a copy.
        archiver = self.archiver()
        real, calls = archiver.backend.client.put_chunk, []
        def put_chunk(*args):
            calls.append(1)
            if len(calls) == 2: raise Crash()
            return real(*args)
        with patch.object(archiver.backend.client, 'put_chunk', side_effect=put_chunk), self.assertRaises(Crash): archiver.run_cycle()
        self.assertIn('upload_id=', media_store.remote_pending(server.read_meta(p), 'fcamera.mp4')['session'])
        m = server.read_meta(q); media_store.set_remote(m, 'fcamera.mp4', backend='gdrive', file_id='fileid-secret', bytes=1, sha256='0' * 64, md5='0', uploaded_at=1.0, verified_by='sha256'); server.save_meta(q, m)
        r = server.app.test_client().get('/api/logs', environ_overrides=PEER)
        self.assertEqual(r.status_code, 200)
        body = r.get_data(as_text=True)
        for secret in ('upload_id=', 'remote_pending', 'secretsession', 'fileid-secret', 'file_id'): self.assertNotIn(secret, body)
        rows = {row['id']: row for row in r.json['logs']}
        self.assertEqual(rows[q.name]['remote_copies']['front'], 'gdrive')  # The copy is still shown.
        self.assertNotIn('storage', rows[q.name])
        self.assertEqual(server.read_meta(p)['storage']['fcamera.mp4']['remote_pending']['backend'], 'gdrive')  # Index untouched.
        self.assertNotIn('upload_id', json.dumps(archiver.status()))

    def completed_pending(self, p):
        # An upload completed at Drive whose commit was lost: the index still records its session.
        content = (p / 'fcamera.mp4').read_bytes(); sha = hashlib.sha256(content).hexdigest(); resume = {}
        ref = self.backend.upload(p / 'fcamera.mp4', p.name, 'fcamera.mp4', sha, None, len(content), resume=resume)
        m = server.read_meta(p)
        media_store.set_remote_pending(m, 'fcamera.mp4', backend='gdrive', session=resume['session'], started_at=1.0, bytes_sent=0, sha256=sha, size=len(content))
        server.save_meta(p, m)
        return ref

    def cycling(self):
        archiver = self.archiver(); archiver.recovered = archiver.held_checked = True  # The cycle's own path.
        return archiver

    def test_completed_session_with_trashed_file_does_not_block_the_cycle(self):
        a = self.log('a' * 32, ['fcamera.mp4'], uploaded=1); b = self.log('b' * 32, ['fcamera.mp4'], uploaded=2)
        ref = self.completed_pending(a)
        with self.drive.lock: self.drive.files[ref.file_id]['trashed'] = True
        archiver = self.cycling()
        self.assertEqual(archiver.run_cycle()['stopped'], 'os_error')
        m = server.read_meta(a); self.assertIsNone(media_store.remote_pending(m, 'fcamera.mp4')); self.assertNotIn('error', media_store.entry(m, 'fcamera.mp4'))
        result = archiver.run_cycle()
        self.assertEqual((result['archived'], result['stopped']), (2, None))
        self.assert_copied(a, 'fcamera.mp4'); self.assert_copied(b, 'fcamera.mp4')

    def test_completed_session_with_wrong_size_marks_error_and_moves_on(self):
        a = self.log('a' * 32, ['fcamera.mp4'], uploaded=1); b = self.log('b' * 32, ['fcamera.mp4'], uploaded=2)
        ref = self.completed_pending(a)
        with self.drive.lock: self.drive.files[ref.file_id]['content'] = b'short'
        archiver = self.cycling()
        self.assertEqual(archiver.run_cycle()['stopped'], 'hash_mismatch')
        m = server.read_meta(a); e = media_store.entry(m, 'fcamera.mp4')
        self.assertIsNone(media_store.remote_pending(m, 'fcamera.mp4')); self.assertEqual(e['error'], 'remote_mismatch')
        self.assertTrue((a / 'fcamera.mp4').is_file())
        result = archiver.run_cycle()
        self.assertEqual((result['archived'], result['stopped']), (1, None)); self.assert_copied(b, 'fcamera.mp4')

    def test_recovery_of_completed_session_never_uploads(self):
        p = self.log('a' * 32, ['fcamera.mp4'])
        ref = self.completed_pending(p)
        with self.drive.lock: self.drive.files[ref.file_id]['trashed'] = True  # Nothing to adopt.
        sessions, puts = len(self.sessions_started()), len(self.requests('PUT'))
        archiver = self.archiver(); archiver.held_checked = True
        archiver.recover_startup()
        self.assertTrue(archiver.recovered)
        self.assertEqual(len(self.sessions_started()), sessions); self.assertEqual(len(self.requests('PUT')), puts + 1)  # The status query only.
        # The record stays for the cycle: its resume finds the file gone and drops it; the next cycle uploads anew.
        m = server.read_meta(p)
        self.assertIsNotNone(media_store.remote_pending(m, 'fcamera.mp4')); self.assertIsNone(media_store.remote(m, 'fcamera.mp4'))
        self.assertEqual(archiver.run_cycle()['stopped'], 'os_error')
        self.assertIsNone(media_store.remote_pending(server.read_meta(p), 'fcamera.mp4'))
        self.assertEqual(archiver.run_cycle()['archived'], 1)
        self.assert_copied(p, 'fcamera.mp4')

    def test_completed_session_missed_by_a_lagging_list_is_adopted_without_resending(self):
        p = self.log('a' * 32, ['fcamera.mp4'])
        size = len((p / 'fcamera.mp4').read_bytes())
        self.completed_pending(p)
        self.drive.scenario.list_lag = 2  # Recovery's and the cycle's find() do not see the file yet.
        sessions, since = len(self.sessions_started()), len(self.requests())
        archiver = self.archiver(); archiver.held_checked = True
        archiver.recover_startup()
        self.assertTrue(archiver.recovered)
        self.assertIsNotNone(media_store.remote_pending(server.read_meta(p), 'fcamera.mp4'))  # Kept, not dropped.
        self.assertEqual(archiver.run_cycle()['archived'], 1)
        self.assert_copied(p, 'fcamera.mp4')
        self.assertEqual(self.drive.scenario.list_lag, 0); self.assertEqual(len(self.files()), 1)
        self.assertEqual(len(self.sessions_started()), sessions)
        # Only status queries went to the session: no byte was sent again.
        puts = [r['headers'].get('Content-Range') for r in self.requests()[since:] if r['method'] == 'PUT']
        self.assertTrue(puts); self.assertEqual(set(puts), {'bytes */%d' % size})

    def moved_check_interrupted(self, change):
        # A moved file's local copy (the moved content) during recovery's Drive check, while `change` happens.
        p, archiver = self.moved_with_local()
        before = self.meta_bytes(p)
        real = archiver.backend.verify
        def verify(*args):
            change(p)
            return real(*args)
        with patch.object(archiver.backend, 'verify', side_effect=verify) as checked:
            archiver.recover_startup()
        self.assertTrue(checked.called); self.assertTrue(archiver.recovered)
        self.assertTrue((p / 'fcamera.mp4').is_file()); self.assertEqual(self.meta_bytes(p), before)
        return p

    def test_recovery_keeps_local_file_touched_during_drive_check(self):
        def touch(p):
            st = (p / 'fcamera.mp4').stat(); os.utime(p / 'fcamera.mp4', ns=(st.st_atime_ns, st.st_mtime_ns + 10**9))
        self.moved_check_interrupted(touch)

    def test_recovery_keeps_local_file_of_a_recording_converting_during_drive_check(self):
        def converting(p): server.processes[p.name] = object()
        self.addCleanup(server.processes.pop, 'a' * 32, None)
        self.moved_check_interrupted(converting)

    def test_user_delete_queues_drive_copies_eviction_keeps_them(self):
        a = self.log('a' * 32); b = self.log('b' * 32, ['fcamera.mp4'])
        self.archiver().run_cycle()
        self.assertEqual(len(self.files()), 3)
        # A verified Drive copy keeps its recording reachable; capacity eviction is refused.
        with server.registration_lock, server.lock, self.assertRaises(server.StorageError): server.delete_recording(b.name)
        pending = media_store.PendingDeletes(self.root)
        self.assertEqual(pending.count(), 0); self.assertTrue(b.exists())
        # The user's delete (DELETE /api/logs/<id>) queues them; the request makes no Drive call.
        since = len(self.requests())
        r = server.app.test_client().delete(f'/api/logs/{a.name}', environ_overrides=PEER, headers=HEADERS)
        self.assertEqual(r.status_code, 200); self.assertFalse(a.exists())
        self.assertEqual(self.requests()[since:], []); self.assertEqual(pending.count(), 2)
        self.archiver().run_cycle()
        self.assertEqual(pending.count(), 0); self.assertEqual(len(self.files()), 1)  # b and its copy are kept.
        self.assertEqual(self.files()[next(iter(self.files()))]['appProperties']['rv_id'], b.name)
        # MOVE also preserves the recording and never queues capacity deletions.
        c = self.log('c' * 32, ['fcamera.mp4'])
        self.archiver(mode='move', allow_local_delete=True).run_cycle()
        with server.registration_lock, server.lock, self.assertRaises(server.StorageError): server.delete_recording(c.name)
        self.assertTrue(c.exists()); self.assertEqual(pending.count(), 0)

if __name__ == '__main__': unittest.main()
