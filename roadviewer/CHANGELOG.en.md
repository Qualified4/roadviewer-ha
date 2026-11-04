# Release notes

[한국어 전체 변경 이력](CHANGELOG.md) · English

These are the current 0.13.x release notes. Earlier release entries remain in the [original Korean history](CHANGELOG.md); they describe behavior at their release date, not necessarily current behavior. See the [current user guide](DOCS.en.md) for present settings and policies.

## 0.13.3

- Moved the LF/FF/RF ground-anchor and estimated-size explanation into overlay settings. Matched lane probability/y[0] card heights, typography, and road-edge alignment.
- Reorganized storage management into status/connections, archiving basics, execution/advanced settings, and a current settings summary. Aligned desktop status-card height and bottom actions.
- Added explained COPY/MOVE choices, clarified local-delete permission and NAS move behavior, and provided retention/threshold/interval presets with custom inputs that preserve existing hour/minute/MB values.
- Visualized the archive threshold versus the Drive MOVE soft limit, with a live summary and distinct unsaved/saving/saved/failed/partially saved states. Retries save only remaining changes.
- Prevented manual archiving from unsaved settings. Existing APIs, policies, and MOVE/COPY engines are unchanged; no log analysis or video reconversion is required.
- Reused Playwright downloads and warmed main’s build, vulnerability database, and browser caches.

## 0.13.2

- Treated Google Drive MOVE as extension storage. Local limits are soft; reaching the quota or archive threshold requests the existing background archiver. Uploads may exceed the limit while disk space covers reservations, temporary files, and a 100 MiB safety margin.
- MOVE runs alongside uploads without duplication. Local files are deleted only after remote transfer, integrity verification, and index commit. Drive failure preserves originals and records; physical shortage rejects new uploads without deleting existing records.
- Automatic local cleanup never deletes Drive files or recordings referencing them. Remote deletion requires explicit permanent deletion. Unknown legacy deletion intents, pins, in-use protection, minimum age, and batch limits are preserved.
- Improved storage/readout presentation and browser-test parallelism; arm64 container checks use a native runner. Required checks and tested-image reuse remain unchanged.
- Updated Korean/English guidance and web asset versions. No reanalysis or reconversion is required. Previously enabled archiving continues under saved settings after updating.

## 0.13.1

- Moved archive settings into the web UI. OAuth client ID/secret remain app options; non-secret settings are stored in `/data/roadviewer/.archive-settings.json` (0600).
- Migrated old archive options once without overwriting an existing settings file. Invalid state disables archiving and reports an error. Settings are included in Home Assistant backups.
- Validated settings server-side and applied them without restart; saving is blocked during a cycle. Saving alone does not run an archive. MOVE requires explicit local-delete permission.
- Verified MOVE against real Drive in a test environment, including remote SHA-256, committed records, local deletion, Range playback, and original download. No reanalysis or reconversion is required.

## 0.13.0

- Added experimental NAS archiving and Google Drive integration, initially configured through app options. NAS moves verified videos first and rlog last, keeping metadata/prepared data local and protecting pins during NAS cleanup.
- Added remote connection, missing-video, and read-error states. An unreachable backend preserves files; downloads/conversion fail safely when the source cannot be reached.
- Added Google device-code OAuth using a user-supplied client and `drive.file` scope. COPY preserves local originals; MOVE requires explicit permission and verifies the uploaded copy before deleting local data.
- Added Range playback and downloads for remote-only files, plus deferred remote deletions and verification retries.
- These are historical release notes. The initial remote-eviction behavior was superseded by the extension-storage protection in **0.13.2**, and settings moved to the web UI in **0.13.1**.
