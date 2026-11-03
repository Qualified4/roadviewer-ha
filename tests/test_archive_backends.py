"""Google Drive device-flow auth, token storage and the HTTP client's backoff, against tests/fake_drive.py."""
import json, os, stat, sys, tempfile, unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'roadviewer/app'))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import archive_backends as ab
from fake_drive import FakeDrive

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


if __name__ == '__main__':
    unittest.main()
