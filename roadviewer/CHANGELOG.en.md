# Release notes

[한국어 전체 변경 이력](CHANGELOG.md) · English

These are the current 0.13.x release notes. Earlier release entries remain in the [original Korean history](CHANGELOG.md); they describe behavior at their release date, not necessarily current behavior. See the [current user guide](DOCS.en.md) for present settings and policies.

## 0.13.14

- Google Drive playback responses now stay in the browser's private cache for one hour instead of a day. Seeks into ranges received while watching stay immediate; after an hour they come from Drive again.

## 0.13.13

- Fixed seeks in Google Drive videos waiting seconds even into ranges the seek bar shows as loaded (grey). Chromium-based browsers (Whale, Samsung Internet and others) drop played ranges from memory but keep showing them, and the Drive video response forbade the browser cache (no-store), so each such seek went back to Google. Playback responses may now stay in the browser's private cache for a day, so seeks into ranges already received are immediate. Downloads are still never cached.

## 0.13.12

- Faster seeking in Google Drive videos. Playback reuses a file's Drive metadata for 30 seconds, so a seek is one round trip to Google; bytes are passed on in 64 KB blocks instead of after each 1 MB; playback ranges are answered at most 16 MB at a time so a request dropped on a seek no longer streams the rest of the file from Drive while holding the server; releasing the seek bar goes straight to the final position instead of waiting for the preview seek in flight.

## 0.13.11

- Saved logs now show their route groups folded by default. Only routes opened by hand are remembered as open; folds saved by earlier versions are not used, so every route starts folded after the update.
- Fixed Google Drive videos failing on first open with "cannot connect to the video store" until a reload. A video request now waits for a Drive check already in progress, and the replay retries by itself while the store is still being checked. When Drive really is unreachable the message names Google Drive instead of the NAS.

## 0.13.10

- In storage management, the Google Drive mode note and Disconnect button moved from the local storage card to the extended storage (Google Drive) card; with archiving off they form a Google Drive card of their own. Opening the run and copy details no longer shifts the local storage card, and its figures line up in equal columns and full-width rows.

## 0.13.9

- Separate route headers from individual segments with distinct backgrounds, a top divider, indentation, and a vertical guide for the expanded list.
- Differentiate route and segment title sizes and refine row spacing. Preserve existing controls and folding on mobile, tablet, and desktop. No log analysis or video reconversion is required.

## 0.13.8

- Keep route-header buttons visible in both fold states. The header height and button elements stay stable while only the segment list expands/collapses, and rapid reversals continue from the current height.
- Prevent row-insertion effects from replaying on expansion. Changes to another segment’s processing state no longer replace header buttons unnecessarily, preserving focus and avoiding flicker.
- Distinguish pins using icons only: yellow background and pin for all pinned, a yellow pin without highlighted background for partial pins, and a neutral pin for none. Remove the tiny partial label while preserving counts in accessible labels and tooltips.
- Preserve per-segment playback, pins, conversion, and downloads, and strengthen browser regression coverage. No log analysis or video reconversion is required.

## 0.13.7

- Group stored segments by full route ID with collapsible sections. The first segment’s upload date/time and segment count stay visible when collapsed; the browser remembers fold state.
- Play the first segment and pin/unpin every currently stored segment in the route from its collapsed header. Partial pins become fully pinned; failures show completed counts and retain an accurate partial state.
- A direct download icon opens the existing multi-segment download dialog for the route. Playback stays content-sized, while expanded-row pins and management menus remain segment-specific.
- Preserve tag filters, live status updates, mobile/keyboard interaction, and existing per-segment controls. No log analysis or video reconversion is required.

## 0.13.6

- Opening storage management now measures Google Drive usage in the background when there is no figure or it is older than 5 minutes. It shows "measuring" meanwhile and refreshes when done, fixing "0 B / quota unknown" after a restart until the first archive cycle. Nothing is moved or copied; accounts for which Google reports no total quota still show it as unknown.

## 0.13.5

- Fixed the Drive/NAS status staying at "checking" in storage management. While the server probes the archive in the background, the panel asks again shortly, so it settles to connected/unavailable without reopening. Connection and archiving behavior are unchanged.

## 0.13.4

- Replaced "Archive now" with "Move all eligible data" ("Copy all eligible data" in COPY). It runs the existing MOVE/COPY engine until every eligible file is processed, without the scheduled batch size or local threshold, while keeping the minimum age and pinned-log protection. The scheduled interval, batch, and threshold are unchanged.
- A confirmation first shows file and segment counts, size, expected local space freed in MOVE, whether local files are really deleted, and excluded records; nothing runs until confirmed. Drive MOVE without local deletion allowed is announced as a copy.
- Progress and processed/succeeded/failed counts are shown; a second run and settings changes are refused meanwhile. Failed files keep their originals, and Drive outages, expired sign-in, or a full NAS stop the run safely. The run state is stored on the server, survives reloads, and a run cut short by a restart shows as interrupted. Remote files are never deleted and verified remote copies are not uploaded again.
- Refreshed the Korean/English guides and UI screenshots. Stabilized the Drive panel test with a fake browser clock and rebalanced CI browser groups.

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
