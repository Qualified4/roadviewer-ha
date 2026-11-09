"""'Archive everything eligible' (Archiver.start_manual) against the fake Drive: no batch or local threshold, the
minimum age and pins kept, copy mode never deleting, no second upload of a verified copy, a run at a time, partial
failures keeping local originals, safe stops on outage or expired sign-in, and a run interrupted by a restart."""
import json, shutil, sys, tempfile, threading, unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_gdrive_archiver as tga  # Sets RV_DATA and imports the server module.
import test_media_integration as tmi
import server, media_store
import archive_backends as ab

KINDS = tga.KINDS

class ManualArchiveTests(unittest.TestCase):
    setUp, auth, make_backend, archiver, files, requests = (getattr(tga.GdriveArchiverTests, n) for n in ('setUp', 'auth', 'make_backend', 'archiver', 'files', 'requests'))

    def log(self, id, uploaded=1, **fields):
        p = tga.make_log(self.root, id, KINDS, [])
        for kind in KINDS: (p / kind).write_bytes(id.encode() + kind.encode() * 10)  # Distinct content per recording.
        m = server.read_meta(p); m.update({'uploaded': uploaded, **fields}); server.save_meta(p, m)
        return p

    def run_manual(self, archiver):
        job = archiver.start_manual()
        self.assertIsNotNone(job)
        archiver.manual.join(20); self.assertFalse(archiver.manual.is_alive())
        self.assertFalse(archiver.cycle.locked()); self.assertFalse(archiver.manual_active)
        return archiver.job

    def pins(self, *ids):
        return patch.object(server.storage_policy, 'settings', {**server.storage_policy.settings, 'pinned_logs': [p.name for p in ids]})

    def test_move_all_ignores_batch_and_threshold_keeps_age_and_pins(self):
        old = [self.log(c * 32) for c in 'abc']
        young = self.log('d' * 32, uploaded=server.time.time())
        pinned = self.log('e' * 32)
        archiver = self.archiver(mode='move', allow_local_delete=True, batch=1, local_threshold_bytes=10**15)
        # The scheduled cycle is held by its threshold.
        self.assertEqual(archiver.run_cycle()['stopped'], 'below_threshold')
        with self.pins(pinned):
            plan = archiver.manual_plan()
            size = sum((p / k).stat().st_size for p in old for k in KINDS)
            self.assertEqual((plan['mode'], plan['deletes_local'], plan['files'], plan['recordings'], plan['bytes'], plan['frees_bytes']),
                             ('move', True, 6, 3, size, size))
            self.assertEqual(plan['excluded'], {'min_age': 1, 'pinned': 1, 'not_ready': 0})
            job = self.run_manual(archiver)
        self.assertEqual((job['state'], job['total_files'], job['processed'], job['succeeded'], job['failed'], job['freed_bytes']),
                         ('done', 6, 6, 6, 0, size))
        for p in old:
            m = server.read_meta(p)
            for kind in KINDS: self.assertEqual(media_store.location(m, kind), 'gdrive'); self.assertFalse((p / kind).exists())
        for p in (young, pinned):
            m = server.read_meta(p)
            for kind in KINDS: self.assertTrue((p / kind).is_file()); self.assertIsNone(media_store.remote(m, kind))
        self.assertEqual(len(self.files()), 6)
        # Persisted: a reload reads the finished run.
        self.assertEqual(json.loads((self.root / media_store.MANUAL_JOB).read_text())['state'], 'done')

    def test_copy_mode_keeps_local_and_never_uploads_twice(self):
        logs = [self.log(c * 32) for c in 'ab']
        archiver = self.archiver(mode='copy', batch=1, local_threshold_bytes=10**15)
        plan = archiver.manual_plan()
        self.assertEqual((plan['mode'], plan['deletes_local'], plan['frees_bytes'], plan['files'], plan['local_delete_blocked']), ('copy', False, 0, 4, False))
        job = self.run_manual(archiver)
        self.assertEqual((job['state'], job['succeeded'], job['freed_bytes'], job['deletes_local']), ('done', 4, 0, False))
        for p in logs:
            for kind in KINDS: tga.GdriveArchiverTests.assert_copied(self, p, kind)
        uploads = len(self.requests('PUT')) + len(self.requests('POST'))
        self.assertEqual(archiver.manual_plan()['files'], 0)
        job = self.run_manual(archiver)
        self.assertEqual((job['state'], job['total_files'], job['processed']), ('done', 0, 0))
        self.assertEqual(len(self.files()), 4)
        self.assertEqual(len(self.requests('PUT')) + len(self.requests('POST')), uploads)

    def test_move_without_local_delete_is_announced_as_copy(self):
        p = self.log('a' * 32)
        archiver = self.archiver(mode='move')
        plan = archiver.manual_plan()
        self.assertEqual((plan['configured_mode'], plan['mode'], plan['deletes_local'], plan['local_delete_blocked']), ('move', 'copy', False, True))
        self.assertEqual(self.run_manual(archiver)['freed_bytes'], 0)
        for kind in KINDS: self.assertTrue((p / kind).is_file())

    def test_existing_copy_is_adopted_by_move_without_upload(self):
        p = self.log('a' * 32)
        self.run_manual(self.archiver())  # Copies first.
        before = len(self.files())
        archiver = self.archiver(mode='move', allow_local_delete=True)
        sessions = len(tga.GdriveArchiverTests.sessions_started(self))
        job = self.run_manual(archiver)
        self.assertEqual((job['state'], job['succeeded']), ('done', 2))
        self.assertEqual(len(self.files()), before); self.assertEqual(len(tga.GdriveArchiverTests.sessions_started(self)), sessions)
        for kind in KINDS: self.assertFalse((p / kind).exists())

    def test_one_run_at_a_time_and_settings_locked(self):
        self.log('a' * 32)
        archiver = self.archiver(mode='move', allow_local_delete=True)
        gate, entered = threading.Event(), threading.Event()
        real = archiver.archive_remote
        def slow(*args, **kwargs):
            entered.set(); gate.wait(10); return real(*args, **kwargs)
        client = server.app.test_client()
        with patch.object(archiver, 'archive_remote', side_effect=slow), patch.object(server, 'archiver', archiver):
            self.assertIsNotNone(archiver.start_manual()); self.assertTrue(entered.wait(5))
            self.assertIsNone(archiver.start_manual())
            self.assertEqual(archiver.run_cycle()['stopped'], 'busy')  # The scheduled cycle does not compete.
            r = client.post('/api/settings/archive/run', headers=tga.HEADERS, environ_overrides=tga.PEER)
            self.assertEqual((r.status_code, r.json['error']), (409, 'archive_running'))
            r = client.post('/api/settings/archive', json={'archive_batch': 8}, headers=tga.HEADERS, environ_overrides=tga.PEER)
            self.assertEqual((r.status_code, r.json['error']), (409, 'archive_running'))
            r = client.post('/api/settings/storage', json={'max_bytes': 0, 'policy': 'reject_new'}, headers=tga.HEADERS, environ_overrides=tga.PEER)
            self.assertEqual((r.status_code, r.json['error']), (409, 'archive_running'))
            r = client.get('/api/settings/storage', environ_overrides=tga.PEER)
            self.assertEqual((r.json['archive']['manual_active'], r.json['archive']['manual']['state'], r.json['archive']['running']), (True, 'running', True))
            gate.set(); archiver.manual.join(20)
        self.assertEqual(archiver.job['state'], 'done')

    def test_verification_failure_is_partial_and_keeps_that_original(self):
        a, b = self.log('a' * 32), self.log('b' * 32)
        archiver = self.archiver(mode='move', allow_local_delete=True)
        real = archiver._verify
        def verify(ref, sha256, size, md5):
            return ('mismatch', None) if (a / 'rlog.zst').is_file() and sha256 == media_store._sha256(a / 'rlog.zst') else real(ref, sha256, size, md5)
        with patch.object(archiver, '_verify', side_effect=verify):
            job = self.run_manual(archiver)
        self.assertEqual((job['state'], job['failed'], job['last_failure']), ('partial', 1, 'hash_mismatch'))
        self.assertTrue((a / 'rlog.zst').is_file())
        self.assertEqual(media_store.entry(server.read_meta(a), 'rlog.zst').get('error'), 'remote_mismatch')
        for kind in KINDS: self.assertFalse((b / kind).exists())  # The run went on.

    def test_outage_and_expired_sign_in_stop_safely(self):
        for code, reason, hexa in (('unavailable', 'storage_unavailable', '1'), ('auth_expired', 'auth_expired', '2')):
            with self.subTest(code=code):
                ids = [self.log((hexa + c) * 16) for c in 'ef']
                archiver = self.archiver(mode='move', allow_local_delete=True)
                calls = []
                real = archiver.backend.upload
                def upload(*args, **kwargs):
                    calls.append(1)
                    if len(calls) > 1: raise ab.BackendError(code)
                    return real(*args, **kwargs)
                with patch.object(archiver.backend, 'upload', side_effect=upload):
                    job = self.run_manual(archiver)
                self.assertEqual((job['state'], job['error'], job['succeeded'], job['failed']), ('failed', reason, 1, 1))
                left = sum((p / k).is_file() for p in ids for k in KINDS)
                self.assertEqual(left, 3)  # Only the verified, committed file went; the failed one and the rest stay.
                for p in ids:
                    for kind in KINDS:
                        if (p / kind).is_file(): self.assertEqual(media_store.location(server.read_meta(p), kind), 'local')
                for p in ids:
                    for kind in KINDS: (p / kind).unlink(missing_ok=True)
                    m = server.read_meta(p); m['status'] = 'unconverted'; server.save_meta(p, m)

    def test_restart_marks_a_running_job_interrupted(self):
        (self.root / media_store.MANUAL_JOB).write_text(json.dumps({'id': 'x', 'state': 'running', 'processed': 1, 'total_files': 5}))
        archiver = self.archiver()
        self.assertEqual(archiver.job['state'], 'interrupted')
        self.assertEqual(json.loads((self.root / media_store.MANUAL_JOB).read_text())['state'], 'interrupted')
        self.assertFalse(archiver.status()['manual_active'])

    def test_run_route_previews_and_starts(self):
        self.log('a' * 32)
        archiver = self.archiver(mode='move', allow_local_delete=True)
        client = server.app.test_client()
        with patch.object(server, 'archiver', archiver):
            r = client.get('/api/settings/archive/run', environ_overrides=tga.PEER)
            self.assertEqual((r.status_code, r.json['plan']['files'], r.json['plan']['mode'], r.json['manual']), (200, 2, 'move', None))
            r = client.post('/api/settings/archive/run', headers=tga.HEADERS, environ_overrides=tga.PEER)
            self.assertEqual((r.status_code, r.json['started'], r.json['manual']['total_files']), (202, True, 2))
            archiver.manual.join(20)
            self.assertEqual(client.get('/api/settings/archive/run', environ_overrides=tga.PEER).json['manual']['state'], 'done')

    def test_running_job_reports_the_file_in_progress_speed_and_time_left(self):
        # The panel shows bytes sent (the file being uploaded included), the speed and the time left while a run goes.
        logs = [self.log(c * 32) for c in 'ab']
        archiver = self.archiver(mode='copy')
        seen, upload = [], archiver.backend.upload
        def watched(*args, on_progress=None, **kw):
            def progress(sent):
                on_progress(sent); seen.append(archiver.status()['manual'])
            return upload(*args, on_progress=progress, **kw)
        with patch.object(archiver.backend, 'upload', watched):
            job = self.run_manual(archiver)
        total = sum((p / k).stat().st_size for p in logs for k in KINDS)
        self.assertEqual((job['state'], job['processed_bytes'], job['total_bytes']), ('done', total, total))
        self.assertNotIn('rate', job)  # Not persisted: a finished run shows no speed.
        running = [m for m in seen if m.get('current_bytes')]
        self.assertTrue(running, 'the file in progress is reported')
        for m in running:
            self.assertIn('rate', m); self.assertIn('eta_seconds', m)
            self.assertLessEqual(m['processed_bytes'] + m['current_bytes'], total)

