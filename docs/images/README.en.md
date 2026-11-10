# Screenshot guide

[한국어](README.md) · English

## Capture scope and privacy

All 27 screenshots were recaptured on 2026-11-11 from the real HTML/CSS/JavaScript of version **1.2.1**, in light and dark mode (54 files), with isolated browser API fixtures. No operational Home Assistant or Drive settings/files were changed. Viewports were 1440px desktop and 390px mobile (the phone map at 2× resolution); each dark-mode image has the same name with `-dark` (e.g. `roadviewer-overview-dark.png`), and the READMEs show the one matching the reader's theme.

Device ID `DEMO-DEVICE`, route hash `0000000000`, pairing code `DEMO0123DEMO4567DEMO8901`, capacities, times, tags, bookmarks, and vehicle values are examples. They are not actual credentials, device tokens, or private driving logs. The code cannot pair a device. The log-list thumbnails are generated example pictures. These layout examples do not replace real-account or playback validation.

The routes on the map screens are not real drives. They are road paths between public landmarks in central Seoul (City Hall, Gwanghwamun, Seoul Station and others) from a public routing service (OSRM), resampled to one point per second; the basemap is the real OpenFreeMap map fetched at capture time (© OpenMapTiles, OpenStreetMap contributors). The video scene and the map position are unrelated.

For the three introduction photos (video with vehicle graphs, road view, wide camera), only the video area of the previous photos was cropped, turned into a still clip, and composited into the new replay screen. The lane and vehicle drawings inside the picture were already part of the old photos, so the overlay is switched off; the same applies to the Map tab and small-map captures that reuse the clip. Speed, graph, and road-view values are fixtures and do not match the scene. The UI detail captures use Korean; the English documents share these images.

## Image list

| Image | Description | Basis |
|---|---|---|
| [roadviewer-overview.png](roadviewer-overview.png) | Replay: driving video with vehicle graphs | 1.2.1 · video area of the earlier photos composited into the new UI |
| [roadviewer-driving-view.png](roadviewer-driving-view.png) | Replay: driving video with the road view | 1.2.1 · video area of the earlier photos composited into the new UI |
| [roadviewer-wide-camera.png](roadviewer-wide-camera.png) | Replay with the wide camera selected | 1.2.1 · video area of the earlier photos composited into the new UI |
| [roadviewer-library-map.png](roadviewer-library-map.png) | Logs tab map view: pastel route per drive and the glass card list of drives | 1.2.1 · fixtures · example route on the real basemap |
| [roadviewer-drive-map.png](roadviewer-drive-map.png) | Drive map: route per segment with segment cards, segment 1 highlighted | 1.2.1 · fixtures · example route on the real basemap |
| [roadviewer-drive-map-mobile.png](roadviewer-drive-map-mobile.png) | Drive map on a phone: map and segment card sheet | 1.2.1 · fixtures · example route on the real basemap |
| [roadviewer-replay-map.png](roadviewer-replay-map.png) | Replay Map tab: travelled route and current position | 1.2.1 · fixtures · example route on the real basemap |
| [roadviewer-video-minimap.png](roadviewer-video-minimap.png) | Small map over the video (labels hidden) | 1.2.1 · fixtures · example route on the real basemap |
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
