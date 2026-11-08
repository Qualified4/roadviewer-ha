"""Exporting recordings as one tar file and importing them back (the log folders are not in Home Assistant backups).

An export holds each recording's locally stored originals (rlog.zst and the camera files) and its record: name, upload
time, tags, bookmarks, pin, upload filenames, codec facts of the stored videos and the index entries of files kept on
Google Drive or the NAS (references only, never their bytes, an upload session or a token). Converted data is never
exported: an imported recording is converted again like an upload.

Layout (ustar, streamed with a known Content-Length):
  manifest.json            {format, version, app_version, exported_at, recordings: [{id, name, files, bytes}]}
  <id>/<kind>              each local original (kind: video_sources.STORED_KINDS)
  <id>/record.json         after its files, so each file is read once and hashed while it is sent; padded with
                           spaces to the size reserved for it when the response started
The browser reads the tar itself (File.slice) and imports one recording at a time: POST /api/logs/import with the
record opens an upload session for its files (the chunked upload machinery: limits, disk checks, cleanup, hashing),
POST /api/logs/import/<session>/finish checks every file against the record's sha256 and registers the recording
with its original id (NAS paths derive from it) in one rename, so a failed import leaves nothing in the list."""
import hashlib, json, math, os, re, shutil, tarfile, tempfile, time, unicodedata
from pathlib import Path
from flask import request, jsonify, abort
from storage_policy import atomic_json
import media_store
from video_sources import SOURCES, STORED_KINDS, validate_hevc, validate_mp4

FORMAT, VERSION = 'roadviewer-export', 1
MANIFEST, RECORD, IMPORT = 'manifest.json', 'record.json', 'import.json'
BLOCK = 512
RECORD_SLACK = 4096  # Room for index entries that change while the export streams (a file archived meanwhile).
READ = 1 << 20
EXPORT_IDS = 150  # As the ZIP download: the ids travel in the URL.
SHA256, MD5 = re.compile(r'^[0-9a-f]{64}$'), re.compile(r'^[0-9a-f]{32}$')
FILE_ID, CODE, ITEM_ID = re.compile(r'^[A-Za-z0-9_-]{1,256}$'), re.compile(r'^[a-z0-9_]{1,64}$'), re.compile(r'^[A-Za-z0-9_-]{1,64}$')
# Index fields kept per location (media_store). Upload sessions (remote_pending) and cleanup flags (removing) never are.
ENTRY_FIELDS = {'nas': ('bytes', 'sha256', 'archived_at', 'restored_at', 'error'),
                'gdrive': ('file_id', 'bytes', 'sha256', 'md5', 'archived_at', 'error'),
                'removed': ('removed_at', 'reason', 'sha256', 'bytes'),
                'local': ('remote', 'error')}
RECORD_KEYS = {'id', 'name', 'uploaded', 'files', 'tags', 'bookmarks', 'pinned', 'video_codecs', 'video_origins', 'originals', 'storage'}
# Not exported, made again on import: status and conversion state (queued per the auto-convert setting, as an upload),
# bytes, video and content_hashes (from the received files and the index).

class Invalid(ValueError): pass

def padding(size): return -size % BLOCK

def header(name, size, mtime):
    info = tarfile.TarInfo(name)
    info.size, info.mtime, info.mode, info.uname, info.gname = size, max(0, int(mtime)), 0o644, 'roadviewer', 'roadviewer'
    return info.tobuf(tarfile.USTAR_FORMAT, 'utf-8', 'strict')

def member_bytes(size): return BLOCK + size + padding(size)

def dumps(value): return json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode()

# --- Validation of a record from an export file (never trusted: it comes from the browser).

def _number(value, low=0):
    return not isinstance(value, bool) and isinstance(value, (int, float)) and math.isfinite(value) and value >= low

def _text(value, limit, what):
    if not isinstance(value, str): raise Invalid(f'{what}이(가) 올바르지 않습니다.')
    value = unicodedata.normalize('NFC', value).strip()
    if not value or len(value) > limit or any(unicodedata.category(c).startswith('C') for c in value): raise Invalid(f'{what}이(가) 올바르지 않습니다.')
    return value