class TransferTests(unittest.TestCase):
    def test_speed_over_the_latest_window_without_resumed_bytes(self):
        now = [0.0]
        t = media_store._Transfer(clock=lambda: now[0])
        self.assertEqual(t.snapshot(), (0, None))  # Nothing sent yet (startup checks): no speed.
        t.begin(50)  # A resumed upload: its first 50 bytes were sent before.
        for i in range(1, 5): now[0] = i; t.progress(50 + 100 * i)
        self.assertEqual(t.snapshot(), (450, None))  # Under RATE_MIN seconds measured.
        now[0] = 5; t.progress(550)
        self.assertEqual(t.snapshot(), (550, 100.0))
        t.end()
        # A stall lowers the speed; old samples leave the window.
        now[0] = 10; self.assertEqual(t.snapshot()[1], 50.0)
        now[0] = 100; t.begin(); t.progress(3000)
        now[0] = 110; self.assertEqual(t.snapshot()[1], 300.0)  # Measured from this file's start, not the idle gap.
        # A restarted upload (sent goes back) counts only new bytes.
        t.progress(1000); self.assertEqual(t.sent, 3500)
        t.end(200); self.assertEqual((t.sent, t.file), (3700, 0))

class ManualNasTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(); self.addCleanup(temp.cleanup); self.root = Path(temp.name)
        for patcher in (patch.object(server, 'ROOT', self.root), patch.object(server, 'upload_receiving', return_value=False), patch.object(server, 'submit')):
            patcher.start(); self.addCleanup(patcher.stop)
        self.nas, _ = tmi.make_nas(self.root)
        self.addCleanup(shutil.rmtree, self.nas, True)

    def archiver(self, **fields):
        settings = media_store.ArchiveSettings(**{'enabled': True, 'path': self.nas, 'min_age_seconds': 86400, **fields})
        store = media_store.ArchiveStore(settings, self.root); store.activate()
        return media_store.Archiver(server, store, settings, backend=ab.make_backend(settings, self.root, store=store))

    def run_manual(self, archiver):
        self.assertIsNotNone(archiver.start_manual()); archiver.manual.join(20)
        return archiver.job

    def test_moves_everything_past_the_batch(self):
        logs = [tga.make_log(self.root, c * 32, KINDS, []) for c in 'abc']
        archiver = self.archiver(batch=1, local_threshold_bytes=10**15)
        self.assertEqual(archiver.run_cycle()['stopped'], 'below_threshold')
        plan = archiver.manual_plan()
        self.assertEqual((plan['mode'], plan['deletes_local'], plan['files']), ('move', True, 6))
        job = self.run_manual(archiver)
        self.assertEqual((job['state'], job['succeeded']), ('done', 6))
        for p in logs:
            for kind in KINDS: self.assertEqual(media_store.location(server.read_meta(p), kind), 'nas'); self.assertFalse((p / kind).exists())

    def test_share_over_its_limit_is_never_cleaned_by_a_manual_run(self):
        old = tga.make_log(self.root, 'a' * 32, ['rlog.zst'], ['fcamera.mp4'], nas=self.nas)
        new = tga.make_log(self.root, 'b' * 32, KINDS, [])
        archiver = self.archiver(nas_max_bytes=1)
        job = self.run_manual(archiver)
        self.assertEqual((job['state'], job['error'], job['succeeded']), ('failed', 'nas_full', 0))
        self.assertTrue((self.nas / old.name / 'fcamera.mp4').is_file())
        self.assertEqual(media_store.location(server.read_meta(old), 'fcamera.mp4'), 'nas')
        for kind in KINDS: self.assertTrue((new / kind).is_file())

if __name__ == '__main__': unittest.main()
