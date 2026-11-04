"""Archive backends: the HTTP client with backoff, Google Drive device-flow auth, the Drive client and the
Drive/NAS backends behind one interface (standard library only)."""
import hashlib, http.client, io, json, os, random, re, ssl, threading, time, uuid
import urllib.error, urllib.parse, urllib.request
from dataclasses import dataclass
from pathlib import Path
from storage_policy import atomic_json
import media_store

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

    def backoff(self, attempt): self.sleep(min(2 ** attempt + self.rand(), 64))

    def request(self, method, url, *, headers=None, body=None, stream=False, timeout=TIMEOUT, retry=True, idempotent=False):
        """retry=False makes one attempt: for requests that must not be resent blindly (files.create, a session's
        chunk PUT); the caller finds out what happened instead (find(), the session's status). idempotent=True
        also retries socket errors and timeouts with the same backoff."""
        attempts = self.attempts if retry else 1
        for attempt in range(attempts):
            last = attempt + 1 >= attempts
            try: r = self._once(method, url, headers, body, stream, timeout)
            except BackendError:
                if not idempotent or last: raise
                self.backoff(attempt)
                continue
            reason = error_reason(r) if r.status == 403 else None
            if reason == 'storageQuotaExceeded': raise BackendError('quota_exceeded', reason=reason)
            if r.status not in RETRY_STATUS and reason not in RATE_REASONS: return r
            r.close()
            if not last: self.backoff(attempt)
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

    def expire(self):
        # Drive answered 401 to this access token: the next access_token() refreshes it.
        with self._lock: self._data['access_token'] = None

    def disconnect(self):
        with self._lock:
            token = self._data.get('refresh_token') or self._data.get('access_token')
            if token:
                try: self._post('/revoke', {'token': token}).close()
                except BackendError: pass  # Forgetting locally still disconnects; the grant can be removed at Google.
            self._data, self._device = {}, None
            try: self.path.unlink()
            except FileNotFoundError: pass

# --- Shared types ---
FOLDER_MIME = 'application/vnd.google-apps.folder'
CHUNK = 2**20  # Resumable chunks must be multiples of 256 KiB, except the last.
CACHE_SECONDS = media_store.CACHE_SECONDS
FILE_FIELDS = 'id,size,sha256Checksum,md5Checksum,appProperties'
# A 403 that only reconnecting fixes (scope removed, app no longer authorized).
AUTH_REASONS = ('insufficientPermissions', 'authError', 'access_denied', 'forbidden')

@dataclass(frozen=True)
class Capabilities:
    kind: str             # 'smb' | 'gdrive'
    local_paths: bool     # files can be opened by path
    checksum: tuple       # checksums the server reports; () means re-read
    range_reads: bool
    atomic_rename: bool   # Drive: completing the session is the atomic point
    remote_cleanup: bool  # automatic remote deletion allowed

@dataclass
class RemoteRef:  # 1:1 with the index's `remote` block. SMB: file_id is '<id>/<kind>'.
    backend: str
    file_id: str | None
    bytes: int
    sha256: str | None
    md5: str | None

@dataclass
class RemoteStat:
    exists: bool
    bytes: int
    sha256: str | None
    md5: str | None
    trashed: bool

@dataclass
class Usage:
    used: int
    free: int | None
    limit: int | None
    reliable: bool

def _int_or(value, default=None):
    try: return int(value)
    except (TypeError, ValueError): return default

def _q(value):
    return str(value).replace('\\', '\\\\').replace("'", "\\'")

def _fail(r):
    reason = error_reason(r) or str(r.status)
    r.close()
    if r.status == 401 or r.status == 403 and reason in AUTH_REASONS: return BackendError('auth_expired', reason=reason)
    if r.status in (404, 410): return BackendError('not_found', reason=reason)
    return BackendError('io', reason=reason)

def _received_end(r):
    # 308 `Range: bytes=0-N` -> N; no header -> nothing received yet.
    m = re.fullmatch(r'bytes=0-(\d+)', (r.headers.get('Range') or '').strip())
    return int(m.group(1)) if m else -1

