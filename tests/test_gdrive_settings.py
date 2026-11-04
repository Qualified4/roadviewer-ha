"""The storage settings with Google Drive (tests/fake_drive.py): signing in with the device flow from the panel,
disconnecting, the archive block (usage, copies, errors, the connection) without a single secret, and the retry of a
file whose Drive copy did not verify."""
import json, os, stat, sys, tempfile, threading, time, unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_media_integration import make_log, PEER, HEADERS  # Sets RV_DATA and imports the server module.
import server, media_store
import archive_backends as ab
from fake_drive import FakeDrive

DAY = 86400
CLIENT_SECRET = 'shh-client-secret'
SMB_KEYS = {'enabled', 'state', 'reason', 'path_configured', 'used_bytes', 'free_bytes', 'max_bytes', 'margin_bytes', 'last_cycle_at',
            'last_error', 'consecutive_failures', 'pending_deletes', 'archived_files', 'archived_bytes', 'running', 'missing_archived'}
GDRIVE_KEYS = SMB_KEYS | {'backend', 'mode', 'effective_mode', 'local_delete_allowed', 'usage_reliable', 'remote_copies_files',
                          'remote_copies_bytes', 'archive_errors', 'gdrive'}
GDRIVE_BLOCK_KEYS = {'configured', 'connected', 'folder_ok', 'pending', 'last_auth_error'}

class GdriveSettingsTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(); self.addCleanup(temp.cleanup); self.root = Path(temp.name)
        self.drive = FakeDrive().start(); self.addCleanup(self.drive.stop)
        self.drive.scenario.device_interval = 1
        for patcher in (patch.dict(os.environ, self.drive.env()), patch.object(server, 'ROOT', self.root),
                        patch.object(server, 'cleanup_uploads'), patch.object(server, 'UPLOADS', self.root / '.uploads'),
                        patch.object(server, 'upload_receiving', return_value=False), patch.object(server, 'submit'),
                        patch.object(server, 'connection', None)):
            patcher.start(); self.addCleanup(patcher.stop)
        (self.root / '.uploads').mkdir()
        # The poll thread waits a hundredth of what Google asks for; the asked intervals are recorded.
        self.waits = []
        def wait(connection, cancel, seconds):
            self.waits.append(seconds)
            return cancel.wait(seconds / 100)
        patcher = patch.object(ab.DriveConnection, '_wait', wait); patcher.start(); self.addCleanup(patcher.stop)
        self.http = ab.Http(sleep=lambda seconds: None, rand=lambda: 0.0)
        self.client = server.app.test_client()
        self.addCleanup(self.join_threads)

    def join_threads(self):
        connection = server.connection
        if connection is None: return
        connection._cancel.set()
        for thread in (connection.thread, connection.revoker):
            if thread: thread.join(5)

    def make_backend(self, **fields):
        # The server as configured with archive_backend: gdrive and an OAuth client.
        fields = {'enabled': True, 'backend': 'gdrive', 'min_age_seconds': DAY, 'gdrive_client_id': 'client-id',
                  'gdrive_client_secret': CLIENT_SECRET, **fields}
        self.settings = media_store.ArchiveSettings(**fields)
        self.auth = ab.DriveAuth(self.root / '.gdrive-auth.json', self.settings.gdrive_client_id, self.settings.gdrive_client_secret, self.http)
        self.backend = ab.DriveBackend(self.settings, self.root, self.auth, ab.DriveClient(self.http, self.auth))
        store = media_store.ArchiveStore(self.settings, self.root)
        self.archiver = media_store.Archiver(server, store, self.settings, backend=self.backend)
        for name, value in (('backend', self.backend), ('store', store), ('archiver', self.archiver)):
            patcher = patch.object(server, name, value); patcher.start(); self.addCleanup(patcher.stop)
        return self.backend

    def connect_directly(self):
        # Signed in already (as after an earlier connection), with the folder created.
        self.auth.start_device_flow(); self.assertEqual(self.auth.poll_once(), 'granted')
        self.backend.activate(); self.assertEqual(self.backend.probe(), ('connected', None))

    def log(self, id, data, **fields):
        p = make_log(self.root, id, list(data), [])
        for kind, content in data.items(): (p / kind).write_bytes(content)
        m = server.read_meta(p)
        m.update({'uploaded': 1, 'status': 'ready', 'files': {kind: '000003fe--d524dc1e0b--8--' + kind for kind in data}, **fields}); server.save_meta(p, m)
        return p

    def get(self, url, **kw): return self.client.get(url, environ_overrides=PEER, **kw)
    def post(self, url, **kw): return self.client.post(url, environ_overrides=PEER, headers=HEADERS, **kw)

    def requests(self, needle):
        with self.drive.lock: return [r for r in self.drive.requests if needle in r['path']]

    def block(self):
        r = self.get('/api/settings/storage')
        self.assertEqual(r.status_code, 200)
        return r.json['archive']

    def settle(self):
        # The background probe started by a request for a stale state has finished.
        for _ in range(200):
            if self.backend.last_result() is not None and self.backend.lock.acquire(blocking=False):
                self.backend.lock.release(); return
            time.sleep(0.01)

    def until(self, condition, seconds=5):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if condition(): return True
            time.sleep(0.01)
        return False

    def secrets(self):
        with self.drive.lock:
            tokens = set(self.drive.access_tokens) | set(self.drive.refresh_tokens) | set(self.drive.issued) | set(self.drive.revoked)
            sessions = [s for s in self.drive.sessions]
            files = [f for f in self.drive.files]
        codes = ['dc-%d' % n for n in range(1, self.drive.device_code_count + 1)]
        return {t for t in tokens if t} | set(sessions) | {f'"{f}"' for f in files} | set(codes) | {
            CLIENT_SECRET, 'secretaccess', 'secretrefresh', 'device_code', 'access_token', 'refresh_token', 'client_secret',
            'upload_id', 'remote_pending', 'file_id', 'Bearer'}

    def assert_no_secrets(self, text):
        for secret in self.secrets(): self.assertNotIn(secret, text)

    def test_archive_block_has_no_secrets(self):
        self.make_backend()
        p = self.log('a' * 32, {'rlog.zst': b'log' * 100, 'fcamera.mp4': b'video' * 100})
        # Waiting for the user: only the code, the page and the expiry are shown.
        with self.drive.lock: self.drive.scenario.device_poll_responses = ['authorization_pending'] * 1000
        r = self.post('/api/settings/archive/gdrive/connect')
        self.assertEqual(r.status_code, 202, r.json)
        self.assert_no_secrets(r.get_data(as_text=True))
        block = self.block()
        self.assertEqual(set(block), GDRIVE_KEYS); self.assertEqual(set(block['gdrive']), GDRIVE_BLOCK_KEYS)
        self.assertEqual(set(block['gdrive']['pending']), {'user_code', 'verification_url', 'expires_at'})
        self.assert_no_secrets(json.dumps(block)); self.assert_no_secrets(json.dumps(self.archiver.status()))
        # Granted, folder created, a copy uploaded and a session left behind: still nothing secret.
        with self.drive.lock: self.drive.scenario.device_poll_responses = []
        self.assertTrue(self.until(lambda: self.auth.connected and self.block()['gdrive']['pending'] is None))
        server.connection.thread.join(5)
        self.assertEqual(self.archiver.run_cycle()['archived'], 2)
        m = server.read_meta(p)
        media_store.set_remote_pending(m, 'qcamera.ts', backend='gdrive', session=self.drive.url + '/upload?upload_id=secretsession',
                                       started_at=1.0, bytes_sent=0, sha256='0' * 64)
        server.save_meta(p, m); server.store.forget_index()
        self.settle()
        r = self.get('/api/settings/storage'); text = r.get_data(as_text=True)
        block = r.json['archive']
        self.assertEqual(set(block), GDRIVE_KEYS); self.assertEqual(set(block['gdrive']), GDRIVE_BLOCK_KEYS)
        self.assertEqual((block['state'], block['backend'], block['mode'], block['effective_mode'], block['local_delete_allowed']),
                         ('connected', 'gdrive', 'move', 'copy', False))
        self.assertEqual((block['remote_copies_files'], block['remote_copies_bytes']), (2, 300 + 500))
        self.assertEqual(block['archive_errors'], {'remote_mismatch': 0})
        self.assertEqual(block['gdrive'], {'configured': True, 'connected': True, 'folder_ok': True, 'pending': None, 'last_auth_error': None})
        self.assert_no_secrets(text); self.assertNotIn('secretsession', text)
        status = json.dumps(self.archiver.status()); self.assert_no_secrets(status); self.assertNotIn('secretsession', status)
        # The token file itself holds the grant, readable by the add-on only.
        self.assertEqual(stat.S_IMODE((self.root / '.gdrive-auth.json').stat().st_mode), 0o600)
        self.assertIn('secretrefresh', (self.root / '.gdrive-auth.json').read_text())

    def test_smb_block_keeps_its_keys(self):
        # The NAS's block has none of the Drive fields (byte-identical to before); the Drive routes refuse.
        r = self.get('/api/settings/storage')
        self.assertEqual(set(r.json['archive']), SMB_KEYS)
        for route in ('connect', 'disconnect'):
            r = self.post(f'/api/settings/archive/gdrive/{route}')
            self.assertEqual((r.status_code, r.json['error']), (409, 'gdrive_not_selected'))

    def test_connect_returns_code_and_polls_to_connected(self):
        self.make_backend()
        with self.drive.lock: self.drive.scenario.device_poll_responses = ['authorization_pending', 'slow_down']
        started = time.time()
        r = self.post('/api/settings/archive/gdrive/connect')
        self.assertEqual(r.status_code, 202, r.json)
        self.assertEqual(set(r.json), {'user_code', 'verification_url', 'expires_in'})
        self.assertEqual((r.json['user_code'], r.json['verification_url']), ('ABCD-EFGH', 'https://www.google.com/device'))
        self.assertTrue(1790 <= r.json['expires_in'] <= 1800)
        thread = server.connection.thread
        self.assertTrue(thread.daemon)
        # A second request while the code waits answers the same code: one flow at a time.
        again = self.post('/api/settings/archive/gdrive/connect')
        self.assertEqual((again.status_code, again.json['user_code']), (202, 'ABCD-EFGH'))
        self.assertEqual(len(self.requests('/device/code')), 1)
        pending = self.block()['gdrive']['pending']
        if pending is not None: self.assertTrue(started + 1790 <= pending['expires_at'] <= time.time() + 1800)
        # The poll thread never needs a server lock: it completes while this thread holds both.
        with server.registration_lock, server.lock:
            thread.join(10)
        self.assertFalse(thread.is_alive())
        # The interval Google gave, and 5 s more after slow_down.
        self.assertEqual(self.waits, [1, 1, 6])
        self.assertEqual(len(self.requests('/token')), 3)
        self.assertTrue(self.auth.connected)
        token = self.root / '.gdrive-auth.json'
        self.assertEqual(stat.S_IMODE(token.stat().st_mode), 0o600)
        self.assertTrue(json.loads(token.read_text())['folder_id'])
        # The folder was created (activate) and the state probed again.
        with self.drive.lock: folders = [f for f in self.drive.files.values() if f['mimeType'] == ab.FOLDER_MIME]
        self.assertEqual(len(folders), 1)
        self.assertEqual(self.backend.last_result(), ('connected', None))
        block = self.block()
        self.assertEqual(block['state'], 'connected')
        self.assertEqual(block['gdrive'], {'configured': True, 'connected': True, 'folder_ok': True, 'pending': None, 'last_auth_error': None})
        r = self.post('/api/settings/archive/gdrive/connect')
        self.assertEqual((r.status_code, r.json['error']), (409, 'gdrive_connected'))

    def test_connect_without_client_config_409(self):
        self.make_backend(gdrive_client_id='')
        r = self.post('/api/settings/archive/gdrive/connect')
        self.assertEqual((r.status_code, r.json['error']), (409, 'gdrive_not_configured'))
        self.assertEqual(self.requests('/device/code'), [])
        self.assertEqual(self.block()['gdrive']['configured'], False)

    def test_denied_and_expired_codes_are_reported_as_codes(self):
        self.make_backend()
        with self.drive.lock: self.drive.scenario.device_poll_responses = ['access_denied']
        self.assertEqual(self.post('/api/settings/archive/gdrive/connect').status_code, 202)
        server.connection.thread.join(5)
        gdrive = self.block()['gdrive']
        self.assertEqual((gdrive['connected'], gdrive['pending'], gdrive['last_auth_error']), (False, None, 'access_denied'))
        self.assertFalse((self.root / '.gdrive-auth.json').exists())
        # A code that expires before the user enters it.
        self.drive.scenario.device_expires_in = 0
        self.assertEqual(self.post('/api/settings/archive/gdrive/connect').status_code, 202)
        server.connection.thread.join(5)
        gdrive = self.block()['gdrive']
        self.assertEqual((gdrive['connected'], gdrive['pending'], gdrive['last_auth_error']), (False, None, 'code_expired'))
        # Google refusing the client itself: the request answers, with a code.
        with self.drive.lock: self.drive.scenario.fail_next('/device/code', 401, reason='invalid_client')
        r = self.post('/api/settings/archive/gdrive/connect')
        self.assertEqual((r.status_code, r.json['error'], r.json['reason']), (502, 'gdrive_auth_failed', 'invalid_client'))
        self.assertEqual(self.block()['gdrive']['last_auth_error'], 'invalid_client')

    def test_reconnect_allowed_after_auth_expired(self):
        self.make_backend(); self.connect_directly()
        with self.drive.lock: self.drive.access_tokens.clear(); self.drive.refresh_tokens.clear()
        self.backend.invalidate(); self.auth.expire()
        self.assertEqual(self.archiver.run_cycle()['stopped'], 'auth_expired')
        self.assertEqual(self.block()['gdrive']['last_auth_error'], 'auth_expired')
        r = self.post('/api/settings/archive/gdrive/connect')
        self.assertEqual(r.status_code, 202, r.json)
        server.connection.thread.join(5)
        self.assertEqual(self.archiver.last_auth_error, None)
        # The same folder: reconnecting never creates another one.
        with self.drive.lock: folders = [f for f in self.drive.files.values() if f['mimeType'] == ab.FOLDER_MIME]
        self.assertEqual(len(folders), 1)
        self.settle()
        self.assertEqual(self.block()['gdrive']['last_auth_error'], None)

    def test_disconnect_removes_token_keeps_index(self):
        self.make_backend(); self.connect_directly()
        p = self.log('a' * 32, {'rlog.zst': b'log' * 100, 'fcamera.mp4': b'video' * 100})
        self.assertEqual(self.archiver.run_cycle()['archived'], 2)
        before = (p / 'meta.json').read_bytes()
        with self.drive.lock: files = {i: dict(f) for i, f in self.drive.files.items()}; refresh = set(self.drive.refresh_tokens)
        r = self.post('/api/settings/archive/gdrive/disconnect')
        self.assertEqual((r.status_code, r.json), (200, {'connected': False}))
        self.assertFalse((self.root / '.gdrive-auth.json').exists())
        server.connection.revoker.join(5)
        with self.drive.lock: self.assertTrue(refresh & set(self.drive.revoked)); self.assertEqual({i: dict(f) for i, f in self.drive.files.items()}, files)
        self.assertEqual((p / 'meta.json').read_bytes(), before)
        for kind in ('rlog.zst', 'fcamera.mp4'): self.assertTrue((p / kind).is_file())
        self.assertEqual(self.backend.probe(), ('unavailable', 'not_connected'))
        block = self.block()
        self.assertEqual((block['gdrive']['connected'], block['gdrive']['folder_ok'], block['usage_reliable']), (False, False, False))
        self.assertEqual(self.archiver.run_cycle()['stopped'], 'storage_unavailable')
        self.assertEqual((p / 'meta.json').read_bytes(), before)
        # A revoke Google does not answer changes nothing: the grant is forgotten here all the same.
        self.connect_directly()
        with self.drive.lock: self.drive.scenario.fail_next('/revoke', 503, times=5)
        r = self.post('/api/settings/archive/gdrive/disconnect')
        self.assertEqual(r.status_code, 200)
        self.assertFalse((self.root / '.gdrive-auth.json').exists())
        server.connection.revoker.join(5)
        self.assertFalse(self.auth.connected)
        # Reconnecting finds the same folder again.
        self.connect_directly()
        with self.drive.lock: folders = [f for f in self.drive.files.values() if f['mimeType'] == ab.FOLDER_MIME]
        self.assertEqual(len(folders), 1)

    def test_disconnect_cancels_a_waiting_code(self):
        self.make_backend()
        with self.drive.lock: self.drive.scenario.device_poll_responses = ['authorization_pending'] * 1000
        self.assertEqual(self.post('/api/settings/archive/gdrive/connect').status_code, 202)
        thread = server.connection.thread
        self.assertEqual(self.post('/api/settings/archive/gdrive/disconnect').status_code, 200)
        thread.join(5); self.assertFalse(thread.is_alive())
        gdrive = self.block()['gdrive']
        self.assertEqual((gdrive['connected'], gdrive['pending'], gdrive['last_auth_error']), (False, None, None))
        # A new code can be asked for right away.
        r = self.post('/api/settings/archive/gdrive/connect')
        self.assertEqual(r.status_code, 202); self.assertEqual(len(self.requests('/device/code')), 2)

    def test_gdrive_block_usage_unreliable(self):
        self.make_backend(); self.connect_directly()
        self.log('a' * 32, {'rlog.zst': b'log' * 100, 'fcamera.mp4': b'video' * 100})
        # No usage known yet: zero and unreliable, and the request does not ask Drive for it.
        self.settle()
        block = self.block()
        self.assertEqual((block['used_bytes'], block['free_bytes'], block['usage_reliable']), (0, 0, False))
        self.assertEqual(self.requests('/about'), [])
        # The archiver cycle measures it. No limit reported (unlimited or unknown): free 0, unreliable.
        self.assertEqual(self.archiver.run_cycle()['archived'], 2)
        self.assertEqual(len(self.requests('/about')), 1)
        self.settle()
        block = self.block()
        self.assertEqual((block['used_bytes'], block['free_bytes'], block['usage_reliable']), (0, 0, False))
        self.assertEqual(len(self.requests('/about')), 1)
        # With a limit: used and free as Drive reports them.
        self.drive.scenario.quota_limit = 10000
        self.backend.usage_cached = None
        self.archiver.run_cycle()
        self.settle()
        block = self.block()
        self.assertEqual((block['used_bytes'], block['free_bytes'], block['usage_reliable']), (800, 10000 - 800, True))
        # A failed probe (invalidate) keeps showing the last figure; the request still never asks Drive.
        about = len(self.requests('/about'))
        self.backend.invalidate()
        self.assertEqual(self.block()['used_bytes'], 800)
        self.assertEqual(len(self.requests('/about')), about)

    def test_retry_remote_mismatch_reuploads(self):
        self.make_backend(); self.connect_directly()
        p = self.log('a' * 32, {'rlog.zst': b'log' * 100, 'fcamera.mp4': b'video' * 100})
        m = server.read_meta(p); media_store.set_location(m, 'fcamera.mp4', location='local', error='remote_mismatch'); server.save_meta(p, m)
        self.assertEqual(self.archiver.run_cycle()['archived'], 1)  # The log only: the failed file waits.
        self.assertIsNone(media_store.remote(server.read_meta(p), 'fcamera.mp4'))
        self.settle()
        self.assertEqual(self.block()['archive_errors'], {'remote_mismatch': 1})
        video = (p / 'fcamera.mp4').read_bytes(); mtime = (p / 'fcamera.mp4').stat().st_mtime_ns
        with self.drive.lock: files = len(self.drive.files)
        sessions = len(self.requests('uploadType=resumable'))
        # Refused: unknown recording, a kind with no error, an invalid body.
        self.assertEqual(self.post(f'/api/logs/{"b" * 32}/archive/retry').status_code, 404)
        r = self.post(f'/api/logs/{p.name}/archive/retry', json={'kinds': ['rlog.zst']})
        self.assertEqual((r.status_code, r.json['error']), (409, 'no_archive_error'))
        for body in ({'kinds': 'fcamera.mp4'}, {'kinds': ['nope']}, {'kinds': []}, {'other': 1}, ['fcamera.mp4']):
            with self.subTest(body=body):
                self.assertEqual(self.post(f'/api/logs/{p.name}/archive/retry', json=body).status_code, 400)
        r = self.post(f'/api/logs/{p.name}/archive/retry', json={'kinds': ['fcamera.mp4']})
        self.assertEqual((r.status_code, r.json), (200, {'retried': ['fcamera.mp4']}))
        m = server.read_meta(p)
        self.assertNotIn('error', media_store.entry(m, 'fcamera.mp4'))
        # Nothing else changed: the files, Drive, no upload from the request.
        self.assertEqual(((p / 'fcamera.mp4').read_bytes(), (p / 'fcamera.mp4').stat().st_mtime_ns), (video, mtime))
        with self.drive.lock: self.assertEqual(len(self.drive.files), files)
        self.assertEqual(len(self.requests('uploadType=resumable')), sessions)
        self.assertEqual(self.block()['archive_errors'], {'remote_mismatch': 0})
        self.assertEqual(self.post(f'/api/logs/{p.name}/archive/retry').status_code, 409)  # Nothing left to retry.
        # The next cycle uploads it again.
        self.assertEqual(self.archiver.run_cycle()['archived'], 1)
        block = media_store.remote(server.read_meta(p), 'fcamera.mp4')
        self.assertEqual((block['backend'], block['bytes']), ('gdrive', len(video)))
        # Without a body every failed kind is retried.
        m = server.read_meta(p)
        for kind in ('rlog.zst', 'fcamera.mp4'): media_store.drop_remote(m, kind); media_store.set_location(m, kind, location='local', error='remote_mismatch')
        server.save_meta(p, m)
        r = self.post(f'/api/logs/{p.name}/archive/retry')
        self.assertEqual((r.status_code, sorted(r.json['retried'])), (200, ['fcamera.mp4', 'rlog.zst']))
        self.assertEqual(server.read_meta(p).get('storage'), {})

    def test_new_post_routes_require_the_request_header(self):
        self.make_backend(); self.connect_directly()
        p = self.log('a' * 32, {'rlog.zst': b'log' * 100})
        m = server.read_meta(p); media_store.set_location(m, 'rlog.zst', location='local', error='remote_mismatch'); server.save_meta(p, m)
        before = (p / 'meta.json').read_bytes()
        for url in ('/api/settings/archive/gdrive/connect', '/api/settings/archive/gdrive/disconnect', f'/api/logs/{p.name}/archive/retry',
                    '/api/settings/archive/run'):
            with self.subTest(url=url):
                self.assertEqual(self.client.post(url, environ_overrides=PEER).status_code, 403)
                self.assertEqual(self.client.post(url, headers=HEADERS).status_code, 403)  # Not from the Supervisor.
        self.assertTrue((self.root / '.gdrive-auth.json').exists()); self.assertEqual((p / 'meta.json').read_bytes(), before)
        self.assertEqual(len(self.requests('/device/code')), 1)  # connect_directly's only.

    def test_transient_token_failure_keeps_polling(self):
        self.make_backend()
        with self.drive.lock:
            self.drive.scenario.device_poll_responses = ['authorization_pending'] * 1000
            self.drive.scenario.fail_next('/token', 500, times=5)  # One poll's every attempt fails.
        self.assertEqual(self.post('/api/settings/archive/gdrive/connect').status_code, 202)
        self.assertTrue(self.until(lambda: len(self.requests('/token')) >= 7))
        gdrive = self.block()['gdrive']
        self.assertEqual((gdrive['pending']['user_code'], gdrive['last_auth_error']), ('ABCD-EFGH', None))
        self.assertTrue(server.connection.thread.is_alive())
        with self.drive.lock: self.drive.scenario.device_poll_responses = []
        server.connection.thread.join(5)
        self.assertTrue(self.auth.connected)
        self.assertEqual(self.block()['gdrive']['last_auth_error'], None)

    def test_disconnect_stops_an_upload_in_progress(self):
        self.make_backend(); self.connect_directly()
        p = self.log('a' * 32, {'fcamera.mp4': os.urandom(3 * ab.CHUNK + 5)})
        put_chunk, after = self.backend.client.put_chunk, []
        def chunk(session, data, start, total):
            if after is not None and not self.auth.connected: after.append(start)
            result = put_chunk(session, data, start, total)
            if start == 0: server.drive_connection().disconnect()
            return result
        with patch.object(self.backend.client, 'put_chunk', side_effect=chunk):
            result = self.archiver.run_cycle()
        self.assertEqual(result['stopped'], 'auth_expired')
        self.assertEqual(after, [])  # No chunk went out once signed out.
        with self.drive.lock: session = next(iter(self.drive.sessions.values()))
        self.assertEqual(len(session['received']), ab.CHUNK)
        m = server.read_meta(p)
        self.assertIsNone(media_store.remote(m, 'fcamera.mp4'))
        self.assertTrue((p / 'fcamera.mp4').is_file())
        self.assertIsNotNone(media_store.remote_pending(m, 'fcamera.mp4'))  # Kept for a resume after reconnecting.

if __name__ == '__main__':
    unittest.main()
