# Release notes

[한국어 전체 변경 이력](CHANGELOG.md) · English

These are the English release notes from 0.13.0 on. Earlier release entries remain in the [original Korean history](CHANGELOG.md); they describe behavior at their release date, not necessarily current behavior. See the [current user guide](DOCS.en.md) for present settings and policies.

## 1.0.31

- The replay's ⋯, 보기 and 레이어 menu buttons fill from where they were pressed when their menu opens (300 ms; from the middle when opened by keyboard) and the fill fades out in 200 ms on close. These buttons skip the separate press ripple.
- The ⋯ button has no background at rest or on hover; it is filled only while its menu is open.

## 1.0.30

- The ⋯ button at the top right of the replay turns into ✕ while its menu is open: the three dots gather in the middle and the ✕'s four strokes draw out of them at full weight; closing reverses it. The ✕ is as wide as the ⋯.
- The replay's ⋯, 보기 and 레이어 menus grow in from their button's side (150 ms) and fade out in 75 ms; with reduced motion they switch at once.
- The 12 old archive options that moved to the web settings (`archive_enabled`, `archive_path`, `archive_mode`, …) are removed from the add-on configuration. The upload limit, device HTTPS certificate and Drive OAuth client options stay; settings already in the web settings are unaffected.

## 1.0.29

- While ‘이동 가능한 데이터 모두 이동’ runs, the Storage tab shows the bytes processed (the file being uploaded included), the transfer speed over the last 30 seconds and the time left. The progress bar follows bytes rather than files, so it keeps moving while a large video uploads.
- Bytes a resumed upload sent earlier and Drive copies adopted without uploading are left out of the speed; for the first seconds, and while the run waits for an upload or conversion, that state shows instead.

## 1.0.28

- After an add-on restart, the first archive run (including ‘이동 가능한 데이터 모두 이동’) checks the archived copies with one Google Drive folder listing instead of a request per file, which took minutes with about a thousand files while the run showed 0 done. A file the listing lacks is still checked by itself, and a local original is still deleted only after Drive itself confirms its copy.
- While those checks run, the Storage tab shows their progress (‘이동 준비 중 · 보관본 확인 n/N’).
- The divider between a card's header and its list fades over the whole 300 ms fold with an ease-out curve, so the change is visible in the dark theme.
- Progress bars (upload, import, archiving) no longer light up on hover as if they could be clicked.

## 1.0.27

- Library cards off screen skip layout and paint, so folding a card in a long list stutters less (on a phone-speed CPU with 30 cards, about 35 to 60 fps).
- Less hesitation after tapping a card's chevron: the fold measured its ends by laying the list out three times; it now does so once when unfolding and not at all when folding.
- When a card folds, its list rises at a steady pace and keeps moving until the panel has closed.
- The divider between a card's header and its list fades in as the card unfolds and out as it folds (about 90 ms).

## 1.0.26

- In the dark theme the glass highlight along the top of a library card's header shows again. Since 1.0.24 the header's background had hidden it except while a card folded; it is now the same at rest and in motion.

## 1.0.25

- A library card's header reads as a card of its own and the segment list as a panel behind it: unfolding rolls the panel out from behind the header, folding rolls it back, and just before the card closes the panel's rounded edge rises slightly above the header's so it is fully tucked away instead of its outline merging into the header's.
- While a card folds, its outline and shadow wrap the header and the visible panel, so the shadow is no longer cut off at the sides, and the white line around the list is gone.
- The header's lower corners ease to square as a card unfolds and back as it folds. The header's shadow on the list and the shade inside the panel's edge are the same soft shadow, follow the rounded corners, last the whole motion and shrink with the visible panel.

## 1.0.24

- A library card's header carries its own background gradient, so an open card no longer stretches it until the header looks flat, and the header no longer changes shade when a fold ends.
- Fold shades are drawn only over the visible list between the divider and the moving bottom edge; the bottom shade no longer rises over the header just before a card closes.
- When a card folds or unfolds, its list always slides 48px, whatever its length.
- Dragging the replay page's segment strip with the mouse no longer selects the surrounding text.

## 1.0.23

