"""End to end with Google Drive as the archive (tests/fake_drive.py): copy mode with a copy that does not verify and
its retry, eviction and the user's delete in copy mode, Drive stalled and then stopped, Drive back, the switch to move
mode with deleting allowed, playback from Drive, a file deleted on Drive, the user's delete of a moved recording, and
archiving off. Each step leans on the previous one, so the scenario runs as a single test. No real Google account,
device page or browser is involved."""
import hashlib, json, os, sys, tempfile, time, unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_media_integration import make_log, PEER, HEADERS  # Sets RV_DATA and imports the server module.
import server, media_store
import archive_backends as ab
from fake_drive import FakeDrive, Handler, FOLDER

KINDS = ('rlog.zst', 'fcamera.mp4')

def sha(data): return hashlib.sha256(data).hexdigest()

class GdriveEndToEnd(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(); self.addCleanup(temp.cleanup); self.root = Path(temp.name)
        self.drive = FakeDrive().start(); self.addCleanup(self.drive.stop)
        for patcher in (patch.dict(os.environ, self.drive.env()), patch.object(server, 'ROOT', self.root),
                        patch.object(server, 'cleanup_uploads'), patch.object(server, 'UPLOADS', self.root / '.uploads'),
                        patch.object(server, 'upload_receiving', return_value=False), patch.object(server, 'submit'),
                        patch.object(server, 'connection', None)):
            patcher.start(); self.addCleanup(patcher.stop)
        (self.root / '.uploads').mkdir()
        self.http = ab.Http(sleep=lambda seconds: None, rand=lambda: 0.0)
        self.client = server.app.test_client()

    def use(self, **fields):
        # The add-on as configured with archive_backend: gdrive (restarted with these options).
        self.settings = media_store.ArchiveSettings(**{'enabled': True, 'backend': 'gdrive', 'min_age_seconds': 0, 'local_threshold_bytes': 0,
                                                       'batch': 64, 'gdrive_client_id': 'client-id', 'gdrive_client_secret': 'secret', **fields})
        self.auth = ab.DriveAuth(self.root / '.gdrive-auth.json', 'client-id', 'secret', self.http)
        self.backend = ab.DriveBackend(self.settings, self.root, self.auth, ab.DriveClient(self.http, self.auth))
        store = media_store.ArchiveStore(self.settings, self.root)
        self.archiver = media_store.Archiver(server, store, self.settings, backend=self.backend)
        for name, value in (('backend', self.backend), ('store', store), ('archiver', self.archiver)):
            patcher = patch.object(server, name, value); patcher.start(); self.addCleanup(patcher.stop)
        return self.archiver

    def recording(self, id, video):
        p = make_log(self.root, id, list(KINDS), [])
        (p / 'rlog.zst').write_bytes(os.urandom(1000)); (p / 'fcamera.mp4').write_bytes(video)
        (p / 'prepared' / 'data.json').write_text('{}')
        m = server.read_meta(p)
        m.update(decoder_version='v28-runtime-geometry', video=True, files={kind: '000003fe--d524dc1e0b--8--' + kind for kind in KINDS})
        server.save_meta(p, m)
        return p

    def get(self, url, **kw): return self.client.get(url, environ_overrides=PEER, **kw)
    def send(self, method, url, **kw): return getattr(self.client, method)(url, environ_overrides=PEER, headers=HEADERS, **kw)
    def rows(self):
        r = self.get('/api/logs'); self.assertEqual(r.status_code, 200); return {row['id']: row for row in r.json['logs']}
    def video(self, p, rng='bytes=0-9'): return self.get(f'/api/logs/{p.name}/video?source=front', headers={'Range': rng})

    def block(self):
        t0 = time.monotonic(); r = self.get('/api/settings/storage'); elapsed = time.monotonic() - t0
        self.assertEqual(r.status_code, 200)
        return r.json['archive'], elapsed

    def settle(self, seconds=15):
        # A background probe started by a request has finished (its lock is free and a result is cached).
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if self.backend.last_result() is not None and self.backend.lock.acquire(blocking=False):
                self.backend.lock.release(); return
            time.sleep(0.02)
        self.fail('the background probe did not finish')

    def files(self, id=None, kind=None):
        with self.drive.lock:
            return {i: dict(f) for i, f in self.drive.files.items() if f['mimeType'] != FOLDER and (id is None or f['appProperties'].get('rv_id') == id)
                    and (kind is None or f['appProperties'].get('rv_kind') == kind)}

    def request_count(self, needle=''):
        with self.drive.lock: return len([r for r in self.drive.requests if needle in r['path']])

    def metas(self, *ps): return {p.name: (p / 'meta.json').read_bytes() for p in ps}

    def stop_drive(self): self.drive.stop()

    def start_drive(self):
        # The same Google again, on the same address, with everything it stored.
        ThreadingHTTPServer.__init__(self.drive, self.drive.server_address, Handler)
        self.drive.start()

    def test_scenario(self):
        # 0. Signed in (the device flow against the fake), the folder created.
        self.use()
        self.auth.start_device_flow(); self.assertEqual(self.auth.poll_once(), 'granted')
        self.backend.activate(); self.assertEqual(self.backend.probe(), ('connected', None))
        videos = {id: os.urandom(size) for id, size in (('a', 5000), ('b', 300 * 1024), ('c', 4000), ('d', 4100), ('e', 4200))}
        a, b, c, d, e = (self.recording(id * 32, videos[id]) for id in 'abcde')
        content = {p.name: {kind: (p / kind).read_bytes() for kind in KINDS} for p in (a, b, c, d, e)}

        # 1. Copy mode (the default for Drive). One video's upload is damaged on the way: its copy does not verify,
        # the entry is marked, both files stay, and the cycle stops; the next cycle copies everything else.
        self.assertEqual((self.settings.mode, self.settings.effective_mode), ('move', 'copy'))
        real = ab.DriveClient.put_chunk
        def damaged(client, session, data, start, total):
            if total == len(videos['a']) and data: data = bytes([data[0] ^ 1]) + data[1:]
            return real(client, session, data, start, total)
        with patch.object(ab.DriveClient, 'put_chunk', damaged):
            self.assertEqual(self.archiver.run_cycle()['stopped'], 'hash_mismatch')
        self.assertIsNone(self.archiver.run_cycle()['stopped'])
        m = server.read_meta(a)
        self.assertEqual((media_store.location(m, 'fcamera.mp4'), media_store.entry(m, 'fcamera.mp4')['error']), ('local', 'remote_mismatch'))
        self.assertIsNone(media_store.remote(m, 'fcamera.mp4')); self.assertEqual(len(self.files(a.name, 'fcamera.mp4')), 1)
        self.assertEqual(self.rows()[a.name]['archive_error'], {'fcamera.mp4': 'remote_mismatch'})
        r = self.video(a); self.assertEqual((r.status_code, r.data), (206, videos['a'][:10])); r.close()  # The local file plays.
        self.settle()
        self.assertEqual(self.block()[0]['archive_errors'], {'remote_mismatch': 1})
        # Retry from the row: the error is cleared, the next cycle uploads it again and it verifies.
        r = self.send('post', f'/api/logs/{a.name}/archive/retry')
        self.assertEqual((r.status_code, r.json), (200, {'retried': ['fcamera.mp4']}))
        self.assertIsNone(self.archiver.run_cycle()['stopped'])
        good = media_store.remote(server.read_meta(a), 'fcamera.mp4')
        self.assertEqual((good['sha256'], self.files()[good['file_id']]['content']), (sha(videos['a']), videos['a']))
        self.assertEqual(len(self.files(a.name, 'fcamera.mp4')), 2)  # The damaged copy stays: no automatic Drive cleanup.
        for p in (a, b, c, d, e):
            m = server.read_meta(p)
            for kind in KINDS:
                block = media_store.remote(m, kind)
                self.assertEqual(media_store.location(m, kind), 'local'); self.assertEqual((p / kind).read_bytes(), content[p.name][kind])
                self.assertEqual((block['sha256'], self.files()[block['file_id']]['content']), (sha(content[p.name][kind]), content[p.name][kind]))
                self.assertIsNone(media_store.remote_pending(m, kind))
        rows = self.rows()
        for p in (a, b, c, d, e):
            self.assertEqual(rows[p.name]['remote_copies'], {'rlog': 'gdrive', 'front': 'gdrive'})
            for key in ('video_state', 'storage_locations', 'archive_error'): self.assertNotIn(key, rows[p.name])
        media = self.request_count('alt=media')
        r = self.video(b, 'bytes=10-99'); self.assertEqual((r.status_code, r.data), (206, videos['b'][10:100])); r.close()
        self.assertEqual(self.request_count('alt=media'), media)  # Played from the local file.
        # Eviction for space keeps the Drive files in copy mode: nothing is queued.
        pending = media_store.PendingDeletes(self.root)
        with self.assertLogs(server.app.logger, 'INFO') as logs:
            with server.registration_lock, server.lock: server.delete_recording(d.name)
        self.assertTrue(any(d.name in line and 'kept' in line for line in logs.output), logs.output)
        self.assertFalse(d.exists()); self.assertEqual(pending.count(), 0); self.assertEqual(len(self.files(d.name)), 2)
        # The user's delete queues them, makes no Drive call itself, and the cycle deletes them.
        since = self.request_count()
        r = self.send('delete', f'/api/logs/{e.name}'); self.assertEqual((r.status_code, r.json), (200, {'deleted': e.name}))
        self.assertEqual(self.request_count(), since); self.assertEqual(pending.count(), 2)
        self.assertIsNone(self.archiver.run_cycle()['stopped'])
        self.assertEqual(pending.count(), 0); self.assertEqual(self.files(e.name), {})
        self.assertEqual(len(self.files(d.name)), 2)  # The evicted recording's files are still there.
        self.settle()
        block, _ = self.block()
        self.assertEqual((block['backend'], block['mode'], block['effective_mode'], block['local_delete_allowed']), ('gdrive', 'move', 'copy', False))
        self.assertEqual((block['remote_copies_files'], block['archive_errors']), (6, {'remote_mismatch': 0}))

        # 2. Drive stalls: the settings panel answers at once from the cache, the probe runs in the background.
        self.backend.invalidate()
        since = self.request_count()
        with self.drive.lock: self.drive.scenario.delay_seconds = 3
        block, elapsed = self.block()
        self.assertLess(elapsed, 2); self.assertEqual((block['state'], block['reason']), ('checking', 'probe_pending'))
        deadline = time.monotonic() + 5
        while self.request_count() == since and time.monotonic() < deadline: time.sleep(0.01)
        self.assertGreater(self.request_count(), since)  # The probe's request is held by the fake now.
        stalled = time.monotonic()
        block, elapsed = self.block()
        self.assertLess(elapsed, 2); self.assertEqual((block['state'], block['reason']), ('checking', 'probe_pending'))
        with self.drive.lock: self.drive.scenario.delay_seconds = 0
        self.settle()
        self.assertGreater(time.monotonic() - stalled, 1)  # It really was waiting on the stalled Drive.
        self.assertEqual(self.backend.last_result(), ('connected', None))

        # 3. Drive is gone (the server stopped): lists answer, copies play from the local files, nothing changes.
        metas, drive = self.metas(a, b, c), self.files()
        self.stop_drive(); self.backend.invalidate()
        rows = self.rows()
        self.assertEqual(set(rows), {a.name, b.name, c.name})
        for p in (a, b, c): self.assertEqual(rows[p.name]['remote_copies'], {'rlog': 'gdrive', 'front': 'gdrive'})
        r = self.video(b, 'bytes=10-99'); self.assertEqual((r.status_code, r.data), (206, videos['b'][10:100])); r.close()
        r = self.get(f'/api/logs/{c.name}/download?source=rlog'); self.assertEqual((r.status_code, r.data), (200, content[c.name]['rlog.zst'])); r.close()
        block, elapsed = self.block()  # Starts the background probe (local files never needed Drive).
        self.assertLess(elapsed, 2); self.assertEqual(block['state'], 'checking')
        self.settle()
        block, elapsed = self.block()
        self.assertLess(elapsed, 2); self.assertEqual(block['state'], 'unavailable')
        for n in (1, 2):
            self.assertEqual(self.archiver.run_cycle()['stopped'], 'storage_unavailable')
            status = self.archiver.status(); self.assertEqual((status['last_error'], status['consecutive_failures']), ('storage_unavailable', n))
        self.assertEqual(self.metas(a, b, c), metas)

        # 4. Drive is back: a clean cycle resets the failure counters; nothing was uploaded again.
        self.start_drive(); self.backend.invalidate()
        self.assertEqual(self.files(), drive)
        self.assertIsNone(self.archiver.run_cycle()['stopped'])
        status = self.archiver.status(); self.assertEqual((status['last_error'], status['consecutive_failures']), (None, 0))
        self.assertEqual(self.metas(a, b, c), metas); self.assertEqual(self.files(), drive)

        # 5. Move mode with deleting allowed (both options): the verified copies are adopted, not uploaded again,
        # and only then the local files go.
        copies = {(p.name, kind): media_store.remote(server.read_meta(p), kind)['file_id'] for p in (a, b, c) for kind in KINDS}
        sessions = self.request_count('uploadType=resumable&fields')
        self.use(mode='move', allow_local_delete=True)
        self.assertEqual(self.archiver.status()['effective_mode'], 'move')
        result = self.archiver.run_cycle()
        self.assertEqual((result['archived'], result['stopped']), (6, None))
        self.assertEqual(self.request_count('uploadType=resumable&fields'), sessions)
        for p in (a, b, c):
            m = server.read_meta(p)
            for kind in KINDS:
                entry = media_store.entry(m, kind)
                self.assertEqual((entry['location'], entry['file_id'], entry['sha256']), ('gdrive', copies[(p.name, kind)], sha(content[p.name][kind])))
                self.assertFalse((p / kind).exists())
        self.settle()
        self.assertEqual(self.block()[0]['effective_mode'], 'move')

        # 6. Playback from Drive: the browser's range is the one asked of Drive.
        r = self.video(b, 'bytes=10-99')
        self.assertEqual((r.status_code, r.headers['Content-Range'], r.data), (206, f'bytes 10-99/{len(videos["b"])}', videos['b'][10:100])); r.close()
        with self.drive.lock: asked = [q for q in self.drive.requests if 'alt=media' in q['path']][-1]
        self.assertEqual({k.lower(): v for k, v in asked['headers'].items()}.get('range'), 'bytes=10-99')
        row = self.rows()[b.name]
        self.assertEqual((row['storage_locations'], row['video_state'], row['video']), ({'rlog': 'gdrive', 'front': 'gdrive'}, {'front': 'available'}, True))

        # 7. The video deleted on Drive by hand: missing when asked for, counted by the restart's recovery; the
        # index is never changed and nothing is marked removed.
        with self.drive.lock: del self.drive.files[copies[(b.name, 'fcamera.mp4')]]
        metas = self.metas(a, b, c)
        r = self.video(b); self.assertEqual(r.status_code, 404); r.close()
        self.assertEqual(media_store.resolve(b, server.read_meta(b), 'fcamera.mp4', None, self.backend)[1], 'missing')
        self.use(mode='move', allow_local_delete=True).recover_startup()
        self.assertTrue(self.archiver.recovered); self.assertEqual(self.archiver.status()['missing_archived'], 1)
        self.assertIsNone(self.archiver.run_cycle()['stopped'])
        self.assertEqual(self.metas(a, b, c), metas)
        self.assertEqual(media_store.location(server.read_meta(b), 'fcamera.mp4'), 'gdrive')
        self.settle()
        self.assertEqual(self.block()[0]['missing_archived'], 1)

        # 8. The user deletes the recording: its Drive files are queued (no Drive call from the request) and the
        # cycle deletes them; the one already gone counts as deleted.
        since = self.request_count()
        r = self.send('delete', f'/api/logs/{b.name}'); self.assertEqual(r.status_code, 200)
        self.assertEqual(self.request_count(), since); self.assertEqual(pending.count(), 2)
        self.assertIsNone(self.archiver.run_cycle()['stopped'])
        self.assertEqual(pending.count(), 0); self.assertFalse(pending.path.exists()); self.assertEqual(self.files(b.name), {})
        for p in (a, c):
            for kind in KINDS: self.assertIn(copies[(p.name, kind)], self.files())

        # 9. Archiving off: local-only recordings carry no new fields, a cycle does nothing and Drive is never asked.
        temp = tempfile.TemporaryDirectory(); self.addCleanup(temp.cleanup); root = Path(temp.name)
        off = media_store.ArchiveStore(media_store.ArchiveSettings(), root)
        archiver = media_store.Archiver(server, off, off.settings)
        since = self.request_count()
        with (patch.object(server, 'ROOT', root), patch.object(server, 'store', off), patch.object(server, 'archiver', archiver),
              patch.object(server, 'backend', ab.make_backend(off.settings, root, store=off))):
            p = make_log(root, 'f' * 32, list(KINDS), []); (p / 'prepared' / 'data.json').write_text('{}')
            m = server.read_meta(p); m.update(decoder_version='v28-runtime-geometry', video=True); server.save_meta(p, m)
            before = (p / 'meta.json').read_bytes()
            row = self.rows()[p.name]
            for key in ('video_state', 'storage_locations', 'remote_copies', 'archive_error'): self.assertNotIn(key, row)
            self.assertEqual(archiver.run_cycle(), {'archived': 0, 'bytes': 0, 'stopped': 'disabled'})
            r = self.get('/api/settings/storage'); self.assertEqual(r.status_code, 200)
            self.assertFalse(r.json['archive']['enabled'])
            for key in ('backend', 'gdrive', 'effective_mode', 'remote_copies_files'): self.assertNotIn(key, r.json['archive'])
            for kind in KINDS: self.assertEqual((p / kind).read_bytes(), kind.encode() * 10)
            self.assertEqual((p / 'meta.json').read_bytes(), before)
        self.assertEqual(self.request_count(), since)

if __name__ == '__main__': unittest.main()
