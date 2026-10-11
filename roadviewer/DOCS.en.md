# Installation and use

This guide describes **0.5.5**.

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

Driver-camera and direct MP4 uploads are unsupported. One segment may use the bare filenames above. Multiple segments use their original route/segment identifiers:

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
- **Restore a missing original:** resend the same log and original camera file. If its cached original SHA-256 matches a retained MP4, only the original is restored; existing playback data and status remain unchanged.
- **Different video:** existing camera data is not overwritten. To replace it, completely delete that recording and upload it again.

Duplicates are detected using the compressed rlog's SHA-256. Renaming identical content does not create another recording; recompression may change the hash. Browser deduplication happens after transfer, so it saves storage/conversion rather than transfer bandwidth. Missing-video attachment and verified original restoration are exceptions to ordinary duplicate skipping.

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

**로그 다운로드** downloads the ZST log. **영상 다운로드** chooses high-quality front → qcamera → wide, then prefers that camera's original over its MP4. It is not necessarily the camera currently selected in the player.

### Conversion and storage settings

**변환 및 저장 설정** sits below uploads and remembers its collapsed state. Conversion creates replay/graph data, remuxes qcamera TS into MP4, and transcodes high-quality/wide HEVC into H.264 MP4 on the server. Each video uses its own log timestamps. HEVC processing is more expensive than TS remuxing.

- **자동 변환:** enabled by default. Eligible recordings are queued oldest-upload first. Disabling clears automatic queued work; running and manually requested work continue.
- **동시 처리 개수:** 1–4, default 1. Lowering the limit does not interrupt running jobs. Settings survive restart; parallel jobs may finish out of order.
- **원본 영상 같이 보관:** enabled by default. Keeps TS/HEVC originals alongside camera-specific MP4s. When disabled, originals are removed only after successful conversion/verification; failed or unsynchronized sources remain. Changing this setting does not immediately delete or restore existing originals.

Processing options save immediately; storage budget/policy have their own Save button. Restoring an original while retention is disabled does not delete it immediately; a subsequent conversion follows the retention setting.

| State | Meaning |
|---|---|
| 미변환 | Originals retained; manual conversion is available |
| 대기 중 | Queued; removal cancels this queued conversion |
| 처리 중 | Reading, analysis, video preparation/verification or finalization |
| 재생 가능 | Playback data is ready, including log-only recordings |
| 변환 실패 | Inspect the error, then retry conversion |

The progress bar uses stage ranges: reading 25%, analysis 50–75% based on analyzed/total frames, video work 75–100% using aggregated camera progress when available. Finalization hides the bar. These are stage weights, not a time estimate.

### Individual and bulk actions

The primary action is Play or Convert. The adjacent dropdown contains removal, downloads and complete deletion when applicable.

| Action | Effect |
|---|---|
| 변환 | Build replay data; use originals or a retained sole MP4 |
| 제거 / 변환 데이터 제거 | Delete analysis/graphs and MP4s that can be recreated from their originals. Preserve originals and a camera's sole MP4. Cancel queued work; reject removal of actively processing work |
| 완전 삭제 | Permanently delete the segment's originals and prepared data; cancel its work |

Manually removed recordings are excluded from automatic conversion until Convert is requested.

Use **로그 선택** at the bottom of settings for bulk actions. Select-all and action controls remain visible while scrolling. **고정 항목도 삭제** is off whenever the dialog opens: pinned segments are protected from bulk removal/deletion unless explicitly included. This does not affect bulk conversion. Individual dropdown actions can explicitly delete pinned recordings.

During a bulk operation selection and closing are locked. Results show completed, skipped and incomplete counts; failed items remain selected.

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

Orange road-edge bands use confidence `1/(1+standard deviation)`; maximum fill opacity remains 10%. Glow is video-only.

The road panel uses lane lines of 1–4px with confidence-based brightness and dashed lines below 50%. Road edges are 2px orange lines, dashed above standard deviation 1. The model path is a purple line, not a vehicle-width ribbon.

The 25/50/80m forward range affects **only the road panel**. Camera lanes, paths, vehicle boxes, detection markers and TARGET are not clipped to this setting; they still require valid data and projection. BSD walls retain their separate 40m maximum length.

### Objects and labels

Enable model paths, lanes, edges, model leads, radarState targets and liveTracks independently. **SCC 감지점 제외** hides SCC-source points from the road view, overlay and liveTracks table. A low-probability model lead remains visible but is dimmed below 50%.

**정보 표시** selects one of Off, TrackID, Distance, yRel, Speed or Relative speed. TrackID is the default; Off leaves shapes only. **liveTracks 정보 표시** applies the selected label to raw points. The camera readouts can switch from lane probabilities/edge deviations to each line's initial `y[0]`.

Road-view liveTracks uses × for measured points and hollow circles otherwise; video uses ×. Raw points are not necessarily vehicles. Radar/liveTracks tables retain roughly ten rows of height with internal scrolling and sticky headers, including when empty. Tables can include objects beyond the road view's range.

Raw `yRel` is positive left; the road coordinate is `-yRel`, with x forward and y right. Model and selected lead distances may use different reference points.

### LF, FF and RF boxes

These are processed Hyundai CCNC display commands, not unfiltered radar objects. Distance is restored by dividing by 0.8. FF lateral position adds the model Position at that distance; if unavailable, it uses the same lane-center curvature correction as LF/RF. Missing geometry leaves the lateral correction unapplied. Filtering/clipping information cannot be recovered.

LF/RF are blue; FF is light cyan. Boxes assume width 1.8m, length 4.5m and default height 1.30m. The anchor is the rear face's bottom center. Orientation follows the midpoint of both lanes at the object and 5m ahead; missing lane geometry falls back to straight orientation. Boxes remain on the ground and ignore marker-height adjustment.

Height is adjustable from 0–3m (zero draws a ground rectangle); fill opacity is 0–100%, default 30%. Transparent boxes show far faces/edges. They grow in over 450ms and fade out over 600ms without a hold period. Brief detection gaps do not restart growth from zero. Animation follows log time and reduced-motion preferences.

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
| Cluster vehicles | LF/FF/RF display state, forward distance, lateral yRel |

Initially selected: speed, acceleration, driver pedal input, angle, intervention and automatic control. Zoom with +/− or return to the whole segment. Click/drag to seek; zoomed playback follows the current time near the center except at the ends. Dragging temporarily holds the viewport; release resumes following.

Driver pedal values differ from automatic requests and final commands. Some vehicles report brake pressed but no brake amount. Torque is a sensor/command value, not proof of driver intervention; `steeringPressed` provides that state. Target steering angle and RPM availability depend on the vehicle. Zero-only valid fields cannot distinguish true zeros from unpopulated defaults; missing fields are not fabricated. LF/FF/RF graphs use the restored display positions, not raw radar coordinates.

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
