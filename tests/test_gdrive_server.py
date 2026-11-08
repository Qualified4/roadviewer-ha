"""The server with Google Drive as the archive (tests/fake_drive.py): archived files stream through the same URLs
(ranges, downloads, ZIPs), are staged locally only where a path is needed (original-format export, conversion),
a local file always wins over its remote copy, and lists, admission and restarts treat a moved file as stored."""
import hashlib, io, json, os, sys, tempfile, threading, time, unittest, zipfile
from pathlib import Path
from unittest.mock import MagicMock, patch
sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_media_integration import make_log, PEER, HEADERS  # Sets RV_DATA and imports the server module.
import server, media_store, playback_cache
import archive_backends as ab
from fake_drive import FakeDrive

DAY = 86400
MIB = 2**20
REAL_CLEANUP = server.cleanup_uploads  # setUp patches it out; the startup cleanup test calls the real one.
HEVC = b'\x00\x00\x01\x40\x01'  # The start validate_hevc accepts.
SUMMARY = {'duration': 1, 'warnings': [], 'model_frames': 0, 'videos': {'front': {'codec': 'hevc'}}}

class GdriveServerTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(); self.addCleanup(temp.cleanup); self.root = Path(temp.name)
        self.drive = FakeDrive().start(); self.addCleanup(self.drive.stop)
        for patcher in (patch.dict(os.environ, self.drive.env()), patch.object(server, 'ROOT', self.root),
                        patch.object(server, 'cleanup_uploads'), patch.object(server, 'UPLOADS', self.root / '.uploads'),
                        patch.object(server, 'upload_receiving', return_value=False), patch.object(server, 'submit')):
            patcher.start(); self.addCleanup(patcher.stop)
        (self.root / '.uploads').mkdir()
        # The in-memory copy of the watched video is off (max_bytes=0) unless a test turns it on: it adds its own
        # download to what Drive is asked.
        self.playback = playback_cache.PlaybackCache(max_bytes=0, janitor=False)
        playback_patch = patch.object(server, 'playback', self.playback); playback_patch.start(); self.addCleanup(playback_patch.stop)
        self.http = ab.Http(sleep=lambda seconds: None, rand=lambda: 0.0)
        auth = self.auth(); auth.start_device_flow(); self.assertEqual(auth.poll_once(), 'granted')
        self.make_backend().activate()
        self.assertEqual(self.backend.probe(), ('connected', None))
        self.client = server.app.test_client()

    def auth(self): return ab.DriveAuth(self.root / '.gdrive-auth.json', 'client-id', 'secret', self.http)

    def make_backend(self, **fields):
        # The server as configured with archive_backend: gdrive: its store has no share path.
        self.settings = media_store.ArchiveSettings(**{'enabled': True, 'backend': 'gdrive', 'min_age_seconds': DAY, **fields})
        auth = self.auth()
        self.backend = ab.DriveBackend(self.settings, self.root, auth, ab.DriveClient(self.http, auth))
        for name, value in (('backend', self.backend), ('store', media_store.ArchiveStore(self.settings, self.root))):
            patcher = patch.object(server, name, value); patcher.start(); self.addCleanup(patcher.stop)
        patcher = patch.object(server, 'archiver', media_store.Archiver(server, server.store, self.settings, backend=self.backend))
        patcher.start(); self.addCleanup(patcher.stop)
        return self.backend

    def archive(self, **fields):
        backend = self.make_backend(**fields)
        archiver = media_store.Archiver(server, server.store, self.settings, backend=backend)
        result = archiver.run_cycle()
        self.assertIsNone(result['stopped'], result)
        return archiver

    def move(self): return self.archive(mode='move', allow_local_delete=True)

    def log(self, id, data, **fields):
        p = make_log(self.root, id, list(data), [])
        for kind, content in data.items(): (p / kind).write_bytes(content)
        m = server.read_meta(p)
        m.update({'uploaded': 1, 'files': {kind: '000003fe--d524dc1e0b--8--' + kind for kind in data}, **fields}); server.save_meta(p, m)
        return p

    def ready(self, p, **fields):
        m = server.read_meta(p); (p / 'prepared' / 'data.json').write_text('{}')
        m.update({'status': 'ready', 'decoder_version': 'v28-runtime-geometry', 'video': server.has_video(p, m), **fields}); server.save_meta(p, m)
        return m

    def convert(self, p, prepared, summary=SUMMARY):
        # A conversion whose decoder (replaced) produced `prepared` and `summary`; returns the Popen mock.
        for name, data in prepared.items(): (p / 'prepared' / name).write_bytes(data)
        (p / 'prepared' / 'summary.json').write_text(json.dumps(summary))
        m = server.read_meta(p); m.update(status='queued', manual_conversion=True); server.save_meta(p, m)
        with patch.object(server, 'ProgressChannel') as channel, patch.object(server.subprocess, 'Popen') as popen:
            channel.return_value.__enter__.return_value.options.return_value = {}
            popen.return_value.communicate.return_value = ('', ''); popen.return_value.returncode = 0; popen.return_value.poll.return_value = 0
            server.run_job(p.name)
        return popen

    def drive_file(self, kind):
        with self.drive.lock: return next(f for f in self.drive.files.values() if f['appProperties'].get('rv_kind') == kind)

    def get(self, url, **kw): return self.client.get(url, environ_overrides=PEER, **kw)
    def send(self, method, url, **kw): return getattr(self.client, method)(url, environ_overrides=PEER, headers=HEADERS, **kw)

    def requests(self, needle):
        with self.drive.lock: return [r for r in self.drive.requests if needle in r['path']]

    def media_requests(self): return self.requests('alt=media')

    def assert_no_ids(self, text):
        files = self.drive.files
        with self.drive.lock: ids = [i for i in files]
        for i in ids:
            for shown in (f'"{i}"', f'{i}:', f'/{i}'): self.assertNotIn(shown, text)
        for secret in ('upload_id=', 'file_id', 'remote_pending', 'access_token', 'refresh_token', 'Bearer'): self.assertNotIn(secret, text)

    def test_watched_video_is_copied_and_seeks_are_answered_locally(self):
        # Opening a Drive video holds the whole file in memory; once received, seeks there never ask Google.
        video = os.urandom(3 * MIB + 77)
        p = self.log('c' * 32, {'rlog.zst': b'log' * 100, 'fcamera.mp4': video}); self.ready(p)
        self.move(); self.playback.max_bytes = 64 * MIB
        r = self.get(f'/api/logs/{p.name}/video?source=front', headers={'Range': 'bytes=0-'}); self.assertEqual(r.status_code, 206); r.close()
        deadline = time.monotonic() + 10
        while not (self.playback.entry and self.playback.entry.complete):
            self.assertLess(time.monotonic(), deadline, 'the copy did not finish'); time.sleep(0.02)
        with self.drive.lock: before = len(self.drive.requests)
        for start in (2 * MIB, 100, MIB + 5):
            r = self.get(f'/api/logs/{p.name}/video?source=front', headers={'Range': f'bytes={start}-'})
            self.assertEqual((r.status_code, r.headers['Content-Range'], r.data), (206, f'bytes {start}-{len(video) - 1}/{len(video)}', video[start:]))
        r = self.get(f'/api/logs/{p.name}/video?source=front', headers={'Range': 'bytes=10-99'}); self.assertEqual(r.data, video[10:100])
        with self.drive.lock: asked = self.drive.requests[before:]
        self.assertEqual(asked, [], 'seeks into the copy make no request to Google (state and metadata are recent)')

    def test_whole_video_copy_reads_the_held_copy_not_google_again(self):
        # The page's background copy of the whole video (X-Roadviewer-Whole-Video) waits for the held copy instead of
        # downloading the same file from Google a second time; its parts add up to the file.
        video = os.urandom(3 * MIB + 77)
        p = self.log('d' * 32, {'rlog.zst': b'log' * 100, 'fcamera.mp4': video}); self.ready(p)
        self.move(); self.playback.max_bytes = 64 * MIB
        r = self.get(f'/api/logs/{p.name}/video?source=front', headers={'Range': 'bytes=0-'}); r.close()
        got, at = b'', 0
        while at < len(video):
            r = self.get(f'/api/logs/{p.name}/video?source=front', headers={'Range': f'bytes={at}-', 'X-Roadviewer-Whole-Video': '1'})
            self.assertEqual(r.status_code, 206); self.assertTrue(r.data); got += r.data; at += len(r.data)
        self.assertEqual(got, video)
        # The player's own first range and the held copy: nothing more for the whole-video parts.
        self.assertEqual(len(self.media_requests()), 2, 'no second download from Google')

    def test_remote_video_range_streams_without_buffering(self):
        video = os.urandom(3 * MIB + 123)
        p = self.log('a' * 32, {'rlog.zst': b'log' * 100, 'fcamera.mp4': video}); self.ready(p)
        self.move()
        self.assertEqual(media_store.location(server.read_meta(p), 'fcamera.mp4'), 'gdrive')
        self.assertFalse((p / 'fcamera.mp4').exists())
        r = self.get(f'/api/logs/{p.name}/video?source=front', headers={'Range': 'bytes=10-99'})
        self.assertEqual(r.status_code, 206)
        # No Content-Length on playback ranges (Content-Range has the size): Ingress would buffer a short one whole.
        self.assertEqual((r.headers['Content-Range'], r.headers.get('Content-Length'), r.headers['Accept-Ranges']), (f'bytes 10-99/{len(video)}', None, 'bytes'))
        # The browser may keep played ranges (private cache only), so a seek back does not go to Google again.
        self.assertEqual(r.headers['Cache-Control'], 'private, max-age=3600'); self.assertTrue(r.headers['ETag'])
        self.assertEqual(r.mimetype, 'video/mp4')
        self.assertEqual(r.data, video[10:100])
        # The browser's range is the one asked of Drive: nothing beyond it is downloaded.
        self.assertEqual(self.media_requests()[-1]['headers'].get('Range'), 'bytes=10-99')
        self.assert_no_ids(json.dumps(dict(r.headers)))
        # Open-ended and whole-file requests stream in small chunks; the response never holds the file.
        r = self.get(f'/api/logs/{p.name}/video?source=front', headers={'Range': f'bytes={MIB}-'}, buffered=False)
        self.assertEqual((r.status_code, r.headers['Content-Range']), (206, f'bytes {MIB}-{len(video) - 1}/{len(video)}'))
        chunks = list(r.response); r.close()
        self.assertTrue(len(chunks) > 1 and all(len(c) <= 65536 for c in chunks))
        self.assertEqual(b''.join(chunks), video[MIB:])
        # An open range is answered with at most PLAYBACK_RANGE, and only that much is asked of Drive: a request the
        # browser drops on a seek cannot keep streaming the rest of the file.
        with patch.object(server, 'PLAYBACK_RANGE', MIB):
            r = self.get(f'/api/logs/{p.name}/video?source=front', headers={'Range': f'bytes={MIB}-'})
        self.assertEqual((r.status_code, r.headers['Content-Range'], r.data), (206, f'bytes {MIB}-{2 * MIB - 1}/{len(video)}', video[MIB:2 * MIB]))
        self.assertEqual(self.media_requests()[-1]['headers'].get('Range'), f'bytes={MIB}-{2 * MIB - 1}')
        # Seeks reuse the file's metadata for a while: each one is a single request to Drive, not two.
        with self.drive.lock: before = len(self.drive.requests)
        r = self.get(f'/api/logs/{p.name}/video?source=front', headers={'Range': 'bytes=5-9'}); self.assertEqual(r.data, video[5:10])
        with self.drive.lock: asked = [q['path'] for q in self.drive.requests[before:]]
        self.assertEqual(len(asked), 1); self.assertIn('alt=media', asked[0])
        r = self.get(f'/api/logs/{p.name}/video?source=front', buffered=False)
        self.assertEqual((r.status_code, r.headers['Content-Length']), (200, str(len(video))))
        self.assertNotIn('Content-Range', r.headers)
        chunks = list(r.response); r.close()
        self.assertTrue(all(len(c) <= 65536 for c in chunks)); self.assertEqual(b''.join(chunks), video)
        # A suffix range is a single range too; several ranges, garbage or a start past the end are refused.
        r = self.get(f'/api/logs/{p.name}/video?source=front', headers={'Range': 'bytes=-5'})
        self.assertEqual((r.status_code, r.data), (206, video[-5:]))
        for bad in ('bytes=0-1,4-5', 'items=0-1', 'bytes=9-3', f'bytes={len(video)}-', 'bytes=x-'):
            with self.subTest(bad=bad):
                r = self.get(f'/api/logs/{p.name}/video?source=front', headers={'Range': bad})
                self.assertEqual((r.status_code, r.headers.get('Content-Range')), (416, f'bytes */{len(video)}'))

    def test_remote_original_download_attachment(self):
        log, video = os.urandom(200 * 1024), os.urandom(100 * 1024)
        p = self.log('a' * 32, {'rlog.zst': log, 'fcamera.mp4': video}); self.ready(p)
        self.move()
        r = self.get(f'/api/logs/{p.name}/original/rlog.zst')
        self.assertEqual((r.status_code, r.data, r.mimetype), (200, log, 'application/zstd'))
        self.assertEqual(r.headers['Content-Disposition'], 'attachment; filename="000003fe--d524dc1e0b--8--rlog.zst"')
        self.assertEqual(r.headers['Content-Length'], str(len(log)))
        r = self.get(f'/api/logs/{p.name}/original/rlog.zst', headers={'Range': 'bytes=0-9'})
        self.assertEqual((r.status_code, r.data), (206, log[:10]))
        # The single downloads (log, camera MP4) take the same path.
        r = self.get(f'/api/logs/{p.name}/download?source=rlog')
        self.assertEqual((r.status_code, r.data), (200, log))
        self.assertIn('attachment', r.headers['Content-Disposition'])
        r = self.get(f'/api/logs/{p.name}/download?source=front&format=mp4')
        self.assertEqual((r.status_code, r.data, r.mimetype), (200, video, 'video/mp4'))
        self.assertIn('000003fe--d524dc1e0b--8--fcamera.mp4', r.headers['Content-Disposition'])
        r = self.get(f'/api/logs/{p.name}/download/video')
        self.assertEqual((r.status_code, r.data), (200, video))

    def test_zip_mixes_local_and_remote(self):
        moved = {'rlog.zst': os.urandom(300 * 1024), 'fcamera.mp4': os.urandom(700 * 1024)}
        a = self.log('a' * 32, moved); self.ready(a)
        self.move()
        local = {'rlog.zst': b'local log' * 50, 'fcamera.mp4': b'local video' * 50}
        b = self.log('b' * 32, local, uploaded=2 ** 40); self.ready(b)  # Too young to archive.
        self.assertEqual(media_store.location(server.read_meta(b), 'rlog.zst'), 'local')
        for url in (f'/api/logs/download.zip?ids={a.name},{b.name}&parts=rlog,front', f'/api/logs/download.zip?ids={a.name},{b.name}&parts=rlog,front&format=mp4'):
            with self.subTest(url=url):
                r = self.get(url)
                self.assertEqual(r.status_code, 200)
                with zipfile.ZipFile(io.BytesIO(r.data)) as z:
                    contents = {i.filename: z.read(i) for i in z.infolist()}
                self.assertEqual(sorted(contents.values()), sorted([*moved.values(), *local.values()]))
                self.assertEqual(len(contents), 4)

    def test_export_original_format_from_remote_stages_then_cleans(self):
        video = os.urandom(400 * 1024)
        p = self.log('a' * 32, {'rlog.zst': b'log' * 100, 'fcamera.mp4': video}); self.ready(p, video_codecs={'front': 'hevc'})
        self.move()
        staged, seen = [], []
        real = server.stage_remote
        def stage(p, rf):
            path = real(p, rf); staged.append(path)
            self.assertTrue(path.is_relative_to(p / '.staging')); self.assertEqual(path.read_bytes(), video)
            return path
        def export(source, kind, offset):
            # The exporter reads the staged copy through its descriptor, as media_export.py does.
            seen.append((kind, offset)); os.lseek(source.fileno(), 0, 0); yield source.read()
        with patch.object(server, 'stage_remote', side_effect=stage), patch.object(server, 'export_chunks', side_effect=export):
            r = self.get(f'/api/logs/{p.name}/download?source=front&format=original')
            self.assertEqual((r.status_code, r.data), (200, video)); r.close()
            r = self.get(f'/api/logs/download.zip?ids={p.name}&parts=front&format=original')
            self.assertEqual(r.status_code, 200)
            with zipfile.ZipFile(io.BytesIO(r.data)) as z: self.assertEqual([z.read(i) for i in z.infolist()], [video])
            r.close()
        self.assertEqual(len(staged), 2); self.assertEqual(seen, [('hevc', 0), ('hevc', 0)])
        for path in staged: self.assertFalse(path.exists())
        self.assertFalse((p / '.staging').exists())
        # A copy that does not match its index is never exported; the staging area is cleaned anyway.
        with self.drive.lock:
            f = next(f for f in self.drive.files.values() if f['appProperties'].get('rv_kind') == 'fcamera.mp4')
            f['content'] = bytes(len(video))
        r = self.get(f'/api/logs/{p.name}/download?source=front&format=original')
        self.assertEqual((r.status_code, r.json['error']), (409, 'media_corrupt'))
        self.assertFalse((p / '.staging').exists())

    def test_export_refused_without_disk_space(self):
        p = self.log('a' * 32, {'rlog.zst': b'log' * 100, 'fcamera.mp4': os.urandom(1000)}); self.ready(p, video_codecs={'front': 'hevc'})
        self.move()
        with patch.object(server.shutil, 'disk_usage', return_value=type('U', (), {'free': 50 * MIB})()):
            r = self.get(f'/api/logs/{p.name}/download?source=front&format=original')
        self.assertEqual((r.status_code, r.json['error']), (507, 'insufficient_disk_space'))
        self.assertFalse(self.media_requests()); self.assertFalse((p / '.staging').exists())

    def test_run_job_stages_remote_inputs(self):
        data = {'rlog.zst': os.urandom(5000), 'fcamera.hevc': os.urandom(9000)}
        p = self.log('a' * 32, data); self.ready(p)
        self.move()
        m = server.read_meta(p)
        self.assertEqual({k: media_store.location(m, k) for k in data}, {'rlog.zst': 'gdrive', 'fcamera.hevc': 'gdrive'})
        m.update(status='queued', manual_conversion=True); server.save_meta(p, m)
        seen = {}
        def popen(args, **kw):
            paths = json.loads(kw['env']['RV_MEDIA_PATHS'])
            seen.update(log=Path(args[-2]), video=Path(paths['fcamera.hevc']), other=Path(paths['ecamera.hevc']))
            seen['contents'] = (seen['log'].read_bytes(), seen['video'].read_bytes())
            proc = unittest.mock.MagicMock(); proc.communicate.return_value = ('', 'failed'); proc.returncode = 1; proc.poll.return_value = 1
            return proc
        with patch.object(server, 'ProgressChannel') as channel, patch.object(server.subprocess, 'Popen', side_effect=popen):
            channel.return_value.__enter__.return_value.options.return_value = {}
            server.run_job(p.name)
        for key in ('log', 'video'): self.assertTrue(seen[key].is_relative_to(p / '.staging'), seen[key])
        self.assertEqual(seen['contents'], (data['rlog.zst'], data['fcamera.hevc']))
        self.assertEqual(seen['other'], p / 'ecamera.hevc')  # Not stored: the decoder finds nothing, as before.
        self.assertFalse((p / '.staging').exists())
        self.assertEqual(server.read_meta(p)['status'], 'error')
        # Drive unreachable: the conversion is deferred, as for an unreachable share; nothing is staged.
        m = server.read_meta(p); m.update(status='queued', error=None); server.save_meta(p, m)
        self.backend.invalidate(); self.drive.scenario.fail_next('/files/', 500, times=100)
        with patch.object(server.subprocess, 'Popen') as never:
            server.run_job(p.name)
        never.assert_not_called()
        m = server.read_meta(p)
        self.assertEqual((m['status'], m.get('deferred')), ('unconverted', 'storage'))
        self.assertFalse((p / '.staging').exists())

    def test_local_preferred_when_both(self):
        log, video = b'log' * 300, b'video' * 300
        p = self.log('a' * 32, {'rlog.zst': log, 'fcamera.mp4': video}); self.ready(p)
        self.archive()  # Copy mode: the local files stay, each with a verified Drive copy.
        m = server.read_meta(p)
        self.assertIsNotNone(media_store.remote(m, 'fcamera.mp4')); self.assertTrue((p / 'fcamera.mp4').is_file())
        before = len(self.requests('/drive/v3/files'))
        r = self.get(f'/api/logs/{p.name}/video?source=front', headers={'Range': 'bytes=0-4'})
        self.assertEqual((r.status_code, r.data), (206, video[:5])); r.close()
        r = self.get(f'/api/logs/{p.name}/original/rlog.zst'); self.assertEqual(r.data, log); r.close()
        r = self.get(f'/api/logs/download.zip?ids={p.name}&parts=rlog,front'); self.assertEqual(r.status_code, 200); r.close()
        self.assertEqual(len(self.requests('/drive/v3/files')), before)  # Drive was never asked.

    def test_remote_unavailable_503_and_list_ok(self):
        p = self.log('a' * 32, {'rlog.zst': b'log' * 100, 'fcamera.mp4': b'video' * 100}); self.ready(p)
        self.move()
        # The download itself fails (the file's metadata still answers): 503, never a partial body.
        self.drive.scenario.fail_next('alt=media', 500, times=100)
        r = self.get(f'/api/logs/{p.name}/video?source=front')
        self.assertEqual((r.status_code, r.json['error']), (503, 'storage_unavailable'))
        self.assertEqual(r.json['message'], server.REMOTE_UNAVAILABLE)
        r = self.get(f'/api/logs/{p.name}/original/rlog.zst')
        self.assertEqual((r.status_code, r.json['error']), (503, 'storage_unavailable'))
        self.drive.scenario.failures.clear()
        # Drive unreachable altogether: every single-file route answers 503; the list keeps working.
        self.backend.invalidate(); self.drive.scenario.fail_next('/files/', 500, times=100)
        for url in (f'/api/logs/{p.name}/video?source=front', f'/api/logs/{p.name}/original/rlog.zst', f'/api/logs/{p.name}/download?source=rlog',
                    f'/api/logs/download.zip?ids={p.name}&parts=rlog'):
            with self.subTest(url=url):
                r = self.get(url)
                self.assertEqual((r.status_code, r.json['error'], r.json['message']), (503, 'storage_unavailable', server.REMOTE_UNAVAILABLE))
        r = self.get('/api/logs')
        self.assertEqual(r.status_code, 200)
        row = r.json['logs'][0]
        self.assertEqual((row['video'], row['storage_locations']['front']), (True, 'gdrive'))
        self.assertEqual(row['video_state']['front'], 'storage_unavailable')
        self.assertEqual(media_store.location(server.read_meta(p), 'fcamera.mp4'), 'gdrive')  # Index untouched.

    def test_list_keeps_last_known_drive_state_while_refreshing(self):
        # Drive's state is cached for 10 s. A stale cache used to read 'checking' for the list, which turned over every
        # archived row's cached entry (and again when the answer came back): the whole list rebuilt every 10 s.
        p = self.log('a' * 32, {'rlog.zst': b'log' * 100, 'fcamera.mp4': b'video' * 100}); self.ready(p)
        self.move(); self.assertEqual(self.backend.probe(), ('connected', None))
        settled = patch.object(server, 'LIST_RACY_SECONDS', -60); settled.start(); self.addCleanup(settled.stop)  # Rows are cached.
        first = self.get('/api/logs').json['logs'][0]
        self.assertEqual(first['storage_locations']['front'], 'gdrive')
        stamp, *result = self.backend.cached; self.backend.cached = (stamp - 60, *result)  # Stale.
        with patch.object(server, 'build_list_row', wraps=server.build_list_row) as built:
            row = self.get('/api/logs').json['logs'][0]
        built.assert_not_called()
        self.assertEqual(row['video_state'], first['video_state'])
        for thread in [t for t in threading.enumerate() if t.name == 'archive-probe']: thread.join(5)
        self.assertIsNotNone(self.backend.last_result())  # Refreshed in the background.
        # Before any probe (or after invalidate()) there is nothing known: the list says so instead of guessing.
        self.backend.invalidate()
        with patch.object(self.backend, 'probe', return_value=('checking', 'probe_pending')):
            self.assertEqual(server.list_archive_state(), 'checking')

    def test_storage_status_keeps_last_known_drive_state_while_refreshing(self):
        # The library header polls the storage status: a stale cache must not read 'checking' until its next poll.
        self.assertEqual(self.backend.probe(), ('connected', None))
        stamp, *result = self.backend.cached; self.backend.cached = (stamp - 60, *result)  # Stale.
        with patch.object(self.backend, 'probe', return_value=('checking', 'probe_pending')):  # The refresh is still out.
            self.assertEqual(self.get('/api/settings/storage').json['archive']['state'], 'connected')
            self.backend.invalidate()  # Nothing known yet (as right after a start): 'checking' is the honest answer.
            self.assertEqual(self.get('/api/settings/storage').json['archive']['state'], 'checking')

    def test_logs_remote_copies_field_only_when_present(self):
        p = self.log('a' * 32, {'rlog.zst': b'log' * 100, 'fcamera.mp4': b'video' * 100}); self.ready(p)
        self.archive()
        self.log('b' * 32, {'rlog.zst': b'other' * 100}, uploaded=2 ** 40)
        r = self.get('/api/logs')
        rows = {row['id']: row for row in r.json['logs']}
        self.assertEqual(rows[p.name]['remote_copies'], {'rlog': 'gdrive', 'front': 'gdrive'})
        self.assertNotIn('remote_copies', rows['b' * 32])
        # A copy changes nothing else in the row: the files are local, so no archive fields.
        for key in ('video_state', 'storage_locations', 'archive_error'): self.assertNotIn(key, rows[p.name])
        self.assertNotIn('archive_error', rows['b' * 32])
        self.assert_no_ids(r.get_data(as_text=True))

    def test_logs_expose_remote_mismatch_per_kind(self):
        p = self.log('a' * 32, {'rlog.zst': b'log' * 100, 'fcamera.mp4': b'video' * 100}); self.ready(p)
        m = server.read_meta(p); media_store.set_location(m, 'fcamera.mp4', location='local', error='remote_mismatch'); server.save_meta(p, m)
        row = self.get('/api/logs').json['logs'][0]
        self.assertEqual(row['archive_error'], {'fcamera.mp4': 'remote_mismatch'})
        r = self.get(f'/api/logs/{p.name}/video?source=front')
        self.assertEqual(r.status_code, 200); r.close()  # The local file still plays.

    def test_gdrive_enabled_server_does_not_touch_share_state(self):
        p = self.log('a' * 32, {'rlog.zst': b'log' * 100, 'fcamera.mp4': b'video' * 100}); self.ready(p)
        self.move()
        self.assertIsNone(server.store.settings.path)
        with patch.object(media_store.ArchiveStore, '_probe', side_effect=AssertionError('share probed')):
            self.assertEqual(self.get('/api/logs').status_code, 200)
            r = self.send('post', '/api/uploads', json={'files': [{'name': 'x/rlog.zst', 'size': 10}]})
            self.assertEqual(r.status_code, 201, r.json)
            r = self.send('post', '/api/upload', data={'files': (io.BytesIO(b'other log' * 10), 'y/rlog.zst')})
            self.assertEqual(r.status_code, 201, r.json)
            r = self.get('/api/settings/storage')
            self.assertEqual(r.status_code, 200)
            self.assertEqual(r.json['archive']['state'], 'connected')
            server.requeue_startup()

    def test_gdrive_located_recording_listed_with_video_and_location(self):
        video = b'video' * 100
        p = self.log('a' * 32, {'rlog.zst': b'log' * 100, 'fcamera.mp4': video}); self.ready(p)
        self.move()
        self.backend.probe()
        r = self.get('/api/logs')
        self.assertEqual(r.status_code, 200)
        row = r.json['logs'][0]
        self.assertTrue(row['video']); self.assertEqual(row['video_download'], 'fcamera.mp4')
        self.assertEqual(row['storage_locations'], {'rlog': 'gdrive', 'front': 'gdrive'})
        self.assertEqual(row['video_state'], {'front': 'available'})
        self.assertEqual((row['bytes'], row['log_bytes']), (len(video) + 300, 300))
        self.assertEqual(row['video_downloads'], [{'source': 'front', 'kind': 'fcamera.mp4', 'bytes': len(video)}])
        self.assertTrue(server.has_video(p, server.read_meta(p)))
        self.assert_no_ids(r.get_data(as_text=True))

    def test_gdrive_located_recording_survives_restart(self):
        p = self.log('a' * 32, {'rlog.zst': b'log' * 100, 'fcamera.mp4': b'video' * 100}); self.ready(p)
        archiver = self.move()
        before = (p / 'meta.json').read_bytes()
        server.requeue_startup()
        archiver = media_store.Archiver(server, server.store, self.settings, backend=self.backend)
        self.assertEqual(archiver.recheck_held(), 0)
        self.assertEqual((p / 'meta.json').read_bytes(), before)
        self.assertTrue((p / 'prepared' / 'data.json').is_file()); server.submit.assert_not_called()
        self.assertFalse(server.stale_recording(p, server.read_meta(p)))
        # The archiver's own restart path (recovery with Drive connected) keeps it too.
        archiver.recover_startup()
        self.assertEqual(server.read_meta(p)['status'], 'ready'); server.submit.assert_not_called()

    def test_reupload_of_moved_recording_is_duplicate(self):
        log, video = os.urandom(3000), b'\x00\x00\x01\x40\x01' + os.urandom(4000)  # A valid-looking HEVC start.
        p = self.log('a' * 32, {'rlog.zst': log, 'fcamera.hevc': video}); self.ready(p)
        self.move()
        self.assertEqual(media_store.location(server.read_meta(p), 'fcamera.hevc'), 'gdrive')
        r = self.send('post', '/api/upload', data={'files': [(io.BytesIO(log), 'x/rlog.zst'), (io.BytesIO(video), 'x/fcamera.hevc')]})
        self.assertEqual(r.status_code, 201, r.json)
        self.assertEqual((r.json['logs'], [d['id'] for d in r.json['duplicates']], r.json['updated']), ([], [p.name], []))
        self.assertFalse((p / 'fcamera.hevc').exists())  # The moved camera is not added back.

    def test_missing_drive_file_logs_backend_neutral_message(self):
        archiver = media_store.Archiver(server, server.store, self.settings, backend=self.backend)
        with self.assertLogs(server.app.logger, 'WARNING') as logs: archiver._note_missing(self.root / ('a' * 32), 'fcamera.mp4')
        self.assertNotIn('share', logs.output[0]); self.assertIn('remote archive (gdrive)', logs.output[0])

    # Fix round 1

    def test_nas_entry_left_from_smb_is_unavailable_under_gdrive(self):
        # After switching from the NAS: its files answer 503 (NAS wording) and Drive archiving goes on for the rest.
        p = self.log('a' * 32, {'rlog.zst': b'log' * 100})
        m = server.read_meta(p); media_store.set_location(m, 'fcamera.mp4', location='nas', bytes=500, sha256='0' * 64, archived_at=1.0)
        server.save_meta(p, m); self.ready(p)
        q = self.log('b' * 32, {'rlog.zst': b'other' * 100, 'fcamera.mp4': b'video' * 100}); self.ready(q)
        r = self.get(f'/api/logs/{p.name}/video?source=front')
        self.assertEqual((r.status_code, r.json['error']), (503, 'storage_unavailable'))
        self.assertEqual(r.json['message'], server.MEDIA_ERRORS['storage_unavailable'][1])
        self.assertEqual(self.get('/api/logs').status_code, 200)
        archiver = self.archive()  # Raises no AttributeError; asserts the cycle was not stopped.
        for kind in ('rlog.zst', 'fcamera.mp4'): self.assertIsNotNone(media_store.remote(server.read_meta(q), kind))
        self.assertEqual(media_store.location(server.read_meta(p), 'fcamera.mp4'), 'nas')
        self.assertEqual(archiver.status()['last_error'], None)

    def test_storage_settings_never_probe_drive_on_the_request(self):
        self.backend.invalidate()
        started, release, threads = threading.Event(), threading.Event(), []
        def slow():
            threads.append(threading.current_thread()); started.set(); release.wait(5)
            return 'connected', None
        with patch.object(self.backend, '_probe', side_effect=slow):
            t0 = time.monotonic(); r = self.get('/api/settings/storage'); elapsed = time.monotonic() - t0
            try:
                self.assertEqual(r.status_code, 200)
                self.assertEqual((r.json['archive']['state'], r.json['archive']['reason']), ('checking', 'probe_pending'))
                self.assertLess(elapsed, 2)
                self.assertTrue(started.wait(2)); self.assertIsNot(threads[0], threading.main_thread())
            finally: release.set()
            for _ in range(100):
                if self.backend.last_result(): break
                time.sleep(0.02)
        r = self.get('/api/settings/storage')
        self.assertEqual((r.json['archive']['state'], r.json['archive']['reason']), ('connected', None))

    def test_reconversion_never_serves_the_old_drive_copy(self):
        old = b'old video' * 100
        p = self.log('a' * 32, {'rlog.zst': b'log' * 100, 'fcamera.hevc': HEVC + b'h' * 500, 'fcamera.mp4': old}); self.ready(p)
        self.archive()
        m = server.read_meta(p); self.assertIsNotNone(media_store.remote(m, 'fcamera.mp4'))
        m['status'] = 'error'; server.save_meta(p, m)  # A failed result is converted again on request.
        r = self.send('post', f'/api/logs/{p.name}/convert')
        self.assertEqual(r.json, {'status': 'queued'})
        m = server.read_meta(p)
        self.assertFalse((p / 'fcamera.mp4').exists()); self.assertNotIn('fcamera.mp4', m.get('storage', {}))
        self.assertIsNotNone(media_store.remote(m, 'fcamera.hevc'))  # The original is unchanged; its copy stays.
        # The new result is not codec-preserving, so it stays in prepared/: it is what plays, never the old copy.
        new = b'new video' * 100
        (p / 'prepared').mkdir(exist_ok=True); (p / 'prepared' / 'fcamera.mp4').write_bytes(new); self.ready(p)
        before = len(self.media_requests())
        r = self.get(f'/api/logs/{p.name}/video?source=front')
        self.assertEqual((r.status_code, r.data), (200, new)); r.close()
        self.assertEqual(len(self.media_requests()), before)
        row = self.get('/api/logs').json['logs'][0]
        self.assertNotIn('storage', row)
        self.assertNotIn('fcamera.mp4', server.read_meta(p).get('storage', {}))

    def test_conversion_promotes_identical_drive_copy_and_copies_the_new_mp4(self):
        hevc, old, new = HEVC + os.urandom(3000), os.urandom(2000), os.urandom(2500)
        p = self.log('a' * 32, {'rlog.zst': b'log' * 100, 'fcamera.hevc': hevc, 'fcamera.mp4': old}); self.ready(p)
        self.archive()
        block = media_store.remote(server.read_meta(p), 'fcamera.hevc')
        # A second recording whose original changed after it was copied: its copy is not promoted.
        q = self.log('b' * 32, {'rlog.zst': b'other' * 100, 'fcamera.hevc': HEVC + os.urandom(3000)}); self.ready(q)
        self.archive()
        (q / 'fcamera.hevc').write_bytes(HEVC + os.urandom(3000))
        self.convert(p, {'fcamera.mp4': new}); self.convert(q, {'fcamera.mp4': new})
        m = server.read_meta(p)
        self.assertEqual(m['status'], 'ready')
        e = media_store.entry(m, 'fcamera.hevc')
        self.assertEqual((e['location'], e['file_id'], e['bytes'], e['sha256']), ('gdrive', block['file_id'], len(hevc), hashlib.sha256(hevc).hexdigest()))
        self.assertFalse((p / 'fcamera.hevc').exists()); self.assertEqual((p / 'fcamera.mp4').read_bytes(), new)
        self.assertIsNone(media_store.remote(m, 'fcamera.mp4'))
        r = self.get(f'/api/logs/{p.name}/original/fcamera.hevc')
        self.assertEqual((r.status_code, r.data), (200, hevc))
        row = next(row for row in self.get('/api/logs').json['logs'] if row['id'] == p.name)
        self.assertEqual((row['remote_copies'], row['storage_locations']['front']), ({'rlog': 'gdrive'}, 'gdrive'))
        mq = server.read_meta(q)
        self.assertEqual(media_store.location(mq, 'fcamera.hevc'), 'local'); self.assertIsNone(media_store.remote(mq, 'fcamera.hevc'))
        # The next copy-mode cycle copies the new MP4.
        self.archive()
        copy = media_store.remote(server.read_meta(p), 'fcamera.mp4')
        self.assertEqual(copy['sha256'], hashlib.sha256(new).hexdigest())
        with self.drive.lock: self.assertEqual(self.drive.files[copy['file_id']]['content'], new)

    def test_stored_counts_a_copy_whose_local_file_is_gone(self):
        video = b'video' * 100
        p = self.log('a' * 32, {'rlog.zst': b'log' * 100, 'fcamera.mp4': video}); self.ready(p)
        self.archive(); (p / 'fcamera.mp4').unlink()
        m = server.read_meta(p)
        self.assertTrue(server.stored(p, m, 'fcamera.mp4')); self.assertTrue(server.has_video(p, m))
        row = self.get('/api/logs').json['logs'][0]
        self.assertEqual((row['video'], row['video_download']), (True, 'fcamera.mp4'))
        r = self.get(f'/api/logs/{p.name}/video?source=front')
        self.assertEqual((r.status_code, r.data), (200, video))

    def test_conversion_never_replaces_moved_mp4(self):
        # The MP4 was moved to Drive; a local original added since must survive a codec-preserving result.
        p = self.log('a' * 32, {'rlog.zst': b'log' * 100, 'fcamera.mp4': b'video' * 100}); self.ready(p)
        self.move()
        hevc = HEVC + os.urandom(1000); (p / 'fcamera.hevc').write_bytes(hevc)
        self.convert(p, {'fcamera.mp4': b'new mp4'})
        m = server.read_meta(p)
        self.assertEqual(m['status'], 'ready')
        self.assertEqual((p / 'fcamera.hevc').read_bytes(), hevc); self.assertFalse((p / 'fcamera.mp4').exists())
        self.assertTrue((p / 'prepared' / 'fcamera.mp4').is_file()); self.assertEqual(media_store.location(m, 'fcamera.mp4'), 'gdrive')

    def test_reupload_of_camera_uses_drive_state(self):
        # A new camera for a moved recording needs Drive reachable: the Drive cache decides, not the share's.
        log = os.urandom(3000)
        p = self.log('a' * 32, {'rlog.zst': log, 'fcamera.mp4': b'video' * 100}); self.ready(p)
        self.move()
        r = self.send('post', '/api/upload', data={'files': [(io.BytesIO(log), 'x/rlog.zst'), (io.BytesIO(HEVC + os.urandom(2000)), 'x/ecamera.hevc')]})
        self.assertEqual(r.status_code, 201, r.json)
        self.assertEqual([u['id'] for u in r.json['updated']], [p.name])
        self.assertTrue((p / 'ecamera.hevc').is_file())

    def test_moved_recordings_survive_soft_quota_and_drive_outage(self):
        # Local quota is a MOVE trigger. The recording survives even when Drive cannot answer.
        p = self.log('a' * 32, {'rlog.zst': b'log' * 100, 'fcamera.mp4': b'video' * 100}); self.ready(p)
        self.move(); (p / 'prepared' / 'data.json').write_bytes(b'x' * MIB)
        self.assertEqual(self.backend.probe()[0], 'connected')
        used = server.storage_used_bytes()
        with patch.dict(server.storage_policy.settings, {'max_bytes': used + 65536 + 10 - 1, 'policy': 'delete_oldest'}):
            r = self.send('post', '/api/uploads', json={'files': [{'name': 'x/rlog.zst', 'size': 10}]})
            self.assertEqual(r.status_code, 201, r.json)
            if server.archiver.manual: server.archiver.manual.join(5)
            self.assertTrue(p.exists())
            # A missing Drive answer cannot reject uploads while the physical disk is safe.
            self.backend.invalidate()
            with patch.object(self.backend, 'probe', return_value=('checking', 'probe_pending')):
                r = self.send('post', '/api/uploads', json={'files': [{'name': 'y/rlog.zst', 'size': 10}]})
            self.assertEqual(r.status_code, 201, r.json)
            if server.archiver.manual: server.archiver.manual.join(5)
            self.assertTrue(p.exists())

    def corrupt_copy(self, kind):
        # Drive's metadata still reports the indexed hash, so only the downloaded bytes show the damage.
        with self.drive.lock:
            f = next(f for f in self.drive.files.values() if f['appProperties'].get('rv_kind') == kind)
            f['content'] = bytes(len(f['content']))

    def test_staging_verifies_the_download(self):
        video = os.urandom(4000)
        p = self.log('a' * 32, {'rlog.zst': os.urandom(3000), 'fcamera.mp4': video}); self.ready(p, video_codecs={'front': 'hevc'})
        self.move(); self.corrupt_copy('fcamera.mp4')
        with patch.object(server, 'export_chunks') as export:
            r = self.get(f'/api/logs/{p.name}/download?source=front&format=original')
        self.assertEqual((r.status_code, r.json['error']), (409, 'media_corrupt')); export.assert_not_called()
        self.assertFalse((p / '.staging').exists())
        # The decoder never gets the damaged copy: the camera counts as unreadable, as a corrupt NAS file does.
        m = server.read_meta(p); m.update(status='queued', manual_conversion=True); server.save_meta(p, m)
        seen = {}
        def popen(args, **kw):
            seen.update(json.loads(kw['env']['RV_MEDIA_PATHS']), log=args[-2])
            proc = MagicMock(); proc.communicate.return_value = ('', 'failed'); proc.returncode = 1; proc.poll.return_value = 1
            return proc
        with patch.object(server, 'ProgressChannel') as channel, patch.object(server.subprocess, 'Popen', side_effect=popen):
            channel.return_value.__enter__.return_value.options.return_value = {}
            server.run_job(p.name)
        self.assertEqual(seen['fcamera.mp4'], str(p / 'fcamera.mp4')); self.assertIn('.staging', seen['log'])
        self.assertFalse((p / '.staging').exists())

    def test_unstaged_remote_input_defers_under_the_lock(self):
        # The job became runnable between staging and the lock: the unstaged remote input defers it.
        p = self.log('a' * 32, {'rlog.zst': b'log' * 100, 'fcamera.mp4': b'video' * 100}); self.ready(p)
        self.move()
        m = server.read_meta(p); m.update(status='queued', manual_conversion=True); server.save_meta(p, m)
        real, calls = server.read_meta, []
        def read(path):
            calls.append(path); data = real(path)
            return dict(data, status='unconverted') if len(calls) == 1 else data
        with patch.object(server, 'read_meta', side_effect=read), patch.object(server.subprocess, 'Popen') as popen:
            server.run_job(p.name)
        popen.assert_not_called()
        m = server.read_meta(p)
        self.assertEqual((m['status'], m['deferred']), ('unconverted', 'storage'))
        self.assertFalse(self.media_requests()); self.assertFalse((p / '.staging').exists())

    def test_conversion_space_is_checked_for_all_inputs_first(self):
        p = self.log('a' * 32, {'rlog.zst': os.urandom(3000), 'fcamera.hevc': os.urandom(4000)}); self.ready(p)
        self.move()
        m = server.read_meta(p); m.update(status='queued', manual_conversion=True); server.save_meta(p, m)
        # Room for either input alone, not for both.
        free = type('U', (), {'free': server.STAGING_MARGIN + 5000})()
        with patch.object(server.shutil, 'disk_usage', return_value=free), patch.object(server.subprocess, 'Popen') as popen:
            server.run_job(p.name)
        popen.assert_not_called(); self.assertFalse(self.media_requests())
        m = server.read_meta(p)
        self.assertEqual((m['status'], m['deferred'], m['error']), ('unconverted', 'storage', '디스크 공간이 부족해 변환을 미뤘습니다.'))

    def test_startup_removes_leftover_staging(self):
        p = self.log('a' * 32, {'rlog.zst': b'log' * 100})
        (p / '.staging' / 'x').mkdir(parents=True); (p / '.staging' / 'x' / 'fcamera.mp4').write_bytes(b'partial')
        other = self.root / 'not-a-recording' / '.staging'; other.mkdir(parents=True)
        REAL_CLEANUP(startup=True)
        self.assertFalse((p / '.staging').exists()); self.assertTrue((p / 'rlog.zst').is_file()); self.assertTrue(other.is_dir())

    # Fix round 2

    def promoted(self, ids):
        # Converted copy-mode recordings: each original's identical Drive copy became the stored file. Their
        # Drive files: the log's copy and the promoted original (the new MP4 is not copied yet).
        ps = [self.log(id, {'rlog.zst': os.urandom(1000), 'fcamera.hevc': HEVC + os.urandom(2000), 'fcamera.mp4': os.urandom(1500)}) for id in ids]
        for p in ps: self.ready(p)
        self.archive(batch=64)  # Every file in one cycle.
        for p in ps:
            self.convert(p, {'fcamera.mp4': os.urandom(1600)})
            m = server.read_meta(p)
            self.assertEqual(media_store.location(m, 'fcamera.hevc'), 'gdrive'); self.assertIsNotNone(media_store.remote(m, 'rlog.zst'))
            self.assertEqual(len(media_store.remote_refs(m)), 2)
        return ps

    def evict(self, p):
        # As storage_policy evicts for space: delete_recording(id) with remote=False, under both locks.
        with server.registration_lock, server.lock: server.delete_recording(p.name)

    def test_automatic_eviction_cannot_remove_drive_recordings_in_either_mode(self):
        pending = media_store.PendingDeletes(self.root)
        a, b, c, d = self.promoted([ch * 32 for ch in 'abcd'])
        with self.assertRaises(server.StorageError): self.evict(a)
        self.assertTrue(a.exists()); self.assertEqual(pending.count(), 0)
        r = self.send('delete', f'/api/logs/{b.name}')
        self.assertEqual(r.status_code, 200); self.assertEqual(pending.count(), 2)
        self.make_backend(mode='move', allow_local_delete=True)
        with self.assertRaises(server.StorageError): self.evict(c)
        self.assertTrue(c.exists()); self.assertEqual(pending.count(), 2)
        r = self.send('delete', f'/api/logs/{d.name}')
        self.assertEqual(r.status_code, 200); self.assertEqual(pending.count(), 4)
        with self.drive.lock: self.assertEqual(len([f for f in self.drive.files.values() if f['appProperties'].get('rv_id') == a.name]), 3)

    def test_unreadable_original_skips_promotion_without_failing_the_conversion(self):
        p = self.log('a' * 32, {'rlog.zst': b'log' * 100, 'fcamera.hevc': HEVC + os.urandom(2000), 'fcamera.mp4': os.urandom(1500)}); self.ready(p)
        self.archive()
        m = server.read_meta(p); m.pop('content_hashes', None); server.save_meta(p, m)  # The original must be read.
        with patch.object(server, 'file_digest', side_effect=OSError(5, 'Input/output error')), self.assertLogs(server.app.logger, 'WARNING') as logs:
            self.convert(p, {'fcamera.mp4': b'new mp4'})
        m = server.read_meta(p)
        self.assertEqual(m['status'], 'ready'); self.assertEqual((p / 'fcamera.mp4').read_bytes(), b'new mp4')
        self.assertEqual(media_store.location(m, 'fcamera.hevc'), 'local'); self.assertIsNone(media_store.remote(m, 'fcamera.hevc'))
        self.assertTrue(any('fcamera.hevc' in line for line in logs.output))

    def test_original_changed_after_hashing_is_not_promoted(self):
        p = self.log('a' * 32, {'rlog.zst': b'log' * 100, 'fcamera.hevc': HEVC + os.urandom(2000), 'fcamera.mp4': os.urandom(1500)}); self.ready(p)
        self.archive()
        real = server.local_content
        def hashed_then_changed(path, m, kind):
            result = real(path, m, kind)
            # The original changes (same size) after it was hashed and before the registration's lock.
            f = path / kind; f.write_bytes(HEVC + os.urandom(2000)); st = f.stat(); os.utime(f, ns=(st.st_atime_ns, st.st_mtime_ns + 10**9))
            return result
        with patch.object(server, 'local_content', side_effect=hashed_then_changed): self.convert(p, {'fcamera.mp4': b'new mp4'})
        m = server.read_meta(p)
        self.assertEqual(m['status'], 'ready')
        self.assertEqual(media_store.location(m, 'fcamera.hevc'), 'local'); self.assertIsNone(media_store.remote(m, 'fcamera.hevc'))

    def test_reupload_restore_clears_stale_remote_state(self):
        # A camera whose upload was pending and whose copy failed to verify, then lost locally: re-uploading it
        # brings new local content, so neither the session nor the error may stay on the entry.
        log, hevc = os.urandom(3000), HEVC + os.urandom(2000)
        p = self.log('a' * 32, {'rlog.zst': log, 'fcamera.hevc': hevc}); self.ready(p)
        m = server.read_meta(p)
        media_store.set_location(m, 'fcamera.hevc', location='local', error='remote_mismatch',
                                 remote_pending={'backend': 'gdrive', 'session': 'https://x/upload?upload_id=s', 'started_at': 1.0, 'bytes_sent': 0, 'sha256': 'x', 'size': 1})
        server.save_meta(p, m); (p / 'fcamera.hevc').unlink()
        self.assertFalse(server.stored(p, server.read_meta(p), 'fcamera.hevc'))
        r = self.send('post', '/api/upload', data={'files': [(io.BytesIO(log), 'x/rlog.zst'), (io.BytesIO(hevc), 'x/fcamera.hevc')]})
        self.assertEqual(r.status_code, 201, r.json); self.assertEqual([u['id'] for u in r.json['updated']], [p.name])
        m = server.read_meta(p)
        self.assertEqual((p / 'fcamera.hevc').read_bytes(), hevc)
        self.assertNotIn('fcamera.hevc', m.get('storage', {}))

    def test_zip_streams_remote_entries_without_buffering(self):
        video = os.urandom(3 * MIB)
        p = self.log('a' * 32, {'rlog.zst': b'log' * 100, 'fcamera.mp4': video}); self.ready(p)
        self.move()
        for url in (f'/api/logs/download.zip?ids={p.name}&parts=front', f'/api/logs/download.zip?ids={p.name}&parts=front&format=mp4'):
            with self.subTest(url=url):
                r = self.get(url, buffered=False)
                chunks = list(r.response); r.close()
                self.assertLess(max(map(len, chunks)), 70 * 1024)
                with zipfile.ZipFile(io.BytesIO(b''.join(chunks))) as z: self.assertEqual([z.read(i) for i in z.infolist()], [video])

if __name__ == '__main__': unittest.main()