def _stage(chunks, dest, sha256, size):
    # Writes to `<dest>.part`, hashing as it goes; only a verified copy is renamed into place. Without a
    # sha256 the byte count is the only check, and a copy that fails it is never moved into place.
    dest = Path(dest)
    part = dest.with_suffix(dest.suffix + '.part')
    h, count = hashlib.sha256(), 0
    try:
        with open(part, 'wb') as f:
            for chunk in chunks: h.update(chunk); f.write(chunk); count += len(chunk)
        if sha256:
            if h.hexdigest() != sha256: raise BackendError('mismatch', reason='sha256')
        elif size is None or count != size: raise BackendError('mismatch', reason='no_checksum')
        os.replace(part, dest)
    except BaseException as e:
        try: part.unlink()
        except OSError: pass
        if isinstance(e, OSError): raise BackendError('io', reason=type(e).__name__) from None
        raise

class _SessionExpired(Exception): pass

class DriveClient:
    """Drive v3 calls. Token handling: one refresh on 401, then auth_expired. Session URIs are credentials:
    they never reach an exception (Http drops URLs)."""
    def __init__(self, http, auth, api_base=None, upload_base=None):
        self.http, self.auth = http, auth
        self.api_base = (api_base or api_base_url()).rstrip('/') + '/drive/v3'
        self.upload_base = (upload_base or upload_base_url()).rstrip('/') + '/drive/v3'

    def __repr__(self): return 'DriveClient()'

    def _request(self, method, url, *, headers=None, body=None, stream=False, retry=True, idempotent=False, token=True):
        for attempt in (0, 1):
            h = dict(headers or {})
            if token: h['Authorization'] = 'Bearer ' + self.auth.access_token()
            r = self.http.request(method, url, headers=h, body=body, stream=stream, retry=retry, idempotent=idempotent)
            if r.status != 401 or not token or attempt: return r
            r.close()
            self.auth.expire()  # A 401 rejected the request unprocessed, so sending it again is safe.
        return r

    def _url(self, path, **params):
        return self.api_base + path + ('?' + urllib.parse.urlencode(params) if params else '')

    def _file(self, file_id, **params): return self._url('/files/' + urllib.parse.quote(file_id, safe=''), **params)

    def get(self, file_id, fields):
        r = self._request('GET', self._file(file_id, fields=fields), idempotent=True)
        if r.status == 404: r.close(); return None
        if r.status != 200: raise _fail(r)
        return r.json() or {}

    def list(self, q, fields):
        found, token = [], None
        while True:
            params = {'q': q, 'fields': 'nextPageToken,' + fields, 'spaces': 'drive', 'pageSize': '1000'}
            if token: params['pageToken'] = token
            r = self._request('GET', self._url('/files', **params), idempotent=True)
            if r.status != 200: raise _fail(r)
            body = r.json() or {}
            found += [f for f in body.get('files') or [] if isinstance(f, dict)]
            token = body.get('nextPageToken')
            if not token: return found

    def create_folder(self, name, app_props):
        # Not retried: after a failure the caller looks the folder up by its appProperties.
        r = self._request('POST', self.api_base + '/files?fields=id', headers={'Content-Type': 'application/json; charset=UTF-8'},
                          body=json.dumps({'name': name, 'mimeType': FOLDER_MIME, 'appProperties': app_props}).encode(), retry=False)
        if r.status != 200: raise _fail(r)
        file_id = (r.json() or {}).get('id')
        if not file_id: raise BackendError('io', reason='no_file_id')
        return file_id

    def start_resumable(self, name, parents, app_props, size):
        # A session holds nothing until completed, so starting one again is harmless.
        url = self.upload_base + '/files?' + urllib.parse.urlencode({'uploadType': 'resumable', 'fields': FILE_FIELDS})
        r = self._request('POST', url, headers={'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': 'application/octet-stream',
                                                'X-Upload-Content-Length': str(size)},
                          body=json.dumps({'name': name, 'parents': parents, 'appProperties': app_props}).encode())
        if r.status != 200: raise _fail(r)
        r.close()
        session = r.headers.get('Location')
        if not session: raise BackendError('io', reason='no_session')
        return session

    def _session(self, r):
        if r.status == 308: r.close(); return 'incomplete', _received_end(r)
        if r.status in (200, 201): return 'done', r.json() or {}
        if r.status in (404, 410): r.close(); return 'expired', None
        raise _fail(r)

    def put_chunk(self, session, data, start, total):
        """('incomplete', last received byte | -1) | ('done', file metadata) | ('expired', None). Not retried:
        after an error the caller asks session_status() how far the upload got."""
        rng = 'bytes %d-%d/%d' % (start, start + len(data) - 1, total) if data else 'bytes */%d' % total
        return self._session(self._request('PUT', session, headers={'Content-Range': rng}, body=data, retry=False, token=False))

    def session_status(self, session, total):
        return self._session(self._request('PUT', session, headers={'Content-Range': 'bytes */%d' % total}, idempotent=True, token=False))

    def download(self, file_id, start=None, end=None):
        headers = {} if start is None else {'Range': 'bytes=%d-%s' % (start, '' if end is None else end)}
        r = self._request('GET', self._file(file_id, alt='media'), headers=headers, stream=True, idempotent=True)
        if r.status == 416: r.close(); raise BackendError('io', reason='range_not_satisfiable')
        if r.status not in (200, 206): raise _fail(r)
        # A range answered with the whole file must not be streamed as if it were the range.
        if start is not None and r.status != 206: r.close(); raise BackendError('io', reason='range_ignored')
        return r

    def delete(self, file_id):
        # Resending is safe: a delete that went through answers 404 the second time.
        r = self._request('DELETE', self._file(file_id), idempotent=True)
        if r.status in (200, 204, 404): r.close(); return True
        raise _fail(r)

    def about(self):
        r = self._request('GET', self._url('/about', fields='storageQuota'), idempotent=True)
        if r.status != 200: raise _fail(r)
        return (r.json() or {}).get('storageQuota') or {}