- The play button's icon morphs between play and pause: the two halves of the play triangle pull apart into the pause bars and close back into the triangle (240 ms; instant with reduced motion).
- On phones the segment list no longer shows through a library card's header while the card folds or unfolds; the header covers it with the card's background during the motion.
- Unfolding a card with many segments no longer slides the list by hundreds of pixels as if scrolling; the list moves a third of the height change visible on screen.

## 1.0.22

- While a library card folds or unfolds, its list keeps moving until the end: the slide was capped at 40px, so long lists looked stopped halfway; it is now a third of the height change, on the edge's curve.
- During the fold the divider between the card header and its list stays visible, and soft shades under the divider and above the moving bottom edge make the list seem to roll under them; they come in as a card starts to close and fade out just before it is fully open.

## 1.0.21

- On tablets and desktops the library's tag filter shows at most two rows; the rest fold behind a **+N개 더보기** chip at the end of the second row, which unfolds them all and then reads **접기**. A selected tag is moved forward and never folded away. Phones keep one sideways-scrolling row.
- Folding a library card no longer occasionally flashes its full height for a frame at the end, and the divider between the card header and its segments stays in place instead of moving and being clipped with the list.
- The segment strip's edge fades fill faster (full after 14px of scrolling), so end blocks no longer look cut off early in a scroll.

## 1.0.20

- The replay page remembers the last of all four analysis tabs (주행 상황, 차선도로, 차량 정보, 북마크); before, only 차량 정보 and 북마크 were restored.
- Folds in the library and settings no longer fade: the growing panel clips its content, which slides down slightly into place (and back up when folding). Rows unfolded with the chevron no longer look faded.
- Back from a long time in the background, a single failed library read retries after a second without a warning, and a later successful read clears the '로그 목록을 읽을 수 없습니다' warning.
- The scrolling segment strip's edge fades widen gradually with the distance from each end instead of switching on at once.
- On tablets and desktops the play button no longer shows a dark band along its top edge and a light one along its bottom (which made it look shifted down); other mint buttons (e.g. upload) no longer show border bands either.
- The segment preview bubble's tail no longer shows a thin line where it joins the bubble.

## 1.0.19

- The empty part of a route card's button row (on phones, under the thumbnail left of 재생) now folds and unfolds the card like the rest of it; the gaps between the buttons still do nothing.

## 1.0.18

- Uploads from a device or another browser now show their progress in the library header's upload pill (`업로드 N%`); before, only this browser's own uploads did.
- The current segment's ring is no longer cut off at either end of a scrolling segment strip, and coloured segment blocks are drawn flat, without the dark inner edge they showed on phones.

## 1.0.17

- Mobile text entry no longer sits under the floating playback controls. Tag and bookmark editors follow the keyboard's visible viewport and keep their save action reachable.
- Picking existing tags no longer raises the keyboard. Selected tags appear first, with search and new-tag entry below.
- Capture bookmarks in a popup without leaving the current replay view. Titles are optional and default to the scene time; the captured time and unfinished draft are preserved.

## 1.0.16

- Added log export and import. Home Assistant backups do not include logs, so all recordings (Storage tab, local storage card) or the selected ones (library selection mode) can be saved as one .tar file: the original log and videos plus name, upload time, tags, bookmarks and pin; files moved to Drive/NAS are included as references only.
- Import uploads that file recording by recording: existing recordings are skipped, a recording that fails its checks is not added, and imported recordings are converted again per the auto-convert setting. With the same Drive/NAS connected, moved files play as before.

## 1.0.15

- The current segment's whole video is read in the background, also while paused, so every seek within the segment is then immediate. Browsers read only a little ahead while paused, so seeking past it lagged and the seek bar's loaded parts were scattered. Drive videos come from the app's in-memory copy, not Google again; videos over 256 MB still stream.

## 1.0.14

- The video is sized against where the floating transport bar actually is instead of a fixed allowance, so it grows right up to the bar with smaller side margins.
- The video no longer grows tall and then shrinks while a segment loads: the bar keeps its last height and the video its last aspect ratio.
- Desktop and tablet now show the previous/next buttons beside the title at the top left of the video (‹ ›), as on phones.
- Deleting permanently from the replay opens the previous segment of the same drive, else the next one, and returns to the log list only when there is neither.

