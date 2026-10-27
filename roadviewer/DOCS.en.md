# Installation and use

This guide describes **0.12.0**.

[한국어](DOCS.md) · English

Start with **Add files → Upload → Convert → Play**. The application currently uses Korean UI labels; their English meanings are given below.

## Installation and access

Add `https://github.com/Qualified4/roadviewer-ha` to the Home Assistant app store repositories, install **Road Viewer**, start it, then open its web UI. Some Home Assistant versions call apps “add-ons.” This is not a HACS integration. Home Assistant Container does not provide the Supervisor app store.

Supported platforms are **amd64** (64-bit Intel/AMD) and **aarch64** (64-bit ARM). Installation downloads only the matching prebuilt GHCR image. ARM 32-bit and i386 are unsupported. Home Assistant may display download/extraction progress; it is not a reliable estimate of total startup time.

The UI uses Home Assistant Ingress, including remote access through your existing Home Assistant address. It needs no separate public Road Viewer port. External device HTTPS is optional and separate.

For local source builds, copy `roadviewer` to `/addons/roadviewer` and remove `image:` from that copy's `config.yaml`. Keeping it selects the published image instead of the local source.

## Uploading files

Use **파일 추가** (Add files), or drag files onto the upload area, then press **업로드** (Upload). Selection does not start transmission. Files can be added together or one at a time. **선택 비우기** clears the selection; adding a selected filename again replaces that selection. Folder selection is unsupported.

| File | Purpose |
|---|---|
| `rlog.zst` | Required driving log |
| `qcamera.ts` | Optional low-bandwidth front video |
| `fcamera.hevc` | Optional high-quality front video |
| `ecamera.hevc` | Optional wide video |

Downloaded `qcamera.mp4` (or `camera.mp4`), `fcamera.mp4`, and `ecamera.mp4` can be uploaded again with the matching `rlog.zst`. Low-resolution front MP4 uses H.264; front/wide MP4 uses HEVC. Select one format per camera; existing camera files are not overwritten. Driver-camera uploads remain unsupported. One segment may use the bare filenames above. Multiple segments use their original route/segment identifiers:

```text
0000035f--b513269850--0--rlog.zst
0000035f--b513269850--0--qcamera.ts
0000035f--b513269850--0--fcamera.hevc
0000035f--b513269850--0--ecamera.hevc
0000035f--b513269850--5--rlog.zst
```

Mixed routes and nonconsecutive segments are supported.

- **Log only:** conversion produces road and vehicle information without video.
- **Add video later:** send the same log with the additional video. It attaches to the existing recording rather than creating another log.
- **Video only:** rejected; include the matching log.
- Re-uploading the same source video checks its saved hash and preserves the retained MP4 and replay data without storing another original copy. Use the download modal for original-format files.
- **Different video:** existing camera data is not overwritten. To replace it, completely delete that recording and upload it again.

Duplicates are detected using the compressed rlog's SHA-256. Renaming identical content does not create another recording; recompression may change the hash. Browser deduplication happens after transfer, so it saves storage/conversion rather than transfer bandwidth. Missing-video attachment are exceptions to ordinary duplicate skipping.

### Limits and recovery

| Item | Limit |
|---|---|
| Browser selection | 100 files |
| Browser batch total | Default 512 MiB; `max_upload_mb` supports 16–2048 |
| Decompressed log | 512 MiB |
| Conversion worker | 10 minutes per job |
| Transfer chunk | 256 KiB |
| Device batch | 50 segments, 200 files, 8 GiB total |
| Device video file | 2 GiB; each rlog must fit `max_upload_mb` |

The UI's MB/GB settings use powers of 1024. The upload limit is distinct from the storage budget. Device limits do not bypass available disk space or storage policy.

If Android's native file picker cannot return multiple files, add one at a time. Closing the app or losing access to a selected file can interrupt uploads; after reopening, select the files again. An unchanged browser session can retry interrupted chunks. No-progress transfers are aborted after 15 seconds and retried up to five times, with delays starting at one second and capped at four seconds. Slow but progressing transfers are retained.