class _Availability:
    """The ArchiveStore pattern: a probe result is reused for CACHE_SECONDS; while a probe is in flight other
    callers get 'checking' instead of waiting or trusting a stale answer."""
    def _init_cache(self, clock):
        self.clock, self.lock = clock, threading.Lock()
        self.cached = self.usage_cached = None

    def _enabled(self): return getattr(self.settings, 'enabled', True)

    def probe(self):
        if not self._enabled(): return 'disabled', getattr(self.settings, 'error', None)
        cached = self.cached
        if cached and self.clock() - cached[0] < CACHE_SECONDS: return cached[1:]
        if not self.lock.acquire(blocking=False): return 'checking', 'probe_pending'
        try:
            cached = self.cached
            if cached and self.clock() - cached[0] < CACHE_SECONDS: return cached[1:]
            result = self._probe()
            self.cached = (self.clock(), *result)
            return result
        finally: self.lock.release()

    def last_state(self):
        # Cache only, for callers holding the server lock; None when stale.
        if not self._enabled(): return 'disabled'
        cached = self.cached
        return cached[1] if cached and self.clock() - cached[0] < CACHE_SECONDS else None

    def last_result(self):
        # (state, reason) from the cache only; None when stale.
        if not self._enabled(): return 'disabled', getattr(self.settings, 'error', None)
        cached = self.cached
        return tuple(cached[1:]) if cached and self.clock() - cached[0] < CACHE_SECONDS else None

    def invalidate(self): self.cached = self.usage_cached = None


