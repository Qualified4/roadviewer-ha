"""Google Drive archiving stopped abruptly at every step (tests/fake_drive.py): right after a resumable session is
started, after it is recorded but before its first chunk, between chunks, after a chunk arrived but before its answer,
after the last chunk arrived but before its answer, before the copy is verified, before and after the index commit
and, in move mode with deleting allowed, before and after the local unlink. Also a recovery stopped between its Drive
check and its local unlink, a sign-out in the middle of an upload, a conversion stopped around the commit that promoted
an original to its Drive copy, and a NAS entry left behind after switching to Drive.

The process stop is a BaseException raised at that point, so no handler sees it. A restart is a new backend (the token
file read again) and a new archiver: recover_startup, then one cycle. After it there is exactly one Drive file per
file, an index that agrees with Drive and the disk, no upload record left, nothing marked removed, the local file kept
in copy mode and, in move mode, deleted only while the committed index says gdrive and Drive holds the same bytes.
Power loss itself (an fsync that never reached the disk) is not reproduced here."""
import contextlib, hashlib, json, os, random, shutil, sys, tempfile, time, unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_media_integration import make_log, PEER, HEADERS  # Sets RV_DATA and imports the server module.
import server, media_store
import archive_backends as ab
from fake_drive import FakeDrive, FOLDER

MIB = 2**20
ID = 'a' * 32
VIDEO = random.Random(8).randbytes(3 * MIB + 123)  # Four chunks.
LOG = b'rlog.zst' * 100
DATA = {'fcamera.mp4': VIDEO, 'rlog.zst': LOG}
MOVE = {'mode': 'move', 'allow_local_delete': True}
MODES = (('copy', {}), ('move', MOVE))
HEVC = b'\x00\x00\x01\x40\x01'  # The start validate_hevc accepts.
SUMMARY = {'duration': 1, 'warnings': [], 'model_frames': 0, 'videos': {'front': {'codec': 'hevc'}}}

class Crash(BaseException):
    """The process stops here: nothing below the raise runs, no `except Exception` catches it."""

def sha(data): return hashlib.sha256(data).hexdigest()

def crashing(target, attr, when, match):
    # Wraps target.attr: the first call whose arguments match crashes before or after the real call.
    real, state = getattr(target, attr), {'done': False}
    def wrapper(*args, **kw):
        hit = not state['done'] and match(*args, **kw)
        if hit: state['done'] = True
        if hit and when == 'before': raise Crash(attr)
        result = real(*args, **kw)
        if hit: raise Crash(attr)
        return result
    return patch.object(target, attr, wrapper), state

def video_chunk(test):
    # put_chunk(client, session, data, start, total) for the video, with `test(start, length, total)`.
    return lambda client, session, data, start, total: total == len(VIDEO) and test(start, len(data), total)

def video_commit(path, value):
    # The index commit that records the video's verified copy (copy mode) or its move (move mode).
    return Path(path).name == 'meta.json' and (media_store.remote(value, 'fcamera.mp4') is not None or media_store.location(value, 'fcamera.mp4') == 'gdrive')

class GdriveCrashTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(); self.addCleanup(temp.cleanup); self.root = Path(temp.name)
        self.drive = FakeDrive().start(); self.addCleanup(self.drive.stop)
        for patcher in (patch.dict(os.environ, self.drive.env()), patch.object(server, 'ROOT', self.root),
                        patch.object(server, 'cleanup_uploads'), patch.object(server, 'upload_receiving', return_value=False),
                        patch.object(server, 'submit'), patch.object(server, 'connection', None),
                        patch.object(ab.DriveConnection, '_wait', lambda connection, cancel, seconds: cancel.wait(0.01))):
            patcher.start(); self.addCleanup(patcher.stop)
        self.http = ab.Http(sleep=lambda seconds: None, rand=lambda: 0.0)
        auth = self.auth(); auth.start_device_flow(); self.assertEqual(auth.poll_once(), 'granted')
        self.make_backend().activate()
        self.assertEqual(self.backend.probe(), ('connected', None))
        self.client = server.app.test_client()
        self.addCleanup(self.join_threads)

    def join_threads(self):
        connection = server.connection
        if connection is None: return
        connection._cancel.set()
        for thread in (connection.thread, connection.revoker):
            if thread: thread.join(5)

    def auth(self): return ab.DriveAuth(self.root / '.gdrive-auth.json', 'client-id', 'secret', self.http)

    def make_backend(self, **fields):
        # A new instance reads the token file again, as after a restart. The server sees the same backend and store.
        self.settings = media_store.ArchiveSettings(**{'enabled': True, 'backend': 'gdrive', 'min_age_seconds': 86400,
                                                       'gdrive_client_id': 'client-id', 'gdrive_client_secret': 'secret', **fields})
        auth = self.auth()
        self.backend = ab.DriveBackend(self.settings, self.root, auth, ab.DriveClient(self.http, auth))
        self.store = media_store.ArchiveStore(self.settings, self.root)
        for name, value in (('backend', self.backend), ('store', self.store)):
            patcher = patch.object(server, name, value); patcher.start(); self.addCleanup(patcher.stop)
        return self.backend

    def archiver(self, **fields):
        backend = self.make_backend(**fields)
        archiver = media_store.Archiver(server, self.store, self.settings, backend=backend)
        patcher = patch.object(server, 'archiver', archiver); patcher.start(); self.addCleanup(patcher.stop)
        return archiver

    def restart(self, **fields):
        # A new process: the backend reads the token file, recovery runs first. The caller runs the cycle.
        archiver = self.archiver(**fields)
        archiver.recover_startup()
        self.assertTrue(archiver.recovered)
        return archiver

    def recording(self, id=ID, data=DATA):
        # Converted, old enough, nothing stale: only the archiver acts on it (recheck_held keeps it as it is).
        p = make_log(self.root, id, list(data), [])
        for kind, content in data.items(): (p / kind).write_bytes(content)
        (p / 'prepared' / 'data.json').write_text('{}')
        m = server.read_meta(p)
        m.update(decoder_version='v28-runtime-geometry', video=True, files={kind: '000003fe--d524dc1e0b--8--' + kind for kind in data})
        server.save_meta(p, m)
        return p

    def forget(self, p):
        # Each row starts from scratch: the same id is reused, Drive keeps only the folder.
        shutil.rmtree(p, ignore_errors=True)
        with self.drive.lock:
            for file_id in [i for i, f in self.drive.files.items() if f['mimeType'] != FOLDER]: del self.drive.files[file_id]
            self.drive.sessions.clear()
        (self.root / media_store.PENDING_DELETES).unlink(missing_ok=True)

    # Drive's side.

    def drive_files(self, id, kind):
        with self.drive.lock:
            return {i: dict(f) for i, f in self.drive.files.items() if f['mimeType'] != FOLDER and not f['trashed']
                    and f['appProperties'].get('rv_id') == id and f['appProperties'].get('rv_kind') == kind}

    def drive_content(self, file_id):
        with self.drive.lock:
            f = self.drive.files.get(file_id)
            return None if f is None or f['trashed'] else f['content']

    def sessions(self, id, kind):
        with self.drive.lock:
            return [u for u, s in self.drive.sessions.items()
                    if (s['file_meta'].get('appProperties') or {}).get('rv_id') == id and (s['file_meta'].get('appProperties') or {}).get('rv_kind') == kind]

    def request_count(self):
        with self.drive.lock: return len(self.drive.requests)

    def data_puts(self, sessions, since):
        # The byte offsets of chunks sent to these sessions since `since` (status queries carry no bytes).
        with self.drive.lock: requests = self.drive.requests[since:]
        starts = []
        for r in requests:
            headers = {k.lower(): v for k, v in r['headers'].items()}
            rng = headers.get('content-range', '')
            if r['method'] == 'PUT' and any('upload_id=' + s in r['path'] for s in sessions) and not rng.startswith('bytes */'):
                starts.append(int(rng.split(' ')[1].split('-')[0]))
        return starts

    # What the process does to the index and the local files, through the crash and the restart.

    def watch(self, stack, p):
        writes, unlinks = [], []
        real_json, real_save, real_unlink = media_store.atomic_json, server.save_meta, Path.unlink
        def atomic_json(path, value):
            if Path(path) == p / 'meta.json': writes.append(json.loads(json.dumps(value)))
            return real_json(path, value)
        def save_meta(q, m):
            if Path(q) == p: writes.append(json.loads(json.dumps(m)))
            return real_save(q, m)
        def unlink(path, *args, **kwargs):
            if path.parent == p and path.name in media_store.MEDIA_KINDS:
                # What the disk says at the moment of the unlink: the committed index and Drive's copy.
                e = media_store.entry(json.loads((p / 'meta.json').read_text()), path.name)
                unlinks.append((path.name, e['location'], e['location'] == 'gdrive' and self.drive_content(e.get('file_id')) == path.read_bytes()))
            return real_unlink(path, *args, **kwargs)
        for target, attr, fn in ((media_store, 'atomic_json', atomic_json), (server, 'save_meta', save_meta), (Path, 'unlink', unlink)):
            stack.enter_context(patch.object(target, attr, fn))
        return writes, unlinks

    def assert_never_removed(self, writes, label):
        self.assertTrue(writes, label)
        for value in writes:
            for kind, e in (value.get('storage') or {}).items():
                self.assertNotEqual(e.get('location'), 'removed', f'{label}: {kind} written as removed')
                self.assertNotIn('removing', e, label)

    def assert_unlinks(self, unlinks, move, label, kinds=DATA):
        if not move: self.assertEqual(unlinks, [], f'{label}: copy mode unlinked a local file'); return
        # Each local file went once, only while the committed index said gdrive and Drive held the same bytes.
        self.assertEqual(sorted(name for name, _, _ in unlinks), sorted(kinds), label)
        for name, where, verified in unlinks: self.assertEqual((where, verified), ('gdrive', True), f'{label}: {name}')

    def assert_consistent(self, p, label, data=DATA):
        # At any moment: a file is gone locally only when the index says gdrive and Drive has its bytes; every
        # recorded copy is on Drive with the indexed content.
        m = server.read_meta(p)
        for kind, content in data.items():
            e = media_store.entry(m, kind)
            if e['location'] == 'gdrive':
                self.assertEqual((e['sha256'], e['bytes']), (sha(content), len(content)), f'{label}: {kind}')
                self.assertEqual(self.drive_content(e['file_id']), content, f'{label}: {kind} indexed on Drive but not there')
            else:
                self.assertEqual(e['location'], 'local', f'{label}: {kind}')
                self.assertEqual((p / kind).read_bytes(), content, f'{label}: {kind} gone locally before its index said gdrive')
                block = media_store.remote(m, kind)
                if block: self.assertEqual(self.drive_content(block['file_id']), content, f'{label}: {kind} copy')
            self.assertNotIn('error', e, f'{label}: {kind}')

    def assert_settled(self, p, move, label, data=DATA):
        m = server.read_meta(p)
        self.assertEqual((m['status'], (p / 'prepared' / 'data.json').is_file()), ('ready', True), label)
        for kind, content in data.items():
            e, files = media_store.entry(m, kind), self.drive_files(p.name, kind)
            self.assertEqual(len(files), 1, f'{label}: {kind}: one Drive file, no duplicate or orphan')
            (file_id, f), = files.items()
            self.assertEqual(f['content'], content, f'{label}: {kind}')
            self.assertIsNone(media_store.remote_pending(m, kind), f'{label}: {kind}: upload record left')
            self.assertNotIn('error', e, f'{label}: {kind}')
            if move:
                self.assertEqual((e['location'], e['file_id'], e['sha256'], e['bytes']), ('gdrive', file_id, sha(content), len(content)), f'{label}: {kind}')
                self.assertFalse((p / kind).exists(), f'{label}: {kind}')
            else:
                block = media_store.remote(m, kind)
                self.assertEqual(e['location'], 'local', f'{label}: {kind}')
                self.assertEqual((p / kind).read_bytes(), content, f'{label}: {kind}')
                self.assertEqual((block['file_id'], block['sha256'], block['bytes'], block['verified_by']), (file_id, sha(content), len(content), 'sha256'), f'{label}: {kind}')

    def video_committed(self, p, move):
        m = server.read_meta(p)
        if move: return media_store.location(m, 'fcamera.mp4') == 'gdrive' and not (p / 'fcamera.mp4').exists()
        return media_store.remote(m, 'fcamera.mp4') is not None

    def test_upload_crash_matrix(self):
        local = lambda path, *a, **k: path == self.root / ID / 'fcamera.mp4'
        both, move_only = ('copy', 'move'), ('move',)
        rows = [  # (label, target, attribute, before/after, which call, modes, what the restart does with the video)
            ('session started, not yet recorded', ab.DriveClient, 'start_resumable', 'after',
             lambda client, name, parents, props, size: size == len(VIDEO), both, ('new_session',)),
            ('session recorded, before the first chunk', ab.DriveClient, 'put_chunk', 'before',
             video_chunk(lambda start, length, total: start == 0), both, ('resumed', 0)),
            ('between chunks', ab.DriveClient, 'put_chunk', 'before',
             video_chunk(lambda start, length, total: start == MIB), both, ('resumed', MIB)),
            ('chunk stored, its answer lost', ab.DriveClient, 'put_chunk', 'after',
             video_chunk(lambda start, length, total: start == MIB), both, ('resumed', 2 * MIB)),
            ('last chunk stored, completion answer lost', ab.DriveClient, 'put_chunk', 'after',
             video_chunk(lambda start, length, total: start + length == total), both, ('adopted',)),
            ('before verify', ab.DriveBackend, 'verify', 'before',
             lambda backend, ref, sha256, size, md5=None: size == len(VIDEO), both, ('adopted',)),
            ('verified, before the index commit', media_store, 'atomic_json', 'before', video_commit, both, ('adopted',)),
            ('after the index commit', media_store, 'atomic_json', 'after', video_commit, both, ('committed',)),
            ('committed, before the local unlink', media_store.Path, 'unlink', 'before', local, move_only, ('committed',)),
            ('after the local unlink', media_store.Path, 'unlink', 'after', local, move_only, ('committed',)),
        ]
        for mode, fields in MODES:
            move = mode == 'move'
            for label, target, attr, when, match, modes, expect in rows:
                if mode not in modes: continue
                label = f'{mode}: {label}'
                with self.subTest(label), contextlib.ExitStack() as stack:
                    self.forget(self.root / ID); p = self.recording()
                    writes, unlinks = self.watch(stack, p)
                    patcher, state = crashing(target, attr, when, match)
                    with patcher, self.assertRaises(Crash): self.archiver(**fields).run_cycle()
                    self.assertTrue(state['done'], label)
                    self.assert_consistent(p, label + ' (at the crash)')
                    pending = media_store.remote_pending(server.read_meta(p), 'fcamera.mp4')
                    if expect[0] == 'new_session': self.assertIsNone(pending, label)
                    elif expect[0] != 'committed': self.assertEqual(pending['backend'], 'gdrive', label)
                    if move and label.endswith('before the local unlink'): self.assertTrue((p / 'fcamera.mp4').is_file(), label)
                    since = self.request_count()
                    # Restart: recovery alone first.
                    archiver = self.restart(**fields)
                    if expect[0] in ('adopted', 'committed'):
                        self.assertTrue(self.video_committed(p, move), label + ': recovery commits the stored copy')
                        self.assertIsNone(media_store.remote_pending(server.read_meta(p), 'fcamera.mp4'), label)
                    if expect[0] == 'resumed':
                        self.assertIsNotNone(media_store.remote_pending(server.read_meta(p), 'fcamera.mp4'), label + ': kept for the resume')
                    self.assert_consistent(p, label + ' (after recovery)')
                    result = archiver.run_cycle()
                    self.assertIsNone(result['stopped'], label)
                    self.assert_settled(p, move, label)
                    sessions = self.sessions(ID, 'fcamera.mp4')
                    puts = self.data_puts(sessions, since)
                    if expect[0] == 'new_session':
                        self.assertEqual(len(sessions), 2, label)  # The unrecorded one holds nothing and completes nothing.
                    else:
                        self.assertEqual(len(sessions), 1, label + ': no second upload')
                    if expect[0] == 'resumed': self.assertEqual(min(puts), expect[1], label + ': resumed where Drive stopped')
                    if expect[0] in ('adopted', 'committed'): self.assertEqual(puts, [], label + ': nothing sent again')
                    self.assert_never_removed(writes, label)
                    self.assert_unlinks(unlinks, move, label)

    def moved_with_local(self):
        # Move mode stopped after its commit and before its unlink: the index says gdrive, the local file is still there.
        p = self.recording()
        patcher, _ = crashing(media_store.Path, 'unlink', 'before', lambda path, *a, **k: path == p / 'fcamera.mp4')
        with patcher, self.assertRaises(Crash): self.archiver(**MOVE).run_cycle()
        self.assertEqual(media_store.location(server.read_meta(p), 'fcamera.mp4'), 'gdrive')
        self.assertTrue((p / 'fcamera.mp4').is_file())
        return p

    def test_recovery_crash_between_drive_check_and_unlink_keeps_local(self):
        # (b) The restart's recovery verifies the moved copy and stops before its locked re-check and unlink.
        p = self.moved_with_local()
        before = (p / 'meta.json').read_bytes()
        with contextlib.ExitStack() as stack:
            writes, unlinks = self.watch(stack, p)
            patcher, state = crashing(ab.DriveBackend, 'verify', 'after', lambda backend, ref, sha256, size, md5=None: size == len(VIDEO))
            with patcher, self.assertRaises(Crash): self.archiver(**MOVE).recover_startup()
            self.assertTrue(state['done'])
            self.assertEqual((p / 'fcamera.mp4').read_bytes(), VIDEO)  # The local file survived.
            self.assertEqual((p / 'meta.json').read_bytes(), before)
            self.assertEqual(unlinks, [])
            # The next restart finishes it: verified again, then unlinked under the lock.
            self.restart(**MOVE).run_cycle()
            self.assert_settled(p, True, 'recovery crash')
            self.assertEqual([name for name, _, _ in unlinks].count('fcamera.mp4'), 1)
            for name, where, verified in unlinks: self.assertEqual((where, verified), ('gdrive', True), name)
            self.assert_never_removed(writes + [json.loads(before)], 'recovery crash')
        self.assertEqual(len(self.sessions(ID, 'fcamera.mp4')), 1)

    def test_corrupt_drive_copy_before_recovery_unlink_keeps_local(self):
        # Move mode stopped before its unlink, and the Drive copy is damaged meanwhile (same size; Drive reports the
        # checksums of what it holds). Recovery's Drive verify fails, so the local file, the only good copy, stays,
        # and the index points at it again (no copy recorded: the Drive file is not trusted). It plays locally; the
        # next cycle uploads a fresh copy and only then moves the file; the damaged Drive file is left alone.
        p = self.moved_with_local()
        e = media_store.entry(server.read_meta(p), 'fcamera.mp4')
        with self.drive.lock:
            f = self.drive.files[e['file_id']]
            f['content'] = damaged = bytes([f['content'][0] ^ 1]) + f['content'][1:]
            f['sha256'], f['md5'] = sha(damaged), hashlib.md5(damaged).hexdigest()
        with contextlib.ExitStack() as stack:
            writes, unlinks = self.watch(stack, p)
            with self.assertLogs(server.app.logger, 'WARNING') as logs: self.restart(**MOVE)
            self.assertTrue(any('the identical local file is used again' in line for line in logs.output), logs.output)
            m = server.read_meta(p)
            self.assertEqual(media_store.entry(m, 'fcamera.mp4'), {'location': 'local'}); self.assertNotIn('fcamera.mp4', m['storage'])
            self.assertEqual(m['content_hashes']['fcamera.mp4']['sha256'], sha(VIDEO))
            self.assertEqual((p / 'fcamera.mp4').read_bytes(), VIDEO); self.assertEqual(unlinks, [])
            with self.drive.lock: media = len([r for r in self.drive.requests if 'alt=media' in r['path']])
            r = self.client.get(f'/api/logs/{ID}/video?source=front', environ_overrides=PEER, headers={'Range': 'bytes=0-9'})
            self.assertEqual((r.status_code, r.data), (206, VIDEO[:10])); r.close()
            with self.drive.lock: self.assertEqual(len([r for r in self.drive.requests if 'alt=media' in r['path']]), media)  # Played locally.
            # The next cycle: a fresh verified copy, then the move.
            self.assertIsNone(self.archiver(**MOVE).run_cycle()['stopped'])
            self.assert_settled(p, True, 'after the fresh copy', data={'rlog.zst': LOG})
            e2 = media_store.entry(server.read_meta(p), 'fcamera.mp4')
            self.assertEqual((e2['location'], e2['sha256'], self.drive_content(e2['file_id'])), ('gdrive', sha(VIDEO), VIDEO))
            self.assertNotEqual(e2['file_id'], e['file_id']); self.assertFalse((p / 'fcamera.mp4').exists())
            self.assertEqual(self.drive_content(e['file_id']), damaged)  # The damaged file is untouched.
            self.assertEqual(set(self.drive_files(ID, 'fcamera.mp4')), {e['file_id'], e2['file_id']})
            self.assertEqual(sorted(name for name, _, _ in unlinks), ['fcamera.mp4', 'rlog.zst'])
            for name, where, verified in unlinks: self.assertEqual((where, verified), ('gdrive', True), name)
            self.assert_never_removed(writes, 'corrupt copy')

    def test_disconnect_mid_upload_then_reconnect_resumes_one_file(self):
        # (c) Signed out from the panel after the first chunk: the upload stops, its session stays recorded;
        # after signing in again the restart resumes the same session.
        p = self.recording()
        archiver = self.archiver()
        put_chunk, sent = self.backend.client.put_chunk, []
        def chunk(session, data, start, total):
            result = put_chunk(session, data, start, total)
            sent.append(start)
            if total == len(VIDEO) and start == 0: server.drive_connection().disconnect()
            return result
        with contextlib.ExitStack() as stack:
            writes, unlinks = self.watch(stack, p)
            with patch.object(self.backend.client, 'put_chunk', side_effect=chunk):
                self.assertEqual(archiver.run_cycle()['stopped'], 'auth_expired')
            server.connection.revoker.join(5)
            self.assertEqual(archiver.status()['last_auth_error'], 'signed_out')
            self.assertFalse((self.root / '.gdrive-auth.json').exists())
            m = server.read_meta(p)
            self.assertIsNotNone(media_store.remote_pending(m, 'fcamera.mp4')); self.assertIsNone(media_store.remote(m, 'fcamera.mp4'))
            self.assertEqual(self.drive_files(ID, 'fcamera.mp4'), {})
            self.assert_consistent(p, 'signed out')
            # Restarted while signed out: nothing happens, the record stays.
            before = (p / 'meta.json').read_bytes()
            archiver = self.archiver(); archiver.recover_startup()
            self.assertFalse(archiver.recovered)
            self.assertEqual(archiver.run_cycle()['stopped'], 'storage_unavailable')
            self.assertEqual((p / 'meta.json').read_bytes(), before)
            # Signing in again from the panel: the same folder is found.
            r = self.client.post('/api/settings/archive/gdrive/connect', environ_overrides=PEER, headers=HEADERS)
            self.assertEqual(r.status_code, 202, r.json)
            server.connection.thread.join(10)
            self.assertTrue(self.backend.auth.connected)
            with self.drive.lock: self.assertEqual(len([f for f in self.drive.files.values() if f['mimeType'] == FOLDER]), 1)
            since = self.request_count()
            self.restart().run_cycle()
            self.assert_settled(p, False, 'reconnected')
            sessions = self.sessions(ID, 'fcamera.mp4')
            self.assertEqual(len(sessions), 1)  # Resumed, not uploaded again.
            self.assertEqual(min(self.data_puts(sessions, since)), MIB)
            self.assert_never_removed(writes, 'reconnected'); self.assertEqual(unlinks, [])

    def convert(self, p, prepared, summary=SUMMARY):
        # A conversion whose decoder (replaced) produced `prepared` and `summary`, as in test_gdrive_server.
        for name, data in prepared.items(): (p / 'prepared' / name).write_bytes(data)
        (p / 'prepared' / 'summary.json').write_text(json.dumps(summary))
        m = server.read_meta(p); m.update(status='queued', manual_conversion=True); server.save_meta(p, m)
        with patch.object(server, 'ProgressChannel') as channel, patch.object(server.subprocess, 'Popen') as popen:
            channel.return_value.__enter__.return_value.options.return_value = {}
            popen.return_value.communicate.return_value = ('', ''); popen.return_value.returncode = 0; popen.return_value.poll.return_value = 0
            server.run_job(p.name)

    def promoting(self, when, id=ID, same_size=False):
        # A copied recording whose conversion replaces its original with the MP4: the original's identical copy
        # becomes the stored file (promote_remote). The process stops right before or after that commit.
        hevc, old, new = HEVC + os.urandom(3000), os.urandom(2000), os.urandom(2000 if same_size else 2500)
        data = {'rlog.zst': LOG, 'fcamera.hevc': hevc, 'fcamera.mp4': old}
        p = self.recording(id, data=data)
        self.assertIsNone(self.archiver().run_cycle()['stopped'])
        block = media_store.remote(server.read_meta(p), 'fcamera.hevc')
        promoted = lambda q, m: m.get('status') == 'ready' and media_store.location(m, 'fcamera.hevc') == 'gdrive'
        patcher, state = crashing(server, 'save_meta', when, promoted)
        with patcher, self.assertRaises(Crash): self.convert(p, {'fcamera.mp4': new})
        self.assertTrue(state['done'])
        self.assertFalse((p / 'fcamera.hevc').exists()); self.assertEqual((p / 'fcamera.mp4').read_bytes(), new)
        return p, hevc, new, block

    def assert_original_from_drive(self, p, hevc, label):
        with self.drive.lock: before = len([r for r in self.drive.requests if 'alt=media' in r['path']])
        r = self.client.get(f'/api/logs/{p.name}/original/fcamera.hevc', environ_overrides=PEER)
        self.assertEqual((r.status_code, r.data), (200, hevc), label); r.close()
        with self.drive.lock: self.assertGreater(len([r for r in self.drive.requests if 'alt=media' in r['path']]), before, label)

    def test_crash_after_promotion_commit_serves_the_original_from_drive(self):
        # (d) The conversion's commit made the original's Drive copy the stored file; the process stopped right after.
        p, hevc, new, block = self.promoting('after')
        m = server.read_meta(p); e = media_store.entry(m, 'fcamera.hevc')
        self.assertEqual((e['location'], e['file_id'], e['sha256']), ('gdrive', block['file_id'], sha(hevc)))
        self.assertIsNone(media_store.remote(m, 'fcamera.mp4'))  # The new MP4 is new content: not copied yet.
        with contextlib.ExitStack() as stack:
            writes, unlinks = self.watch(stack, p)
            archiver = self.restart()
            self.assertEqual(media_store.entry(server.read_meta(p), 'fcamera.hevc'), e)
            self.assertIsNone(archiver.run_cycle()['stopped'])
            self.assertEqual(unlinks, [])
            if writes: self.assert_never_removed(writes, 'promoted')
        m = server.read_meta(p)
        self.assertEqual(media_store.entry(m, 'fcamera.hevc'), e)
        self.assertEqual(len(self.sessions(ID, 'fcamera.hevc')), 1); self.assertEqual(list(self.drive_files(ID, 'fcamera.hevc')), [block['file_id']])
        self.assert_original_from_drive(p, hevc, 'promoted')
        # The new MP4 is copied by the cycle; the old MP4's copy stays on Drive (never deleted automatically).
        copy = media_store.remote(m, 'fcamera.mp4')
        self.assertEqual((copy['sha256'], self.drive_content(copy['file_id'])), (sha(new), new))
        self.assertEqual(len(self.drive_files(ID, 'fcamera.mp4')), 2)
        for kind in media_store.MEDIA_KINDS: self.assertIsNone(media_store.remote_pending(m, kind))
        self.assertEqual((p / 'fcamera.mp4').read_bytes(), new); self.assertTrue((p / 'rlog.zst').is_file())

    def test_crash_before_promotion_commit_keeps_the_original_reachable(self):
        # The registration removed the original and stopped before its commit: the index on disk still has the
        # original's verified copy, which stands in for it.
        p, hevc, new, block = self.promoting('before')
        m = server.read_meta(p)
        self.assertEqual((media_store.location(m, 'fcamera.hevc'), media_store.remote(m, 'fcamera.hevc')['file_id']), ('local', block['file_id']))
        with contextlib.ExitStack() as stack:
            writes, unlinks = self.watch(stack, p)
            self.restart().run_cycle()
            self.assertEqual(unlinks, [])
            if writes: self.assert_never_removed(writes, 'not promoted')
        m = server.read_meta(p)
        self.assertEqual(media_store.remote(m, 'fcamera.hevc')['file_id'], block['file_id'])
        self.assertEqual(len(self.sessions(ID, 'fcamera.hevc')), 1); self.assertEqual(list(self.drive_files(ID, 'fcamera.hevc')), [block['file_id']])
        self.assert_original_from_drive(p, hevc, 'not promoted')
        for kind in media_store.MEDIA_KINDS: self.assertIsNone(media_store.remote_pending(m, kind))
        # The previous MP4's copy no longer describes the local MP4: recovery dropped it (F1, next test). The
        # conversion run again (requeue_startup reconverts a recording left processing) promotes the original.
        self.assertEqual(m['status'], 'processing'); self.assertIsNone(media_store.remote(m, 'fcamera.mp4'))
        self.convert(p, {'fcamera.mp4': new})
        m = server.read_meta(p); e = media_store.entry(m, 'fcamera.hevc')
        self.assertEqual((m['status'], e['location'], e['file_id']), ('ready', 'gdrive', block['file_id']))
        self.assertIsNone(media_store.remote(m, 'fcamera.mp4'))
        self.assertIsNone(self.archiver().run_cycle()['stopped'])
        self.assertEqual(media_store.remote(server.read_meta(p), 'fcamera.mp4')['sha256'], sha(new))
        self.assertEqual(len(self.sessions(ID, 'fcamera.hevc')), 1)

    def test_stale_copy_left_by_an_interrupted_conversion_is_dropped(self):
        # F1. The conversion replaced the MP4 and stopped before saving its index: the index on disk still has the
        # previous MP4's copy next to the new local MP4. The restart's recovery drops that block (nothing is
        # deleted; the old Drive file stays as an orphan) and the new content is copied once converted again.
        for label, id, same_size in (('other size', 'a' * 32, False), ('same size, hashed', 'b' * 32, True)):
            with self.subTest(label), contextlib.ExitStack() as stack:
                p, hevc, new, block = self.promoting('before', id=id, same_size=same_size)
                m = server.read_meta(p); old = media_store.remote(m, 'fcamera.mp4')
                self.assertNotEqual(old['sha256'], sha(new)); self.assertEqual(m['status'], 'processing')
                writes, unlinks = self.watch(stack, p)
                real, read = media_store._sha256, []
                def hashing(path):
                    read.append(Path(path)); return real(path)
                with self.assertLogs(server.app.logger, 'INFO') as logs, patch.object(media_store, '_sha256', hashing): archiver = self.restart()
                # Another size is decided without reading the file; the same size needs the read.
                self.assertEqual(p / 'fcamera.mp4' in read, same_size, label)
                dropped = [line for line in logs.output if 'dropped' in line]
                self.assertEqual(len(dropped), 1, logs.output); self.assertIn(f'{id}/fcamera.mp4', dropped[0])
                self.assertNotIn(old['file_id'], dropped[0].replace(f'{id}/fcamera.mp4', ''))
                m = server.read_meta(p)
                self.assertIsNone(media_store.remote(m, 'fcamera.mp4'))
                self.assertEqual(media_store.remote(m, 'fcamera.hevc')['file_id'], block['file_id'])  # The original's copy stands in for it.
                self.assertIsNotNone(media_store.remote(m, 'rlog.zst'))  # A copy that matches is kept.
                self.assertEqual(self.drive_content(old['file_id']), self.drive_files(id, 'fcamera.mp4')[old['file_id']]['content'])
                self.assertIsNone(archiver.run_cycle()['stopped'])
                self.assertEqual(unlinks, [])  # Recovery and the cycle delete nothing.
                # Converted again, then copied: one current Drive file for the new MP4; the old one untouched.
                self.convert(p, {'fcamera.mp4': new})
                self.assertIsNone(self.archiver().run_cycle()['stopped'])
                m = server.read_meta(p); copy = media_store.remote(m, 'fcamera.mp4')
                self.assertEqual((copy['sha256'], self.drive_content(copy['file_id'])), (sha(new), new))
                files = self.drive_files(id, 'fcamera.mp4')
                self.assertEqual(set(files), {old['file_id'], copy['file_id']})
                self.assertEqual([i for i, f in files.items() if f['content'] == new], [copy['file_id']])
                self.assertEqual(len(self.sessions(id, 'fcamera.mp4')), 2)
                self.assertEqual(len(self.sessions(id, 'fcamera.hevc')), 1)
                # Only the conversion's own unlink of the original it replaced (already gone: missing_ok).
                self.assertEqual(unlinks, [('fcamera.hevc', 'local', False)]); self.assert_never_removed(writes, label)
                for kind in media_store.MEDIA_KINDS: self.assertIsNone(media_store.remote_pending(m, kind))

    def test_stale_copy_of_a_file_changing_during_the_check_waits(self):
        # The file changes while recovery reads it (outside the lock): the re-check under the lock sees it and leaves
        # the index alone; the next start decides on the file as it is then.
        p, hevc, new, block = self.promoting('before', same_size=True)
        before = (p / 'meta.json').read_bytes()
        real = media_store._sha256
        def touched(path):
            result = real(path)
            if Path(path) == p / 'fcamera.mp4':
                st = (p / 'fcamera.mp4').stat(); os.utime(p / 'fcamera.mp4', ns=(st.st_atime_ns, st.st_mtime_ns + 10**9))
            return result
        with patch.object(media_store, '_sha256', touched): self.restart()
        self.assertEqual((p / 'meta.json').read_bytes(), before)
        self.restart()
        self.assertIsNone(media_store.remote(server.read_meta(p), 'fcamera.mp4'))

    def test_matching_copies_are_kept_by_recovery(self):
        # The negative of F1: a copy that describes the local file is never dropped (no needless upload). A fresh
        # recorded hash answers without reading the file; otherwise, or while processing, the file is read.
        real, read = media_store._sha256, []
        def hashing(path):
            read.append(Path(path)); return real(path)
        for label, id, fresh, status in (('fresh recorded hash', 'c' * 32, True, 'ready'), ('no recorded hash', 'd' * 32, False, 'ready'),
                                         ('processing, fresh hash', 'e' * 32, True, 'processing')):
            with self.subTest(label):
                p = self.recording(id)
                self.assertIsNone(self.archiver().run_cycle()['stopped'])
                m = server.read_meta(p)
                for kind in DATA: self.assertIsNotNone(media_store.remote(m, kind))
                # The copy recorded the verified hash (archive_remote); an older index has none.
                expected = {kind: {'size': (p / kind).stat().st_size, 'mtime_ns': (p / kind).stat().st_mtime_ns, 'sha256': sha(DATA[kind])} for kind in DATA}
                self.assertEqual(m['content_hashes'], expected, label)
                if not fresh: m.pop('content_hashes')
                m['status'] = status; server.save_meta(p, m)
                before, sessions, read[:] = server.read_meta(p), len(self.sessions(id, 'fcamera.mp4')), []
                with patch.object(media_store, '_sha256', hashing): self.restart().run_cycle()
                after = server.read_meta(p)
                self.assertEqual(after['storage'], before['storage'], label)  # Every copy is kept.
                self.assertEqual(len(self.sessions(id, 'fcamera.mp4')), sessions, label)
                own = [path for path in read if path.parent == p]
                if fresh and status == 'ready': self.assertEqual((own, after), ([], before), label)
                else: self.assertEqual(sorted(path.name for path in own), sorted(DATA), label)
                # A read that matched records the hash (not while processing), so the next start reads nothing.
                self.assertEqual(after.get('content_hashes'), expected if (fresh or status == 'ready') else None, label)
                if status == 'ready':
                    read[:] = []
                    with patch.object(media_store, '_sha256', hashing), patch.object(media_store, '_digests', side_effect=AssertionError('read')):
                        self.restart().run_cycle()
                    self.assertEqual([path for path in read if path.parent == p], [], label + ': second start')
                    self.assertEqual(server.read_meta(p), after, label)

    def test_empty_file_never_stalls_the_cycle(self):
        # Drive never completes an empty upload: an empty file is skipped (one warning) and the cycle goes on.
        p = self.recording('f' * 32, data={'fcamera.mp4': b'', 'rlog.zst': LOG})
        q = self.recording('0' * 32)
        empty = media_store.entry(server.read_meta(p), 'fcamera.mp4')
        archiver = self.archiver()
        warnings = []
        for _ in range(2):
            with self.assertLogs(server.app.logger, 'INFO') as logs:
                server.app.logger.info('cycle'); result = archiver.run_cycle()
            warnings += [line for line in logs.output if 'is empty' in line]
            self.assertIsNone(result['stopped'])
        self.assertEqual(len(warnings), 1); self.assertIn(f'{p.name}/fcamera.mp4', warnings[0])
        m = server.read_meta(p)
        self.assertEqual(media_store.entry(m, 'fcamera.mp4'), empty); self.assertIsNone(media_store.remote(m, 'fcamera.mp4'))
        self.assertEqual((p / 'fcamera.mp4').read_bytes(), b''); self.assertEqual(self.sessions(p.name, 'fcamera.mp4'), [])
        self.assert_settled(p, False, 'its log', data={'rlog.zst': LOG})
        self.assert_settled(q, False, 'the next recording')
        self.assertIsNone(archiver.status()['last_error'])

    def test_probe_is_bounded_when_drive_stalls(self):
        # A request that needs Drive's state (here /video of a moved file) waits for one short probe, never for
        # retries: a stalled Drive answers unavailable within the probe timeout (shortened here; 15 s by default).
        self.assertLessEqual(ab.PROBE_TIMEOUT, 15)
        p = self.recording()
        self.assertIsNone(self.archiver(**MOVE).run_cycle()['stopped'])
        self.assertEqual(media_store.location(server.read_meta(p), 'fcamera.mp4'), 'gdrive')
        folder = self.backend.auth.folder_id
        with patch.object(ab, 'PROBE_TIMEOUT', 1):
            with self.drive.lock: self.drive.scenario.delay_seconds = 3
            try:
                self.backend.invalidate(); since = self.request_count()
                t0 = time.monotonic(); state = self.backend.probe(); elapsed = time.monotonic() - t0
                self.assertEqual(state, ('unavailable', 'network')); self.assertLess(elapsed, 2.5)
                with self.drive.lock: asked = [r for r in self.drive.requests[since:] if f'/files/{folder}' in r['path']]
                self.assertEqual(len(asked), 1)  # Not retried.
                self.backend.invalidate()
                t0 = time.monotonic(); r = self.client.get(f'/api/logs/{ID}/video?source=front', environ_overrides=PEER); elapsed = time.monotonic() - t0
                self.assertEqual((r.status_code, r.json['error']), (503, 'storage_unavailable')); r.close()
                self.assertLess(elapsed, 2.5)
            finally:
                with self.drive.lock: self.drive.scenario.delay_seconds = 0
        self.backend.invalidate()
        self.assertEqual(self.backend.probe(), ('connected', None))

    def test_leftover_nas_entry_under_gdrive_answers_503_and_recovery_goes_on(self):
        # (e) A file moved to the NAS before switching to Drive: unreachable now (503), never touched; the restart's
        # recovery and cycle carry on with every other file.
        p = self.recording(data={'rlog.zst': LOG})
        m = server.read_meta(p); media_store.set_location(m, 'fcamera.mp4', location='nas', bytes=500, sha256='0' * 64, archived_at=1.0); server.save_meta(p, m)
        nas = media_store.entry(m, 'fcamera.mp4')
        q = self.recording('b' * 32)
        with contextlib.ExitStack() as stack:
            writes, unlinks = self.watch(stack, p)
            archiver = self.restart()
            result = archiver.run_cycle()
            self.assertEqual(unlinks, [])
            self.assert_never_removed(writes, 'nas entry')
        self.assertIsNone(result['stopped']); self.assertIsNone(archiver.status()['last_error'])
        self.assert_settled(q, False, 'other recording')
        self.assert_settled(p, False, 'its log', data={'rlog.zst': LOG})
        self.assertEqual(media_store.entry(server.read_meta(p), 'fcamera.mp4'), nas)
        r = self.client.get(f'/api/logs/{p.name}/video?source=front', environ_overrides=PEER)
        self.assertEqual((r.status_code, r.json['error']), (503, 'storage_unavailable')); r.close()
        self.assertEqual(self.client.get('/api/logs', environ_overrides=PEER).status_code, 200)

if __name__ == '__main__': unittest.main()
