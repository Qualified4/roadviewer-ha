"""A small, deterministic stand-in for Google's OAuth device flow and the Drive v3 API.

Usage:
    with FakeDrive() as drive:          # binds 127.0.0.1 on a free port and serves in a thread
        os.environ.update(drive.env())  # RV_GDRIVE_API_BASE / RV_GDRIVE_UPLOAD_BASE / RV_GDRIVE_OAUTH_BASE
        ...
    # Leaving the block shuts the server down and joins its thread.

State (guard with `drive.lock` when touching it from a test while requests may be in flight):
    files     {id: {name, mimeType, parents, appProperties, content(bytes), trashed, md5, sha256[, created]}}
    sessions  {upload_id: {received(bytes), total(int|None), file_meta(dict), file_id(str|None)}}
    access_tokens / refresh_tokens   sets of currently valid tokens; revoked: tokens posted to /revoke
    requests  [{method, path, headers}] in arrival order

Endpoints:
    POST /device/code                 -> {device_code, user_code, verification_url, expires_in, interval}
    POST /token  (device_code grant)  -> next item of scenario.device_poll_responses, or a grant when empty
    POST /token  (refresh_token)      -> new access token, or 400 invalid_grant for an unknown refresh token
    POST /revoke                      -> drops the token (and, for a refresh token, every access token)
    GET  /drive/v3/files?q=           -> list; q understands `appProperties has { key='k' and value='v' }`,
                                         `'<id>' in parents`, `trashed=true|false`, `name='x'`, `mimeType='x'`
    POST /drive/v3/files              -> create from JSON metadata (folders, empty files)
    GET  /drive/v3/files/{id}         -> metadata; `alt=media` returns content, `Range: bytes=a-b` -> 206
    PATCH/DELETE /drive/v3/files/{id} -> update metadata (name, appProperties, trashed, add/removeParents) / 204
    POST /upload/drive/v3/files?uploadType=resumable -> 200 with `Location: <session uri>`
    PUT  <session uri>                -> `Content-Range: bytes a-b/N` appends; `bytes */N` asks for status.
                                         Incomplete -> 308 (+ `Range: bytes=0-<end>` once bytes arrived);
                                         complete -> 200 {id, name, size, sha256Checksum, md5Checksum, appProperties}
    GET  /drive/v3/about              -> {storageQuota: {usage, usageInDrive[, limit]}}
Drive endpoints answer 401 unless `Authorization: Bearer <valid access token>` is sent
(scenario.require_auth = False turns that off); PUTs to a session URI need no token, as at Google.

Scenario (`drive.scenario`):
    fail_next(path_substring, status, reason=None, times=1, headers=None)
        The next `times` requests whose path contains `path_substring` get `status` with a Google-shaped
        error body (`{"error": reason}` on OAuth paths, `{"error": {"code", "message", "errors": [{"reason"}]}}`
        elsewhere) plus any extra `headers` (e.g. a redirect `Location`).
    device_poll_responses  list of 'authorization_pending' | 'slow_down' | 'access_denied' | 'expired_token'
                           | 'granted', consumed one per device-code poll
    delay_seconds          sleep before handling each request (timeouts); drive.most_waiting counts the most
                           requests sleeping at once (round trips that overlap)
    quota_limit            None (no limit reported) or bytes; completing an upload past it -> 403 storageQuotaExceeded
    lose_completion_response  store the completed upload, then close the socket without answering (once)
    list_lag               the next N files.list calls answer an empty list (a create not yet visible to search)
    access_expires_in, device_expires_in, device_interval   numbers handed out by the OAuth endpoints
"""
import hashlib, json, re, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

FOLDER = 'application/vnd.google-apps.folder'
OAUTH_PATHS = ('/device/code', '/token', '/revoke')
DEVICE_ERRORS = {'authorization_pending': 428, 'slow_down': 403, 'access_denied': 403, 'expired_token': 400}


class Scenario:
    def __init__(self):
        self.failures = []
        self.device_poll_responses = []
        self.delay_seconds = 0
        self.quota_limit = None
        self.lose_completion_response = False
        self.list_lag = 0
        self.require_auth = True
        self.access_expires_in = 3599
        self.device_expires_in = 1800
        self.device_interval = 5

    def fail_next(self, path_substring, status, reason=None, times=1, headers=None):
        self.failures.append({'path': path_substring, 'status': status, 'reason': reason, 'times': times, 'headers': headers or {}})

    def take_failure(self, path):
        for rule in self.failures:
            if rule['times'] > 0 and rule['path'] in path:
                rule['times'] -= 1
                return rule
        return None


