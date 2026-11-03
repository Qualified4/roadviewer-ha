"""Google Drive device-flow auth, token storage, the HTTP client's backoff and the Drive/NAS backends,
against tests/fake_drive.py."""
import hashlib, json, os, random, stat, sys, tempfile, unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'roadviewer/app'))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import archive_backends as ab
import media_store
from fake_drive import FakeDrive, FOLDER

SECRET = 'client-secret-xyz'


class Clock:
    def __init__(self): self.t = 1000.0
    def __call__(self): return self.t


class BackendTestCase(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(); self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.drive = FakeDrive().start(); self.addCleanup(self.drive.stop)
        env = patch.dict(os.environ, self.drive.env()); env.start(); self.addCleanup(env.stop)
        self.sleeps = []
        self.http = ab.Http(sleep=self.sleeps.append, rand=lambda: 0.5)
        self.clock = Clock()

    def auth(self):
        return ab.DriveAuth(self.root/'.gdrive-auth.json', 'client-id', SECRET, self.http, clock=self.clock)

    def connected(self):
        auth = self.auth(); auth.start_device_flow(); self.assertEqual(auth.poll_once(), 'granted'); return auth


class DriveAuthTests(BackendTestCase):
    def test_device_flow_pending_then_granted(self):
        self.drive.scenario.device_poll_responses[:] = ['authorization_pending', 'authorization_pending']
        auth = self.auth()
        self.assertFalse(auth.connected)
        flow = auth.start_device_flow()
        self.assertEqual(flow, {'user_code': 'ABCD-EFGH', 'verification_url': 'https://www.google.com/device', 'expires_at': 1000.0 + 1800, 'interval': 5})
        self.assertEqual([auth.poll_once(), auth.poll_once()], ['pending', 'pending'])
        self.assertFalse(auth.connected)
        self.assertEqual(auth.poll_once(), 'granted')
        self.assertTrue(auth.connected)
        token = auth.access_token()
        self.assertIn(token, self.drive.access_tokens)
        form = [r for r in self.drive.requests if r['path'] == '/device/code']
        self.assertEqual(len(form), 1)
        # Requested scope defaults to drive.file; the grant survives a reload from disk.
        again = self.auth()
        self.assertTrue(again.connected); self.assertEqual(again.access_token(), token)
        self.assertEqual(json.loads((self.root/'.gdrive-auth.json').read_text())['scope'], 'https://www.googleapis.com/auth/drive.file')
        self.assertEqual(self.sleeps, [])

    def test_slow_down_increases_interval(self):
        self.drive.scenario.device_poll_responses[:] = ['slow_down', 'slow_down', 'authorization_pending']
        auth = self.auth(); auth.start_device_flow()
        self.assertEqual(auth.interval, 5)
        self.assertEqual(auth.poll_once(), 'pending'); self.assertEqual(auth.interval, 10)
        self.assertEqual(auth.poll_once(), 'pending'); self.assertEqual(auth.interval, 15)
        self.assertEqual(auth.poll_once(), 'pending'); self.assertEqual(auth.interval, 15)
        self.assertEqual(auth.poll_once(), 'granted')
        self.assertEqual(self.sleeps, [])  # slow_down is the poller's business, not a rate-limit retry.

    def test_denied_and_expired(self):
        self.drive.scenario.device_poll_responses[:] = ['access_denied']
        auth = self.auth(); auth.start_device_flow()
        self.assertEqual(auth.poll_once(), 'denied'); self.assertFalse(auth.connected)
        self.assertEqual(auth.poll_once(), 'expired')  # The flow is over: nothing left to poll.
        self.drive.scenario.device_poll_responses[:] = ['expired_token']
        auth.start_device_flow()
        self.assertEqual(auth.poll_once(), 'expired'); self.assertFalse(auth.connected)
        # Past expires_at the poll answers locally without asking Google.
        auth.start_device_flow()
        self.clock.t += 1800
        count = len(self.drive.requests)
        self.assertEqual(auth.poll_once(), 'expired')
        self.assertEqual(len(self.drive.requests), count)
        self.assertFalse((self.root/'.gdrive-auth.json').exists())

    def test_refresh_before_expiry(self):
        auth = self.connected()
        first = auth.access_token()
        self.clock.t += 3599 - 61
        self.assertEqual(auth.access_token(), first)
        self.clock.t += 2  # Inside the last minute: refreshed ahead of expiry.
        second = auth.access_token()
        self.assertNotEqual(second, first)
        self.assertIn(second, self.drive.access_tokens)
        saved = json.loads((self.root/'.gdrive-auth.json').read_text())
        self.assertEqual(saved['access_token'], second)
        self.assertEqual(saved['expires_at'], self.clock.t + 3599)
        refreshes = [r for r in self.drive.requests if r['path'] == '/token']
        self.assertEqual(len(refreshes), 2)

    def test_invalid_grant_raises_auth_expired(self):
        auth = self.connected()
        self.drive.refresh_tokens.clear()  # Revoked from the Google account page.
        self.clock.t += 3600
        with self.assertRaises(ab.BackendError) as caught: auth.access_token()
        self.assertEqual((caught.exception.code, caught.exception.retryable), ('auth_expired', False))
        self.drive.scenario.fail_next('/token', 401, 'invalid_client')
        with self.assertRaises(ab.BackendError) as caught: auth.access_token()
        self.assertEqual(caught.exception.code, 'auth_expired')
        # A server error during refresh is not an expired grant.
        self.drive.scenario.fail_next('/token', 503, times=5)
        with self.assertRaises(ab.BackendError) as caught: auth.access_token()
        self.assertEqual((caught.exception.code, caught.exception.retryable), ('unavailable', True))
        self.assertTrue(auth.connected)  # Data is left alone: the user reconnects.
        # Never connected at all.
        with self.assertRaises(ab.BackendError) as caught: ab.DriveAuth(self.root/'other.json', 'client-id', SECRET, self.http).access_token()
        self.assertEqual(caught.exception.code, 'auth_expired')

    def test_token_file_mode_0600_and_keys(self):
        auth = self.connected()
        path = self.root/'.gdrive-auth.json'
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        saved = json.loads(path.read_text())
        self.assertEqual(set(saved), {'refresh_token', 'access_token', 'expires_at', 'scope', 'folder_id', 'storage_id'})
        self.assertIn(saved['refresh_token'], self.drive.refresh_tokens)
        self.assertEqual((saved['folder_id'], saved['storage_id']), (None, None))
        auth.remember(folder_id='f9', storage_id='s1')
        self.assertEqual((auth.folder_id, auth.storage_id), ('f9', 's1'))
        saved = json.loads(path.read_text())
        self.assertEqual((saved['folder_id'], saved['storage_id']), ('f9', 's1'))
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        self.assertFalse(path.with_suffix('.tmp').exists())
        # Reconnecting keeps the folder binding.
        auth.start_device_flow(); self.assertEqual(auth.poll_once(), 'granted')
        self.assertEqual(json.loads(path.read_text())['folder_id'], 'f9')
        # Disconnect revokes at Google and forgets everything.
        refresh = json.loads(path.read_text())['refresh_token']
        auth.disconnect()
        self.assertFalse(path.exists()); self.assertFalse(auth.connected)
        self.assertIn(refresh, self.drive.revoked); self.assertNotIn(refresh, self.drive.refresh_tokens)
        # A revoke that fails still forgets locally.
        auth = self.connected()
        self.drive.scenario.fail_next('/revoke', 503, times=5)
        auth.disconnect()
        self.assertFalse(path.exists())
        # A damaged file reads as not connected.
        path.write_text('{not json')
        self.assertFalse(self.auth().connected)

    def test_token_never_in_repr_or_errors(self):
        auth = self.connected()
        saved = json.loads((self.root/'.gdrive-auth.json').read_text())
        secrets = [saved['refresh_token'], saved['access_token'], SECRET]
        texts = [repr(auth), str(auth)]
        self.drive.refresh_tokens.clear(); self.clock.t += 3600
        for fail in [None, ('/token', 500, None, 5), ('/token', 429, None, 5)]:
            if fail: self.drive.scenario.fail_next(*fail)
            try: auth.access_token()
            except ab.BackendError as e: texts += [str(e), repr(e), repr(e.args)]
            else: self.fail('expected BackendError')
        session = self.drive.url + '/upload/drive/v3/files?uploadType=resumable&upload_id=up1-secretsession'
        self.drive.stop()
        try: self.http.request('PUT', session, headers={'Authorization': 'Bearer ' + saved['access_token']}, body=b'x')
        except ab.BackendError as e: texts += [str(e), repr(e), repr(e.args)]
        else: self.fail('expected BackendError')
        for text in texts:
            for secret in secrets + ['secretsession']: self.assertNotIn(secret, text)
        self.assertEqual(ab.redact('a %s b %s' % (secrets[0], session), [secrets[0], session, '', None]), 'a <secret> b <secret>')

    def test_device_code_rejected_client(self):
        auth = ab.DriveAuth(self.root/'x.json', '', SECRET, self.http)
        with self.assertRaises(ab.BackendError) as caught: auth.start_device_flow()
        self.assertEqual(caught.exception.code, 'auth_expired')
        self.assertIn('invalid_client', str(caught.exception))


class HttpTests(BackendTestCase):
    def about(self, auth):
        return self.http.request('GET', self.drive.url + '/drive/v3/about?fields=storageQuota', headers={'Authorization': 'Bearer ' + auth.access_token()})

    def test_backoff_on_429_then_success(self):
        auth = self.connected()
        self.drive.scenario.fail_next('/about', 429, times=2)
        self.drive.scenario.fail_next('/about', 403, 'userRateLimitExceeded')
        self.drive.scenario.fail_next('/about', 503)
        r = self.about(auth)
        self.assertEqual(r.status, 200)
        self.assertEqual(r.json(), {'storageQuota': {'usage': '0', 'usageInDrive': '0'}})
        self.assertEqual(self.sleeps, [1.5, 2.5, 4.5, 8.5])  # min(2**n + rand, 64), n = 0..3
        self.drive.scenario.quota_limit = 10
        self.assertEqual(self.about(auth).json()['storageQuota']['limit'], '10')

    def test_rate_limit_exhausted_raises(self):
        auth = self.connected()
        self.drive.scenario.fail_next('/about', 403, 'rateLimitExceeded', times=5)
        with self.assertRaises(ab.BackendError) as caught: self.about(auth)
        self.assertEqual((caught.exception.code, caught.exception.retryable), ('rate_limited', True))
        self.assertEqual(len(self.sleeps), 4)
        self.assertEqual(len([r for r in self.drive.requests if '/about' in r['path']]), 5)
        # Capped at 64 seconds.
        http = ab.Http(sleep=self.sleeps.append, rand=lambda: 0.25, attempts=9)
        self.sleeps.clear(); self.drive.scenario.fail_next('/about', 429, times=9)
        with self.assertRaises(ab.BackendError): http.request('GET', self.drive.url + '/drive/v3/about', headers={'Authorization': 'Bearer ' + auth.access_token()})
        self.assertEqual(self.sleeps, [1.25, 2.25, 4.25, 8.25, 16.25, 32.25, 64, 64])
        # 5xx that never clears is an outage.
        self.sleeps.clear(); self.drive.scenario.fail_next('/about', 502, times=5)
        with self.assertRaises(ab.BackendError) as caught: self.about(auth)
        self.assertEqual((caught.exception.code, caught.exception.retryable), ('unavailable', True))
        # Out of storage is final: no retries.
        self.sleeps.clear(); self.drive.scenario.fail_next('/about', 403, 'storageQuotaExceeded')
        with self.assertRaises(ab.BackendError) as caught: self.about(auth)
        self.assertEqual((caught.exception.code, caught.exception.retryable), ('quota_exceeded', False))
        self.assertEqual(self.sleeps, [])
        # Other 4xx come back to the caller untouched.
        self.drive.scenario.fail_next('/about', 403, 'insufficientFilePermissions')
        r = self.about(auth)
        self.assertEqual(r.status, 403); self.assertEqual(ab.error_reason(r), 'insufficientFilePermissions')
        self.assertEqual(self.sleeps, [])

    def test_no_redirect_follow(self):
        auth = self.connected()
        self.drive.scenario.fail_next('/drive/v3/files/f1', 302, headers={'Location': self.drive.url + '/drive/v3/about'})
        r = self.http.request('GET', self.drive.url + '/drive/v3/files/f1', headers={'Authorization': 'Bearer ' + auth.access_token()})
        self.assertEqual(r.status, 302)
        self.assertEqual(r.headers.get('location'), self.drive.url + '/drive/v3/about')
        self.assertFalse(any('/about' in req['path'] for req in self.drive.requests))
        # A resumable session's 308 is an answer, not a redirect.
        start = self.http.request('POST', self.drive.url + '/upload/drive/v3/files?uploadType=resumable',
                                  headers={'Authorization': 'Bearer ' + auth.access_token(), 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Length': '4'},
                                  body=json.dumps({'name': 'x'}).encode())
        session = start.headers['Location']
        r = self.http.request('PUT', session, headers={'Content-Range': 'bytes 0-1/4'}, body=b'ab')
        self.assertEqual((r.status, r.headers.get('Range')), (308, 'bytes=0-1'))
        r = self.http.request('PUT', session, headers={'Content-Range': 'bytes */4'})
        self.assertEqual((r.status, r.headers.get('Range')), (308, 'bytes=0-1'))
        r = self.http.request('PUT', session, headers={'Content-Range': 'bytes 2-3/4'}, body=b'cd')
        self.assertEqual(r.status, 200)
        self.assertEqual(r.json()['size'], '4')

    def test_proxy_env_ignored(self):
        proxy = FakeDrive().start(); self.addCleanup(proxy.stop)
        env = {'http_proxy': proxy.url, 'HTTP_PROXY': proxy.url, 'https_proxy': proxy.url, 'HTTPS_PROXY': proxy.url, 'all_proxy': proxy.url, 'no_proxy': '', 'NO_PROXY': ''}
        with patch.dict(os.environ, env):
            http = ab.Http(sleep=self.sleeps.append)
            auth = ab.DriveAuth(self.root/'.gdrive-auth.json', 'client-id', SECRET, http, clock=self.clock)
            auth.start_device_flow(); self.assertEqual(auth.poll_once(), 'granted')
        self.assertEqual(proxy.requests, [])

    def test_stream_and_socket_errors(self):
        auth = self.connected()
        token = auth.access_token()
        with self.drive.lock: self.drive.files['f1'] = dict(name='n', mimeType='application/octet-stream', parents=[], appProperties={}, content=bytes(range(200)), trashed=False, md5='', sha256='')
        r = self.http.request('GET', self.drive.url + '/drive/v3/files/f1?alt=media', headers={'Authorization': 'Bearer ' + token, 'Range': 'bytes=10-109'}, stream=True)
        self.assertEqual((r.status, r.headers['Content-Range']), (206, 'bytes 10-109/200'))
        self.assertEqual(b''.join(r.iter_chunks(30)), bytes(range(10, 110)))
        # Completion stored, answer lost: the socket error surfaces as a retryable outage.
        start = self.http.request('POST', self.drive.url + '/upload/drive/v3/files?uploadType=resumable', headers={'Authorization': 'Bearer ' + token}, body=b'{}')
        self.drive.scenario.lose_completion_response = True
        with self.assertRaises(ab.BackendError) as caught: self.http.request('PUT', start.headers['Location'], headers={'Content-Range': 'bytes 0-1/2'}, body=b'ok')
        self.assertEqual((caught.exception.code, caught.exception.retryable), ('unavailable', True))
        self.assertEqual(self.http.request('PUT', start.headers['Location'], headers={'Content-Range': 'bytes */2'}).json()['size'], '2')
        # A server that stops answering times out.
        self.drive.scenario.delay_seconds = 0.5
        with self.assertRaises(ab.BackendError) as caught: self.http.request('GET', self.drive.url + '/drive/v3/about', timeout=0.1)
        self.assertEqual(caught.exception.code, 'unavailable')
        self.drive.scenario.delay_seconds = 0
        self.assertEqual(self.sleeps, [])


ID, KIND, MB = 'a' * 32, 'fcamera.mp4', 2**20


class DriveBackendTests(BackendTestCase):
    def setUp(self):
        super().setUp()
        self.now = 0.0
        self.drive_auth = self.connected()
        self.settings = SimpleNamespace(enabled=True, backend='gdrive', gdrive_folder_name='Road Viewer')
        self.backend = self.make()

    def make(self, auth=None):
        auth = auth or self.drive_auth
        return ab.DriveBackend(self.settings, self.root, auth, ab.DriveClient(self.http, auth), clock=lambda: self.now)

    def folders(self):
        with self.drive.lock: return {i: f for i, f in self.drive.files.items() if f['mimeType'] == FOLDER}

    def local_id(self): return json.loads((self.root/'.archive.json').read_text())['storage_id']

    def media(self, size, name='media'):
        data = random.Random(size).randbytes(size)
        path = self.root/name; path.write_bytes(data)
        return path, data, hashlib.sha256(data).hexdigest(), hashlib.md5(data).hexdigest()

    def upload(self, size, kind=KIND, **kwargs):
        path, data, sha, md5 = self.media(size)
        return self.backend.upload(path, ID, kind, sha, md5, size, **kwargs), data, sha, md5

    def put_file(self, file_id, content=b'x', parents=None, trashed=False, **props):
        with self.drive.lock:
            self.drive.files[file_id] = dict(name='n', mimeType='application/octet-stream', parents=parents if parents is not None else [self.drive_auth.folder_id],
                                             appProperties=props, content=content, trashed=trashed, md5=hashlib.md5(content).hexdigest(), sha256=hashlib.sha256(content).hexdigest())

    def requests(self, method=None, since=0):
        with self.drive.lock: rows = self.drive.requests[since:]
        return [dict(r, headers={k.lower(): v for k, v in r['headers'].items()}) for r in rows if method is None or r['method'] == method]

    def ranges(self, since=0): return [r['headers'].get('content-range') for r in self.requests('PUT', since)]

    def content(self, file_id):
        with self.drive.lock: return self.drive.files[file_id]['content']

    def test_probe_connected_and_folder_trashed(self):
        b = self.backend
        self.assertEqual(b.probe(), ('unavailable', 'folder_missing'))  # Not activated yet.
        b.activate()
        self.assertEqual(b.probe(), ('connected', None))
        self.assertEqual(b.last_state(), 'connected')
        folder = self.drive_auth.folder_id
        with self.drive.lock: self.drive.files[folder]['trashed'] = True
        self.assertEqual(b.probe(), ('connected', None))  # Reused for 10 seconds.
        self.now += 10
        self.assertIsNone(b.last_state())
        self.assertEqual(b.probe(), ('unavailable', 'folder_trashed'))
        with self.drive.lock: self.drive.files[folder]['trashed'] = False
        b.invalidate()
        with b.lock: self.assertEqual(b.probe(), ('checking', 'probe_pending'))  # Another probe is in flight.
        self.assertEqual(b.probe(), ('connected', None))
        # An outage is not a missing folder.
        b.invalidate(); self.drive.scenario.fail_next('/drive/v3/files/' + folder, 503, times=5)
        self.assertEqual(b.probe(), ('unavailable', 'network'))
        # A rejected access token is refreshed once.
        b.invalidate(); self.drive.access_tokens.clear()
        self.assertEqual(b.probe(), ('connected', None))
        # The grant revoked at Google.
        b.invalidate(); self.drive.access_tokens.clear(); self.drive.refresh_tokens.clear()
        self.assertEqual(b.probe(), ('unavailable', 'auth_expired'))
        self.assertEqual(ab.DriveBackend(self.settings, self.root, self.auth_for('none.json'), None).probe(), ('unavailable', 'not_connected'))
        self.assertEqual(ab.DriveBackend(SimpleNamespace(enabled=False, error=None), self.root, self.drive_auth, None).probe(), ('disabled', None))

    def auth_for(self, name): return ab.DriveAuth(self.root/name, 'client-id', SECRET, self.http, clock=self.clock)

    def test_storage_id_mismatch_unavailable(self):
        b = self.backend; b.activate()
        folder = self.drive_auth.folder_id
        with self.drive.lock: self.drive.files[folder]['appProperties']['rv_storage_id'] = 'someone-else'
        b.invalidate(); self.assertEqual(b.probe(), ('unavailable', 'storage_id_mismatch'))
        with self.drive.lock: self.drive.files[folder]['appProperties']['rv_storage_id'] = self.local_id()
        b.invalidate(); self.assertEqual(b.probe(), ('connected', None))
        (self.root/'.archive.json').unlink()
        b.invalidate(); self.assertEqual(b.probe(), ('unavailable', 'storage_id_mismatch'))
        b.activate()  # A folder is bound: verify only.
        self.assertEqual(len(self.folders()), 1)
        self.assertFalse((self.root/'.archive.json').exists())
        self.assertEqual(b.probe(), ('unavailable', 'storage_id_mismatch'))

    def test_activate_creates_folder_once(self):
        self.backend.activate(); self.backend.activate()
        folders = self.folders()
        self.assertEqual(len(folders), 1)
        (folder, f), = folders.items()
        sid = self.local_id()
        self.assertEqual((f['name'], f['parents'], f['appProperties']), ('Road Viewer', [], {'rv_storage_id': sid}))
        self.assertEqual((self.drive_auth.folder_id, self.drive_auth.storage_id), (folder, sid))
        self.make(self.auth()).activate()  # Restart: reloaded from disk.
        self.assertEqual(len(self.folders()), 1)
        # Disconnect forgets the binding; reconnecting finds the folder by its storage id instead of making another.
        self.drive_auth.disconnect()
        again = self.connected(); self.assertIsNone(again.folder_id)
        b = self.make(again); b.activate()
        self.assertEqual(len(self.folders()), 1)
        self.assertEqual((again.folder_id, again.storage_id), (folder, sid))
        self.assertEqual(b.probe(), ('connected', None))
        # Our storage id but no folder carrying it (another account, deleted): never claimed.
        with self.drive.lock: self.drive.files.clear()
        again.disconnect()
        other = self.connected(); b = self.make(other); b.activate()
        self.assertEqual(self.folders(), {})
        self.assertEqual(b.probe(), ('unavailable', 'folder_missing'))
        self.assertEqual(self.local_id(), sid)
        self.assertEqual(len([r for r in self.requests('POST') if r['path'].startswith('/drive/v3/files')]), 1)

    def test_upload_in_chunks_and_verify_sha256(self):
        self.backend.activate()
        size = 2 * MB + MB // 2
        progress, resume = [], {}
        ref, data, sha, md5 = self.upload(size, resume=resume, on_progress=progress.append)
        self.assertEqual(progress, [0, MB, 2 * MB, size])
        self.assertEqual(self.ranges(), ['bytes 0-1048575/%d' % size, 'bytes 1048576-2097151/%d' % size, 'bytes 2097152-%d/%d' % (size - 1, size)])
        self.assertEqual(ref, ab.RemoteRef('gdrive', ref.file_id, size, sha, md5))
        with self.drive.lock: f = dict(self.drive.files[ref.file_id])
        self.assertEqual(f['content'], data)
        self.assertEqual((f['name'], f['parents']), ('%s--%s' % (ID, KIND), [self.drive_auth.folder_id]))
        self.assertEqual(f['appProperties'], {'rv_id': ID, 'rv_kind': KIND, 'rv_sha256': sha, 'rv_storage_id': self.local_id()})
        self.assertEqual(resume['bytes_sent'], size); self.assertIn('upload_id=', resume['session'])
        self.assertEqual(self.backend.verify(ref, sha, size), 'ok')
        self.assertEqual(self.backend.verify(ref, '0' * 64, size), 'mismatch')
        self.assertEqual(self.backend.verify(ref, sha, size + 1), 'mismatch')
        self.assertEqual(self.backend.stat(ref), ab.RemoteStat(True, size, sha, md5, False))
        self.assertEqual(self.sleeps, [])
        # The local file is not what the caller hashed: the upload is not trusted.
        path, *_ = self.media(1000)
        with self.assertRaises(ab.BackendError) as caught: self.backend.upload(path, ID, 'ecamera.mp4', '0' * 64, None, 1000)
        self.assertEqual(caught.exception.code, 'mismatch')
        # An empty file is one status request.
        path, _, sha0, _ = self.media(0)
        ref = self.backend.upload(path, ID, 'rlog.zst', sha0, None, 0)
        self.assertEqual((ref.bytes, self.ranges()[-1]), (0, 'bytes */0'))

    def test_upload_resumes_from_308_range(self):
        self.backend.activate()
        size = 3 * MB + 100
        path, data, sha, md5 = self.media(size)
        class Stop(Exception): pass
        def stop(n):
            if n == 2 * MB: raise Stop()
        resume = {}
        with self.assertRaises(Stop): self.backend.upload(path, ID, KIND, sha, md5, size, resume, stop)
        self.assertEqual(resume['bytes_sent'], 2 * MB)
        mark = len(self.drive.requests)
        progress = []
        ref = self.backend.upload(path, ID, KIND, sha, md5, size, dict(resume), progress.append)
        self.assertEqual(self.ranges(mark), ['bytes */%d' % size, 'bytes 2097152-3145727/%d' % size, 'bytes 3145728-%d/%d' % (size - 1, size)])
        self.assertEqual(self.requests('POST', mark), [])  # Same session.
        self.assertEqual(progress, [3 * MB, size])
        self.assertEqual(self.content(ref.file_id), data)
        self.assertEqual(self.backend.verify(ref, sha, size), 'ok')
        # A session that completed while we were away is adopted without sending anything.
        mark = len(self.drive.requests)
        again = self.backend.upload(path, ID, KIND, sha, md5, size, dict(resume))
        self.assertEqual((again.file_id, self.ranges(mark)), (ref.file_id, ['bytes */%d' % size]))
        # The completion answer is lost: the session is asked, not sent the last chunk again.
        self.drive.scenario.lose_completion_response = True
        mark = len(self.drive.requests)
        lost, small, *_ = self.upload(1000, kind='ecamera.mp4')
        self.assertEqual(self.ranges(mark), ['bytes 0-999/1000', 'bytes */1000'])
        self.assertEqual(self.content(lost.file_id), small)
        self.assertEqual(len([f for f in self.drive.files.values() if f['name'].endswith('ecamera.mp4')]), 1)

    def test_upload_session_expired_restarts(self):
        self.backend.activate()
        size = 2 * MB + 5
        path, data, sha, md5 = self.media(size)
        old = self.drive.url + '/upload/drive/v3/files?uploadType=resumable&upload_id=gone-secretsession'
        resume = {'session': old, 'bytes_sent': MB}
        ref = self.backend.upload(path, ID, KIND, sha, md5, size, resume)
        self.assertEqual(self.content(ref.file_id), data)
        self.assertNotEqual(resume['session'], old)
        self.assertEqual(self.ranges()[:2], ['bytes */%d' % size, 'bytes 0-1048575/%d' % size])
        # Expiring part-way: one new session, from byte 0.
        expired = []
        def expire(n):
            if n == MB and not expired:
                expired.append(n)
                with self.drive.lock: self.drive.sessions.clear()
        mark = len(self.drive.requests)
        ref = self.backend.upload(path, ID, 'ecamera.mp4', sha, md5, size, {}, expire)
        self.assertEqual(self.content(ref.file_id), data)
        self.assertEqual(self.ranges(mark).count('bytes 0-1048575/%d' % size), 2)
        # Expiring every time gives up, without the session URI in the message.
        def always(n):
            if n == MB:
                with self.drive.lock: self.drive.sessions.clear()
        with self.assertRaises(ab.BackendError) as caught: self.backend.upload(path, ID, 'camera.mp4', sha, md5, size, {}, always)
        self.assertEqual((caught.exception.code, caught.exception.reason), ('unavailable', 'session_expired'))
        for text in (str(caught.exception), repr(caught.exception)): self.assertNotIn('secretsession', text)

    def test_verify_falls_back_to_md5_then_unverifiable(self):
        self.backend.activate()
        ref, _, sha, md5 = self.upload(5000)
        with self.drive.lock: self.drive.files[ref.file_id]['sha256'] = None
        self.assertEqual(self.backend.verify(ref, sha, 5000, md5=md5), 'ok')
        self.assertEqual(self.backend.verify(ref, sha, 5000, md5='0' * 32), 'mismatch')
        self.assertEqual(self.backend.verify(ref, sha, 5000), 'unverifiable')  # Local md5 unknown.
        with self.drive.lock: self.drive.files[ref.file_id]['md5'] = None
        self.assertEqual(self.backend.verify(ref, sha, 5000, md5=md5), 'unverifiable')
        with self.drive.lock: self.drive.files.pop(ref.file_id)
        with self.assertRaises(ab.BackendError) as caught: self.backend.verify(ref, sha, 5000)
        self.assertEqual(caught.exception.code, 'not_found')

    def test_find_by_app_properties_ignores_other_storage_id(self):
        self.backend.activate()
        ref, *_ = self.upload(100)
        ours = self.local_id()
        self.put_file('x1', rv_id=ID, rv_kind=KIND, rv_storage_id='other-instance')
        self.put_file('x2', trashed=True, rv_id=ID, rv_kind=KIND, rv_storage_id=ours)
        self.put_file('x3', rv_id=ID, rv_kind='ecamera.mp4', rv_storage_id=ours)
        self.put_file('x4', parents=['elsewhere'], rv_id=ID, rv_kind=KIND, rv_storage_id=ours)
        self.put_file('x5', rv_id=ID, rv_kind=KIND)
        mark = len(self.drive.requests)
        self.assertEqual(self.backend.find(ID, KIND), [ref])
        q = parse_qs(urlsplit(self.requests('GET', mark)[0]['path']).query)
        self.assertEqual(q['q'][0], "appProperties has { key='rv_id' and value='%s' } and appProperties has { key='rv_kind' and value='%s' } "
                                    "and trashed=false and '%s' in parents" % (ID, KIND, self.drive_auth.folder_id))
        self.assertEqual(q['fields'][0], 'nextPageToken,files(id,size,sha256Checksum,md5Checksum,appProperties)')
        self.assertEqual(self.backend.find('b' * 32, KIND), [])

    def test_delete_refuses_foreign_file(self):
        self.backend.activate()
        self.put_file('x1', rv_id=ID, rv_kind=KIND, rv_storage_id='other-instance')
        self.put_file('x2')
        for file_id in ('x1', 'x2'):
            with self.assertRaises(ab.BackendError) as caught: self.backend.delete(ab.RemoteRef('gdrive', file_id, 1, None, None))
            self.assertEqual((caught.exception.code, caught.exception.reason), ('io', 'foreign_file'))
            self.assertIn(file_id, self.drive.files)
        self.assertEqual(self.requests('DELETE'), [])

    def test_delete_404_is_confirmed(self):
        self.backend.activate()
        ref, *_ = self.upload(100)
        self.assertTrue(self.backend.delete(ref))
        self.assertNotIn(ref.file_id, self.drive.files)
        self.assertTrue(self.backend.delete(ref))  # Already gone.
        ref, *_ = self.upload(100)
        self.drive.scenario.fail_next('/drive/v3/files/' + ref.file_id, 503, times=5)
        self.assertFalse(self.backend.delete(ref))  # Unsure: kept for later.
        self.assertIn(ref.file_id, self.drive.files)
        self.drive.access_tokens.clear(); self.drive.refresh_tokens.clear()
        self.assertFalse(self.backend.delete(ref))
        self.assertIn(ref.file_id, self.drive.files)

    def test_download_range_206(self):
        self.backend.activate()
        ref, data, *_ = self.upload(3 * MB)
        mark = len(self.drive.requests)
        self.assertEqual(b''.join(self.backend.open(ref, 10, 109)), data[10:110])
        self.assertEqual(self.requests('GET', mark)[-1]['headers'].get('range'), 'bytes=10-109')
        chunks = list(self.backend.open(ref))
        self.assertEqual(b''.join(chunks), data)
        self.assertNotIn('range', self.requests('GET', mark)[-1]['headers'])
        self.assertTrue(all(len(c) <= MB for c in chunks))
        self.assertEqual(b''.join(self.backend.open(ref, 2 * MB)), data[2 * MB:])
        with self.assertRaises(ab.BackendError) as caught: self.backend.open(ref, len(data) + 5)  # Raised at the call.
        self.assertEqual((caught.exception.code, caught.exception.reason), ('io', 'range_not_satisfiable'))
        with self.assertRaises(ab.BackendError) as caught: self.backend.open(ab.RemoteRef('gdrive', 'nope', 1, None, None))
        self.assertEqual(caught.exception.code, 'not_found')

    def test_download_to_verifies_hash(self):
        self.backend.activate()
        ref, data, sha, _ = self.upload(MB + 7)
        out = self.root/'out'; out.mkdir()
        self.backend.download_to(ref, out/'fcamera.mp4', sha)
        self.assertEqual((out/'fcamera.mp4').read_bytes(), data)
        with self.assertRaises(ab.BackendError) as caught: self.backend.download_to(ref, out/'other.mp4', '0' * 64)
        self.assertEqual(caught.exception.code, 'mismatch')
        self.assertEqual(sorted(p.name for p in out.iterdir()), ['fcamera.mp4'])  # No partial or wrong copy left.

    def test_usage_unreliable_without_limit(self):
        self.backend.activate()
        self.upload(1000)
        self.assertEqual(self.backend.usage(), ab.Usage(used=1000, free=None, limit=None, reliable=False))
        self.drive.scenario.quota_limit = 10**6
        self.assertEqual(self.backend.usage().limit, None)  # Reused for 10 seconds.
        self.now += 10
        self.assertEqual(self.backend.usage(), ab.Usage(used=1000, free=10**6 - 1000, limit=10**6, reliable=True))

    def test_create_and_session_put_not_retried_on_5xx(self):
        self.drive.scenario.fail_next('/drive/v3/files?fields=id', 503)
        self.backend.activate()
        self.assertEqual(len([r for r in self.requests('POST') if r['path'].startswith('/drive/v3/files')]), 1)
        self.assertEqual((self.folders(), self.sleeps), ({}, []))
        self.assertEqual(self.backend.probe(), ('unavailable', 'folder_missing'))
        sid = self.drive_auth.storage_id
        self.assertTrue(sid); self.assertFalse((self.root/'.archive.json').exists())
        self.backend.activate()  # The storage id recorded before the failed create is used.
        self.assertEqual([f['appProperties']['rv_storage_id'] for f in self.folders().values()], [sid])
        self.assertEqual(self.local_id(), sid)
        # A chunk that got a 5xx is not resent blindly: the session is asked first, then the chunk is sent
        # again after one backoff because nothing arrived.
        self.drive.scenario.fail_next('upload_id', 503)
        size = MB + MB // 2
        mark = len(self.drive.requests)
        ref, data, *_ = self.upload(size)
        self.assertEqual(self.ranges(mark), ['bytes 0-1048575/%d' % size, 'bytes */%d' % size, 'bytes 0-1048575/%d' % size, 'bytes 1048576-%d/%d' % (size - 1, size)])
        self.assertEqual(self.sleeps, [1.5])
        self.assertEqual(self.content(ref.file_id), data)

    def test_get_retries_socket_error_then_succeeds(self):
        self.backend.activate()
        ref, *_ = self.upload(100)
        real, calls, failures = self.http._once, [], [2]
        def flaky(method, *args):
            calls.append(method)
            if failures[0]:
                failures[0] -= 1
                raise ab.BackendError('unavailable', retryable=True, reason='timeout')
            return real(method, *args)
        with patch.object(self.http, '_once', flaky):
            self.assertTrue(self.backend.stat(ref).exists)
            self.assertEqual((calls, self.sleeps), (['GET'] * 3, [1.5, 2.5]))
            calls.clear(); self.sleeps.clear(); failures[0] = 99
            with self.assertRaises(ab.BackendError) as caught: self.backend.stat(ref)
            self.assertEqual(caught.exception.code, 'unavailable')
            self.assertEqual((len(calls), len(self.sleeps)), (5, 4))
            # Not safe to resend: one attempt.
            for call in (lambda: self.backend.client.create_folder('x', {}), lambda: self.backend.client.put_chunk(self.drive.url + '/upload/drive/v3/files?uploadType=resumable&upload_id=x', b'ab', 0, 2)):
                calls.clear(); self.sleeps.clear()
                with self.assertRaises(ab.BackendError): call()
                self.assertEqual((len(calls), self.sleeps), (1, []))

    def test_probe_folder_missing_after_reconnect(self):
        b = self.backend; b.activate()
        folder = self.drive_auth.folder_id
        # Reconnected with another account: the binding is kept, but that account cannot see the folder.
        self.drive_auth.start_device_flow(); self.assertEqual(self.drive_auth.poll_once(), 'granted')
        with self.drive.lock: self.drive.files.pop(folder)
        b.invalidate()
        self.assertEqual(b.probe(), ('unavailable', 'folder_missing'))
        b.activate()  # Bound already: never a second folder.
        self.assertEqual(self.folders(), {})
        self.assertEqual((self.drive_auth.folder_id, b.probe()), (folder, ('unavailable', 'folder_missing')))


class SmbBackendTests(BackendTestCase):
    def test_smb_backend_delegates_to_store(self):
        env = patch.dict(os.environ, {'RV_ARCHIVE_ALLOW_ANY_PATH': '1'}); env.start(); self.addCleanup(env.stop)
        share, data_root = self.root/'share', self.root/'data'
        share.mkdir(); data_root.mkdir()
        settings = media_store.ArchiveSettings(enabled=True, path=share)
        store = media_store.ArchiveStore(settings, data_root)
        b = ab.make_backend(settings, data_root, store=store)
        self.assertIsInstance(b, ab.SmbBackend)
        self.assertEqual(b.caps, ab.Capabilities('smb', True, (), True, True, True))
        self.assertEqual(b.probe(), ('unavailable', 'sentinel_missing'))
        b.activate()
        self.assertEqual((b.probe(), b.last_state()), (('connected', None), 'connected'))
        self.assertEqual(b.storage_id(), store.local_id()); self.assertTrue(b.storage_id())
        content = random.Random(1).randbytes(MB + 3)
        src = self.root/'src'; src.write_bytes(content)
        sha = hashlib.sha256(content).hexdigest()
        progress = []
        ref = b.upload(src, ID, KIND, sha, None, len(content), on_progress=progress.append)
        self.assertEqual((ref.file_id, progress), ('%s/%s' % (ID, KIND), [MB, MB + 3]))
        self.assertEqual((share/ID/KIND).read_bytes(), content)
        self.assertEqual(b.stat(ref), ab.RemoteStat(True, MB + 3, None, None, False))
        self.assertEqual([r.file_id for r in b.find(ID, KIND)], [ref.file_id])
        self.assertEqual((b.verify(ref, sha, MB + 3), b.verify(ref, '0' * 64, MB + 3)), ('ok', 'mismatch'))
        self.assertEqual(b''.join(b.open(ref, 5, 9)), content[5:10])
        b.download_to(ref, self.root/'copy.mp4', sha)
        self.assertEqual((self.root/'copy.mp4').read_bytes(), content)
        usage = b.usage()
        self.assertEqual((usage.used >= MB + 3, usage.limit, usage.reliable), (True, None, True))
        self.assertTrue(b.delete(ref))
        self.assertFalse((share/ID).exists()); self.assertEqual(b.find(ID, KIND), [])
        b.invalidate(); self.assertIsNone(store.cached)
        # Drive settings give a Drive backend; the client secret stays out of its repr.
        drive = ab.make_backend(SimpleNamespace(backend='gdrive', gdrive_client_id='cid', gdrive_client_secret=SECRET), self.root)
        self.assertIsInstance(drive, ab.DriveBackend)
        self.assertEqual(drive.auth.path, self.root/'.gdrive-auth.json')
        self.assertEqual(drive.caps, ab.Capabilities('gdrive', False, ('sha256', 'md5'), True, False, False))
        self.assertNotIn(SECRET, repr(drive) + repr(drive.auth) + repr(drive.client))


if __name__ == '__main__':
    unittest.main()
