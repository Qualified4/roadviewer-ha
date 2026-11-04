"""Archive preferences: migration, safe failures, API guards and live swaps. Temporary data only."""
import json, os, stat, subprocess, sys, tempfile, threading, unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_media_integration import make_log, PEER, HEADERS
import server, media_store, archive_settings as prefs
from storage_policy import atomic_json

PRODUCTION = dict(archive_enabled=True, archive_backend='gdrive', archive_mode='copy', archive_allow_local_delete=False,
                  archive_interval_minutes=1440, archive_batch=2, archive_min_age_hours=168,
                  archive_local_threshold_mb=3072, archive_gdrive_folder_name='Road Viewer')
SECRETS = dict(archive_gdrive_client_id='private-client-id', archive_gdrive_client_secret='private-client-secret')


class ArchiveSettingsTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(); self.addCleanup(temp.cleanup); self.root = Path(temp.name)
        self.path = self.root / prefs.FILENAME

    def install(self, options=None):
        options = {**SECRETS, **(options or {})}
        settings, marker, error = prefs.load(self.root, options)
        store = media_store.ArchiveStore(settings, self.root)
        backend = server.archive_backends.make_backend(settings, self.root, store=store)
        archiver = media_store.Archiver(server, store, settings, backend=backend)
        for name, value in dict(ROOT=self.root, options=options, archive_settings=settings, archive_migrated_from=marker,
                                archive_settings_error=error, store=store, backend=backend, archiver=archiver, connection=None).items():
            p = patch.object(server, name, value); p.start(); self.addCleanup(p.stop)
        self.client = server.app.test_client()
        return archiver

    def get(self): return self.client.get('/api/settings/archive', environ_overrides=PEER)
    def post(self, data): return self.client.post('/api/settings/archive', json=data, environ_overrides=PEER, headers=HEADERS)

    def test_production_migration_preserves_values_and_other_files(self):
        for name in ('.gdrive-auth.json', '.archive.json', 'index.json'):
            (self.root / name).write_bytes(b'unchanged fixture')
        p = make_log(self.root, 'a'*32, ['rlog.zst'], [])
        before = {f: f.read_bytes() for f in self.root.rglob('*') if f.is_file()}
        settings, marker, error = prefs.load(self.root, {**PRODUCTION, **SECRETS})
        self.assertIsNone(error); self.assertEqual(marker, 'options.json')
        for key, value in PRODUCTION.items(): self.assertEqual(prefs.values(settings)[key], value, key)
        self.assertEqual(settings.effective_mode, 'copy')
        for f, content in before.items(): self.assertEqual(f.read_bytes(), content)
        saved = json.loads(self.path.read_text())
        self.assertEqual(set(saved), prefs.KEYS | {'version', 'migrated_from'})
        self.assertFalse(set(saved) & SECRETS.keys()); self.assertNotIn('private-', self.path.read_text())
        self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o600)

    def test_disabled_stays_disabled(self):
        settings, _, error = prefs.load(self.root, {**PRODUCTION, 'archive_enabled': False})
        self.assertFalse(settings.enabled); self.assertIsNone(error)

    def test_defaults_and_missing_values_reuse_parser(self):
        settings, marker, error = prefs.load(self.root, {})
        self.assertEqual(settings, media_store.ArchiveSettings.from_options({}))
        self.assertEqual(marker, 'defaults'); self.assertIsNone(error)
        self.assertFalse(self.path.exists())  # Nothing to migrate: no file until the user saves.
        self.path.write_text(json.dumps({'archive_batch': 9}))
        loaded, _, error = prefs.load(self.root, PRODUCTION)
        self.assertEqual(loaded, media_store.ArchiveSettings.from_options({'archive_batch': 9})); self.assertIsNone(error)

    def test_existing_file_never_overwritten_by_options(self):
        prefs.load(self.root, {'archive_batch': 7})
        before = self.path.read_bytes()
        settings, _, error = prefs.load(self.root, {**PRODUCTION, 'archive_batch': 'invalid'})
        self.assertEqual(settings.batch, 7); self.assertFalse(settings.enabled); self.assertIsNone(error)
        self.assertEqual(before, self.path.read_bytes())

    def test_corrupt_or_invalid_file_disabled_and_untouched(self):
        for content in ('{broken', '[]', '{"archive_enabled":true,"archive_backend":"typo"}',
                        '{"archive_mode":"typo"}', '{"archive_batch":0}', '{"version":999}',
                        '{"version":true}', '{"migrated_from":[]}', '{"unknown":1}'):
            with self.subTest(content=content):
                self.path.write_text(content)
                settings, _, error = prefs.load(self.root, PRODUCTION)
                self.assertFalse(settings.enabled); self.assertEqual(settings.mode, 'copy')
                self.assertEqual(error, 'settings_error'); self.assertEqual(self.path.read_text(), content)

    def test_unreadable_file_disabled_and_untouched(self):
        self.path.mkdir()
        settings, _, error = prefs.load(self.root, PRODUCTION)
        self.assertFalse(settings.enabled); self.assertEqual(error, 'settings_error'); self.assertTrue(self.path.is_dir())

    def test_invalid_migration_does_not_write_defaults(self):
        for data in ({'archive_batch': 0}, {'archive_mode': 'typo'}, {'archive_enabled': 'true'},
                     {'archive_enabled': True, 'archive_path': '../recordings'}):
            settings, _, error = prefs.load(self.root, data)
            self.assertFalse(settings.enabled); self.assertEqual(error, 'settings_error'); self.assertFalse(self.path.exists())

    def test_get_hides_secrets(self):
        self.install(PRODUCTION)
        r = self.get(); self.assertEqual(r.status_code, 200); self.assertEqual(r.headers['Cache-Control'], 'no-store')
        self.assertEqual(set(r.json), prefs.KEYS | {'effective_mode', 'client_configured'})
        self.assertTrue(r.json['client_configured']); self.assertEqual(r.json['effective_mode'], 'copy')
        for secret in SECRETS.values(): self.assertNotIn(secret, r.text)

    def test_status_exposes_error_until_explicit_save(self):
        self.path.write_text('{bad'); self.install()
        self.assertEqual(self.get().json['settings_error'], 'settings_error')
        block = self.client.get('/api/settings/storage', environ_overrides=PEER).json['archive']
        self.assertFalse(block['enabled']); self.assertEqual(block['settings_error'], 'settings_error')
        self.assertEqual(self.path.read_text(), '{bad')
        self.assertEqual(self.post({'archive_mode': 'copy'}).status_code, 200)
        self.assertNotIn('settings_error', self.get().json)
        self.assertNotIn('settings_error', self.client.get('/api/settings/storage', environ_overrides=PEER).json['archive'])

    def test_guards(self):
        self.install()
        self.assertEqual(self.client.post('/api/settings/archive', json={}, environ_overrides=PEER).status_code, 403)
        self.assertEqual(self.client.post('/api/settings/archive', json={}, headers=HEADERS).status_code, 403)

    def test_validation_is_atomic_with_field_codes(self):
        # Migrated NAS settings (archiving off), so a file exists that invalid saves must not change; NAS paths are checked.
        self.install(dict(PRODUCTION, archive_enabled=False, archive_backend='smb'))
        before = self.path.read_bytes()
        cases = [('archive_enabled', 'true'), ('archive_allow_local_delete', 1), ('archive_backend', 'ftp'),
                 ('archive_mode', 'remove'), ('archive_batch', True), ('archive_batch', 0), ('archive_batch', 65),
                 ('archive_interval_minutes', 0), ('archive_interval_minutes', 1441), ('archive_min_age_hours', 8761),
                 ('archive_min_age_hours', 1.5), ('archive_local_threshold_mb', -1), ('archive_nas_max_mb', -1),
                 ('archive_nas_margin_mb', '1'), ('archive_gdrive_folder_name', '  '), ('archive_gdrive_folder_name', 'a'*256),
                 ('archive_path', 42), ('archive_path', '/share/NAS'), ('archive_path', '/share/NAS/../x'),
                 ('archive_path', '/tmp/recordings'), ('unknown', 1), ('archive_gdrive_client_id', 'leak')]
        with patch.dict(os.environ, {'RV_ARCHIVE_ALLOW_ANY_PATH': ''}):
            for key, value in cases:
                with self.subTest(key=key, value=value):
                    r = self.post({key: value, 'archive_mode': 'copy'} if key != 'archive_mode' else {key: value})
                    self.assertEqual(r.status_code, 400, r.json); self.assertIn(key, r.json['fields'])
                    self.assertEqual(self.path.read_bytes(), before)
            self.assertEqual(self.post({'archive_path': '/share/NAS/roadviewer', 'archive_enabled': True}).status_code, 200)
        self.assertEqual(self.client.post('/api/settings/archive', json=[], environ_overrides=PEER, headers=HEADERS).status_code, 400)

    def test_gdrive_path_validation_matches_from_options(self):
        self.install(PRODUCTION)
        # SMB-only paths are ignored by the existing Drive parser, including an invalid string.
        with patch.dict(os.environ, {'RV_ARCHIVE_ALLOW_ANY_PATH': ''}):
            self.assertIsNone(media_store.ArchiveSettings.from_options({**PRODUCTION, 'archive_path': '../ignored'}).error)
            self.assertEqual(self.post({'archive_path': '../ignored'}).status_code, 200)
            self.assertEqual(self.post({'archive_backend': 'smb', 'archive_path': '../ignored'}).status_code, 400)

    def test_partial_save_keeps_other_values_and_file_permissions(self):
        archiver = self.install(PRODUCTION); before = self.get().json
        self.assertEqual(self.post({'archive_enabled': False}).status_code, 200)
        self.assertFalse(archiver.settings.enabled); self.assertFalse(server.store.settings.enabled)
        self.assertEqual(archiver.run_cycle()['stopped'], 'disabled')
        after = self.get().json
        self.assertEqual({k: v for k, v in before.items() if k != 'archive_enabled'},
                         {k: v for k, v in after.items() if k != 'archive_enabled'})
        self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o600)

    def test_startup_with_production_options_preserves_token_without_activation(self):
        token = self.root / '.gdrive-auth.json'; token.write_text(json.dumps({'refresh_token': 'fixture-token', 'folder_id': 'fixture-folder'}))
        before = token.read_bytes()
        code = ('import archive_backends;'
                'archive_backends.DriveBackend.activate=lambda self:(_ for _ in ()).throw(AssertionError("activation at import"));'
                'import server,json;print(json.dumps(server.archive_preferences()))')
        env = {**os.environ, 'RV_DATA': str(self.root), 'RV_ARCHIVE_OPTIONS_JSON': json.dumps({**PRODUCTION, **SECRETS})}
        done = subprocess.run([sys.executable, '-c', code], cwd=Path(server.__file__).parent, env=env, capture_output=True, text=True, timeout=30)
        self.assertEqual(done.returncode, 0, done.stderr)
        data = json.loads(done.stdout)
        for key, value in PRODUCTION.items(): self.assertEqual(data[key], value)
        self.assertEqual(token.read_bytes(), before); self.assertFalse((self.root / '.archive.json').exists())

    def test_409_during_real_cycle_saves_nothing(self):
        archiver = self.install(PRODUCTION); started, release = threading.Event(), threading.Event()
        before = self.path.read_bytes()
        def cycle(result): started.set(); release.wait(5)
        with patch.object(archiver, '_cycle', side_effect=cycle):
            worker = threading.Thread(target=archiver.run_cycle); worker.start()
            try:
                self.assertTrue(started.wait(5)); r = self.post({'archive_mode': 'move', 'archive_allow_local_delete': True})
                self.assertEqual((r.status_code, r.json), (409, {'error': 'archive_running'}))
                self.assertEqual(self.path.read_bytes(), before); self.assertEqual(archiver.settings.effective_mode, 'copy')
            finally: release.set(); worker.join(5)

    def test_live_backend_swaps_keep_token_and_rewire_references(self):
        archiver = self.install(PRODUCTION)
        token = self.root / '.gdrive-auth.json'; token.write_text(json.dumps({'refresh_token': 'fixture-token'}))
        before = token.read_bytes()
        for data, kind in (({'archive_backend': 'smb', 'archive_path': str(self.root)}, 'smb'),
                           ({'archive_backend': 'gdrive'}, 'gdrive'), ({'archive_gdrive_folder_name': 'Other'}, 'gdrive')):
            old_backend = server.backend
            r = self.post(data); self.assertEqual(r.status_code, 200, r.json)
            self.assertIsNot(server.backend, old_backend); self.assertEqual(server.backend.caps.kind, kind)
            self.assertIs(archiver.backend, server.backend); self.assertIs(archiver.store, server.store)
            self.assertIs(archiver.settings, server.store.settings); self.assertIs(archiver.settings, server.archive_settings)
            self.assertEqual(archiver.remote, kind == 'gdrive'); self.assertEqual(token.read_bytes(), before)
            self.assertIs(server.storage_policy.s.store, server.store)
            if kind == 'gdrive':
                self.assertTrue(server.backend.auth.connected); self.assertIs(server.connection.backend, server.backend)
            else: self.assertIs(server.backend.store, server.store); self.assertIsNone(server.connection)

    def test_save_never_starts_cycle_activation_or_eviction(self):
        archiver = self.install(PRODUCTION)
        with patch.object(archiver, 'run_cycle') as cycle, patch.object(archiver, 'activate') as activate, \
             patch.object(server, 'delete_recording') as delete, patch.object(server, 'process_pending') as pending:
            for data in ({'archive_mode': 'move', 'archive_allow_local_delete': True}, {'archive_enabled': False},
                         {'archive_enabled': True, 'archive_interval_minutes': 99}):
                self.assertEqual(self.post(data).status_code, 200)
            for mocked in (cycle, activate, delete, pending): mocked.assert_not_called()
        self.assertEqual(archiver.settings.interval_seconds, 5940); self.assertTrue(archiver.settings.enabled)

    def test_persistence_across_new_process_ignores_stale_options(self):
        self.install(PRODUCTION)
        self.assertEqual(self.post({'archive_mode': 'move', 'archive_allow_local_delete': True, 'archive_interval_minutes': 13}).status_code, 200)
        code = 'import server,json;print(json.dumps(server.archive_preferences()))'
        env = {**os.environ, 'RV_DATA': str(self.root), 'RV_ARCHIVE_OPTIONS_JSON': json.dumps({**PRODUCTION, **SECRETS})}
        done = subprocess.run([sys.executable, '-c', code], cwd=Path(server.__file__).parent, env=env, capture_output=True, text=True, timeout=30)
        self.assertEqual(done.returncode, 0, done.stderr)
        result = json.loads(done.stdout); self.assertEqual(result['effective_mode'], 'move'); self.assertEqual(result['archive_interval_minutes'], 13)

    def test_write_failure_keeps_runtime_settings(self):
        archiver = self.install(PRODUCTION); before = self.path.read_bytes(); old = archiver.settings
        with patch.object(server, 'atomic_json', side_effect=OSError('fixture failure')):
            self.assertEqual(self.post({'archive_mode': 'move'}).status_code, 500)
        self.assertIs(archiver.settings, old); self.assertEqual(before, self.path.read_bytes())

    def test_scheduler_honours_live_interval_and_enabled_without_immediate_work(self):
        archiver = self.install(PRODUCTION); now = [0]; runs = []
        class Stop:
            def wait(_, timeout):
                now[0] += timeout
                if now[0] == 3: self.assertEqual(self.post({'archive_interval_minutes': 1, 'archive_enabled': False}).status_code, 200)
                if now[0] == 65: self.assertEqual(self.post({'archive_enabled': True, 'archive_interval_minutes': 2}).status_code, 200)
                return now[0] >= 190
        def run():
            if archiver.settings.enabled: runs.append(now[0])
        with patch.object(server, 'cleanup_stop', Stop()), patch.object(media_store.time, 'monotonic', lambda: now[0]), \
             patch.object(archiver, 'run_cycle', side_effect=run), patch.object(archiver, 'activate') as activate:
            archiver._loop(); activate.assert_not_called()
        self.assertEqual(runs, [185])

    def test_eviction_observes_mode_only_after_swap(self):
        self.install(PRODUCTION)
        entered, release, evicted = threading.Event(), threading.Event(), threading.Event()
        p = make_log(self.root, 'a'*32, [], [])
        m = server.read_meta(p)
        media_store.set_location(m, 'rlog.zst', location='gdrive', file_id='fixture-file', bytes=10)
        server.save_meta(p, m)
        modes = []; replies = []
        def write(path, data):
            modes.append(server.backend.settings.effective_mode); entered.set(); release.wait(5); atomic_json(path, data)
        def evict():
            with server.registration_lock, server.lock:
                modes.append(server.backend.settings.effective_mode); server.delete_recording(p.name); evicted.set()
        with patch.object(server, 'atomic_json', side_effect=write):
            saver = threading.Thread(target=lambda: replies.append(self.post({'archive_mode': 'move', 'archive_allow_local_delete': True})))
            saver.start(); self.assertTrue(entered.wait(5))
            worker = threading.Thread(target=evict); worker.start()
            try: self.assertFalse(evicted.wait(.05)); self.assertEqual(server.archiver.settings.effective_mode, 'copy')
            finally: release.set(); saver.join(5); worker.join(5)
        self.assertEqual(replies[0].status_code, 200); self.assertEqual(modes, ['copy', 'move'])
        self.assertEqual(media_store.PendingDeletes(self.root).count(), 1)


class BackupInclusionTests(unittest.TestCase):
    def test_settings_and_token_files_are_not_excluded_from_backups(self):
        # backup_exclude drops recording folders by a hex-prefix glob; the preferences must stay in the backup.
        import fnmatch, re
        text = (Path(__file__).resolve().parents[1] / 'roadviewer' / 'config.yaml').read_text(encoding='utf-8')
        block = text.split('backup_exclude:', 1)[1]
        patterns = re.findall(r'^\s+-\s+"([^"]+)"', block.split('\n\n', 1)[0], re.M)
        self.assertIn('roadviewer/[0-9a-f]*', patterns)
        for name in (prefs.FILENAME, '.gdrive-auth.json', '.archive.json'):
            with self.subTest(name=name):
                self.assertFalse(any(fnmatch.fnmatch('roadviewer/' + name, p) for p in patterns))


if __name__ == '__main__': unittest.main()
