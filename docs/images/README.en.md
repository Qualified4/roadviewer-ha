# Screenshot guide

[한국어](README.md) · English

## Capture scope and privacy

All 27 screenshots were recaptured on 2026-11-11 from the real HTML/CSS/JavaScript of version **1.2.1**, in light and dark mode (54 files), with isolated browser API fixtures. No operational Home Assistant or Drive settings/files were changed. Viewports were 1440px desktop and 390px mobile (the phone map at 2× resolution); each dark-mode image has the same name with `-dark` (e.g. `roadviewer-overview-dark.png`), and the READMEs show the one matching the reader's theme.

Device ID `DEMO-DEVICE`, route hash `0000000000`, pairing code `DEMO0123DEMO4567DEMO8901`, capacities, times, tags, bookmarks, and vehicle values are examples. They are not actual credentials, device tokens, or private driving logs. The code cannot pair a device. The log-list thumbnails are generated example pictures. These layout examples do not replace real-account or playback validation.

The routes on the map screens are not real drives. They are road paths between public landmarks in central Seoul (City Hall, Gwanghwamun, Seoul Station and others) from a public routing service (OSRM), resampled to one point per second; the basemap is the real OpenFreeMap map fetched at capture time (© OpenMapTiles, OpenStreetMap contributors). The video scene and the map position are unrelated.

The 10 files of the five captures with video (video with vehicle graphs, road view, wide camera, Map tab, small map) were recaptured on 2026-11-14 with the version **1.3.7** UI (script `tests/docs_video_shots.cjs`, scenes and erased areas in `tests/docs_video_scenes.json`). Only the video in these captures comes from real drive logs: **light images use a daytime drive, dark images a night drive** (there is no daytime wide video, so both wide-camera images use the night wide video). Each is one real video frame made into a still clip and remastered: the daytime moments were chosen where the windshield reflection of the dashboard is barely visible; the reflection was estimated from many frames of the same segment (it stays fixed while the road moves) with the pixels covered by vehicles left out (their positions from the replay data, projected into the picture) and subtracted only where the frame actually shows it. Night frames got only gentle levels and sharpening that keep deep blacks and contrast, plus light multi-frame denoising. Every licence plate (front and rear, near and far cars) and the text of road and shop signs was erased so it cannot be read: the plate or sign is found inside its box and that shape is filled by inpainting from the surrounding pixels; lit signs were filled, glow included, from the dark surface around them. Captures made from the night drive show an evening start time for the example drive. The overlay is on with default settings and is drawn by the app from that log's own replay data and vehicle data (including the longitudinal control state) at the same time, so the overlay, the picture, and the speed, graph and road-view values match. All location (GPS) fields were removed from the served data; the route and position on the Map tab and the small map are the example route above and are not related to the video scene. Device ID, route identifier, dates, times and bookmarks are examples. The UI detail captures use Korean; the English documents share these images.

## Image list