## Library and conversion

`00000395--0d0eda17c5--7` is displayed as **395 / 구간 7**. The copy icon copies the full original identifier, including leading zeros and the hash.

**새로고침** refreshes the list, state, sizes and conversion settings; it does not reload the page or restart conversion. The list refreshes about every three seconds, and active conversion progress about every second.

The header reports Road Viewer file usage, including originals, prepared data and temporary uploads—not whole-disk utilization. Each recording separately reports retained files and removable prepared data. **영상 있음** indicates that any supported original or MP4 exists, not that conversion is complete. A log-only recording can also become playable.

Choose **다운로드** (Download) in the compact recording menu to select files and MP4/original format in a modal. **전체 선택** (Select all) and **선택 해제** (Clear selection) control the ZIP contents. Use **받기** beside a file to download it individually without ZIP; for multiple segments, expand **개별 받기** to choose a segment’s file. Original-format downloads remux f/e to HEVC and q to TS without re-encoding: quality is preserved, but bytes and hashes may differ from the uploaded file. Selected files stream as one ZIP without a persistent download copy. Bulk download uses the same modal for up to 150 selected segments, omitting absent cameras. Removing prepared data preserves each camera’s sole retained MP4.

In the download popup, use route-level select-all and individual segment checkboxes to change the scope. A minus indicates a partial selection; select-all, the selected count and the download button stay visible while scrolling. Replay initially selects the current segment; bulk management preserves the segments you selected.

### Conversion and storage settings

Newly completed conversions remux qcamera H.264 and front/wide HEVC into MP4 without re-encoding. Verification compares SHA-256 hashes of compressed pictures and headers, packet counts and timestamps without decoding every frame; it does not screen the source for every possible decoding error. Originals are removed only after compressed-picture, decoder-header, packet-count and log-clock verification; failed sources and rlog.zst are preserved. With automatic conversion off, uploads remain in their uploaded form until manual conversion. HEVC playback requires browser/device support; playback failure switches to the low-resolution camera when available.

- **자동 변환:** enabled by default. Eligible recordings are queued oldest-upload first. Disabling clears automatic queued work; running and manually requested work continue.
- **동시 처리 개수:** 1–4, default 1. Lowering the limit does not interrupt running jobs. Settings survive restart; parallel jobs may finish out of order.
Choose **다운로드** (Download) in the compact recording menu to select files and MP4/original format in a modal. **전체 선택** (Select all) and **선택 해제** (Clear selection) control the ZIP contents. Use **받기** beside a file to download it individually without ZIP; for multiple segments, expand **개별 받기** to choose a segment’s file. Original-format downloads remux f/e to HEVC and q to TS without re-encoding: quality is preserved, but bytes and hashes may differ from the uploaded file. Selected files stream as one ZIP without a persistent download copy. Bulk download uses the same modal for up to 150 selected segments, omitting absent cameras. Removing prepared data preserves each camera’s sole retained MP4.

Processing options save immediately; storage budget/policy have their own Save button. Failed videos retain their uploaded originals.

| State | Meaning |
|---|---|
| 미변환 | Originals retained; manual conversion is available |
| 대기 중 | Queued; removal cancels this queued conversion |
| 처리 중 | Reading, analysis, video preparation/verification or finalization |
| 재생 가능 | Playback data is ready, including log-only recordings |
| 변환 실패 | Inspect the error, then retry conversion |

The bar stays visible from preparation until the large compressed files have been saved. With video, stage weights are preparation/decompression 0–4%, log reading 4–45%, frame analysis 45–60%, camera reading/remuxing/verification 60–80%, and graph generation, JSON encoding, compression/writes and replay compaction 80–100%. Log-only recordings redistribute the video share across reading, analysis and saving. Updates use consumed bytes, processed frames/samples and written bytes, with smooth transitions at roughly one-second intervals. Labels name the actual operation and show overall progress. Atomic completion of the large writes reaches 100%; the brief summary/registration phase hides the bar and keeps only the sweep effect. Heavy conversion work is completed before that final phase. These are work-based stage weights, not a remaining-time estimate.