class DriveBackend(_Availability):
    caps = Capabilities('gdrive', local_paths=False, checksum=('sha256', 'md5'), range_reads=True, atomic_rename=False, remote_cleanup=False)

    def __init__(self, settings, root, auth, client, clock=time.monotonic):
        self.settings, self.root, self.auth, self.client = settings, Path(root), auth, client
        self._init_cache(clock)

    def __repr__(self): return 'DriveBackend(connected=%r)' % self.auth.connected

    # The same local copy file the NAS uses, under its own key: a NAS-era "storage_id" is the share's
    # identity, not Drive's, and switching backends keeps the other one's key.
    LOCAL_KEY = 'gdrive_storage_id'

    def _read_local_ids(self):
        try: data = json.loads((self.root / media_store.LOCAL_COPY).read_text())
        except (OSError, ValueError): return {}
        return data if isinstance(data, dict) else {}

    def _write_local_id(self, key, value):
        # Merged into what is there, so other keys in the file survive.
        atomic_json(self.root / media_store.LOCAL_COPY, {**self._read_local_ids(), key: value})

    def storage_id(self):
        value = self._read_local_ids().get(self.LOCAL_KEY)
        return value if isinstance(value, str) and value else None

    def _probe(self):
        if not self.auth.connected: return 'unavailable', 'not_connected'
        folder_id = self.auth.folder_id
        if not folder_id: return 'unavailable', 'folder_missing'
        try: folder = self.client.get(folder_id, 'trashed,appProperties')
        except BackendError as e: return 'unavailable', 'network' if e.code == 'unavailable' else e.code
        # 404: deleted for good, or reconnected with an account that cannot see it.
        if folder is None: return 'unavailable', 'folder_missing'
        if folder.get('trashed'): return 'unavailable', 'folder_trashed'
        local = self.storage_id()
        if local is None or (folder.get('appProperties') or {}).get('rv_storage_id') != local: return 'unavailable', 'storage_id_mismatch'
        return 'connected', None

    def _find_folder(self, storage_id):
        q = "appProperties has { key='rv_storage_id' and value='%s' } and mimeType='%s' and trashed=false" % (_q(storage_id), FOLDER_MIME)
        # Several (a create retried by hand, a lagging list): always the oldest, so every caller picks the same.
        found = [f for f in self.client.list(q, 'files(id,createdTime)') if f.get('id')]
        return [f['id'] for f in sorted(found, key=lambda f: (f.get('createdTime') or '', f['id']))]

    def activate(self):
        """Creates the folder only on a fresh setup (no folder bound, no local storage id). Otherwise only
        verifies; a folder whose binding was lost (disconnect) is found again by its storage id, never recreated."""
        if not self._enabled() or not self.auth.connected: return
        self.invalidate()
        try:
            if not self.auth.folder_id:
                local = self.storage_id()
                storage_id = local or self.auth.storage_id
                found = self._find_folder(storage_id) if storage_id else []
                if not found and storage_id and local is None:
                    # About to create: a folder whose create answer was lost may not be listed yet, so look once more.
                    self.client.http.backoff(0)
                    found = self._find_folder(storage_id)
                if found: folder_id = found[0]
                elif local is None:
                    if storage_id is None:
                        # Recorded before the create: a create whose answer was lost is found next time.
                        storage_id = uuid.uuid4().hex
                        self.auth.remember(storage_id=storage_id)
                    name = getattr(self.settings, 'gdrive_folder_name', '') or 'Road Viewer'
                    folder_id = self.client.create_folder(name, {'rv_storage_id': storage_id})
                else: folder_id = None  # Our id but no folder carrying it: stays unavailable.
                if folder_id:
                    if local is None: self._write_local_id(self.LOCAL_KEY, storage_id)
                    self.auth.remember(folder_id=folder_id, storage_id=storage_id)
        except (BackendError, OSError): pass  # Stays unavailable; the next probe reports why.
        self.invalidate()

    def _ref(self, meta):
        return RemoteRef('gdrive', meta.get('id'), _int_or(meta.get('size'), 0), meta.get('sha256Checksum') or None, meta.get('md5Checksum') or None)

    def stat(self, ref):
        meta = self.client.get(ref.file_id, 'id,size,sha256Checksum,md5Checksum,trashed')
        if meta is None: return None
        trashed = bool(meta.get('trashed'))
        return RemoteStat(not trashed, _int_or(meta.get('size'), 0), meta.get('sha256Checksum') or None, meta.get('md5Checksum') or None, trashed)

    def find(self, id, kind):
        local, folder_id = self.storage_id(), self.auth.folder_id
        if not local or not folder_id: return []
        q = ("appProperties has { key='rv_id' and value='%s' } and appProperties has { key='rv_kind' and value='%s' } "
             "and trashed=false and '%s' in parents") % (_q(id), _q(kind), _q(folder_id))
        return [self._ref(f) for f in self.client.list(q, 'files(%s)' % FILE_FIELDS)
                if (f.get('appProperties') or {}).get('rv_storage_id') == local]

    def upload(self, local, id, kind, sha256, md5, size, resume=None, on_progress=None):
        """Resumable upload in 1 MiB chunks. `resume` ({session, bytes_sent, sha256, size} from an earlier attempt,
        or {}) is updated in place before every on_progress(bytes_sent) call so the caller can persist it; a
        session recorded for another sha256/size is discarded. Returns the completed file's ref; verify() is a
        separate step."""
        folder_id, storage_id = self.auth.folder_id, self.storage_id()
        if not folder_id or not storage_id: raise BackendError('unavailable', reason='folder_missing')
        resume = resume if resume is not None else {}
        session, offset = resume.get('session'), 0
        # A session's rv_sha256 was fixed when it started: one made for other content is never asked or continued.
        if session and (resume.get('sha256') != sha256 or resume.get('size', size) != size):
            session = None
            resume.update(session=None, bytes_sent=0)
        if session:
            state, value = self.client.session_status(session, size)
            if state == 'done': return self._completed(value, size, resume, on_progress)
            if state == 'incomplete': offset = value + 1
            else: session = None
        props = {'rv_id': id, 'rv_kind': kind, 'rv_sha256': sha256 or '', 'rv_storage_id': storage_id}
        for _ in range(2):  # One fresh session if the current one expires part-way.
            if not session:
                session, offset = self.client.start_resumable('%s--%s' % (id, kind), [folder_id], props, size), 0
                resume.update(session=session, bytes_sent=0, sha256=sha256, size=size)
                if on_progress: on_progress(0)
            try: meta = self._send(local, session, offset, size, sha256, md5, resume, on_progress)
            except _SessionExpired: session = None; continue
            except BackendError as e:
                # The session carries the old rv_sha256: drop it so a persisted resume cannot complete it later.
                if e.reason == 'local_changed': resume.update(session=None, bytes_sent=0)
                raise
            return self._completed(meta, size, resume, on_progress)
        raise BackendError('unavailable', retryable=True, reason='session_expired')

    def session_status(self, resume):
        """'done' | 'incomplete' | 'expired' for a persisted upload (the index's remote_pending). One status
        query; nothing is sent. A record without a session or size has nothing to resume: 'expired'."""
        session, size = (resume or {}).get('session'), (resume or {}).get('size')
        if not isinstance(session, str) or not session or type(size) is not int: return 'expired'
        return self.client.session_status(session, size)[0]

    def _completed(self, meta, size, resume, on_progress):
        ref = self._ref(meta)
        if not ref.file_id: raise BackendError('io', reason='no_file_id')
        if ref.bytes != size: raise BackendError('mismatch', reason='size')
        resume['bytes_sent'] = size
        if on_progress: on_progress(size)
        return ref

    def _send(self, local, session, offset, size, sha256, md5, resume, on_progress):
        # The file is read once: the part the session already holds is only hashed, the rest hashed and sent.
        # The whole file is read and checked before the last chunk goes out, so a session carrying a wrong
        # rv_sha256 is never completed: an uncompleted session commits nothing.
        h256, hmd5, checked = hashlib.sha256(), hashlib.md5(), False
        try: f = open(local, 'rb')
        except OSError as e: raise BackendError('io', reason=type(e).__name__) from None
        with f:
            read = 0
            while read < offset:
                data = f.read(min(CHUNK, offset - read))
                if not data: raise BackendError('io', reason='local_shrank')
                h256.update(data); hmd5.update(data); read += len(data)
            sent, buf, stalls = offset, b'', 0
            while True:
                while len(buf) < CHUNK and read < size:
                    data = f.read(min(CHUNK - len(buf), size - read))
                    if not data: raise BackendError('io', reason='local_shrank')
                    h256.update(data); hmd5.update(data); buf += data; read += len(data)
                if read == size and not checked:
                    if f.read(1) or sha256 and h256.hexdigest() != sha256 or md5 and hmd5.hexdigest() != md5:
                        raise BackendError('mismatch', reason='local_changed')
                    checked = True
                try: state, value = self.client.put_chunk(session, buf, sent, size)
                except BackendError as e:
                    if e.code not in ('unavailable', 'rate_limited'): raise
                    # The chunk may or may not have arrived: ask the session rather than resending blindly.
                    state, value = self.client.session_status(session, size)
                if state == 'expired': raise _SessionExpired()
                if state == 'done': return value
                end = value + 1
                if not sent <= end <= sent + len(buf): raise BackendError('io', reason='bad_range')
                if end == sent:
                    stalls += 1
                    if stalls >= self.client.http.attempts: raise BackendError('unavailable', retryable=True, reason='no_progress')
                    self.client.http.backoff(stalls - 1)
                else: stalls = 0
                buf, sent = buf[end - sent:], end
                resume['bytes_sent'] = sent
                if on_progress: on_progress(sent)

    def verify(self, ref, sha256, size, md5=None):
        meta = self.client.get(ref.file_id, 'size,sha256Checksum,md5Checksum,trashed')
        if meta is None or meta.get('trashed'): raise BackendError('not_found')
        if size is not None and _int_or(meta.get('size')) != size: return 'mismatch'
        if meta.get('sha256Checksum') and sha256: return 'ok' if meta['sha256Checksum'] == sha256 else 'mismatch'
        if meta.get('md5Checksum') and md5: return 'ok' if meta['md5Checksum'] == md5 else 'mismatch'
        return 'unverifiable'

    def open(self, ref, start=0, end=None):
        # The request is made now, so a missing file or a bad range raises here rather than on the first chunk.
        r = self.client.download(ref.file_id, None if not start and end is None else start, end)
        return r.iter_chunks(CHUNK)

    def download_to(self, ref, dest, sha256): _stage(self.open(ref), dest, sha256 or ref.sha256, ref.bytes)

    def delete(self, ref):
        """True: deleted or already gone (confirmed). False: unsure (network, auth). Only a media file of ours
        is deleted; anything else (another instance's file, our folder, a file without rv_id) raises
        BackendError('io', reason='foreign_file')."""
        try:
            if not ref.file_id or ref.file_id == self.auth.folder_id: raise BackendError('io', reason='foreign_file')
            meta = self.client.get(ref.file_id, 'appProperties,trashed,mimeType')
            if meta is None: return True
            local, props = self.storage_id(), meta.get('appProperties') or {}
            if not local or props.get('rv_storage_id') != local or not props.get('rv_id') or meta.get('mimeType') == FOLDER_MIME:
                raise BackendError('io', reason='foreign_file')
            return self.client.delete(ref.file_id)
        except BackendError as e:
            if e.reason == 'foreign_file': raise
            return False

    def usage(self):
        cached = self.usage_cached
        if cached and self.clock() - cached[0] < CACHE_SECONDS: return cached[1]
        quota = self.client.about()
        usage, limit = _int_or(quota.get('usage'), 0), _int_or(quota.get('limit')) or None
        result = Usage(used=_int_or(quota.get('usageInDrive'), usage), free=max(limit - usage, 0) if limit else None, limit=limit, reliable=bool(limit))
        self.usage_cached = (self.clock(), result)
        return result