| Image | Description | Basis |
|---|---|---|
| [roadviewer-overview.png](roadviewer-overview.png) | Replay: driving video with vehicle graphs | 1.3.7 · real drive video (light day, dark night) · plates erased · overlay on (that log's data) |
| [roadviewer-driving-view.png](roadviewer-driving-view.png) | Replay: driving video with the road view | 1.3.7 · real drive video (light day, dark night) · plates erased · overlay on (that log's data) |
| [roadviewer-wide-camera.png](roadviewer-wide-camera.png) | Replay with the wide camera selected | 1.3.7 · real night wide video (light and dark; no daytime wide video) · plates erased · overlay on (that log's data) |
| [roadviewer-library-map.png](roadviewer-library-map.png) | Logs tab map view: pastel route per drive and the glass card list of drives | 1.2.1 · fixtures · example route on the real basemap |
| [roadviewer-drive-map.png](roadviewer-drive-map.png) | Drive map: route per segment with segment cards, segment 1 highlighted | 1.2.1 · fixtures · example route on the real basemap |
| [roadviewer-drive-map-mobile.png](roadviewer-drive-map-mobile.png) | Drive map on a phone: map and segment card sheet | 1.2.1 · fixtures · example route on the real basemap |
| [roadviewer-replay-map.png](roadviewer-replay-map.png) | Replay Map tab: travelled route and current position | 1.3.7 · real drive video (light day, dark night) · plates erased · overlay on (that log's data) · example route on the real basemap (unrelated to the video) |
| [roadviewer-video-minimap.png](roadviewer-video-minimap.png) | Small map over the video (labels hidden) | 1.3.7 · real drive video (light day, dark night) · plates erased · overlay on (that log's data) · example route on the real basemap (unrelated to the video) |
| [roadviewer-library-upload.png](roadviewer-library-upload.png) | Upload tab with three selected files and preparation notes (device pairing is on the device tab) | 1.2.1 · fixtures |
| [roadviewer-device-pairing.png](roadviewer-device-pairing.png) | New-device pairing popup on the device tab (example code) | 1.2.1 · fixtures |
| [roadviewer-library-settings.png](roadviewer-library-settings.png) | Settings tab: conversion defaults and display mode | 1.2.1 · fixtures |
| [roadviewer-archive-confirm.png](roadviewer-archive-confirm.png) | Storage tab: confirmation before a manual move-all | 1.2.1 · fixtures |
| [roadviewer-storage-overview.png](roadviewer-storage-overview.png) | Storage tab: local and extended storage (Google Drive) status | 1.2.1 · fixtures |
| [roadviewer-storage-mobile.png](roadviewer-storage-mobile.png) | Whole storage tab on mobile | 1.2.1 · fixtures |
| [roadviewer-storage-advanced.png](roadviewer-storage-advanced.png) | Storage tab: advanced settings expanded | 1.2.1 · fixtures |
| [roadviewer-library-logs.png](roadviewer-library-logs.png) | Logs tab: quick filters, an open drive with segment thumbnails, automatic-control summary and route shape | 1.2.1 · fixtures |
| [roadviewer-bulk-selection.png](roadviewer-bulk-selection.png) | In-list selection mode and bottom action bar | 1.2.1 · fixtures |
| [roadviewer-download-options.png](roadviewer-download-options.png) | File and format selection for downloads | 1.2.1 · fixtures |
| [roadviewer-tags-library.png](roadviewer-tags-library.png) | Tag filter chips, tags on drives and segments, storage locations | 1.2.1 · fixtures |
| [roadviewer-tags-editor.png](roadviewer-tags-editor.png) | Segment tag editor popup | 1.2.1 · fixtures |
| [roadviewer-bookmarks-editor.png](roadviewer-bookmarks-editor.png) | Bookmark recording popup: scene time, title and note | 1.2.1 · fixtures |
| [roadviewer-bookmarks-list.png](roadviewer-bookmarks-list.png) | Replay bookmark tab: saved scenes | 1.2.1 · fixtures |
| [roadviewer-bookmarks-timeline.png](roadviewer-bookmarks-timeline.png) | Floating playback bar with bookmark markers | 1.2.1 · fixtures |
| [roadviewer-overlay-settings.png](roadviewer-overlay-settings.png) | Overlay settings popup (visible top part) | 1.2.1 · fixtures |
| [roadviewer-camera-info.png](roadviewer-camera-info.png) | Camera installation information popup | 1.2.1 · fixtures |
| [roadviewer-boundaries-probability.png](roadviewer-boundaries-probability.png) | Analysis panel **차선·도로** (lanes/road) tab: probability mode | 1.2.1 · fixtures |
| [roadviewer-boundaries-distance.png](roadviewer-boundaries-distance.png) | Analysis panel **차선·도로** tab: y[0] lateral distance mode | 1.2.1 · fixtures |

[Main guide](../../README.en.md) · [User guide](../../roadviewer/DOCS.en.md)