## 1.0.13

- Leaving a turned phone/tablet fullscreen by moving to another segment no longer leaves the next segment's seek touches and dialogs in the turned orientation.
- The driving map places the followed lead (선택) and FF labels first, so traffic never pushes them out; other labels still fill free places as before, and label backgrounds no longer touch.
- On 320px-wide phones the speed sits at the right edge with the wheel below it, clear of the segment navigation, and the playback buttons flow in one row without overlapping; 360px and wider keep the existing layout.
- Folded radarState/liveTracks tables are no longer rebuilt during playback (they fill with current values when opened), and the hidden driving map is not drawn during video fullscreen.

## 1.0.12

- After holding a finger on the segment strip to show a thumbnail, sliding it scrubs through the segments like a mouse pointer; the strip does not scroll meanwhile, and lifting the finger hides the preview without changing segments.
- On long drives, resting the held finger near an end of the strip moves the strip on to further segments.

## 1.0.11

- Hovering a block of the replay segment strip (or holding a finger on it) shows that segment's thumbnail and start time above the strip; it goes away on release, and a hold does not change segments.
- Phone and tablet fullscreen hides the segment strip; the title menu at the top left still changes segments.
- The horizontally scrolling segment strip of long drives has a larger touch area (about 16px to 28px); on touch screens the event track just below also counts as the strip.
- README screenshots are recaptured from 1.0.11 with dark-mode versions, so GitHub shows the ones matching the reader's theme.
- In the stacked layout the video no longer shrinks after leaving fullscreen. It is sized to use the room the app bar gives up while playing; paused, with the app bar shown, the controls at the bottom of the video move up clear of the transport bar.

## 1.0.10

- In the stacked layout the sticky video card has the same shadow as the other cards, so the card scrolling up under it meets a clear edge.
- Notices over the video (e.g. no log data for this segment) use the same text colour and weight as the other chips, on a thinner background that shows more of the picture.
- The default automatic archive interval is now 24 hours instead of 10 minutes. It applies only when the setting was never saved; saved values are kept.
- The English release notes describe their actual range (0.13.0 on).

## 1.0.9

- Opening a replay from the log list no longer leaves the stacked video stuck at a small size (the 320px fallback height); its size follows the panel's width and the screen height.
- No white focus ring around the video title after moving to the replay.
- The glass of the over-video controls is thinner so the blur shows: 10% fill and less darkening in dark mode, 40% white in light mode. Text contrast is lower over very bright (dark mode) or very dark (light mode) footage.
- The dark page glow is centred; on wide screens it sat to the right.
- The Drive state at the top right of the library no longer flips to **확인 중** (checking) periodically: the last known state is shown while the server rechecks Drive, and the header refreshes every 3 s while checking, otherwise every 10 s (no more Google API calls than before).

## 1.0.8

- The log list no longer rebuilds every row each time the Drive state is rechecked (about every 10 s): with the list open, responses that took 2.5-5 s are back to about 0.5 s. The list shows the last known state while it is rechecked in the background.
- The log list draws faster: rows inside folded cards are no longer measured for motion and dates use prebuilt formats, cutting drawing time on phones to about a quarter.
- The list response leaves out the file hashes and storage details the screen never used, about halving its size.
- On phones and tablets full screen opens in landscape: the orientation is locked where the browser allows it, and elsewhere (the Android Home Assistant app, iPad) the picture is turned a quarter turn, so hold the device on its left side. Touch seeking follows the turned bar.
- Fixes the page background gradient missing since 1.0.7.
- The **새 코드 발급** (new code) icon turns once per press, like the log list's refresh button.

## 1.0.7

