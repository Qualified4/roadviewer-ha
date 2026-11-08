"""Export to one tar file and import back (log_transfer.py): the tar holds local originals and the record, Drive/NAS
files only by reference (never a session or secret); an import keeps the id, skips what is already stored, rejects
bad input and never leaves half a recording in the list."""
import hashlib, io, json, os, sys, tarfile, tempfile, unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_media_integration import PEER, HEADERS  # Sets RV_DATA and imports the server module.
import server, media_store, log_transfer

HEVC = b'\x00\x00\x01\x40\x01' + b'\x07' * 300  # The start validate_hevc accepts.
SECRET = 'https://www.googleapis.com/upload/drive/v3/files?upload_id=SECRET-SESSION'

class LogExportTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(); self.addCleanup(temp.cleanup); self.root = Path(temp.name)
        (self.root / '.uploads').mkdir()
        self.policy = {'max_bytes': 0, 'policy': 'reject_new', 'pinned_logs': []}
        self.submitted = []
        for patcher in (patch.object(server, 'ROOT', self.root), patch.object(server, 'UPLOADS', self.root / '.uploads'),
                        patch.object(server, 'cleanup_uploads'), patch.object(server, 'upload_receiving', return_value=False),
                        patch.object(server, 'submit', side_effect=self.submitted.append), patch.object(server, 'auto_convert', True),
                        patch.object(server.storage_policy, 'path', self.root / '.storage-settings.json'),
                        patch.object(server.storage_policy, 'settings', self.policy),
                        patch.object(server.log_transfer, 'digests', {})):
            patcher.start(); self.addCleanup(patcher.stop)
        self.client = server.app.test_client()

    def get(self, url, **kw): return self.client.get(url, environ_overrides=PEER, **kw)
    def send(self, method, url, **kw): return getattr(self.client, method)(url, environ_overrides=PEER, headers=HEADERS, **kw)

    def log(self, id, data, **fields):
        p = self.root / id; (p / 'prepared').mkdir(parents=True)
        for kind, content in data.items(): (p / kind).write_bytes(content)
        (p / 'prepared' / 'data.json.gz').write_bytes(b'converted'); (p / 'prepared' / 'thumbnail.jpg').write_bytes(b'jpeg')
        m = {'id': id, 'name': '000003fe--d524dc1e0b--8', 'status': 'ready', 'uploaded': 1700000000.5, 'error': None, 'video': True,
             'files': {kind: '000003fe--d524dc1e0b--8--' + kind for kind in data}, 'duration': 60, 'decoder_version': 'v28-runtime-geometry',
             'conversion_revision': 3, **fields}
        server.save_meta(p, m)
        return p

    def export(self, ids=None):
        r = self.get('/api/logs/export.tar' + (f'?ids={",".join(ids)}' if ids else ''))
        self.assertEqual(r.status_code, 200, r.data[:300])
        data = r.data
        self.assertEqual(int(r.headers['Content-Length']), len(data))
        self.assertEqual(r.headers['Cache-Control'], 'no-store')
        self.assertRegex(r.headers['Content-Disposition'], r'attachment; filename="?roadviewer-export-\d{8}-\d{4}\.tar"?')
        return data

    def members(self, data):
        with tarfile.open(fileobj=io.BytesIO(data)) as tar:
            return {m.name: tar.extractfile(m).read() for m in tar.getmembers()}, [m.name for m in tar.getmembers()]

    def import_tar(self, data):
        # What the page does (log-transfer.js): one recording at a time, its files in chunks from the tar.
        files, _ = self.members(data)
        manifest = json.loads(files['manifest.json']); results = []
        for row in manifest['recordings']:
            record = json.loads(files[f"{row['id']}/record.json"])
            r = self.send('post', '/api/logs/import', json={'format': manifest['format'], 'version': manifest['version'], 'record': record})
            if r.status_code != 201 or 'session' not in r.json: results.append(r); continue
            for i, kind in enumerate(r.json['files']):
                body = files[f"{row['id']}/{kind}"]
                for offset in range(0, len(body), r.json['chunk_size']):
                    chunk = self.send('put', f"/api/uploads/{r.json['session']}/files/{i}?offset={offset}", data=body[offset:offset + r.json['chunk_size']])
                    self.assertEqual(chunk.status_code, 200, chunk.json)
            results.append(self.send('post', f"/api/logs/import/{r.json['session']}/finish"))
        return results

    def listed(self): return {row['id']: row for row in self.get('/api/logs').json['logs']}

    def leftovers(self):
        return [p.name for p in self.root.iterdir() if p.name.startswith('.upload-')] + [p.name for p in (self.root / '.uploads').iterdir()]

    def test_export_holds_manifest_originals_and_record_only(self):
        log, video = b'log' * 4000, HEVC
        p = self.log('a' * 32, {'rlog.zst': log, 'fcamera.hevc': video},
                     tags=[{'name': '출근', 'color': 'blue'}], bookmarks=[{'id': 'b' * 32, 'time': 12.5, 'title': '합류', 'note': '메모'}],
                     video_codecs={'front': 'hevc'}, video_origins={'front': 0.25}, auto_excluded=True, manual_conversion=True,
                     content_hashes={'rlog.zst': {'size': 1, 'mtime_ns': 1, 'sha256': 'f' * 64}})
        self.policy['pinned_logs'] = [p.name]
        files, order = self.members(self.export())
        self.assertEqual(order, ['manifest.json', f'{p.name}/rlog.zst', f'{p.name}/fcamera.hevc', f'{p.name}/record.json'])
        manifest = json.loads(files['manifest.json'])
        self.assertEqual((manifest['format'], manifest['version']), ('roadviewer-export', 1))
        self.assertEqual(manifest['app_version'], log_transfer.LogTransfer.app_version(server.log_transfer))
        self.assertEqual(manifest['recordings'], [{'id': p.name, 'name': '000003fe--d524dc1e0b--8', 'files': ['rlog.zst', 'fcamera.hevc'], 'bytes': len(log) + len(video)}])
        self.assertEqual((files[f'{p.name}/rlog.zst'], files[f'{p.name}/fcamera.hevc']), (log, video))
        record = json.loads(files[f'{p.name}/record.json'])  # Padding is whitespace.
        self.assertEqual(set(record), log_transfer.RECORD_KEYS)
        self.assertEqual(record['originals'], {'rlog.zst': {'bytes': len(log), 'sha256': hashlib.sha256(log).hexdigest()},
                                               'fcamera.hevc': {'bytes': len(video), 'sha256': hashlib.sha256(video).hexdigest()}})
        self.assertEqual((record['tags'], record['pinned'], record['video_origins'], record['storage']), ([{'name': '출근', 'color': 'blue'}], True, {'front': 0.25}, {}))
        self.assertEqual(record['bookmarks'][0]['title'], '합류')
        for name in files: self.assertNotIn('prepared', name); self.assertNotIn('thumbnail', name)
        for derived in ('status', 'conversion_revision', 'duration', 'content_hashes', 'auto_excluded'): self.assertNotIn(derived, record)

    def test_export_keeps_remote_references_without_bytes_sessions_or_secrets(self):
        log = b'log' * 100
        p = self.log('a' * 32, {'rlog.zst': log})
        m = server.read_meta(p)
        media_store.set_location(m, 'fcamera.mp4', location='gdrive', file_id='DriveFile_1', bytes=900, sha256='1' * 64, md5='2' * 32, archived_at=5.0)
        media_store.set_location(m, 'ecamera.hevc', location='nas', bytes=700, sha256='3' * 64, archived_at=6.0, removing=True)
        media_store.set_remote(m, 'rlog.zst', backend='gdrive', file_id='DriveLog_2', bytes=len(log), sha256=hashlib.sha256(log).hexdigest(), md5=None, uploaded_at=7.0, verified_by='md5')
        media_store.set_remote_pending(m, 'rlog.zst', backend='gdrive', session=SECRET, started_at=1.0, bytes_sent=0, sha256='4' * 64, size=1)
        server.save_meta(p, m)
        data = self.export()
        files, order = self.members(data)
        self.assertEqual(order, ['manifest.json', f'{p.name}/rlog.zst', f'{p.name}/record.json'], 'Drive/NAS files are never downloaded')
        record = json.loads(files[f'{p.name}/record.json'])
        self.assertEqual(record['storage'], {
            'rlog.zst': {'location': 'local', 'remote': {'backend': 'gdrive', 'file_id': 'DriveLog_2', 'bytes': len(log), 'sha256': hashlib.sha256(log).hexdigest(), 'md5': None, 'uploaded_at': 7.0, 'verified_by': 'md5'}},
            'fcamera.mp4': {'location': 'gdrive', 'file_id': 'DriveFile_1', 'bytes': 900, 'sha256': '1' * 64, 'md5': '2' * 32, 'archived_at': 5.0},
            'ecamera.hevc': {'location': 'nas', 'bytes': 700, 'sha256': '3' * 64, 'archived_at': 6.0}})
        for secret in (b'SECRET-SESSION', b'remote_pending', b'session', b'removing', b'refresh_token'): self.assertNotIn(secret, data)

    def test_export_of_selected_recordings(self):
        a = self.log('a' * 32, {'rlog.zst': b'one'}); b = self.log('b' * 32, {'rlog.zst': b'two'})
        files, _ = self.members(self.export([b.name]))
        self.assertEqual([row['id'] for row in json.loads(files['manifest.json'])['recordings']], [b.name])
        self.assertEqual(self.get('/api/logs/export.tar?ids=' + 'c' * 32).status_code, 404)
        self.assertEqual(self.get('/api/logs/export.tar?ids=' + ','.join(f'{i:032x}' for i in range(151))).status_code, 400)
        files, _ = self.members(self.export())
        self.assertEqual({row['id'] for row in json.loads(files['manifest.json'])['recordings']}, {a.name, b.name})

    def test_file_changed_during_export_is_left_out(self):
        # The header promised the planned size: a file replaced meanwhile is sent as zeros and missing from the record.
        p = self.log('a' * 32, {'rlog.zst': b'log' * 10, 'qcamera.ts': b'q' * 100})
        response = self.get('/api/logs/export.tar'); body = response.response
        first = next(iter(body))  # The manifest: the plan (sizes) is made.
        (p / 'qcamera.ts').write_bytes(b'other')
        data = first + b''.join(body)
        self.assertEqual(len(data), int(response.headers['Content-Length']))
        files, _ = self.members(data)
        self.assertEqual(list(json.loads(files[f'{p.name}/record.json'])['originals']), ['rlog.zst'])

    def test_import_restores_a_local_recording_with_its_id(self):
        log = b'log' * 5000
        p = self.log('a' * 32, {'rlog.zst': log, 'fcamera.hevc': HEVC}, tags=[{'name': '여행', 'color': 'rose'}],
                     bookmarks=[{'id': 'c' * 32, 'time': 3, 'title': 'A', 'note': ''}])
        self.policy['pinned_logs'] = [p.name]
        data = self.export()
        server.delete_recording(p.name); self.policy['pinned_logs'] = []
        [r] = self.import_tar(data)
        self.assertEqual((r.status_code, r.json), (201, {'imported': p.name, 'status': 'queued'}))
        m = server.read_meta(p)
        self.assertEqual((m['name'], m['uploaded'], m['tags'], m['bookmarks'][0]['title'], m['status']), ('000003fe--d524dc1e0b--8', 1700000000.5, [{'name': '여행', 'color': 'rose'}], 'A', 'queued'))
        self.assertEqual((p / 'rlog.zst').read_bytes(), log); self.assertFalse((p / 'prepared').exists())
        self.assertEqual(m['content_hashes']['rlog.zst']['sha256'], hashlib.sha256(log).hexdigest())
        self.assertEqual(m['bytes'], len(log) + len(HEVC))
        self.assertEqual(self.policy['pinned_logs'], [p.name]); self.assertEqual(self.submitted, [p.name])
        self.assertTrue(self.listed()[p.name]['pinned']); self.assertEqual(self.leftovers(), [])

    def test_import_checks_a_kept_mp4_by_its_own_name(self):
        # validate_mp4 expects H.264 for camera.mp4 (the low-res camera): the check runs on the file's real name.
        video = (Path(__file__).resolve().parent / 'fixtures' / 'black.mp4').read_bytes()
        p = self.log('a' * 32, {'rlog.zst': b'log' * 10, 'camera.mp4': video}); data = self.export(); server.delete_recording(p.name)
        [r] = self.import_tar(data)
        self.assertEqual(r.status_code, 201, r.json); self.assertEqual((p / 'camera.mp4').read_bytes(), video)

    def test_import_without_auto_convert_waits_unconverted(self):
        p = self.log('a' * 32, {'rlog.zst': b'log' * 10}); data = self.export(); server.delete_recording(p.name)
        with patch.object(server, 'auto_convert', False): [r] = self.import_tar(data)
        self.assertEqual(r.json['status'], 'unconverted'); self.assertEqual(self.submitted, [])

    def test_import_of_remote_references_keeps_them(self):
        log = b'log' * 10
        p = self.log('a' * 32, {})
        m = server.read_meta(p)
        media_store.set_location(m, 'rlog.zst', location='gdrive', file_id='DriveLog', bytes=30, sha256=hashlib.sha256(log).hexdigest(), md5=None, archived_at=1.0)
        media_store.set_location(m, 'fcamera.mp4', location='nas', bytes=900, sha256='1' * 64, archived_at=1.0)
        server.save_meta(p, m)
        data = self.export(); server.delete_recording(p.name, remote=True)
        (self.root / media_store.PENDING_DELETES).unlink(missing_ok=True)
        [r] = self.import_tar(data)
        self.assertEqual((r.status_code, r.json['imported']), (201, p.name))
        m = server.read_meta(p)
        self.assertEqual(media_store.entry(m, 'rlog.zst'), {'location': 'gdrive', 'file_id': 'DriveLog', 'bytes': 30, 'sha256': hashlib.sha256(log).hexdigest(), 'md5': None, 'archived_at': 1.0})
        self.assertEqual(media_store.location(m, 'fcamera.mp4'), 'nas')
        row = self.listed()[p.name]
        # Not connected to that Drive or NAS here: shown as an unreachable archive, as any other archived recording.
        self.assertEqual(row['storage_locations'], {'rlog': 'gdrive', 'front': 'nas'})
        self.assertEqual(row['video_state'], {'front': 'storage_unavailable'})
        self.assertNotIn('DriveLog', json.dumps(row))
        # Played from the same NAS path (derived from the id) once it is connected.
        nas = Path(tempfile.mkdtemp(prefix='rv-nas-')); self.addCleanup(lambda: __import__('shutil').rmtree(nas, ignore_errors=True))
        store = media_store.ArchiveStore(media_store.ArchiveSettings(enabled=True, path=nas), self.root); store.activate()
        (nas / p.name).mkdir(); (nas / p.name / 'fcamera.mp4').write_bytes(b'v' * 900)
        with patch.object(server, 'store', store):
            self.assertEqual(media_store.resolve(p, m, 'fcamera.mp4', store), (nas / p.name / 'fcamera.mp4', 'available'))

    def test_existing_id_or_content_is_skipped(self):
        p = self.log('a' * 32, {'rlog.zst': b'same log'}); data = self.export()
        [r] = self.import_tar(data)
        self.assertEqual((r.status_code, r.json), (200, {'skipped': 'exists', 'id': p.name}))
        # Another id with the same original log: the recording is already stored.
        files, _ = self.members(data); record = json.loads(files[f'{p.name}/record.json']); record['id'] = 'b' * 32
        r = self.send('post', '/api/logs/import', json={'format': 'roadviewer-export', 'version': 1, 'record': record})
        self.assertEqual(r.json, {'skipped': 'duplicate', 'id': 'b' * 32})
        self.assertEqual(sorted(self.listed()), [p.name]); self.assertEqual(self.leftovers(), [])

    def valid_record(self):
        return {'id': 'a' * 32, 'name': 'x', 'uploaded': 1, 'originals': {'rlog.zst': {'bytes': 3, 'sha256': hashlib.sha256(b'log').hexdigest()}}}

    def test_bad_input_is_rejected(self):
        def post(record=None, **body):
            return self.send('post', '/api/logs/import', json={'format': 'roadviewer-export', 'version': 1, 'record': record or self.valid_record(), **body})
        r = post(version=2); self.assertEqual(r.status_code, 400); self.assertIn('버전', r.json['message'])
        self.assertEqual(post(format='zip').status_code, 400)
        cases = {'traversal': {'files': {'rlog.zst': '../../etc/passwd'}}, 'unknown kind': {'originals': {'evil.sh': {'bytes': 1, 'sha256': '0' * 64}}},
                 'bad id': {'id': '../' + 'a' * 29}, 'size': {'originals': {'rlog.zst': {'bytes': -1, 'sha256': '0' * 64}}},
                 'shape': {'extra': 1}, 'storage': {'storage': {'fcamera.mp4': {'location': 'gdrive', 'file_id': '../x', 'bytes': 1, 'sha256': '0' * 64}}},
                 'pending session': {'storage': {'rlog.zst': {'location': 'local', 'remote_pending': {'session': SECRET}}}},
                 'no log': {'originals': {'qcamera.ts': {'bytes': 1, 'sha256': '0' * 64}}}, 'tag': {'tags': [{'name': 'a', 'color': 'black'}]}}
        for name, change in cases.items():
            with self.subTest(name):
                r = post({**self.valid_record(), **change}); self.assertEqual(r.status_code, 400, r.json); self.assertTrue(r.json['message'])
        self.assertEqual(self.listed(), {}); self.assertEqual(self.leftovers(), [])

    def test_hash_mismatch_or_bad_video_leaves_nothing(self):
        for name, kind, body in (('checksum', 'rlog.zst', b'not the log'), ('hevc', 'fcamera.hevc', b'\xff' * 50)):
            with self.subTest(name):
                record = self.valid_record()
                if name == 'hevc': record['originals'][kind] = {'bytes': len(body), 'sha256': hashlib.sha256(body).hexdigest()}
                r = self.send('post', '/api/logs/import', json={'format': 'roadviewer-export', 'version': 1, 'record': record}); session = r.json['session']
                for i, k in enumerate(r.json['files']):
                    data = body if k == kind else b'log'
                    if name == 'checksum': data = data[:3]
                    self.assertEqual(self.send('put', f'/api/uploads/{session}/files/{i}?offset=0', data=data).status_code, 200)
                # The ordinary upload finish never registers an import session.
                self.assertEqual(self.send('post', f'/api/uploads/{session}/finish').status_code, 409)
                r = self.send('post', f'/api/logs/import/{session}/finish')
                self.assertEqual(r.status_code, 422 if name == 'checksum' else 400, r.json)
                self.assertEqual(self.listed(), {}); self.assertFalse((self.root / ('a' * 32)).exists()); self.assertEqual(self.leftovers(), [])

    def test_abandoned_import_is_cleaned_like_an_upload(self):
        r = self.send('post', '/api/logs/import', json={'format': 'roadviewer-export', 'version': 1, 'record': self.valid_record()})
        session = self.root / '.uploads' / r.json['session']
        self.assertTrue((session / 'import.json').is_file())
        os.utime(session, (0, 0))
        with patch.object(server, 'cleanup_uploads', REAL_CLEANUP): server.cleanup_uploads()
        self.assertFalse(session.exists()); self.assertEqual(self.listed(), {})

REAL_CLEANUP = server.cleanup_uploads

if __name__ == '__main__': unittest.main()
