"""Archive backends: the HTTP client with backoff and Google Drive device-flow auth (standard library only)."""
import http.client, io, json, os, random, re, ssl, threading, time
import urllib.error, urllib.parse, urllib.request
from pathlib import Path
from storage_policy import atomic_json

DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file'
DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'
TOKEN_KEYS = ('refresh_token', 'access_token', 'expires_at', 'scope', 'folder_id', 'storage_id')
RETRY_STATUS = (429, 500, 502, 503, 504)
RATE_REASONS = ('userRateLimitExceeded', 'rateLimitExceeded')
REFRESH_MARGIN = 60
TIMEOUT = 60
# Error reasons are Google's fixed tokens; anything else is cut down so free text never reaches a message.
REASON = re.compile(r'[A-Za-z0-9_.-]{1,64}')

# Tests point these at tests/fake_drive.py; production never sets them.
def api_base_url(): return os.environ.get('RV_GDRIVE_API_BASE') or 'https://www.googleapis.com'
def upload_base_url(): return os.environ.get('RV_GDRIVE_UPLOAD_BASE') or 'https://www.googleapis.com/upload'
def oauth_base_url(): return os.environ.get('RV_GDRIVE_OAUTH_BASE') or 'https://oauth2.googleapis.com'

def redact(text, secrets):
    text = str(text)
    for secret in sorted((str(s) for s in secrets if s), key=len, reverse=True):
        text = text.replace(secret, '<secret>')
    return text

class BackendError(Exception):
    """code: unavailable|auth_expired|rate_limited|quota_exceeded|not_found|mismatch|io. The message is the code
    and, at most, a short Google error token: never a URL, header or body."""
    def __init__(self, code, retryable=False, reason=None):
        reason = reason if isinstance(reason, str) and REASON.fullmatch(reason) else None
        super().__init__(code if reason is None else '%s: %s' % (code, reason))
        self.code, self.retryable, self.reason = code, retryable, reason

class HttpResponse:
    def __init__(self, status, headers, raw, data=None):
        self.status, self.headers, self._raw = status, headers, raw
        self._buf = None if data is None else io.BytesIO(data)

    def __repr__(self): return 'HttpResponse(status=%d)' % self.status

    def read(self, n=-1):
        if self._buf is not None: return self._buf.read(n)
        try: return self._raw.read(n) if n is not None and n >= 0 else self._raw.read()
        except (OSError, http.client.HTTPException) as e:
            self.close()
            raise BackendError('unavailable', retryable=True, reason=type(e).__name__) from None

    def iter_chunks(self, size=2**20):
        try:
            while True:
                chunk = self.read(size)
                if not chunk: return
                yield chunk
        finally:
            self.close()

    def json(self):
        if self._buf is None:
            data = self.read(); self.close(); self._buf = io.BytesIO(data)
        data = self._buf.getvalue()
        try: return json.loads(data) if data.strip() else None
        except ValueError: return None

    def close(self):
        if self._raw is not None:
            try: self._raw.close()
            except OSError: pass

def error_reason(response):
    """Google's error token: OAuth's `{"error": "slow_down"}` or Drive's `{"error": {"errors": [{"reason": ...}]}}`."""
    body = response.json()
    if not isinstance(body, dict): return None
    error = body.get('error')
    if isinstance(error, str): return error
    if isinstance(error, dict):
        errors = error.get('errors')
        if isinstance(errors, list) and errors and isinstance(errors[0], dict) and errors[0].get('reason'):
            return errors[0]['reason']
        return error.get('status')
    return None

class _NoRedirect(urllib.request.HTTPRedirectHandler):
    # A redirect comes back as the response itself: a resumable session's 308 is an answer, and a token must
    # never follow a Location to another host.
    def redirect_request(self, *args, **kwargs): return None

class Http:
    def __init__(self, sleep=time.sleep, rand=random.random, attempts=5):
        self.sleep, self.rand, self.attempts = sleep, rand, attempts
        # Environment proxies are ignored: the add-on talks to Google directly.
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect(),
                                                  urllib.request.HTTPSHandler(context=ssl.create_default_context()))

    def __repr__(self): return 'Http()'

    def _once(self, method, url, headers, body, stream, timeout):
        if body is None and method in ('POST', 'PUT', 'PATCH'): body = b''  # Sends Content-Length: 0.
        req = urllib.request.Request(url, data=body, headers=headers or {}, method=method)
        try:
            try: raw = self.opener.open(req, timeout=timeout); status = raw.status
            except urllib.error.HTTPError as e: raw = e; status = e.code
            headers = raw.headers
            if stream and status < 400: return HttpResponse(status, headers, raw)
            try: data = raw.read()
            finally: raw.close()
            return HttpResponse(status, headers, None, data)
        except (OSError, http.client.HTTPException, ValueError) as e:
            # urllib.error.URLError is an OSError. The cause is dropped: its text can carry the URL.
            raise BackendError('unavailable', retryable=True, reason=type(e).__name__) from None

    def request(self, method, url, *, headers=None, body=None, stream=False, timeout=TIMEOUT):
        for attempt in range(self.attempts):
            r = self._once(method, url, headers, body, stream, timeout)
            reason = error_reason(r) if r.status == 403 else None
            if reason == 'storageQuotaExceeded': raise BackendError('quota_exceeded', reason=reason)
            if r.status not in RETRY_STATUS and reason not in RATE_REASONS: return r
            r.close()
            if attempt + 1 < self.attempts: self.sleep(min(2 ** attempt + self.rand(), 64))
        raise BackendError('rate_limited' if r.status in (403, 429) else 'unavailable', retryable=True, reason=str(r.status))