- Google Drive archiving is faster: uploads use 16MiB chunks over a reused connection to Google instead of a new connection per chunk.
- The thumbnail/start-time backfill no longer waits for archiving to finish. Fixes drives that kept an old date, with every segment showing the same time, while a long archive run was active.
- Prepared data uses a new replay format, roughly halving its size per segment. Existing data is rewritten in the background after the app starts; no reconversion is needed.
- Past 20 segments, a route card's segment bar shows the first 20 blocks and a **+** coloured by the most urgent state among the rest.
- Every route card starts collapsed each time the log list opens. On phones the expand button sits in the action row, and in selection mode the checkbox and expand button are vertically centred.
- Pressing a card no longer flashes; the ripple and arrow motion remain, and the arrow colour changes smoothly.
- The archive start threshold is entered in GB with decimals; the custom local storage limit also accepts decimal GB.
- Fixes a band behind the page while scrolling on desktop, and tag colour swatches stretched into ovals.
- The guide and documentation screenshots match the current UI.

## 1.0.6

- Drive start times are corrected: logs without a GPS fix use the live system clock (clocks) instead of the stale start record (initData), and every segment of a drive is dated from its latest segment's clock. Logs already recalculated are recalculated once more.
- The playback bar can be dragged by touch, following the finger even when the app's web view tries to take over the gesture.
- The background job that fills thumbnails and start times now pauses while any video is being watched (local ones too, not only Drive), so it no longer competes with playback and seeking; logs without GPS read less of their start.

## 1.0.4

- Fixes 1.0.3 failing to start: an internal name clash in the background job that recalculates start times stopped the server from booting.

## 1.0.3

- Drive start times come from GPS time. A device clock not yet set at start-up no longer puts different days' drives at the same time and date; segments without GPS are corrected from another segment of the same drive. Existing logs (Drive and NAS too) are recalculated in the background.
- Drive cards take their thumbnail from the first segment instead of the last.
- Stacked, the video shrinks and grows exactly with the scroll position, so the page follows the finger 1:1; on the cover display the 차선·도로 tab scrolls to its end.
- While playing, touching the video again while the controls show hides them at once. The playback bar can be dragged by touch.
- Buttons and cards regain the design's depth and the play button its mint gradient. The screen-mode switch has one consistent shape and its highlight slides to the chosen mode.
- Back responds at once with a progress line at the top and returns faster, as the library page is fetched ahead.

## 1.0.2

- Over-video controls use the same glass as the magazine home's tab bar: blur only (no milky brightening) and a 1px rim lit along the top instead of an even white outline. The quality chooser keeps its chevron.
- The video frame follows the picture's own aspect ratio, removing the black bars above and below, and the white card around the video is gone.
- On phones the previous/next segment buttons sit beside the title at the top left of the video (‹ 구간 k ›); narrow screens show only the segment in the title.
- Lane and road-edge readouts moved to a new **차선·도로** analysis tab.
- Controls hidden during playback come back when touching anywhere on the video or its playback bar.

## 1.0.1

- Replay page: the segment-chooser title moved to the top left of the video and the camera/overlay buttons to the bottom left; the app bar is a single line. The speed shows as white figures without a pill, with the wheel to its upper right.
- While playing, the title, buttons and fullscreen over the video fade out and come back briefly on touch. On touch or short screens the app bar also folds while playing, and the video is sized so the playback bar never covers it.
- Side by side, the video stays put while only the analysis scrolls. Stacked, the video sticks to the top and shrinks to 60% while scrolling; on short phone screens (such as the Fold cover display) the playback bar also folds into one row.
- Lane and road-edge readouts moved out of the layer menu back under the driving map.
- The segment strip uses the library's status colours with the current segment outlined; the play button has a soft glow.
- Over-video glass is more transparent with a thinner edge and stays dark in fullscreen; the fullscreen button no longer loses its icon on hover.
- A softer press ripple; touch scrolling no longer stops dead after pressing a button (lingering focus and a fixed background removed). The green hairline beside the tablet analysis tabs is gone and the tabs are larger on touch screens.
- The library opens quickly: rows come from cached stored metadata, and older logs get their summaries and start times saved in the background.
- Thumbnails are now produced for logs moved to Drive or NAS: an unreadable log no longer stalls the run, drive-card thumbnails come first, and new thumbnails appear in the list right away. The gap above the phone library header is fixed.

## 1.0.0