def error_body(path, status, reason):
    if path.split('?')[0] in OAUTH_PATHS:
        return {'error': reason or 'error'}
    return {'error': {'code': status, 'message': reason or 'error', 'errors': [{'reason': reason or 'error', 'domain': 'global'}]}}


def file_json(file_id, f):
    out = {'kind': 'drive#file', 'id': file_id, 'name': f['name'], 'mimeType': f['mimeType'], 'parents': list(f['parents']),
           'appProperties': dict(f['appProperties']), 'trashed': f['trashed']}
    if f.get('created'): out['createdTime'] = f['created']
    if f['mimeType'] != FOLDER:
        out.update(size=str(len(f['content'])), md5Checksum=f['md5'], sha256Checksum=f['sha256'])
    return out


def matches(f, q):
    for key, value in re.findall(r"appProperties has \{\s*key='([^']*)' and value='([^']*)'\s*\}", q):
        if f['appProperties'].get(key) != value: return False
    for parent in re.findall(r"'([^']*)' in parents", q):
        if parent not in f['parents']: return False
    for value in re.findall(r'trashed\s*=\s*(true|false)', q):
        if f['trashed'] != (value == 'true'): return False
    for value in re.findall(r"\bname\s*=\s*'([^']*)'", q):
        if f['name'] != value: return False
    for value in re.findall(r"mimeType\s*=\s*'([^']*)'", q):
        if f['mimeType'] != value: return False
    return True


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *args): pass

    def do_GET(self): self.handle_any('GET')
    def do_POST(self): self.handle_any('POST')
    def do_PUT(self): self.handle_any('PUT')
    def do_PATCH(self): self.handle_any('PATCH')
    def do_DELETE(self): self.handle_any('DELETE')

    def send(self, status, body=None, headers=None):
        data = b'' if body is None else body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(status)
        if body is not None and not isinstance(body, bytes): self.send_header('Content-Type', 'application/json; charset=UTF-8')
        for key, value in (headers or {}).items(): self.send_header(key, value)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def handle_any(self, method):
        d = self.server
        length = int(self.headers.get('Content-Length') or 0)
        self.body = self.rfile.read(length) if length else b''
        with d.lock:
            d.requests.append({'method': method, 'path': self.path, 'headers': dict(self.headers)})
            delay = d.scenario.delay_seconds
            rule = d.scenario.take_failure(self.path)
        if delay:
            with d.lock: d.waiting += 1; d.most_waiting = max(d.most_waiting, d.waiting)
            try: time.sleep(delay)
            finally:
                with d.lock: d.waiting -= 1
        if rule:
            return self.send(rule['status'], error_body(self.path, rule['status'], rule['reason']), rule['headers'])
        url = urlsplit(self.path)
        self.query = {k: v[0] for k, v in parse_qs(url.query).items()}
        path = url.path
        if path in OAUTH_PATHS:
            if method != 'POST': return self.send(405)
            self.form = {k: v[0] for k, v in parse_qs(self.body.decode()).items()}
            return {'/device/code': self.device_code, '/token': self.token, '/revoke': self.revoke}[path]()
        # A resumable session URI is its own credential, as at Google.
        if d.scenario.require_auth and not (method == 'PUT' and 'upload_id' in self.query):
            auth = self.headers.get('Authorization', '')
            with d.lock: valid = auth.startswith('Bearer ') and auth[7:] in d.access_tokens
            if not valid: return self.send(401, error_body(path, 401, 'authError'))
        if path == '/drive/v3/about' and method == 'GET': return self.about()
        if path == '/drive/v3/files':
            if method == 'GET': return self.list_files()
            if method == 'POST': return self.create()
        m = re.fullmatch(r'/drive/v3/files/([^/]+)', path)
        if m:
            if method in ('GET', 'PATCH', 'DELETE'): return getattr(self, method.lower() + '_file')(m.group(1))
        if path == '/upload/drive/v3/files' and self.query.get('uploadType') == 'resumable':
            if method == 'POST' and 'upload_id' not in self.query: return self.start_session()
            if method == 'PUT' and 'upload_id' in self.query: return self.put_session(self.query['upload_id'])
        return self.send(404, error_body(path, 404, 'notFound'))

    # --- OAuth ---
    def device_code(self):
        d = self.server
        if not self.form.get('client_id'): return self.send(401, {'error': 'invalid_client'})
        with d.lock: d.device_code_count += 1; code = 'dc-%d' % d.device_code_count
        self.send(200, {'device_code': code, 'user_code': 'ABCD-EFGH', 'verification_url': 'https://www.google.com/device',
                        'expires_in': d.scenario.device_expires_in, 'interval': d.scenario.device_interval})

    def issue(self, refresh=None):
        d = self.server
        d.token_count += 1
        access = 'at-%d-secretaccess' % d.token_count
        d.access_tokens.add(access)
        body = {'access_token': access, 'expires_in': d.scenario.access_expires_in, 'token_type': 'Bearer',
                'scope': 'https://www.googleapis.com/auth/drive.file'}
        if refresh is None:
            refresh = 'rt-%d-secretrefresh' % d.token_count
            d.refresh_tokens.add(refresh)
            body['refresh_token'] = refresh
        d.issued[access] = refresh
        return body

    def token(self):
        d = self.server
        grant = self.form.get('grant_type')
        with d.lock:
            if grant == 'urn:ietf:params:oauth:grant-type:device_code':
                if not self.form.get('device_code', '').startswith('dc-'): return self.send(400, {'error': 'invalid_grant'})
                step = d.scenario.device_poll_responses.pop(0) if d.scenario.device_poll_responses else 'granted'
                if step != 'granted': return self.send(DEVICE_ERRORS[step], {'error': step})
                return self.send(200, self.issue())
            if grant == 'refresh_token':
                refresh = self.form.get('refresh_token')
                if refresh not in d.refresh_tokens: return self.send(400, {'error': 'invalid_grant', 'error_description': 'Token has been expired or revoked.'})
                return self.send(200, self.issue(refresh))
        self.send(400, {'error': 'unsupported_grant_type'})

    def revoke(self):
        d = self.server
        token = self.form.get('token') or self.query.get('token')
        with d.lock:
            d.revoked.append(token)
            if token in d.refresh_tokens:
                d.refresh_tokens.discard(token)
                d.access_tokens -= {a for a, r in d.issued.items() if r == token}
            elif token in d.access_tokens:
                d.access_tokens.discard(token)
            else:
                return self.send(400, {'error': 'invalid_token'})
        self.send(200, {})

    # --- Drive ---
    def json_body(self):
        return json.loads(self.body.decode() or '{}')

    def new_file(self, meta, content=b''):
        d = self.server
        d.file_count += 1
        file_id = 'f%d' % d.file_count
        d.files[file_id] = {'name': meta.get('name', 'Untitled'), 'mimeType': meta.get('mimeType', 'application/octet-stream'),
                            'parents': list(meta.get('parents') or []), 'appProperties': dict(meta.get('appProperties') or {}),
                            'content': content, 'trashed': False, 'md5': hashlib.md5(content).hexdigest(),
                            'sha256': hashlib.sha256(content).hexdigest(), 'created': '2026-11-03T00:00:00.%06dZ' % d.file_count}
        return file_id

    def used(self):
        return sum(len(f['content']) for f in self.server.files.values())

    def about(self):
        d = self.server
        with d.lock:
            quota = {'usage': str(self.used()), 'usageInDrive': str(self.used())}
            if d.scenario.quota_limit is not None: quota['limit'] = str(d.scenario.quota_limit)
        self.send(200, {'storageQuota': quota})

    def list_files(self):
        d = self.server
        q = self.query.get('q', '')
        with d.lock:
            found = [file_json(i, f) for i, f in d.files.items() if matches(f, q)]
            if d.scenario.list_lag > 0: d.scenario.list_lag -= 1; found = []
        self.send(200, {'kind': 'drive#fileList', 'files': found})

    def create(self):
        d = self.server
        with d.lock: file_id = self.new_file(self.json_body()); out = file_json(file_id, d.files[file_id])
        self.send(200, out)

    def get_file(self, file_id):
        d = self.server
        with d.lock:
            f = d.files.get(file_id)
            if f is None: return self.send(404, error_body(self.path, 404, 'notFound'))
            out, content = file_json(file_id, f), f['content']
        if self.query.get('alt') != 'media': return self.send(200, out)
        m = re.fullmatch(r'bytes=(\d+)-(\d*)', self.headers.get('Range', ''))
        if not m: return self.send(200, content, {'Content-Type': 'application/octet-stream'})
        start = int(m.group(1)); end = min(int(m.group(2)) if m.group(2) else len(content) - 1, len(content) - 1)
        if start >= len(content): return self.send(416, error_body(self.path, 416, 'requestedRangeNotSatisfiable'), {'Content-Range': 'bytes */%d' % len(content)})
        self.send(206, content[start:end + 1], {'Content-Type': 'application/octet-stream', 'Content-Range': 'bytes %d-%d/%d' % (start, end, len(content))})

    def patch_file(self, file_id):
        d = self.server
        meta = self.json_body()
        with d.lock:
            f = d.files.get(file_id)
            if f is None: return self.send(404, error_body(self.path, 404, 'notFound'))
            if 'name' in meta: f['name'] = meta['name']
            if 'trashed' in meta: f['trashed'] = bool(meta['trashed'])
            for key, value in (meta.get('appProperties') or {}).items():
                if value is None: f['appProperties'].pop(key, None)
                else: f['appProperties'][key] = value
            for parent in filter(None, self.query.get('removeParents', '').split(',')):
                if parent in f['parents']: f['parents'].remove(parent)
            for parent in filter(None, self.query.get('addParents', '').split(',')):
                if parent not in f['parents']: f['parents'].append(parent)
            out = file_json(file_id, f)
        self.send(200, out)

    def delete_file(self, file_id):
        d = self.server
        with d.lock:
            if d.files.pop(file_id, None) is None: return self.send(404, error_body(self.path, 404, 'notFound'))
        self.send(204)

    def start_session(self):
        d = self.server
        total = self.headers.get('X-Upload-Content-Length')
        with d.lock:
            d.session_count += 1
            upload_id = 'up%d-secretsession' % d.session_count
            d.sessions[upload_id] = {'received': b'', 'total': int(total) if total else None, 'file_meta': self.json_body(), 'file_id': None}
        self.send(200, None, {'Location': d.url + '/upload/drive/v3/files?uploadType=resumable&upload_id=' + upload_id})

    def put_session(self, upload_id):
        d = self.server
        header = self.headers.get('Content-Range', '')
        with d.lock:
            s = d.sessions.get(upload_id)
            if s is None: return self.send(404, error_body(self.path, 404, 'notFound'))
            if s['file_id'] is not None: return self.send(200, file_json(s['file_id'], d.files[s['file_id']]))
            status = re.fullmatch(r'bytes \*/(\d+|\*)', header)
            chunk = re.fullmatch(r'bytes (\d+)-(\d+)/(\d+|\*)', header)
            if status:
                total = None if status.group(1) == '*' else int(status.group(1))
            elif chunk:
                start, end = int(chunk.group(1)), int(chunk.group(2))
                total = None if chunk.group(3) == '*' else int(chunk.group(3))
                if start != len(s['received']) or end - start + 1 != len(self.body):
                    return self.send(400, error_body(self.path, 400, 'badContentRange'))
                s['received'] += self.body
            elif not header:
                s['received'] = self.body; total = len(self.body)
            else:
                return self.send(400, error_body(self.path, 400, 'badContentRange'))
            if total is not None: s['total'] = total
            if s['total'] is None or len(s['received']) < s['total']:
                headers = {'Range': 'bytes=0-%d' % (len(s['received']) - 1)} if s['received'] else {}
                return self.send(308, None, headers)
            limit = d.scenario.quota_limit
            if limit is not None and self.used() + len(s['received']) > limit:
                return self.send(403, error_body(self.path, 403, 'storageQuotaExceeded'))
            s['file_id'] = self.new_file(s['file_meta'], s['received'])
            out = file_json(s['file_id'], d.files[s['file_id']])
            lose = d.scenario.lose_completion_response
            d.scenario.lose_completion_response = False
        if lose:
            self.close_connection = True
            return
        self.send(200, out)


