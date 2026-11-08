# Road Viewer

[한국어](README.md) · English

Feature reference: **1.0.16**

Replay and analyze openpilot logs with front/wide camera video inside Home Assistant.

## Quick start

**On the 업로드 (Upload) tab: Add files or drag and drop → Upload → Convert → Play.** Automatic conversion is enabled by default. The screen is split into **로그 · 업로드 · 저장공간 · 장치 · 설정** (Logs, Upload, Storage, Devices, Settings) tabs, shown as a bottom tab bar on phones.

Select the segment's `rlog.zst` with whichever videos you need (`qcamera.ts`, high-quality front `fcamera.hevc`, wide `ecamera.hevc`). Log-only uploads are supported. Per-camera MP4s can be re-uploaded with the same segment's rlog, but video-only registration is not supported. A qcamera MP4 must be H.264 and front/wide MP4s HEVC. Several segments can be selected together; if a mobile file picker does not allow multiple selection, add files one at a time.

## Features

- Synchronized video, road view and vehicle graphs, up to 4× speed
- Front/wide camera switching and calibrated camera overlays, with a default quality per connection (small qcamera on mobile data, high-quality front on Wi-Fi/wired)
- Lanes, model paths, radar points, LF/FF/RF boxes, blind spots and turn signals
- Compact app bar (start time · 구간 k (i/N), view and ⋯ menus) and a floating playback bar (segment strip, automatic-control/takeover track, bookmark markers)
- Automatic, side-by-side and stacked layouts with adjustable width; Auto/Light/Dark display mode (the video area stays dark)
- 24 selectable/reorderable graphs and camera installation information
- Automatic/manual conversion, up to four concurrent jobs and lossless MP4 retention
- Later camera attachment, original-format export and log/video downloads
- Segment tags and scene bookmarks on the bookmark tab
- Search, filter chips and route cards grouped by date (thumbnail, start time, segment status bar, automatic-control ratio and takeover count, folded by default) with per-segment storage location chips (local, Drive, NAS); thumbnails and start times of older or archived logs are backfilled in the background
- Per-segment pins, in-list selection mode for bulk tags/download/conversion/removal/deletion, a remove/download/completely-delete ⋯ menu on the replay screen, storage budgets and cleanup
- Experimental archiving that copies or moves older recordings to Google Drive or a NAS, with Drive connect/disconnect
- Optional HTTPS device uploads with pairing
- MCP server for AI agents: [roadviewer-mcp](https://github.com/Qualified4/roadviewer-mcp) (separate project, using only the existing Ingress login and API)

## Managing files

**Remove prepared data** deletes analysis/graphs and reproducible MP4s while preserving logs, TS/HEVC originals and each camera's sole MP4. Queued conversion is cancelled; removal is blocked while processing. **Completely delete** removes all files for that segment.

Press **선택** (Select) on the Logs tab, or long-press a segment on touch screens, to enter selection mode and use the bottom action bar for bulk actions. Pins are protected by default; explicitly enable **고정 포함** (Include pinned) to include them. Starting selection mode again restores protection.

Outside effective Drive MOVE, storage-policy eviction occurs only after upload receipt and validation, not on reservations alone. Pinned segments, queued/processing routes, and recordings referencing Drive are protected. Drive MOVE uses the soft-limit behavior described below.

The web UI uses Home Assistant Ingress. External device HTTPS is off by default and configured inside the app only when needed.

**Original logs, videos and prepared data are excluded from Home Assistant app backups.** Keep originals separately. Processing/storage policies and device authentication configuration are backed up.

See the [user guide](DOCS.en.md) · [한국어](DOCS.md), or the app's Documentation tab. See [current release notes](CHANGELOG.en.md) or the [full Korean history](CHANGELOG.md).

## Platforms

Supports `amd64` (64-bit Intel/AMD) and `aarch64` (64-bit ARM). Installation/update downloads only the matching prebuilt image. Download/extraction progress presentation depends on Home Assistant/Supervisor.

## MP4 storage and downloads

Newly completed conversions remux qcamera H.264 and front/wide HEVC into MP4 without re-encoding. Verification compares SHA-256 hashes of compressed pictures and headers, packet counts and timestamps without decoding every frame; it does not screen the source for every possible decoding error. Originals are removed only after compressed-picture, decoder-header, packet-count and log-clock verification; failed sources and rlog.zst are preserved. With automatic conversion off, uploads remain in their uploaded form until manual conversion. HEVC playback requires browser/device support; playback failure switches to the low-resolution camera when available.

The bar stays visible from preparation until the large compressed files have been saved. With video, stage weights are preparation/decompression 0–4%, log reading 4–45%, frame analysis 45–60%, camera reading/remuxing/verification 60–80%, and graph generation, JSON encoding, compression/writes and replay compaction 80–100%. Log-only recordings redistribute the video share across reading, analysis and saving. Updates use consumed bytes, processed frames/samples and written bytes, with smooth transitions at roughly one-second intervals. Labels name the actual operation and show overall progress. Atomic completion of the large writes reaches 100%; the brief summary/registration phase hides the bar and keeps only the sweep effect. Heavy conversion work is completed before that final phase. These are work-based stage weights, not a remaining-time estimate.

Choose **다운로드** (Download) in a segment's ⋯ menu to select files and MP4/original format in a modal. **전체 선택** (Select all) and **선택 해제** (Clear selection) control the ZIP contents. Use **받기** beside a file to download it individually without ZIP; for multiple segments, expand **개별 받기** to choose a segment’s file. Original-format downloads remux f/e to HEVC and q to TS without re-encoding: quality is preserved, but bytes and hashes may differ from the uploaded file. Selected files stream as one ZIP without a persistent download copy. Selection-mode download uses the same modal for up to 150 selected segments, omitting absent cameras. Removing prepared data preserves each camera’s sole retained MP4.

In selection mode, route-card checkboxes select a whole route and segment checkboxes single segments; a minus indicates a partial selection. Choose **다운로드** (Download) in the bottom action bar to select files and format. Segment ⋯ menu and replay downloads keep the compact file/format popup for the current segment.

## Storage settings

Status, archiving basics, execution/advanced controls, and a live summary make up the storage screen. Presets preserve existing custom values. Review the summary, then save; unsaved edits never start manual archiving. Tags classify segments and bookmarks return to log timestamps; neither replaces pin protection.

**Google Drive MOVE is extension storage for local data.** With Drive MOVE and permission to delete local originals configured, the local maximum is a **soft limit**. When archiving is enabled, reaching that limit or the archive start threshold requests a background move through the existing archiver; when both are positive, the lower value is used. Uploads can temporarily exceed the limit while physical disk space covers other uploads’ outstanding reservations, temporary files, and a **100 MiB safety margin**. Admission does not wait for a Drive transfer to finish.

MOVE deletes only the corresponding local file after remote transfer, integrity verification, and index commit. Minimum age, pin/in-use protection, batch limits, and the shared cycle lock remain enforced. Drive outages and verification failures preserve originals and records. Uploads continue while physical headroom is sufficient; otherwise new uploads are rejected without deleting existing records. Disabling archiving prevents moves; configured Drive MOVE still uses the soft limit, with physical disk headroom controlling upload admission.

Moved recordings **remain listed, playable, and downloadable**. Automatic local reclamation never deletes Drive files or recordings referencing them, including COPY references. Only explicit **Completely delete** can enqueue remote deletion. Unattributed deletion intents from older versions are retained without automatic execution.

Other policies retain upload rejection or validated-commit eviction of eligible unpinned data. See the [full guide](DOCS.en.md#reading-the-storage-screen).
