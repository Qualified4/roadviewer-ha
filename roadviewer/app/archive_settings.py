"""Non-secret archive preferences, strict validation and one-time options migration."""
import json
from dataclasses import replace
from media_store import ArchiveSettings, MB
from storage_policy import atomic_json

FILENAME = '.archive-settings.json'
VERSION = 1
RANGES = {'archive_local_threshold_mb': (0, None), 'archive_min_age_hours': (0, 8760),
          'archive_interval_minutes': (1, 1440), 'archive_batch': (1, 64),
          'archive_nas_max_mb': (0, None), 'archive_nas_margin_mb': (0, None)}


def values(s):
    return dict(archive_enabled=s.enabled, archive_backend=s.backend, archive_mode=s.mode,
                archive_allow_local_delete=s.allow_local_delete, archive_path=str(s.path) if s.path else '',
                archive_local_threshold_mb=s.local_threshold_bytes // MB, archive_min_age_hours=s.min_age_seconds // 3600,
                archive_interval_minutes=s.interval_seconds // 60, archive_batch=s.batch,
                archive_nas_max_mb=s.nas_max_bytes // MB, archive_nas_margin_mb=s.nas_margin_bytes // MB,
                archive_gdrive_folder_name=s.gdrive_folder_name)


KEYS = frozenset(values(ArchiveSettings.from_options({})))


def validate(body):
    """Check types/ranges before from_options can coerce or clamp invalid input."""
    if not isinstance(body, dict): return {'_body': 'expected_object'}
    errors = {key: 'unknown_field' for key in body.keys() - KEYS}
    for key, value in body.items():
        if key not in KEYS: continue
        if key in RANGES:
            lo, hi = RANGES[key]
            if type(value) is not int: errors[key] = 'expected_integer'
            elif value < lo or hi is not None and value > hi: errors[key] = 'out_of_range'
        elif key in ('archive_enabled', 'archive_allow_local_delete'):
            if type(value) is not bool: errors[key] = 'expected_boolean'
        elif not isinstance(value, str): errors[key] = 'expected_string'
        elif key == 'archive_backend' and value not in ('smb', 'gdrive'): errors[key] = 'invalid_enum'
        elif key == 'archive_mode' and value not in ('move', 'copy'): errors[key] = 'invalid_enum'
        elif key == 'archive_gdrive_folder_name' and not 1 <= len(value.strip()) <= 255: errors[key] = 'invalid_length'
    if not errors:
        parsed = ArchiveSettings.from_options(body)
        if parsed.error: errors['archive_path'] = parsed.error
    return errors


def document(settings, migrated_from):
    return dict(values(settings), version=VERSION, migrated_from=migrated_from)


def load(root, options):
    """An existing file is authoritative, including when it cannot be read safely."""
    path = root / FILENAME
    try:
        try:
            data = json.loads(path.read_text(encoding='utf-8'))
        except FileNotFoundError:
            data = {k: options[k] for k in KEYS if k in options}
            marker = 'options.json' if data else 'defaults'
        else:
            if (not isinstance(data, dict) or type(data.get('version', VERSION)) is not int
                    or data.get('version', VERSION) != VERSION):
                raise ValueError('invalid_document')
            marker = data.get('migrated_from', 'web')
            if not isinstance(marker, str) or marker not in ('options.json', 'defaults', 'web', 'error'):
                raise ValueError('invalid_marker')
            data = {k: v for k, v in data.items() if k not in ('version', 'migrated_from')}
            errors = validate(data)
            if errors: raise ValueError('invalid_settings')
            return parse(data, options), marker, None
        if validate(data): raise ValueError('invalid_settings')
        settings = parse(data, options)
        atomic_json(path, document(settings, marker))
        return settings, marker, None
    except (OSError, ValueError, TypeError):
        # Never recover a bad preference file from stale options, or write over it.
        return replace(parse({}, options), enabled=False, mode='copy'), 'error', 'settings_error'


def parse(data, options):
    credentials = {k: options.get(k, '') for k in ('archive_gdrive_client_id', 'archive_gdrive_client_secret')}
    return ArchiveSettings.from_options({**data, **credentials})