class FakeDrive(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self):
        super().__init__(('127.0.0.1', 0), Handler)
        self.url = 'http://127.0.0.1:%d' % self.server_address[1]
        self.lock = threading.Lock()
        self.scenario = Scenario()
        self.files, self.sessions, self.requests, self.revoked, self.issued = {}, {}, [], [], {}
        self.access_tokens, self.refresh_tokens = set(), set()
        self.file_count = self.session_count = self.token_count = self.device_code_count = 0
        self.waiting = self.most_waiting = 0  # requests sleeping out delay_seconds now / the most at once
        self.thread = None

    def handle_error(self, request, client_address):
        pass  # A client that timed out or hung up mid-answer is part of the scenario, not a failure.

    def env(self):
        return {'RV_GDRIVE_API_BASE': self.url, 'RV_GDRIVE_UPLOAD_BASE': self.url + '/upload', 'RV_GDRIVE_OAUTH_BASE': self.url}

    def start(self):
        self.thread = threading.Thread(target=self.serve_forever, kwargs={'poll_interval': 0.05}, daemon=True)
        self.thread.start()
        return self

    def stop(self):
        if self.thread:
            self.shutdown(); self.thread.join(5); self.thread = None
        self.server_close()

    def __enter__(self): return self.start()
    def __exit__(self, *exc): self.stop()