class SmbBackend:
    """The NAS behind the Backend interface. State, capacity and deletion go to ArchiveStore; NAS archiving
    itself keeps using Archiver.archive_file, so the path-based upload/verify/open here are minimal."""
    caps = Capabilities('smb', local_paths=True, checksum=(), range_reads=True, atomic_rename=True, remote_cleanup=True)

    def __init__(self, store): self.store = store
    def __repr__(self): return 'SmbBackend()'

    def probe(self): return self.store._check()
    def last_state(self): return self.store.last_state()
    def invalidate(self): self.store.invalidate()
    def storage_id(self): return self.store.local_id()
    def activate(self): self.store.activate()

    def usage(self):
        used, free = self.store.usage()
        return Usage(used=used, free=free, limit=None, reliable=self.store.last_state() == 'connected')

    def _path(self, ref):
        if not self.store.available(): raise BackendError('unavailable', reason='share')
        id, _, kind = (ref.file_id or '').partition('/')
        if id in ('', '.', '..'): raise BackendError('io', reason='bad_ref')
        try: return self.store.path_for(id, kind)
        except ValueError: raise BackendError('io', reason='bad_ref') from None

    def stat(self, ref):
        path = self._path(ref)
        try: st = path.stat()
        except FileNotFoundError: return None
        except OSError as e: raise BackendError('unavailable', reason=type(e).__name__) from None
        return RemoteStat(True, st.st_size, None, None, False)

    def find(self, id, kind):
        ref = RemoteRef('smb', '%s/%s' % (id, kind), 0, None, None)
        st = self.stat(ref)
        if st is None: return []
        ref.bytes = st.bytes
        return [ref]

    def upload(self, local, id, kind, sha256, md5, size, resume=None, on_progress=None):
        ref = RemoteRef('smb', '%s/%s' % (id, kind), size, sha256, md5)
        dest = self._path(ref)
        try:
            dest.parent.mkdir(parents=True, exist_ok=True)
            f = open(local, 'rb')
        except OSError as e: raise BackendError('io', reason=type(e).__name__) from None
        sent = 0
        def chunks():
            nonlocal sent
            with f:
                while data := f.read(CHUNK):
                    sent += len(data)
                    if on_progress: on_progress(sent)
                    yield data
            # Raised inside the staging, so a short or long copy never reaches its final name.
            if sent != size: raise BackendError('mismatch', reason='size')
        _stage(chunks(), dest, sha256, size)
        return ref

    def verify(self, ref, sha256, size, md5=None):
        st = self.stat(ref)
        if st is None: raise BackendError('not_found')
        if size is not None and st.bytes != size: return 'mismatch'
        if not sha256: return 'unverifiable'
        h = hashlib.sha256()
        for chunk in self.open(ref): h.update(chunk)
        return 'ok' if h.hexdigest() == sha256 else 'mismatch'

    def open(self, ref, start=0, end=None):
        path = self._path(ref)
        try: f = open(path, 'rb')
        except FileNotFoundError: raise BackendError('not_found') from None
        except OSError as e: raise BackendError('unavailable', reason=type(e).__name__) from None
        def chunks():
            with f:
                f.seek(start)
                left = None if end is None else end - start + 1
                while left is None or left > 0:
                    try: data = f.read(CHUNK if left is None else min(CHUNK, left))
                    except OSError as e: raise BackendError('unavailable', reason=type(e).__name__) from None
                    if not data: return
                    if left is not None: left -= len(data)
                    yield data
        return chunks()

    def download_to(self, ref, dest, sha256): _stage(self.open(ref), dest, sha256 or ref.sha256, ref.bytes)

    def delete(self, ref):
        id, _, kind = (ref.file_id or '').partition('/')
        if id in ('', '.', '..') or kind not in media_store.MEDIA_KINDS: raise BackendError('io', reason='bad_ref')
        _removed, failed = media_store.delete_archived(self.store, id, [kind])
        return not failed


def make_backend(settings, root, store=None, auth=None, http=None):
    if getattr(settings, 'backend', 'smb') == 'gdrive':
        http = http or Http()
        auth = auth or DriveAuth(Path(root) / '.gdrive-auth.json', getattr(settings, 'gdrive_client_id', '') or '',
                                 getattr(settings, 'gdrive_client_secret', '') or '', http)
        return DriveBackend(settings, root, auth, DriveClient(http, auth))
    return SmbBackend(store if store is not None else media_store.ArchiveStore(settings, root))