### Individual and bulk actions

The primary action is Play or Convert. The adjacent dropdown contains removal, downloads and complete deletion when applicable.

| Action | Effect |
|---|---|
| 변환 | Build replay data; use originals or a retained sole MP4 |
| 제거 / 변환 데이터 제거 | Delete analysis/graphs and MP4s that can be recreated from their originals. Preserve originals and a camera's sole MP4. Cancel queued work; reject removal of actively processing work |
| 완전 삭제 | Permanently delete the segment's originals and prepared data; cancel its work |

Manually removed recordings are excluded from automatic conversion until Convert is requested.

Use **로그 선택** at the bottom of settings for bulk actions. Select-all and action controls remain visible while scrolling. **고정 항목도 삭제** is off whenever the dialog opens: pinned segments are protected from bulk removal/deletion unless explicitly included. This does not affect bulk conversion. Individual dropdown actions can explicitly delete pinned recordings.

Choose **다운로드** (Download) in the compact recording menu to select files and MP4/original format in a modal. **전체 선택** (Select all) and **선택 해제** (Clear selection) control the ZIP contents. Use **받기** beside a file to download it individually without ZIP; for multiple segments, expand **개별 받기** to choose a segment’s file. Original-format downloads remux f/e to HEVC and q to TS without re-encoding: quality is preserved, but bytes and hashes may differ from the uploaded file. Selected files stream as one ZIP without a persistent download copy. Bulk download uses the same modal for up to 150 selected segments, omitting absent cameras. Removing prepared data preserves each camera’s sole retained MP4.

During a bulk operation selection and closing are locked. Results show completed, skipped and incomplete counts; failed items remain selected.

## Segment tags

Use the tag icon beside a recording name in the library or replay screen. A segment supports up to 100 tags, each up to 32 characters, with 12 colors and suggestions from existing tags. Click a selected tag to edit its name or color. Whitespace is normalized and names differing only by letter case are deduplicated.

Use **태그 필터** (Tag filter) to show a particular tag or **태그 없음** (Untagged). For bulk editing, open **로그 선택**, select segments, then choose **태그 편집** and Add or Remove. Only the selected tags change; unrelated tags and pins remain intact. Partial failures retain successful changes, and retry targets only the failed segments.

Tags are stored in server-side segment metadata and survive conversion, reconversion and prepared-data removal. Complete deletion removes them with the recording. These are segment tags, not camera-specific tags or timeline bookmarks.

