# module-archive

The archive: people and their family tree, locations and tracks, devices, photos, videos and documents, and finding things among them.

An [EiN](https://github.com/einhq) module. It is developed and tested inside a checkout of EiN core,
as `modules/archive`, and a deployment chooses whether to run it. `mod.json` is its manifest: the core it
needs (`coreApi`), the modules it depends on, and what it exports.

## What it holds

One module for everything the archive holds, in areas that keep their own folders (`lib/<area>/`, `types/<area>/`, `test/<area>/`, `ui/<area>/`) and aliases (`@archive/<area>/…`); people, location, device, media, document and staging were modules of their own until ein/core#442. **Finding things**, at the root (`search` and `facets` are core's since ein/core#442, with archive's `search-*` commands as its text providers): the global `timeline` and `timeline-facets`, the home page's providers `news-albums` (the albums people made lately), `events-anniversaries` (what comes round around a date) and `onthisday-media` (the years with pictures from a calendar day), `find-within` for the map. The search box's reading of words is archive's too (`archive-parse`, `lib/search/`, set as `CFG_SEARCH_PARSER`), and so is what it offers the assistant, in its `etc/assistant.d/`: its commands as tools, what it says of the archive, the family tree (`/family`) and map (`/map/pins`) cards, suggested questions and `agent-eval`'s questions. **people**: Family tree — persons, relationships, events. **media**: EXIF extraction, face detection, fingerprinting, reverse geocoding, picture vectors, transcripts and voices. **document**: Text extraction, OCR, semantic indexing. **location**: Location/location search; placing locations (`location-locate`, media centroid then `geocode-location`), kept up to date by `archive-bridge` and the `location-upkeep` / `location-link-point` pipelines; tracks (a device's recorded route is its child `track`; `track-create/append/read/import` take the device, `track-list` lists the devices that have one, GPX import, and a GPX file dropped in staging is imported into the device it names by `track-stage` (the `track-stage` pipeline) or waits on the staging page for someone to name it, while one uploaded on a device's Track tab goes through /tmp into that device's track (`track-stage --device`); the registry keeps `{points, firstTs, lastTs, bbox}`, which `track-list`, the timeline and its facets read for every track at once (`NodeVFS.trackSummaries`) — whoever appended, a command or a routing key — and `track-read` takes `--bbox`/`--from`/`--to`/`--tolerance` for a map viewport). **device**: Camera/recorder tracking, timestamp correction. **staging**: Private per-user media inbox in categories, the groups suggested for it (the organizer, its grouping verbs and the read-only `auto-album-cluster` analysis), duplicate review, existing-album suggestions, and promotion into the shared library

## Architecture

- [media-ingestion.md](architecture/media-ingestion.md) — the media ingestion flow phase by phase, face recognition, speaker recognition
- [media-hardware.md](architecture/media-hardware.md) — media work on any hardware: where models run, what happens when a step cannot run, how failed and missing work heals
- [staging.md](architecture/staging.md) — the staging area and its organizer
- [explore.md](architecture/explore.md) — the pages for finding things: Search, Timeline, Map and Media, the lightbox, albums and the staging page