def _entry(kind, e):
    if not isinstance(e, dict) or e.get('location') not in ENTRY_FIELDS or set(e) - {'location', *ENTRY_FIELDS[e['location']]}:
        raise Invalid(f'{kind}의 저장 위치 정보가 올바르지 않습니다.')
    where, out = e['location'], {'location': e['location']}
    for key, value in e.items():
        if key == 'location': continue
        ok = {'bytes': lambda v: type(v) is int and v >= 0, 'sha256': lambda v: isinstance(v, str) and bool(SHA256.fullmatch(v)),
              'md5': lambda v: v is None or isinstance(v, str) and bool(MD5.fullmatch(v)), 'file_id': lambda v: isinstance(v, str) and bool(FILE_ID.fullmatch(v)),
              'error': lambda v: isinstance(v, str) and bool(CODE.fullmatch(v)), 'reason': lambda v: isinstance(v, str) and bool(CODE.fullmatch(v)),
              'remote': lambda v: True}.get(key, _number)(value)
        if not ok: raise Invalid(f'{kind}의 저장 위치 정보가 올바르지 않습니다.')
        out[key] = value
    if where == 'local':
        if 'error' in out and out['error'] != 'remote_mismatch': raise Invalid(f'{kind}의 저장 위치 정보가 올바르지 않습니다.')
        if 'remote' in out: out['remote'] = _remote(kind, out['remote'])
    if where in ('nas', 'gdrive') and ('sha256' not in out or 'bytes' not in out): raise Invalid(f'{kind}의 저장 위치 정보가 올바르지 않습니다.')
    if where == 'gdrive' and 'file_id' not in out: raise Invalid(f'{kind}의 저장 위치 정보가 올바르지 않습니다.')
    return out

def _remote(kind, block):
    if (not isinstance(block, dict) or set(block) - set(media_store.REMOTE_FIELDS) or block.get('backend') not in media_store.REMOTE_BACKENDS
            or not (isinstance(block.get('file_id'), str) and FILE_ID.fullmatch(block['file_id']))
            or not (isinstance(block.get('sha256'), str) and SHA256.fullmatch(block['sha256'])) or type(block.get('bytes')) is not int or block['bytes'] < 0
            or block.get('md5') is not None and not (isinstance(block['md5'], str) and MD5.fullmatch(block['md5']))
            or 'uploaded_at' in block and not _number(block['uploaded_at'])
            or 'verified_by' in block and not (isinstance(block['verified_by'], str) and CODE.fullmatch(block['verified_by']))):
        raise Invalid(f'{kind}의 원격 사본 정보가 올바르지 않습니다.')
    return dict(block)