- The whole interface was redesigned: neutral surfaces with a mint accent, flat buttons and selects, and translucent glass for floating bars and over-video controls. A **screen mode** setting (auto, light, dark) was added; the video area always stays dark.
- The library is split into **로그 · 업로드 · 저장공간 · 장치 · 설정** tabs (a bottom tab bar on phones). Uploads keep running when switching tabs, with progress in the header.
- The log tab adds search and filter chips (pinned, unconverted, processing, Drive, NAS, each tag), date-grouped drive cards with thumbnails, a segment status bar, automatic-control ratio and takeover count, and a storage summary. Segment actions moved into the ⋯ menu.
- Bulk management is now an in-list **selection mode** ("선택" or long-press) with a bottom action bar for tags, download, convert, remove and delete.
- The replay page was rearranged: a compact app bar, controls over the video (camera, overlay, speed, steering state with an **개입** (intervention) marker, fullscreen), a **floating transport bar** at the bottom (segment strip, control/takeover track, bookmark markers) and analysis tabs (driving view, vehicle data, bookmarks). Tapping the time toggles the total length.
- Conversion now stores a **thumbnail**, the real **drive start time** and a control summary; older logs and logs moved to Drive or NAS are backfilled in the background (Drive downloads only the start of each file).
- Long drives with tens to hundreds of segments scroll the segment strip with the current segment centred, and list bars show proportional status runs. A press ripple and Material-based motion were added.
- The user guide, READMEs and documentation screenshots were updated for the new interface.

## 0.13.20

- Under each segment, the log list now shows where the log and each camera video (high-quality, low-res, wide) are kept: **로컬** (local), **Drive** or **NAS**. Only files moved by archiving show Drive or NAS.
- The replay page's download button became a menu like the list's, with **제거** (Remove), **다운로드** (Download) and **완전 삭제** (Delete permanently); a confirmed remove or delete returns to the log list.
- The "재생 화면" label above the replay toolbar is gone, and the list's status and file guide matches the current menu.
- The user guide, READMEs and device API docs were brought up to date: enabling Drive move mode (in the web UI), automatic cleanup never deleting Drive files, device upload limits and chunk size, and the per-connection default quality; duplicated paragraphs were removed.

## 0.13.19

- The default playback quality setting moved from a button at the top of the replay page into the camera list below the video: **기본 화질** (default quality) beside 닫기 (close) opens the mobile data and Wi-Fi/wired choices.

## 0.13.18

- A **재생 화질** (playback quality) setting at the top of the replay page chooses, separately for mobile data and for Wi-Fi/wired, whether a video opens on the small front video (qcamera) or the high-quality one (fcamera). Mobile data defaults to qcamera and Wi-Fi/wired to fcamera; the choice is kept per browser.
  - The connection is told apart only where the browser reports it (Chromium browsers on Android such as Samsung Internet, Whale and Chrome). Elsewhere (iPhone, iPad, desktop browsers) phones and tablets follow the mobile-data choice and other devices the Wi-Fi/wired one; the dialog shows which applies.

## 0.13.17

- Phones and tablets now start on the small front video (qcamera) instead of the high-quality one (fcamera), to save mobile data. Desktops still start on the high-quality front, the selector below the video still switches at any time, and if qcamera cannot be read the high-quality front follows.

## 0.13.16

- The Google Drive playback cache moved from a scratch folder on disk (up to 1 GB) to memory and now holds only the video being watched. Opening another video or camera drops the previous one at once, and it is freed after 10 minutes unwatched; files over 256 MB are not held and stream from Drive. Nothing is written to the Home Assistant host's storage any more, and seeks into the part already received stay quick.

## 0.13.15

- Fixed seeks in Google Drive videos pausing for seconds. Each request from Home Assistant to Google takes over a second, and a seek chained a connection check, a metadata read and the download.
  - A read trusts a 'connected' from the last 5 minutes and reuses a file's metadata for 10 minutes; a failed download makes the next read check again.
  - Opening a Drive video copies the whole file to a scratch folder in the background, and seeks into the part already copied are answered without Google. The scratch copies hold at most 1 GB (least recently watched go first), are not made with less than 2 GB of free disk, are emptied on restart, and a finished copy whose SHA-256 differs from the index is discarded. They are not counted against the storage limit or archived; downloads always come from Drive.

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