The web UI bundles Pretendard Variable 1.3.9 for Korean text without contacting an external CDN. The initial font transfer is approximately 1.96 MiB; subsequent loads use the browser cache. Its SIL Open Font License is included with the [official release](https://github.com/orioncactus/pretendard/releases/tag/v1.3.9).

## Scene bookmarks

Choose **북마크** (Bookmarks) beside the seek bar to capture the current log time. Enter a title (up to 80 characters) and an optional note (up to 1,000 characters). The captured time stays fixed during playback; **현재 시각으로** updates it to the current playhead. Each segment supports up to 100 bookmarks.

Click a gold seek-bar marker or an entry in the chronological list to seek video, road view and graphs together, preserving playing or paused state. Entries can be edited or deleted from the dialog.

Bookmarks use log time rather than camera time and are stored in segment metadata. They survive camera switching, reconversion and prepared-data removal; complete recording deletion removes them. No reanalysis is required.

## Video playback and layout

Playback prefers high-quality front, then qcamera, then wide. When multiple sources are available, use the selector below the video. Switching preserves log time and playing/paused state using each camera's time offset. A failing source triggers an attempt to use another available video.

Before playback is ready, the control area shows a message instead of active playback controls. The seek bar shows buffered video ranges. Errors provide a refresh action.

The top navigation includes the library, segment selector, Pin and previous/next recording buttons. Neighbors within the same route are labeled previous/next **segment**. Pins are per segment and shared with the library.

The heading becomes sticky while scrolling. Its center arrow/title-information row toggles navigation buttons, excluding the copy control. The arrow is hidden at the page top; collapsed state is remembered. The arrow alone brightens on interaction. Collapsed and expanded states use their corresponding heading rows for sticky positioning. Top and bottom sticky backgrounds share the configured width.

The fixed playback bar supports play/pause, frame stepping, seeking and speeds up to 4×. Seeking preserves the playing/paused state. Short boundary mismatches are tolerated; real gaps or missing tails are not invented.

Both layout toggles off means automatic responsive layout. **좌우 분할** shows video and analysis side by side; **상하 분리** stacks them. **화면 폭** opens a stable slider dialog:

| Viewport | Width adjustment | Default |
|---|---|---|
| Up to 600px | 50–100% | 100% |
| 601–1280px | 320–1280px | 1280px |
| Above 1280px | 720–1920px | 1420px |

Actual width never exceeds the viewport. Each category is remembered separately. Layout, display selections, graph selection/order and collapsed sections are local browser preferences, not account-wide settings.

## Road view and camera overlay

### Lanes, edges and range

In the video overlay, mint lane bands grow up to 75% confidence, reaching a maximum physical width of **0.225m**. Above 75%, width stays fixed while fill opacity grows from **7.5% to 20%**. The 1px outline's opacity follows confidence. Projection makes distant bands narrower.

Coral red road-edge bands use confidence `1/(1+standard deviation)`; maximum fill opacity remains 10%. Glow is video-only.

The road panel uses lane lines of 1–4px with confidence-based brightness and dashed lines below 50%. Road edges are 2px coral red lines, dashed above standard deviation 1. The model path is a purple line, not a vehicle-width ribbon.

The paired front/rear ranges **25/5m, 50/10m and 80/20m** affect **only the road panel**. **후방 표시 · LR / RR** defaults to on and remembers its state; turning it off restores the full forward view. LR/RR appear behind the ego vehicle and 0m line. Rear dashed lines are straight position guides, not measured lanes or extrapolated road curvature. Rear coordinates retain the cluster command distance without the front targets' 0.8 distance restoration or curvature correction. Existing logs need reconversion to populate rear values; existing playback remains available. LR/RR are not added to the camera overlay, which retains BSD. Camera lanes, paths, vehicle boxes, detection markers and TARGET are not clipped to this setting; they still require valid data and projection. BSD walls retain their separate 40m maximum length.

### Objects and labels

Enable model paths, lanes, edges, model leads, radarState targets and liveTracks independently. **SCC 감지점 제외** hides SCC-source points from the road view, overlay and liveTracks table. A low-probability model lead remains visible but is dimmed below 50%.

**정보 표시** selects one of Off, TrackID, Distance, yRel, Speed or Relative speed. TrackID is the default; Off leaves shapes only. **liveTracks 정보 표시** applies the selected label to raw points. The camera readouts can switch from lane probabilities/edge deviations to each line's initial `y[0]`.

Road-view liveTracks uses × for measured points and hollow circles otherwise; video uses ×. Raw points are not necessarily vehicles. Radar/liveTracks tables retain roughly ten rows of height with internal scrolling and sticky headers, including when empty. Tables can include objects beyond the road view's range.

Raw `yRel` is positive left; the road coordinate is `-yRel`, with x forward and y right. Model and selected lead distances may use different reference points.

### LF, FF and RF boxes

These are processed Hyundai CCNC display commands, not unfiltered radar objects. Distance is restored by dividing by 0.8. FF lateral position adds the model Position at that distance; if unavailable, it uses the same lane-center curvature correction as LF/RF. Missing geometry leaves the lateral correction unapplied. Filtering/clipping information cannot be recovered.

LF/RF are blue; FF is light cyan. Boxes assume width 1.8m, length 4.5m and default height 1.30m. The anchor is the rear face's bottom center. Orientation follows the midpoint of both lanes at the object and 5m ahead; missing lane geometry falls back to straight orientation. Boxes remain on the ground and ignore marker-height adjustment.

Height is adjustable from 0–3m (zero draws a ground rectangle); fill opacity is 0–100%, default 30%. Transparent boxes show far faces/edges. A new detection rises from the ground over 450ms. A frame without the detection dims the box to 40% at once before a 600ms fade, so even one-frame dropouts show as blinks; a quick return restores full brightness without replaying the entry. When the same car moves to another slot (e.g. FF→LF, matched by position, even with up to 600ms between the slots, 300ms of both being sent, or the old slot picking up another car right away) it slides there over 300ms and changes color instead of disappearing and reappearing. During playback, positions are interpolated between 20 Hz samples. Turning off **Smooth motion** disables all of this and shows each recorded sample as-is (on by default, remembered). Animation follows log time and reduced-motion preferences.

LF/FF/RF display is enabled by default, with saved selections respected. Their messages lack TrackID and speed; those labels show an unavailable value. A missing/stale command is not treated as a valid detection.

### Road signals, BSD and overlay settings

TARGET uses the configured path width (default 1.86m), with softly fading ends. Its video trail length follows smoothed actual deceleration `carState.aEgo`, reaching 8m at 3m/s² over the available lane geometry. It is not measured brake force. No acceleration data means no braking trail.

`LANE_HIGHLIGHT`, `LANE_LEFT` and `LANE_RIGHT` control lane highlighting to the valid end of the lanes. `LANE_HIGHLIGHT_DISTANCE` is not used. Mint turn arrows animate near the corresponding lane; they do not reproduce the physical bulb's exact flash phase.

BSD uses `carState.leftBlindspot/rightBlindspot`. Video walls rise/fade in and lower/fade out, extend at most 40m, and default to 0.80m high. Ten vertical yellow lines move irregularly along each wall, five with stronger glow. The road panel uses a yellow glow on the detected side's border rather than a wall stripe. Walls are independent of marker height and the cluster-road toggle.

Below the video, **주행 상황 겹쳐 보기**, **설정** and **카메라 설치 정보** provide the overlay controls. Settings include:

| Setting | Default / range |
|---|---|
| Vehicle box height | 1.30m / 0–3m |
| Vehicle box fill | 30% / 0–100% |
| Model path width | 1.86m / 1–3m |
| BSD wall height | 0.80m / 0–3m; zero hides the video wall |
| Marker height | 60cm / 0–200cm; connects markers to ground |
| Box, BSD and TARGET labels | Independently enabled |
| Labels below boxes | Optional text below the box without background/border |

Every slider has an individual reset button. Settings are remembered. The path width affects video model paths and TARGET, not the road panel's purple line. Rendering preferences do not require log reconversion.

### Wide-camera overlays

Wide video uses its sensor and `liveCalibration.wideFromDeviceEuler` with the front/device calibration. The same 3D coordinates are reused; only small shared camera metadata is added, not a second set of coordinates.

Missing calibration or an unsupported sensor produces an explanation instead of using front-camera projection. Older converted data needs log reanalysis to obtain wide calibration; this feature alone does not automatically reanalyze all ready recordings.

## Vehicle information graphs

Switch to **차량 정보** beside the road tab. The summary shows speed, acceleration, steering angle and steering intervention. Initial/last values can be held only within the supported data-boundary tolerances; initial preview identifies its first valid sample time.

**그래프 선택** chooses and reorders graphs by dragging the handle. Reset order keeps checkbox selections. Selection/order are remembered; additional graphs scroll inside the panel.

There are **23 graphs**:

| Group | Graphs |
|---|---|
| Speed and acceleration | Speed, acceleration, automatic target acceleration, longitudinal jerk, RPM |
| Pedals and braking | Driver pedal input, driver pedal state, automatic gas/brake output, acceleration/deceleration requests, longitudinal control stage, standstill/brake hold |
| Steering | Angle, steering rate, steering torque, automatic torque command, driver intervention, curvature, lateral acceleration |
| Control state | Automatic control, cruise state |
| Cluster vehicles | LF/FF/RF display state, forward distance, lateral LATERAL and yRel graphs |

Initially selected: speed, acceleration, driver pedal input, angle, intervention and automatic control. Zoom with +/− or return to the whole segment. Click/drag to seek; zoomed playback follows the current time near the center except at the ends. Dragging temporarily holds the viewport; release resumes following.

Driver pedal values differ from automatic requests and final commands. Some vehicles report brake pressed but no brake amount. Torque is a sensor/command value, not proof of driver intervention; `steeringPressed` provides that state. Target steering angle and RPM availability depend on the vehicle. Zero-only valid fields cannot distinguish true zeros from unpopulated defaults; missing fields are not fabricated. The LATERAL graph shows LF_LATERAL/FF_LATERAL/RF_LATERAL cluster commands before path/lane restoration; FF uses the signed −6.4–6.3m range. The separate yRel graph shows the restored box positions, positive left and negative right. Both can differ from raw radar coordinates. Existing replay data supplies the pre-restoration values without reanalysis; missing values remain unavailable.

## Camera information and steering icon

The camera dialog reports device type, dongle ID when available, sensor, calibration status, roll/pitch/yaw and height at the current sample. It distinguishes calibrated/default height. Installation translation offsets cannot be determined from the displayed information.

For camera installation directions viewed from inside the car facing forward:

| Angle | Negative | Positive |
|---|---|---|
| Roll | Right / clockwise | Left / counterclockwise |
| Pitch | Up | Down |
| Yaw | Right | Left |

Calibration normally assumes zero roll; a zero value does not prove a physically level installation.

Speed is based on `carState.vEgo`, not necessarily the dashboard speed. The wheel follows recorded steering angle, turns white for `steeringPressed`, and changes appearance with steering control state/torque. It is not a hands-on-wheel or pedal detector.

## Storage, cleanup and backups

The container data root is `/data/roadviewer`, not necessarily the same path on the host. UUID recording directories contain originals, metadata and prepared files. Replay data is gzip-compressed JSON. Data converted by 0.3.14 or earlier is migrated to compressed storage in the background; older application versions may need reconversion to read it.

The cleanup timer checks incomplete uploads every minute; 15 minutes without progress expires them. **저장소 즉시 정리** in the upload section force-cleans incomplete browser uploads before that timeout, potentially interrupting another browser's upload. It preserves registered recordings, active registration and valid device upload sessions.

Home Assistant app backups exclude originals (ZST, TS, HEVC), MP4s, analysis/graphs, per-recording metadata and upload staging. They retain configuration:

| State | Container path |
|---|---|
| Processing options | `/data/roadviewer/.processing-settings.json` |
| Storage policy and segment pins | `/data/roadviewer/.storage-settings.json` |
| Device authentication | `/data/roadviewer/.devices.json` |

Supervisor manages external port mappings. Browser preferences are not included in app backups. Restoring a backup does not restore recordings: keep originals separately. Previously created backup archives are unchanged.

Restart cleans incomplete processing outputs and requeues eligible work; manual conversion can resume with automatic conversion disabled. Decoder-format changes can invalidate prepared data before oldest-first reprocessing. Rendering-only updates do not inherently require reconversion.

## Storage budget and pins

Under **저장공간 관리**, select unlimited or a byte budget and the full-storage policy. Defaults are unlimited and reject new uploads. Usage, budget, actual free disk and reservations are shown separately.

- **Reject new:** retain existing recordings.
- **Delete oldest unpinned:** group by full route ID and order by earliest upload time, not driving time; delete only unpinned eligible segments.
- **Pin:** affects only that segment, including after restart. New segments do not inherit another segment's pin.

Incoming/active-upload routes, groups with queued/processing work, and pinned segments are protected. Legacy route pins migrate to existing segments. Short display names are not storage grouping keys.

Reservation requests never delete existing recordings. Chunk uploads reserve declared bytes plus metadata headroom; legacy multipart uploads also allow for a staging copy. A real 100MiB free-disk margin is required. Reclaimable logical quota may be reserved, but uploads still need actual disk space before eviction.

Deletion can occur only after all files have arrived, passed validation/checksums and need registration. Duplicate-only uploads do not trigger eviction. Capacity is preflighted before deleting; locks keep concurrent admission consistent. Completion, cancellation, terminal failure and expiry release reservations. Status polling and device token renewal do not extend idle expiry.

This is an upload-admission budget, not a filesystem quota: conversion output or other disk users can exceed estimates. Lowering the budget does not immediately delete files.

## Connecting a comma device

1. Prepare a trusted certificate and key under Home Assistant `/ssl`.
2. Set `device_certfile` and `device_keyfile` to filenames directly under that directory, such as `fullchain.pem` and `privkey.pem`.
3. In **로그 업로드 → 외부 장치 연결**, enable external access, choose a free HTTPS host port, save, then press **지금 재시작**. Only Road Viewer restarts.
4. Forward the selected external TCP port to that Home Assistant host port. Never expose Ingress 8099 or private upstream 8098.
5. Press **새 장치 연결** and enter the HTTPS base URL and one-time code in the compatible comma/Carrot Web uploader.

Codes last five minutes, work once, and support copy, cancel and reissue. A new code invalidates the old one; successful pairing changes Cancel to Close. Issuing another code does not disconnect previously paired devices.

Nginx exposes only `/api/device/` on external HTTPS. Long-term credentials are returned once and later used for HMAC, not sent again. Certificate renewal is external; the app reloads valid updated certificate files.

**연결 해제** blocks new and subsequent authenticated requests. **목록 제거** removes a disconnected registration without deleting recordings; reconnect by pairing again. Device sessions have a two-hour absolute lifetime and 15-minute idle timeout. Valid partial device transfers can survive app restarts.

The old `device_api_enabled` option is unused. Remove a leftover option if Home Assistant reports it invalid. Saving a port differs from applying it; restart after ongoing uploads/playback finish. Missing/invalid TLS fails closed.

### Testing without openpilot

When external HTTPS is enabled, open `https://<domain>:<port>/api/device/test`. Pair and use virtual files or small real rlog/qcamera files, then create/resume a session, upload and finish. The page limits files to 64MiB because hashing uses browser memory. It supports interrupted transfer, invalid-signature and nonce-replay checks.

This uses the real API and storage policy. Virtual files are not real driving logs and will fail conversion. Keys/tokens stay in page memory; refreshing requires pairing again. Direct local HTML and Ingress access to this page are unsupported.

See the [English API specification](../docs/device-api.en.md) or [한국어 API 문서](../docs/device-api.md) for exact authentication, limits, recovery and test commands.

## Troubleshooting and validation

For stalled uploads, inspect file access, connectivity, capacity and the library's error. Application `Upload failure` logs include phase, offset, elapsed time, browser byte counters and error code. Browser bytes do not prove server persistence. Retry failed conversion after reading its reported cause.

CI covers both platforms, dependency/image security, real container HTTPS isolation, upload/storage/conversion and browser behavior. Actual Home Assistant performance and native Android file selection depend on the environment.

The bundled openpilot schema may need updating for sufficiently different log formats. See [schema licensing](schema/OPENPILOT-LICENSE) and the historical [changelog](CHANGELOG.md).
