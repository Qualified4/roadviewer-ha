"""Device-only HTTP contract. File transfer delegates to server's upload engine."""
import errno, hashlib, hmac, json, re, secrets, time
from collections import deque
from flask import request, jsonify, abort
from storage_policy import atomic_json, ROUTE

PAIR_TTL = 300
SESSION_TTL = 7200
CLOCK_SKEW = 120
NONCE = re.compile(r'^[A-Za-z0-9_-]{16,64}$')

class DeviceAPI:
    def __init__(self, s):
        self.s = s
        self.path = s.ROOT / '.devices.json'
        self.state = json.loads(self.path.read_text()) if self.path.exists() else {'master': secrets.token_hex(32), 'devices': {}, 'nonces': {}, 'receipts': {}}
        self.pairing = None
        self.attempts = deque()
        routes = [('/api/device/test', 'device_test_page', self.test_page, ['GET']),
                  ('/api/settings/devices', 'devices', self.manage, ['GET']),
                  ('/api/settings/devices/pairing', 'pairing', self.pairing_ui, ['GET', 'POST', 'DELETE']),
                  ('/api/settings/devices/<id>/revoke', 'revoke_device', self.revoke, ['POST']),
                  ('/api/device/pair', 'device_pair', self.pair, ['POST']),
                  ('/api/device/uploads', 'device_begin', self.begin, ['POST']),
                  ('/api/device/uploads/<id>', 'device_status', self.session, ['GET', 'DELETE']),
                  ('/api/device/uploads/<id>/files/<int:index>', 'device_chunk', self.chunk, ['PUT']),
                  ('/api/device/uploads/<id>/finish', 'device_finish', self.finish, ['POST'])]
        for path, name, fn, methods in routes: s.app.add_url_rule(path, name, fn, methods=methods)

    def test_page(self):
        response = self.s.send_from_directory(self.s.BASE/'web', 'device-test.html', conditional=False)
        response.headers['Content-Security-Policy'] = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
        response.headers['Referrer-Policy'] = 'no-referrer'
        response.headers['X-Content-Type-Options'] = 'nosniff'
        return response

    def save(self): atomic_json(self.path, self.state)

    def fail(self, code, status=400): return jsonify(error=code), status

    def secret(self, id): return hmac.new(bytes.fromhex(self.state['master']), ('roadviewer-device-v1:' + id).encode(), hashlib.sha256).hexdigest()

    def manage(self):
        with self.s.lock:
            return jsonify(enabled=self.s.options.get('device_api_enabled', False), devices=list(self.state['devices'].values()))

    def pairing_ui(self):
        with self.s.lock:
            if request.method == 'POST':
                self.pairing = {'code': secrets.token_hex(12).upper(), 'expires_at': time.time() + PAIR_TTL, 'status': 'waiting'}
            elif request.method == 'DELETE': self.pairing = None
            if self.pairing and self.pairing['expires_at'] <= time.time() and self.pairing['status'] == 'waiting': self.pairing = {'status': 'expired', 'expires_at': self.pairing['expires_at']}
            return jsonify(self.pairing or {'status': 'cancelled'})

    def pair(self):
        if (request.content_length or 0) > 4096: return self.fail('request_too_large', 413)
        body = request.get_json(silent=True)
        if not isinstance(body, dict): return self.fail('invalid_pairing_request')
        code = body.get('code'); metadata = body.get('metadata')
        if not isinstance(code, str) or not isinstance(metadata, dict) or set(metadata) - {'name', 'dongle_id'} or not isinstance(metadata.get('name'), str) or not 1 <= len(metadata['name'].strip()) <= 80 or ('dongle_id' in metadata and (not isinstance(metadata['dongle_id'], str) or len(metadata['dongle_id']) > 80)):
            return self.fail('invalid_pairing_request')
        with self.s.lock:
            now = time.time()
            while self.attempts and self.attempts[0] < now - 60: self.attempts.popleft()
            if len(self.attempts) >= 10: return self.fail('pairing_rate_limited', 429)
            self.attempts.append(now)
            p = self.pairing
            if not p or p['status'] != 'waiting' or p['expires_at'] <= now or not hmac.compare_digest(p['code'].encode(), code.encode()):
                return self.fail('invalid_pairing_code', 401)
            if len(self.state['devices']) >= 100: return self.fail('device_limit_reached', 409)
            id = secrets.token_hex(16)
            self.state['devices'][id] = dict(device_id=id, name=metadata['name'].strip(), dongle_id=metadata.get('dongle_id', ''), registered_at=now, last_seen=None, revoked=False)
            self.save()
            self.pairing = {'status': 'paired', 'expires_at': p['expires_at'], 'device_id': id}
            return jsonify(device_id=id, device_secret=self.secret(id), algorithm='HMAC-SHA256'), 201

    def revoke(self, id):
        with self.s.lock:
            device = self.state['devices'].get(id)
            if not device: return self.fail('device_not_found', 404)
            device['revoked'] = True; self.save()
            # Reject every subsequent session request, not just new sessions.
            for p in self.s.UPLOADS.iterdir():
                f = p / 'device.json'
                if f.is_file() and json.loads(f.read_text())['device_id'] == id and not self.s.active_uploads[p.name]:
                    self.s.shutil.rmtree(p)
        return jsonify(revoked=True)

    def authenticate(self):
        id = request.headers.get('X-RV-Device', '')
        stamp = request.headers.get('X-RV-Timestamp', '')
        nonce = request.headers.get('X-RV-Nonce', '')
        signature = request.headers.get('X-RV-Signature', '')
        if not re.fullmatch(r'[0-9]{10}', stamp) or not NONCE.fullmatch(nonce) or not re.fullmatch(r'[0-9a-f]{64}', signature): abort(401, description='invalid_authentication')
        now = time.time(); timestamp = int(stamp)
        if abs(now - timestamp) > CLOCK_SKEW: abort(401, description='stale_timestamp')
        if request.query_string: abort(400, description='unexpected_query')
        body_hash = hashlib.sha256(request.get_data()).hexdigest()
        canonical = '\n'.join(('RV1', id, stamp, nonce, request.method, request.path, body_hash))
        with self.s.lock:
            device = self.state['devices'].get(id)
            if not device or device['revoked']: abort(401, description='invalid_device')
            expected = hmac.new(self.secret(id).encode('ascii'), canonical.encode('utf-8'), hashlib.sha256).hexdigest()
            if not hmac.compare_digest(expected, signature): abort(401, description='invalid_signature')
            nonces = {k: expiry for k, expiry in self.state['nonces'].items() if expiry >= now}
            key = hashlib.sha256((id + ':' + nonce).encode()).hexdigest()
            if key in nonces: abort(409, description='nonce_replayed')
            if len(nonces) >= 10000: abort(429, description='authentication_rate_limited')
            nonces[key] = timestamp + CLOCK_SKEW + 1
            self.state['nonces'] = nonces
            self.state['receipts'] = {k: v for k, v in self.state['receipts'].items() if v['expires_at'] > now}
            device['last_seen'] = now; self.save()
        return id

    def batch_files(self, body):
        if not isinstance(body, dict) or set(body) != {'batch_id', 'segments'} or not isinstance(body['batch_id'], str) or not re.fullmatch(r'[A-Za-z0-9_-]{16,64}', body['batch_id']): abort(400, description='invalid_batch')
        segments = body['segments']
        if not isinstance(segments, list) or not 1 <= len(segments) <= 50: abort(400, description='invalid_segments')
        files = []; seen = set()
        for segment in segments:
            if not isinstance(segment, dict) or set(segment) != {'route', 'segment', 'files'}: abort(400, description='invalid_segment')
            route = segment['route']; number = segment['segment']; kinds = segment['files']
            if not isinstance(route, str) or not ROUTE.fullmatch(route) or type(number) is not int or not 0 <= number <= 999999 or not isinstance(kinds, list) or not 1 <= len(kinds) <= 2: abort(400, description='invalid_segment')
            if (route, number) in seen: abort(400, description='duplicate_segment')
            seen.add((route, number)); names = set()
            for f in kinds:
                if not isinstance(f, dict) or set(f) != {'kind', 'size', 'sha256'} or f.get('kind') not in ('rlog.zst', 'qcamera.ts') or type(f.get('size')) is not int or not 0 < f['size'] <= self.s.app.config['MAX_CONTENT_LENGTH'] or not isinstance(f.get('sha256'), str) or not re.fullmatch(r'[0-9a-f]{64}', f['sha256']): abort(400, description='invalid_file')
                if f['kind'] in names: abort(400, description='duplicate_file')
                names.add(f['kind']); files.append(dict(name=f'{route}--{number}--{f["kind"]}', size=f['size'], sha256=f['sha256']))
            if 'rlog.zst' not in names: abort(400, description='rlog_required')
        return files

    def begin(self):
        if (request.content_length or 0) > 65536: return self.fail('request_too_large', 413)
        id = self.authenticate()
        body = request.get_json(silent=True); files = self.batch_files(body)
        digest = hashlib.sha256(json.dumps(body, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        self.s.cleanup_uploads()
        with self.s.registration_lock, self.s.lock:
            if self.state['devices'][id]['revoked']: return self.fail('invalid_device', 401)
            for p in self.s.UPLOADS.iterdir():
                f = p / 'device.json'
                if not f.is_file(): continue
                old = json.loads(f.read_text())
                if old['device_id'] == id and old['batch_id'] == body['batch_id']:
                    if old['batch_hash'] != digest: return self.fail('batch_conflict', 409)
                    return self.issue_token(p, old)
            for receipt in self.state['receipts'].values():
                if receipt['device_id'] == id and receipt['batch_id'] == body['batch_id']:
                    if receipt['batch_hash'] != digest: return self.fail('batch_conflict', 409)
                    return jsonify(state='completed', result=receipt['result'])
            if len(self.state['receipts']) >= 256 or sum(1 for p in self.s.UPLOADS.iterdir() if (p/'device.json').is_file()) >= 32: return self.fail('session_limit_reached', 429)
            response, status = self.s.create_upload(files)
            if status != 201: return response, status
            p = self.s.UPLOADS / response.json['id']
            meta = dict(device_id=id, batch_id=body['batch_id'], batch_hash=digest, expires_at=time.time() + SESSION_TTL)
            return self.issue_token(p, meta, 201)

    def issue_token(self, p, meta, status=200):
        token = secrets.token_urlsafe(32); meta['token_hash'] = hashlib.sha256(token.encode()).hexdigest()
        atomic_json(p/'device.json', meta)
        return jsonify(id=p.name, token=token, expires_at=meta['expires_at'], idle_timeout_seconds=self.s.UPLOAD_IDLE_SECONDS, chunk_size=self.s.CHUNK_SIZE, files=self.offsets(p)), status

    def offsets(self, p):
        files = json.loads((p/'manifest.json').read_text())
        return [dict(index=i, name=f['name'], size=f['size'], received=(p/str(i)).stat().st_size if (p/str(i)).exists() else 0) for i, f in enumerate(files)]

    def authorize_session(self, id):
        if not self.s.ID.fullmatch(id): abort(404, description='session_not_found')
        token = request.headers.get('Authorization', '')
        if not token.startswith('Bearer ') or not 20 <= len(token) <= 100: abort(401, description='invalid_upload_token')
        p = self.s.UPLOADS/id; f = p/'device.json'
        meta = json.loads(f.read_text()) if f.is_file() else self.state['receipts'].get(id)
        if not meta: abort(404, description='session_not_found')
        device = self.state['devices'].get(meta['device_id'])
        if not device or device['revoked']: abort(401, description='invalid_device')
        if meta['expires_at'] <= time.time() or ('result' not in meta and time.time()-p.stat().st_mtime > self.s.UPLOAD_IDLE_SECONDS): abort(410, description='session_expired')
        if not hmac.compare_digest(meta['token_hash'], hashlib.sha256(token[7:].encode()).hexdigest()): abort(401, description='invalid_upload_token')
        return p, meta

    def session(self, id):
        with self.s.lock:
            p, meta = self.authorize_session(id)
            if 'result' in meta: return jsonify(state='completed', result=meta['result'])
            if request.method == 'DELETE': return self.s.cancel_upload(id)
            # Polling alone does not extend the idle lifetime.
            return jsonify(id=id, state='uploading', expires_at=meta['expires_at'], files=self.offsets(p))

    def chunk(self, id, index):
        with self.s.lock:
            _, meta = self.authorize_session(id)
            if 'result' in meta: return self.fail('session_completed', 409)
        try:
            response = self.s.app.make_response(self.s.upload_chunk(id, index))
        except OSError as e:
            if e.errno != errno.ENOSPC: raise
            response = self.s.app.make_response(self.fail('insufficient_disk_space', 507))
        if response.status_code == 507:
            with self.s.lock:
                if not self.s.active_uploads[id]: self.s.shutil.rmtree(self.s.UPLOADS/id, ignore_errors=True)
        return response

    def finish(self, id):
        with self.s.lock:
            p, meta = self.authorize_session(id)
            if 'result' in meta: return jsonify(meta['result']), 200
        # Existing finish validates length, checks SHA256, registers and cleans up.
        response = self.s.app.make_response(self.s.finish_upload(id))
        if response.status_code == 201:
            with self.s.lock:
                self.state['receipts'][id] = dict(meta, result=response.get_json())
                self.save()
        return response
