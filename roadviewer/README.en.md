# Road Viewer

[한국어](README.md) · English

Feature reference: **0.6.0**

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
- Automatic/manual conversion, up to four concurrent jobs and optional TS/HEVC retention
- Later camera attachment, missing-original restoration and log/video downloads
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