def parse_record(value, id_pattern, tag_colors):
    """The validated record, or Invalid with a message for the user."""
    if not isinstance(value, dict) or set(value) - RECORD_KEYS or not {'id', 'name', 'originals'} <= set(value): raise Invalid('기록 정보의 형식이 올바르지 않습니다.')
    id = value['id']
    if not isinstance(id, str) or not id_pattern.fullmatch(id): raise Invalid('기록 ID가 올바르지 않습니다.')
    record = {'id': id, 'name': _text(value['name'], 300, '기록 이름')}
    uploaded = value.get('uploaded', time.time())
    if not _number(uploaded): raise Invalid('업로드 시각이 올바르지 않습니다.')
    record['uploaded'] = uploaded
    files = value.get('files', {})
    if not isinstance(files, dict) or set(files) - set(STORED_KINDS): raise Invalid('업로드 파일 이름이 올바르지 않습니다.')
    for kind, name in files.items():
        name = _text(name, 255, '업로드 파일 이름')
        if '/' in name or '\\' in name or name in ('.', '..'): raise Invalid('업로드 파일 이름이 올바르지 않습니다.')
        files[kind] = name
    record['files'] = dict(files)
    tags = value.get('tags', [])
    if not isinstance(tags, list) or len(tags) > 100: raise Invalid('태그 정보가 올바르지 않습니다.')
    seen = {}
    for tag in tags:
        if not isinstance(tag, dict) or set(tag) - {'name', 'color'}: raise Invalid('태그 정보가 올바르지 않습니다.')
        name = ' '.join(_text(tag.get('name'), 32, '태그 이름').split()); color = tag.get('color', 'mint')
        if color not in tag_colors: raise Invalid('태그 색상이 올바르지 않습니다.')
        seen.setdefault(name.lower(), {'name': name, 'color': color})
    record['tags'] = list(seen.values())
    bookmarks = value.get('bookmarks', [])
    if not isinstance(bookmarks, list) or len(bookmarks) > 100: raise Invalid('북마크 정보가 올바르지 않습니다.')
    marks = {}
    for b in bookmarks:
        if (not isinstance(b, dict) or set(b) != {'id', 'time', 'title', 'note'} or not isinstance(b['id'], str) or not ITEM_ID.fullmatch(b['id'])
                or not _number(b['time']) or b['time'] > 86400 or not isinstance(b['note'], str)):
            raise Invalid('북마크 정보가 올바르지 않습니다.')
        note = unicodedata.normalize('NFC', b['note']).strip()
        if len(note) > 1000 or any(unicodedata.category(c).startswith('C') and c not in '\n\t' for c in note): raise Invalid('북마크 정보가 올바르지 않습니다.')
        marks[b['id']] = {'id': b['id'], 'time': b['time'], 'title': ' '.join(_text(b['title'], 80, '북마크 제목').split()), 'note': note}
    record['bookmarks'] = sorted(marks.values(), key=lambda b: (b['time'], b['id']))
    pinned = value.get('pinned', False)
    if type(pinned) is not bool: raise Invalid('고정 정보가 올바르지 않습니다.')
    record['pinned'] = pinned
    codecs, origins = value.get('video_codecs', {}), value.get('video_origins', {})
    if not isinstance(codecs, dict) or set(codecs) - set(SOURCES) or any(c not in ('h264', 'hevc') for c in codecs.values()): raise Invalid('영상 코덱 정보가 올바르지 않습니다.')
    if not isinstance(origins, dict) or set(origins) - set(SOURCES) or not all(_number(v, -math.inf) for v in origins.values()): raise Invalid('영상 시작 정보가 올바르지 않습니다.')
    record['video_codecs'], record['video_origins'] = dict(codecs), dict(origins)
    originals = value['originals']
    if not isinstance(originals, dict) or set(originals) - set(STORED_KINDS): raise Invalid('원본 파일 목록이 올바르지 않습니다.')
    for kind, info in originals.items():
        if (not isinstance(info, dict) or set(info) != {'bytes', 'sha256'} or type(info['bytes']) is not int or info['bytes'] <= 0
                or not isinstance(info['sha256'], str) or not SHA256.fullmatch(info['sha256'])):
            raise Invalid(f'{kind} 파일 정보가 올바르지 않습니다.')
    record['originals'] = {kind: dict(originals[kind]) for kind in STORED_KINDS if kind in originals}
    storage = value.get('storage', {})
    if not isinstance(storage, dict) or set(storage) - set(STORED_KINDS): raise Invalid('저장 위치 정보가 올바르지 않습니다.')
    entries = {}
    for kind in STORED_KINDS:
        if kind not in storage: continue
        e = _entry(kind, storage[kind])
        if kind in record['originals'] and e['location'] != 'local': raise Invalid(f'{kind}의 저장 위치가 원본 파일과 맞지 않습니다.')
        # A local entry describes a file sent with it, or one whose verified remote copy stands in for it.
        if e['location'] == 'local' and kind not in record['originals'] and 'remote' not in e: continue
        entries[kind] = e
    record['storage'] = entries
    if not log_digest(record): raise Invalid('원본 로그(rlog.zst)가 없는 기록입니다.')
    return record

def log_digest(record):
    # The recording's rlog.zst content (duplicates are found by it, as uploads find them): sent, or kept elsewhere.
    sent = record['originals'].get('rlog.zst')
    if sent: return sent['sha256']
    e = record['storage'].get('rlog.zst')
    if not e: return None
    if e['location'] in media_store.REMOTE_LOCATIONS: return e['sha256']
    return e.get('remote', {}).get('sha256') if e['location'] == 'local' else None

