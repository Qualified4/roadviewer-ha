# Road Viewer

[한국어](README.md) · English

Feature reference: **0.12.2**

Replay and analyze openpilot logs with front/wide camera video inside Home Assistant.

## Quick start

**Add files or drag and drop → Upload → Convert → Play.** Automatic conversion is enabled by default.

Select `rlog.zst` and optional cameras from the same segment: `qcamera.ts`, high-quality front `fcamera.hevc`, and wide `ecamera.hevc`. Logs alone work; video-only and direct MP4 uploads do not. Multiple segments can be uploaded together. If a mobile file picker cannot return multiple files, add them one at a time.

## Features

- Synchronized video, road view and vehicle graphs, up to 4× speed
- Front/wide camera switching and calibrated camera overlays
- Lanes, model paths, radar points, LF/FF/RF boxes, blind spots and turn signals
- Automatic, side-by-side and stacked layouts, adjustable width and sticky playback controls
- 23 selectable/reorderable graphs and camera installation information
- Automatic/manual conversion, up to four concurrent jobs and lossless MP4 retention
- Later camera attachment, original-format export and log/video downloads
- Per-segment pins, bulk conversion/removal/deletion, storage budgets and cleanup
- Optional HTTPS device uploads with pairing

## Managing files

**Remove prepared data** deletes analysis/graphs and reproducible MP4s while preserving logs, TS/HEVC originals and each camera's sole MP4. Queued conversion is cancelled; removal is blocked while processing. **Completely delete** removes all files for that segment.

Use **로그 선택** at the bottom of settings for bulk actions. Pins are protected by default; explicitly enable **고정 항목도 삭제** to include them. Reopening the dialog restores protection.

Storage-policy eviction occurs only after upload receipt and validation, not on reservation requests alone. Pinned segments and queued/processing routes remain protected.

The web UI uses Home Assistant Ingress. External device HTTPS is off by default and configured inside the app only when needed.

**Original logs, videos and prepared data are excluded from Home Assistant app backups.** Keep originals separately. Processing/storage policies and device authentication configuration are backed up.

See the [user guide](DOCS.en.md) · [한국어](DOCS.md), or the app's Documentation tab. The [changelog](CHANGELOG.md) is in Korean.

## Platforms

Supports `amd64` (64-bit Intel/AMD) and `aarch64` (64-bit ARM). Installation/update downloads only the matching prebuilt image. Download/extraction progress presentation depends on Home Assistant/Supervisor.

## MP4 storage and downloads

Newly completed conversions remux qcamera H.264 and front/wide HEVC into MP4 without re-encoding. Verification compares SHA-256 hashes of compressed pictures and headers, packet counts and timestamps without decoding every frame; it does not screen the source for every possible decoding error. Originals are removed only after compressed-picture, decoder-header, packet-count and log-clock verification; failed sources and rlog.zst are preserved. With automatic conversion off, uploads remain in their uploaded form until manual conversion. HEVC playback requires browser/device support; playback failure switches to the low-resolution camera when available.

The bar stays visible from preparation until the large compressed files have been saved. With video, stage weights are preparation/decompression 0–4%, log reading 4–45%, frame analysis 45–60%, camera reading/remuxing/verification 60–80%, and graph generation, JSON encoding, compression/writes and replay compaction 80–100%. Log-only recordings redistribute the video share across reading, analysis and saving. Updates use consumed bytes, processed frames/samples and written bytes, with smooth transitions at roughly one-second intervals. Labels name the actual operation and show overall progress. Atomic completion of the large writes reaches 100%; the brief summary/registration phase hides the bar and keeps only the sweep effect. Heavy conversion work is completed before that final phase. These are work-based stage weights, not a remaining-time estimate.

Choose **다운로드** (Download) in the compact recording menu to select files and MP4/original format in a modal. **전체 선택** (Select all) and **선택 해제** (Clear selection) control the ZIP contents. Use **받기** beside a file to download it individually without ZIP; for multiple segments, expand **개별 받기** to choose a segment’s file. Original-format downloads remux f/e to HEVC and q to TS without re-encoding: quality is preserved, but bytes and hashes may differ from the uploaded file. Selected files stream as one ZIP without a persistent download copy. Bulk download uses the same modal for up to 150 selected segments, omitting absent cameras. Removing prepared data preserves each camera’s sole retained MP4.

Choose **로그 선택** (Select logs) at the bottom of settings. The first **로그 일괄 관리** (Bulk log management) dialog groups recordings by route, with route-level select-all and individual segment checkboxes. A minus indicates a partial selection; the top select-all/count and bottom action buttons stay visible while scrolling. Then choose **다운로드** (Download) to select files and format. Individual library and replay downloads keep the compact file/format popup for the current segment.