class DriveAuth:
    """OAuth 2.0 device flow for a TV/limited-input client, the token file and access-token refresh."""
    def __init__(self, path, client_id, client_secret, http, oauth_base=None, clock=time.time):
        self.path = Path(path)
        self._client_id, self._client_secret = client_id, client_secret
        self.http, self.clock = http, clock
        self.oauth_base = (oauth_base or oauth_base_url()).rstrip('/')
        self._lock = threading.RLock()
        self._device = None
        self._data = {}
        self.load()

    def __repr__(self): return 'DriveAuth(path=%r, connected=%r)' % (str(self.path), self.connected)

    @property
    def connected(self): return bool(self._data.get('refresh_token'))
    @property
    def folder_id(self): return self._data.get('folder_id')
    @property
    def storage_id(self): return self._data.get('storage_id')
    @property
    def interval(self): return self._device['interval'] if self._device else None

    def load(self):
        try: data = json.loads(self.path.read_text())
        except (OSError, ValueError): data = {}
        self._data = {k: data.get(k) for k in TOKEN_KEYS} if isinstance(data, dict) else {}
        return self.connected

    def save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        atomic_json(self.path, {k: self._data.get(k) for k in TOKEN_KEYS})

    def remember(self, *, folder_id=None, storage_id=None):
        with self._lock:
            if folder_id is not None: self._data['folder_id'] = folder_id
            if storage_id is not None: self._data['storage_id'] = storage_id
            self.save()

    def _post(self, path, form):
        return self.http.request('POST', self.oauth_base + path, headers={'Content-Type': 'application/x-www-form-urlencoded'},
                                 body=urllib.parse.urlencode(form).encode())

    def start_device_flow(self, scope=DRIVE_SCOPE):
        r = self._post('/device/code', {'client_id': self._client_id, 'scope': scope})
        body = r.json() if r.status == 200 else None
        if not isinstance(body, dict) or not body.get('device_code'):
            raise BackendError('auth_expired', reason=error_reason(r) or str(r.status))
        with self._lock:
            expires_at = self.clock() + int(body.get('expires_in', 1800))
            self._device = {'device_code': body['device_code'], 'expires_at': expires_at, 'interval': int(body.get('interval', 5))}
        return {'user_code': body['user_code'], 'verification_url': body['verification_url'], 'expires_at': expires_at, 'interval': self._device['interval']}

    def poll_once(self):
        """One token request; the caller waits `interval` seconds between polls."""
        with self._lock:
            d = self._device
            if d is None or self.clock() >= d['expires_at']:
                self._device = None
                return 'expired'
            r = self._post('/token', {'client_id': self._client_id, 'client_secret': self._client_secret,
                                      'device_code': d['device_code'], 'grant_type': DEVICE_GRANT})
            if r.status == 200:
                self._store(r.json() or {})
                self._device = None
                return 'granted'
            reason = error_reason(r)
            if reason == 'authorization_pending' or (reason is None and r.status == 428): return 'pending'
            if reason == 'slow_down':
                d['interval'] += 5
                return 'pending'
            self._device = None
            if reason == 'access_denied': return 'denied'
            if reason in ('expired_token', 'invalid_grant'): return 'expired'
            raise BackendError('auth_expired', reason=reason or str(r.status))

    def _store(self, body):
        if not body.get('access_token'): raise BackendError('auth_expired', reason='no_access_token')
        data = dict(self._data)  # Reconnecting keeps the folder binding.
        if body.get('refresh_token'): data['refresh_token'] = body['refresh_token']
        if not data.get('refresh_token'): raise BackendError('auth_expired', reason='no_refresh_token')
        data['access_token'] = body['access_token']
        data['expires_at'] = self.clock() + int(body.get('expires_in', 3600))
        data['scope'] = body.get('scope') or data.get('scope')
        self._data = {k: data.get(k) for k in TOKEN_KEYS}
        self.save()

    def access_token(self):
        with self._lock:
            if not self.connected: raise BackendError('auth_expired', reason='not_connected')
            if self._data.get('access_token') and (self._data.get('expires_at') or 0) - REFRESH_MARGIN > self.clock():
                return self._data['access_token']
            r = self._post('/token', {'client_id': self._client_id, 'client_secret': self._client_secret,
                                      'refresh_token': self._data['refresh_token'], 'grant_type': 'refresh_token'})
            if r.status == 200:
                self._store(r.json() or {})
                return self._data['access_token']
            reason = error_reason(r)
            # invalid_grant (revoked/expired), 401 invalid_client, 403 access_denied: only reconnecting helps.
            if r.status in (400, 401, 403): raise BackendError('auth_expired', reason=reason or str(r.status))
            raise BackendError('unavailable', retryable=True, reason=reason or str(r.status))

    def disconnect(self):
        with self._lock:
            token = self._data.get('refresh_token') or self._data.get('access_token')
            if token:
                try: self._post('/revoke', {'token': token}).close()
                except BackendError: pass  # Forgetting locally still disconnects; the grant can be removed at Google.
            self._data, self._device = {}, None
            try: self.path.unlink()
            except FileNotFoundError: pass