class LogTransfer:
    def __init__(self, s):
        self.s = s
        self.digests = {}  # id -> (stat signature, rlog sha256 or None): duplicate checks stat each log, not hash it.
        s.app.add_url_rule('/api/logs/export.tar', 'export_logs', self.export, methods=['GET'])
        s.app.add_url_rule('/api/logs/import', 'import_log', self.begin, methods=['POST'])
        s.app.add_url_rule('/api/logs/import/<id>/finish', 'finish_import', self.finish, methods=['POST'])

    # --- Export

    def app_version(self):
        match = re.search(r'assets/style.css\?v=([^"&]+)', (self.s.BASE / 'web' / 'library.html').read_text())
        return match[1] if match else None

    def export_entry(self, m, kind):
        # The index entry as exported (whitelisted fields), or None for a plain local file.
        e = media_store.entry(m, kind)
        where = e['location']
        if where not in ENTRY_FIELDS: return None
        out = {'location': where, **{k: e[k] for k in ENTRY_FIELDS[where] if k in e and k != 'remote'}}
        if where == 'local':
            block = media_store.remote(m, kind)
            if block: out['remote'] = {k: block[k] for k in media_store.REMOTE_FIELDS if k in block}
            if out.get('error') != 'remote_mismatch': out.pop('error', None)
            return out if len(out) > 1 else None
        return out

    def record(self, p, m, originals):
        storage = {}
        for kind in STORED_KINDS:
            e = self.export_entry(m, kind)
            if e: storage[kind] = e
        files = m.get('files') if isinstance(m.get('files'), dict) else {}
        with self.s.lock: pinned = self.s.storage_policy.pinned(m)
        return {'id': m['id'], 'name': m.get('name', ''), 'uploaded': m.get('uploaded', 0),
                'files': {k: v for k, v in files.items() if k in STORED_KINDS and isinstance(v, str)},
                'tags': m.get('tags', []), 'bookmarks': m.get('bookmarks', []), 'pinned': pinned,
                'video_codecs': m.get('video_codecs', {}), 'video_origins': m.get('video_origins', {}),
                'originals': originals, 'storage': storage}

    def plan(self, p, m):
        # (kind, size, mtime) of each local original; the record's size is reserved now for the Content-Length.
        files = []
        for kind in STORED_KINDS:
            if media_store.location(m, kind) != 'local': continue
            try: st = (p / kind).stat()
            except OSError: continue
            if st.st_size > 0 and st.st_size < 8**11: files.append((kind, st.st_size, st.st_mtime))  # ustar sizes
        planned = self.record(p, m, {kind: {'bytes': size, 'sha256': '0' * 64} for kind, size, _ in files})
        return {'path': p, 'meta': m, 'files': files, 'record_size': len(dumps(planned)) + RECORD_SLACK}

    def export(self):
        s = self.s
        ids = list(dict.fromkeys(i for i in request.args.get('ids', '').split(',') if i))
        if len(ids) > EXPORT_IDS: abort(400)
        plans = []
        # Without the lock: metadata is replaced atomically, and every file is opened while streaming.
        for p in [s.folder(id) for id in ids] if ids else s.recording_paths():
            try: m = s.read_meta(p)
            except FileNotFoundError:
                if ids: abort(404)
                continue
            plans.append(self.plan(p, m))
        if not plans: abort(404)
        plans.sort(key=lambda plan: s.recording_order(plan['meta']))
        manifest = dumps({'format': FORMAT, 'version': VERSION, 'app_version': self.app_version(), 'exported_at': time.time(),
                          'recordings': [{'id': plan['meta']['id'], 'name': plan['meta'].get('name', ''), 'files': [f[0] for f in plan['files']],
                                          'bytes': sum(f[1] for f in plan['files'])} for plan in plans]})
        total = member_bytes(len(manifest)) + sum(sum(member_bytes(f[1]) for f in plan['files']) + member_bytes(plan['record_size']) for plan in plans) + 2 * BLOCK
        now = time.time()
        def stream():
            yield header(MANIFEST, len(manifest), now) + manifest + b'\0' * padding(len(manifest))
            for plan in plans: yield from self.stream_recording(plan, now)
            yield b'\0' * (2 * BLOCK)
        response = s.app.response_class(stream(), mimetype='application/x-tar', direct_passthrough=True)
        response.headers['Content-Length'] = str(total)
        s.attachment(response, time.strftime('roadviewer-export-%Y%m%d-%H%M.tar'))
        response.headers['Cache-Control'] = 'no-store'
        return response

    def stream_recording(self, plan, now):
        p, sent = plan['path'], {}
        for kind, size, mtime in plan['files']:
            yield header(f"{p.name}/{kind}", size, mtime)
            digest, left = hashlib.sha256(), size
            try:
                # The size planned is what the header declared: a file replaced or removed since is not exported
                # (its bytes are zeros and the record leaves it out).
                with (p / kind).open('rb') as source:
                    if os.fstat(source.fileno()).st_size == size:
                        while left and (chunk := source.read(min(READ, left))):
                            digest.update(chunk); left -= len(chunk); yield chunk
            except OSError: pass
            if left:
                while left:
                    n = min(READ, left); left -= n; yield b'\0' * n
            else: sent[kind] = {'bytes': size, 'sha256': digest.hexdigest()}
            yield b'\0' * padding(size)
        # The index as it is now (a file archived during the export is kept by reference), within the reserved size.
        try: m = self.s.read_meta(p)
        except (OSError, ValueError): m = plan['meta']
        data = dumps(self.record(p, m, sent))
        if len(data) > plan['record_size']: data = dumps(self.record(p, plan['meta'], sent))
        data += b' ' * (plan['record_size'] - len(data))
        yield header(f'{p.name}/{RECORD}', len(data), now) + data + b'\0' * padding(len(data))

    # --- Import

    def error(self, message, status=400, code='invalid_import'): return jsonify(error=code, message=message), status

    def body(self):
        request.max_content_length = 1 << 20
        body = request.get_json(silent=True)
        if not isinstance(body, dict) or set(body) != {'format', 'version', 'record'}: raise Invalid('불러오기 요청이 올바르지 않습니다.')
        if body['format'] != FORMAT: raise Invalid('Road Viewer 내보내기 파일이 아닙니다.')
        if body['version'] != VERSION: raise Invalid(f'지원하지 않는 내보내기 형식 버전입니다 ({body["version"]!r}). 앱을 업데이트한 뒤 다시 시도하세요.')
        return parse_record(body['record'], self.s.ID, self.s.TAG_COLORS)

    def stored_log_digest(self, p):
        # The rlog.zst hash of a stored recording (as register_files reads it), cached while its meta and log are unchanged.
        try:
            st = (p / 'meta.json').stat()
            try: log = (p / 'rlog.zst').stat(); log = (log.st_size, log.st_mtime_ns, log.st_ino)
            except FileNotFoundError: log = None
        except FileNotFoundError: return None
        signature = (st.st_size, st.st_mtime_ns, st.st_ino, log)
        cached = self.digests.get(p.name)
        if cached and cached[0] == signature: return cached[1]
        try:
            m = self.s.read_meta(p)
            digest = self.s.stored_digests(p, m, ('rlog.zst',)).get('rlog.zst')
        except (OSError, ValueError, KeyError, AttributeError): return None
        self.digests[p.name] = (signature, digest)
        return digest

    def skipped(self, record):
        # Why this record is not imported: its id is taken, or a stored recording has the same log. Hashing happens
        # outside the locks (callers recheck the id under them).
        s = self.s
        if (s.ROOT / record['id']).exists(): return 'exists'
        wanted, paths = log_digest(record), s.recording_paths()
        for id in set(self.digests) - {p.name for p in paths}: self.digests.pop(id, None)
        return 'duplicate' if any(self.stored_log_digest(p) == wanted for p in paths) else None

    def begin(self):
        s = self.s
        try: record = self.body()
        except Invalid as e: return self.error(str(e))
        s.cleanup_uploads()
        reason = self.skipped(record)
        if reason: return jsonify(skipped=reason, id=record['id'])
        files = [{'name': kind, 'size': info['bytes'], 'sha256': info['sha256']} for kind, info in record['originals'].items()]
        if not files:
            # Only references (every file is on Drive or the NAS): registered at once.
            s.archive_state()
            with s.registration_lock:
                with tempfile.TemporaryDirectory(dir=s.ROOT, prefix='.upload-') as temp:
                    result = self.register(record, Path(temp), [], None)
            return self.answer(record, result)
        s.archive_state()  # Refreshed before locking: admission reads it without probing the share.
        with s.registration_lock, s.lock:
            if (s.ROOT / record['id']).exists(): return jsonify(skipped='exists', id=record['id'])
            result = s.create_upload(files)
            response, status = result if isinstance(result, tuple) else (result, result.status_code)
            if status != 201: return result
            session = response.get_json()
            atomic_json(s.UPLOADS / session['id'] / IMPORT, record)
        return jsonify(session=session['id'], chunk_size=session['chunk_size'], files=[f['name'] for f in files]), 201

    def finish(self, id):
        s = self.s
        with s.lock:
            p, files = s.upload_session(id)
            if not (p / IMPORT).is_file(): abort(404)
            if s.active_uploads[id]: return s.upload_error('upload_busy', '업로드 조각을 전송 중입니다.', 409)
            if any(not (p / str(i)).is_file() or (p / str(i)).stat().st_size != f['size'] for i, f in enumerate(files)):
                return s.upload_error('incomplete_upload', '아직 전송되지 않은 파일이 있습니다.', 409)
            s.active_uploads[id] += 1; s.finishing_uploads.add(id)
        try:
            try: record = parse_record(json.loads((p / IMPORT).read_text()), s.ID, s.TAG_COLORS)
            except (Invalid, ValueError): return self.error('불러오기 정보가 올바르지 않습니다.')
            if [f['name'] for f in files] != list(record['originals']): return self.error('불러오기 정보가 올바르지 않습니다.')
            # Hashed outside the locks (the chunks' running hash when it is still valid), then checked as uploads are.
            for i, f in enumerate(files):
                if s.received_digest(id, i, p / str(i)) != record['originals'][f['name']]['sha256']:
                    return self.error(f'{f["name"]} 파일이 내보낸 내용과 다릅니다 (체크섬 불일치).', 422, 'checksum_mismatch')
            reason = self.skipped(record)
            if reason: return jsonify(skipped=reason, id=record['id'])
            s.archive_state()
            with s.registration_lock:
                with tempfile.TemporaryDirectory(dir=s.ROOT, prefix='.upload-') as temp:
                    result = self.register(record, Path(temp), [(p / str(i), f['name']) for i, f in enumerate(files)], id)
            return self.answer(record, result)
        finally:
            with s.lock:
                shutil.rmtree(p, ignore_errors=True)
                s.active_uploads.pop(id, None); s.finishing_uploads.discard(id); s.upload_hashes.pop(id, None)

    def answer(self, record, result):
        s = self.s
        if result is not None: return result
        s.process_pending()  # Archived files of recordings evicted by admission, now that the locks are released.
        s.store.forget_index()
        m = s.read_meta(s.ROOT / record['id'])
        if m['status'] == 'queued': s.submit(record['id'])
        return jsonify(imported=record['id'], status=m['status']), 201

    def register(self, record, temp, received, reservation_id):
        # Caller holds registration_lock. The recording is built in a staging folder under ROOT (.upload-*, removed at
        # start) and appears with one rename; None once registered, else the response to send.
        s, stage = self.s, temp / record['id']
        stage.mkdir()
        hashes = {}
        for path, kind in received:
            os.replace(path, stage / kind); st = (stage / kind).stat()
            hashes[kind] = {'size': st.st_size, 'mtime_ns': st.st_mtime_ns, 'sha256': record['originals'][kind]['sha256']}
            # The same checks as an upload (by the file's own name: an MP4's expected codec follows it).
            try:
                if kind.endswith('.hevc'): validate_hevc(stage / kind)
                if kind.endswith('.mp4'): validate_mp4(stage / kind)
            except ValueError as e: return self.error(f'{kind}: {e}')
        m = {'id': record['id'], 'name': record['name'], 'uploaded': record['uploaded'], 'status': 'queued' if s.auto_convert else 'unconverted',
             'manual_conversion': False, 'files': record['files'], 'error': None, 'content_hashes': hashes,
             'tags': record['tags'], 'bookmarks': record['bookmarks']}
        for key in ('video_codecs', 'video_origins'):
            if record[key]: m[key] = record[key]
        if record['storage']: m['storage'] = {kind: dict(e) for kind, e in record['storage'].items()}
        m.update(video=s.has_video(stage, m), bytes=s.original_bytes(stage, m))
        with s.lock:
            if (s.ROOT / record['id']).exists(): return jsonify(skipped='exists', id=record['id'])
            s.storage_policy.admit(0, [{'name': kind} for _, kind in received], commit=True, reservation_id=reservation_id)
            s.save_meta(stage, m)
            stage.rename(s.ROOT / record['id'])
            if record['pinned']:
                policy = s.storage_policy
                policy.settings['pinned_logs'] = sorted({*policy.settings['pinned_logs'], record['id']})
                atomic_json(policy.path, policy.settings)
        return None
