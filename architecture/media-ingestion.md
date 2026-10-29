# Media Ingestion Flow

Part of EiN Architecture (core's `docs/architecture.md`), which holds the core: topology, VFS, registries, managers, commands, node types, boot and servers. The module system that hosts this pipeline is in core's `docs/architecture/modules.md`.

Upload → index → derivatives → browse/search, driven by small pipelines in
[modules/archive/pipelines/](../pipelines), each triggered by the fact it
waits for rather than by a shared DAG:

1. **Upload.** `POST /file/<dir>/?name=` streams bytes into a new file node, under a numbered name
   when the name is taken, and sets `size`/`mimetype`/`sha256`
   (post-file (core's `src/servers/http/handlers/post-file.ts`)). The mimetype is sniffed from the
   head of the bytes, except that a camera RAW name (`.NEF`, `.RAF`, …) decides over a sniff that
   only says text, bytes or TIFF, as no sniffer knows the RAW formats, and a sidecar's name over
   one that says text: `.json` is `application/json` and `.xmp` (also over XML)
   `application/rdf+xml`, so a Takeout or XMP sidecar is metadata and never a document to index
   (core's `src/lib/media/raw.ts`). The `update` emits a VFS event on
   `system.vfs.file.updated`.
2. **Derive the fact.** `archive-bridge` sees it, checks the rules (media mimetype, has bytes, not a
   derivative, not in `/tmp` or a trash, no `metadata/exif` yet) and publishes
   `media.file.discovered` to `/dev/events`. Nothing under `/tmp` is ever a fact: a picture put there
   to search with is not the archive's, and indexed, its vectors would answer every search. Nothing
   in a trash is discovered or indexed again either: it waits there to be restored or purged.
   Metadata extraction is one `media.probe` call to EMS (`@archive/media/exif-service`), which runs
   exiftool there — a stay-open pool, numeric ungrouped JSON — and ffprobe for every video and
   recording, and hands both dumps back under `raw`. `exif-extract` keeps its interpretation
   (`types/exif.ts`, `exif-date.ts`, `video-codec.ts`, the orientation rules) over the exiftool
   dump exactly as before — exiftool's `MIMEType` replaces the sniffed one, a RAW name again
   deciding over a plain TIFF — and `resolveMediaFacts` reads the stream facts off the ffprobe dump
   rather than spawning a probe. The file-node and metadata existence checks are direct VFS
   reads; source SHA-256 measurement and content-change detection retain their previous
   semantics.
3. **Fan out.** Each pipeline binds one or more facts. Alternative triggers keep
   their own guards and run overrides, so a stale-transcript fact can bypass the
   ordinary "transcript already exists" guard without defining another pipeline:

   | pipeline               | fact                                                                            | resource                                                                                           |
   | ---------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
   | `media-ingest`         | `file.discovered`                                                               | pool `ingest` (1 cpu, priority 100)                                                                |
   | `media-reindex`        | `file.content-changed`                                                          | pool `ingest` (1 cpu, priority 100)                                                                |
   | `media-device`         | `metadata.extracted` (has device info)                                          | inline                                                                                             |
   | `media-geocode`        | `position.available`                                                            | inline                                                                                             |
   | `media-stills`         | `metadata.extracted`, not `undecodable`                                         | pool `stills` (1 cpu, priority 60)                                                                 |
   | `media-transcode`      | `metadata.extracted` (video/audio) or `file.turned` (forced), not `undecodable` | pool `transcode` (2 cpu), then the storyboard `stills` (1 cpu) and the chapters `shots` (1 models) |
   | `media-fingerprint`    | `metadata.extracted`, not `undecodable`                                         | pool `fingerprint` (1 cpu, priority 30)                                                            |
   | `media-faces`          | `metadata.extracted` (image)                                                    | pool `faces` (1 model slot, priority 100)                                                          |
   | `media-video-faces`    | `metadata.extracted` (video)                                                    | pool `faces` (1 model slot, priority 50)                                                           |
   | `media-embed-picture`  | `metadata.extracted` (image/video) or `picture.stale`                           | pool `embed-picture` (1 model slot; priority 50/10)                                                |
   | `media-embed-text`     | `text-embedding.stale`                                                          | pool `embed-text` (1 model slot; priority 20)                                                      |
   | `media-face-assign`    | `face.detected` (one per face)                                                  | pool `face-assign` (1 cpu, exclusive)                                                              |
   | `media-transcribe`     | `metadata.extracted` (video/audio) or `transcript.stale`, not `undecodable`     | pool `transcribe` (1 model slot; priority 50/10)                                                   |
   | `media-voiceprint`     | `transcript.generated`, `speakers.missing`; not `speakersAt`                    | pool `diarize` (1 model slot; priority 30)                                                         |
   | `media-speaker-assign` | `speakers.detected` (one per recording), `speakers.face-changed`                | pool `speaker-assign` (1 cpu, exclusive `person-mint`)                                             |
   | `media-speaker-faces`  | `faces.completed` (video with `speakersAt`)                                     | pool `diarize` (1 model slot; priority 30), then `speaker-assign` (1 cpu, exclusive `person-mint`) |
   | `media-duplicates`     | `duplicates.stale`                                                              | pool `dedupe` (1 cpu, priority 20)                                                                 |
   | `staging-retime`       | `staging.retime.requested` (a move into a category with other time rules)       | pool `retime` (1 cpu, priority 20)                                                                 |
   | `staging-sidecars`     | `staging.sidecars.arrived` (a sidecar, or media beside an unpaired one, landed) | pool `sidecars` (1 cpu, priority 30, exclusive)                                                    |
   | `staging-organize`     | `staging.category.changed` (a category's files changed, or a run was asked for) | pool `organize` (1 cpu, priority 15, reserved)                                                     |

   **Sidecars.** A Google Photos Takeout JSON or an XMP file beside a picture is paired with it by
   `media-sidecars` ([sidecars.ts](../lib/media/sidecars.ts)): moved under it
   as `<file>/sidecar`, a file carrying `sourceId` (the picture's id, so it is a derived file no
   pipeline takes) and `sidecar` (what it says), or a softlink to one an edited copy or a Live
   Photo's video shares. `exif-extract` and `@archive/media/resolve-time` read it as a capture-time
   source (`takenAtSource: 'sidecar'`) and for a position where the bytes have none. In staging the
   bridge announces `staging.sidecars.arrived` for the folder when an unpaired sidecar's bytes land
   or it is moved in, when a media file lands where one waits (asked with a one-row query, kept ten
   seconds), and when a directory is moved into a category, wherever the category pairs sidecars
   (`stagingCategory.sidecars`). The pipeline coalesces a folder's facts behind a 30-second hold.

   **The organizer.** The bridge announces `staging.category.changed` for a category's directory
   whenever a staged file in it is created, deleted, moved or updated in what grouping reads (its
   capture time, its reading, its faces, its camera, its type), a GPS fix is made for one, or a
   folder moves in, out or within; under `albums/` only a category's request
   (`albums/<category>/.request`, written by `staging organize --queue`) is announced, so the
   organizer's own writes start no run. `staging-organize` holds a category's facts two minutes and
   folds those arriving during a run into one more; the run reads what changed from the audit trail
   (`audit --after`) and plans only those parts again ([auto-albums.md](../docs/auto-albums.md#the-organizer)).
   Person assignments, geocodes and tags make no fact: the `staging-organizer` service finds them
   in the trail every 15 minutes and asks for a run. The fact names the category, which is in no
   lane, so a bulk category's grouping does not wait behind its own indexing.

   `media.file.removed` has no pipeline yet. The bridge derives it when an indexed media file's
   last name is unlinked, from the attrs the `system.vfs.file.deleted` event carries — the node
   is gone by then — so its `data` (`mimetype`, `size`, `sha256`) is what the file was.

   **`undecodable`** is a file-node attr naming why nothing can read the container, written by
   `exif-extract` when ffprobe refuses the file outright and cleared (set to null) by any later
   index that succeeds — see `UNDECODABLE_ATTR` in
   [media-probe.ts](../lib/media/media-probe.ts). ffprobe still exits 0 on a container
   holding a codec it cannot decode, so a refusal means there is no track table and no decoder
   will ever get a frame out of the bytes. That is a property of the file, not a transient
   error, so the four decoding pipelines `skipIfAttr` on it instead of counting the same
   permanent answer as two or three failures; `generate-derivatives` and `compute-fingerprint`
   repeat the answer for callers that come in below a trigger, and the lightbox shows the reason
   in place of a player that cannot work. `-f` overrides both commands; re-indexing with
   `exif-extract -f` is what takes the mark off.

   Pooled work is the work that needs one coherent host budget: the model-bound steps (slow
   calls into EMS), metadata ingestion, derivative rendering, fingerprinting, `assign-faces` (a
   kNN over every known face — it used to run inside `detect-faces`, holding a model slot for
   work that never calls EMS), and transcoding (minutes of ffmpeg). All of it sits in one
   `/pools/media`, and the two workers differ only
   in what they offer: the `models` service offers `models` slots and takes
   `faces`/`embed-picture`/`embed-text`/`transcribe`/`diarize`, the `cpu` service offers `cpu` slots and
   takes `ingest`/`stills`/`fingerprint` plus `face-assign`/`speaker-assign`/`dedupe`/`retime`/`transcode`.
   A `kind` no worker declares does not run slowly — it never runs at all, so the two
   lists have to be kept in step (`modules/archive/services/*/start.sh`).
   `assign-faces` also declares `exclusive: person-mint`, so two faces of the same
   new person cannot each mint one — previously only the worker's concurrency
   prevented that, and only by accident.
   Its second step, `person-cover --file` (module `people`), runs inline after the assignment
   and gives every named person in the image who has no cover a `coverPhoto` link to the crop
   of one of their own faces (`@archive/people/cover`): human-assigned faces first, then photos where
   they are the only face (`faceCount` 1), then confident detections, then the largest face in
   display pixels, walking down the ranking until a crop has bytes. A cover that still resolves
   is never replaced unless it is a face crop whose face now belongs to somebody else. Links it
   writes carry `autoCover: true`, so `person-cover --repick` can redo its own picks after the
   ranking changes without touching a cover somebody set. Faces moved by hand — naming, merging, splitting — pass no
   pipeline, so the `people` module's `person-covers` service runs `person-cover --all` hourly
   as the reconciler.
4. **Derivatives.** `generate-derivatives` reads `config/sizes.yaml` and writes web renditions as
   **child file nodes** under a `thumbnails/` directory of the media node, named by size class.
   Images are **AVIF** (`320x320` cover thumb, plus `512x512`/`800x800`/`1600x1600`/`2560x2560`
   `contain` sizes), video is **AV1** in MP4 (`1920x1080.mp4` with AAC, and a silent
   `480x480.mp4` hover clip) with the image sizes up to `1600x1600` as poster frames, audio is AAC
   in MP4 (`128k-44100.m4a`) plus a rendered waveform in the image sizes. The `<width>x<height>` name is the target **box**: a `contain`
   rendition is usually shorter, and never upscaled past the source (`fit: contain` in EMS's
   `image.renditions`, `min(iw,W)` in `video.transcode`). Only the `cover` thumb enlarges, because
   it owes its consumers an exact square. A source smaller than a box lands at its own size in
   the first box it fits, and the boxes above it are **not made** — they would be byte-for-byte
   copies. The UI applies the same cut (`availableBoxes` in
   `src/builtin/ui/src/client/lib/derivatives.ts`, from the node's `width`/`height`/`angle`/
   `sar`) so it never asks for a size a small file lacks, and its `w` descriptors say the
   rendition's real width rather than the box's. A file without stored dimensions gets, and is
   asked for, the whole ladder; `regenerate --prune` removes the copies made before this rule.
   Only two consumers use the `cover` crop now — the 48px map marker and the album cover
   card — so `512x512` (`grid`) exists as the _contain_ rendition the justified media grid draws
   a tile from, and video gets it too so a video poster is the clip's own shape rather than a
   square. `--only still|transcode|storyboard` splits by the cost of the work, not by media type:
   `media-stills` runs `still`, every AVIF picture of every type (photo sizes and face crops,
   poster frames, waveforms), and `media-transcode` runs `transcode`, the ffmpeg renditions of
   video (the `preview` hover clip included) and audio, so a failed encode never takes the poster
   frame with it, and then `storyboard` (below); `--size a,b`
   narrows a run to named sizes, which is what makes adding a size a ~1-hour backfill rather than a
   re-encode of the whole ladder; `--prune` deletes renditions that are no longer targets, which
   is how a format change cleans up after itself. Every still-image size of one file is one
   EMS call from `@archive/media/image-ladder` — `image.renditions` for a photo, `video.poster` for a
   clip, `audio.waveform` for a recording — so the source is decoded once and every output is
   an independent clone of it; no smaller rendition is ever cascaded from a larger one, and a
   video's poster frame is extracted and square-pixelled once. Every image output is first
   written to a hidden temporary VFS sibling whose physical path EMS is handed, and all staged
   outputs must be non-empty and reconciled before any final path is replaced, so an
   interrupted or partially successful ladder leaves the old renditions servable. A temp an
   interrupted step leaves behind is removed by the next ladder or transcode into the same
   directory once it is a day old (`@archive/media/staging`). Both
   audio/video transcode settings are unchanged. All derivatives carry `sourceId`, which is
   how the bridge knows not to index them. Originals are never modified (rotation applied
   from the `angle` attr at derivative time, by EMS, in the display frame).

   **Audio carries both a sound rendition and a picture.** EMS's `audio.waveform` draws the
   envelope with ffmpeg's `showwavespic` in the UI's own accent-on-media-bg palette
   (`WAVEFORM_STYLE` in `@archive/media/image-ladder` states the colours and the banner aspect), so audio
   gets the same `thumb/grid/small/medium` AVIF renditions a photo does and the tile, the srcset and
   the cover card need no special case. The picture is drawn at each target's aspect rather than
   resized into one — `cover` draws square, `contain` a 3:1 banner — because centre-cropping a
   waveform leaves a slice that reads as a blob, and every size comes from one decode of the
   track (`aresample=8000` ahead of the drawing still leaves thousands of samples per column).

   **Video carries two mp4s, and they are not a ladder.** `1920x1080.mp4` is what the lightbox
   plays; `480x480.mp4` is a silent 20-second clip a grid tile plays under the pointer, and on a
   touch screen when it scrolls into view. Both are one `video.transcode` call each — the hover
   clip with `clip: {start, duration}` (an input-side seek, so the decode starts at a keyframe
   near the offset instead of at zero) and `audio: null`, neither of which touches the filter
   graph, so EMS's CPU and CUDA chains stay in lockstep. The clip starts at 00:00:01, exactly
   where the poster frame was taken, so swapping the still for the clip shows the same frame
   twice rather than a jump cut. Its class is `transcode`, not `preview`: the class names the
   cost, and a 20-second re-encode belongs on the media pool beside the full rendition. A source
   under 2s gets no clip at all — the poster already is the whole video — which is read off the
   file node's promoted `duration`. The sound rendition's `bitrate`/`sample-rate` in `sizes.yaml`
   are **ceilings**, not targets — `audio.transcode` caps them at the source's own and stays
   mono for a mono source, after a flat 128k stereo turned a 14.8 MB 64 kbps mono tape rip into
   a 30 MB rendition carrying strictly less information.

   The transcodes (`@archive/media/transcode`) and the image ladder
   **create the output node before EMS writes** — `sourceId` has to be set at creation so
   the bytes route to the volatile tier — and so they must delete that node again when the encode
   fails, or the failure is indistinguishable from success to anything downstream. For the same
   reason `generate-derivatives` treats a **0-byte rendition as absent** rather than as done:
   presence alone made one failed encode permanent, since every later run skipped the empty
   placeholder.

   **Face crops are a target too, and that is what makes them repairable.** A face crop
   (`regions/<region>/image.avif`) is a rendition like any other — it carries the source's
   `sourceId` and routes to the volatile tier — but it is _written_ by `detect-faces`, from a
   box rather than from a size class, and it lands under the region instead of under
   `thumbnails/`. For a long time that also meant it was in no entry of `generate-derivatives`'
   target table, and the table is what a `regenerate` sweep walks: `find-broken-renditions`
   could _find_ an interrupted crop and nothing could rebuild it, so on a multi-week crawl
   every interrupted write was permanent (14 of them in production, and the UI shows its placeholder
   for those faces indefinitely). It is now the `face` target of the `preview` class, so
   `regenerate --size face` is the repair pass and `-f` re-cuts. Rebuilding needs no detection —
   the box is stored on the region and a crop is reproducible from it forever — and both
   authors of `regions/` are covered, `face-*` and `manual-*` alike. A video region's crop is
   cut from the frame at its `atSeconds` (`video.poster` with the box as `crop`, one call per
   frame). `--prune` never
   reaches it: prune only walks `thumbnails/`. The rebuild itself is
   [@archive/media/face-crop-rebuild](../lib/media/face-crop-rebuild.ts), shared with
   `detect-faces` and `regenerate-face-crops` so the four spellings this used to have cannot
   come apart again; the geometry stays in `@archive/media/face-crop`.
   `regenerate-face-crops` remains separate because it answers a different question — re-encode
   crops that exceed `MAX_CROP_DIMENSION`, in resumable pages over the whole corpus.
   Cutting from the original rather than from a decoded copy used to mean the rebuild owed the
   frame question its own answer per family, which is where face crops have gone wrong before: a
   RAW's box was measured on the embedded preview while ImageMagick decoded the sensor image, and
   a HEIF came back from libheif already turned by its `irot`. The box now travels to EMS as a
   fraction and nothing else, and EMS cuts it out of whatever raster it decodes, so neither family
   needs a declared frame any more (docs/api.md §3.3 and §4.2 in the ems repo; what EiN owes
   is the node's `angle`/`mirror` and its mimetype).

   Two constraints are worth knowing before touching this. **A rendition must carry no
   orientation tag** — ImageMagick's `-strip` does not clear its own orientation property, only
   the EXIF block, and the AVIF encoder writes the property as a HEIF `irot` transform which every
   decoder then applies, undoing the rotation: the identical chain measured 800x1600 as PNG and
   1600x800 as AVIF, so every rendition of an EXIF-rotated photo was served in the original
   orientation. EMS clears it (`-orient Undefined` beside `-strip`, `ems/tools/magick.py`) and the
   contract promises it (§4.2). And an AVIF's `ftyp` header is indistinguishable from an MP4's
   to the content sniffer, so `src/lib/media/mime.ts` classifies it by major brand — otherwise
   every thumbnail is stored, and served, as `video/mp4`. The audio rendition uses ffmpeg's
   **ipod** muxer for the same reason: it writes the `M4A` brand that marks the file as audio.

   **A video also carries a storyboard**, `storyboard-<tile>.avif`: its frames at an even interval
   tiled into one sheet, for the frame the lightbox player's timeline shows under the pointer.
   EMS's `video.storyboard` makes it from the `1920x1080.mp4` rendition rather than the source —
   the rendition is upright and is the timeline the player plays — so it is its own class,
   `storyboard`, run by `media-transcode` after the transcode and forced with it when a video is
   turned; not `still`, which a turn re-makes inline. The interval grows with the length rather
   than the sheet (`sizes.yaml`: at most 240 tiles of 160 px), so any video is one sheet, and how
   to cut it into tiles is on the sheet's node (`storyboard` attr: interval, count, columns,
   rows, tile size; `@archive/media/storyboard`). A video under 4 s gets none, and an EMS from
   before the op is skipped rather than failed. `--prune` keeps it by name; writing a sheet
   removes any other. It is no gap: nothing announces a video without one, so the videos indexed
   before it have none until they are re-imported or transcoded again.
5. **Serve/browse.** The UI lists a media directory via `ls -l`; when a `thumbnails/` child is present
   it requests `/file/<path>/thumbnails/512x512.avif` (grid tile) and a `srcset` of the photo renditions
   (lightbox, so the browser picks per viewport), falling back to the original when `thumbnails/`
   is absent (not yet indexed). A tile that 404s falls back first to the **same** rendition with the
   `srcset` dropped — a browser given a srcset never falls back to `src`, so one advertised rendition
   the corpus does not have yet would otherwise take down a tile whose own rendition is present — then
   to the next **contain** rendition, and never to the square thumb: that crop has already lost the
   sides of the picture, and re-cropping it into a non-square slot would turn a justified grid
   back into squares. `get-file` honours `Range` and answers 206, which is what lets `<video>`
   seek without buffering the whole transcode.

   **Renditions are cacheable, originals are not.** `get-file` sets `Cache-Control` only on nodes
   carrying `sourceId`: their URL is stable and their bytes change only when something explicitly
   regenerates them. Without it a browser has neither `Cache-Control` nor `Last-Modified` to
   compute freshness from, so every grid tile and every hover preview costs at least a 304 round
   trip. The headers go out with the 304 too — one that answers "unchanged" and carries no
   lifetime goes stale the moment it lands, which defeats the header on exactly the requests it
   exists for. The session that _causes_ a regeneration (a rotate in the lightbox) busts the URL
   itself through `client/lib/derivative-version.ts`, which is shared so the grid behind the
   lightbox updates too.

   **A video tile plays.** With a pointer, resting on it swaps the still for the `480x480.mp4`
   clip after a short hover-intent delay; on a touch screen an IntersectionObserver plays the
   most-visible video tile instead, since there is no hover to react to. Exactly one tile plays
   page-wide — `client/lib/video-preview.ts` owns that decision at module level rather than
   per-grid, because a timeline renders one grid per date bucket and each would otherwise pick its
   own. Leaving unmounts the `<video>`, which is the whole reset: the still underneath is the same
   frame the clip started on. `prefers-reduced-motion` disables it, and a clip that 404s is
   remembered so a not-yet-backfilled video is asked for once and never again.
6. **Search.** `embed-picture`, `transcribe-file`, `index-document`, `read-text` and `compute-fingerprint` (a picture's or a video's keyframes' SSCD copy-detection descriptor, taken from what `embed-picture` reads) populate the embedding registry.

   **Text indexing.** `document-index` runs `index-document` on a file's VFS `updated` and on its
   `moved`, one trigger body shared by both: PDF, plain text, Word and OpenDocument text. JSON and
   XMP sidecars are not documents (step 1). Pictures are `media-ocr`'s: `read-text` on the media
   pool (kind `ocr`), after `media.metadata.extracted` so the picture is read in its display frame,
   and on a `moved`. It asks EMS `ocr.read` (PP-OCRv6) for the original's lines and keeps them
   beside the text, `lines` on `<file>/metadata/content` (each line's words, four corners as
   fractions of the picture, and score), and stamps the file `ocrBy`. `media-scan` announces
   `media.ocr.stale` for a picture whose `ocrBy` names another engine than EMS names in
   `capabilities.models.ocr`, and `media-ocr` reads it again with `-f`; a reading without text
   removes the old one. A picture Tesseract read has no `ocrBy` and keeps that reading until a
   reset or import reads it anew. Plan: wow `history/ocr-tiers.md`.
   EMS tells the language of the text from its reading, and the language picks the transcriber
   that writes the picture's handwriting (Swedish and Finnish, or English); `read-text` keeps it
   as `ocrLanguage` and `ocrLanguageConfidence` on `<file>/metadata/content`, none when there is
   too little text to tell. `file-set-text-language <file> <code|auto>` sets it by hand as
   `ocrLanguageManual` on the file, which `read-text` gives EMS instead; the bridge reads that
   write on a read picture as `media.text.language-set`, and `media-ocr` reads it again with `-f`.
   Plan: wow `history/ocr-language.md`.
   `file-set-text <file> --text-base64 <b64>` (the lightbox's text editor) writes the text by
   hand: it replaces `<file>/metadata/content` without `lines`, embeds it, and marks the file
   `textManual` with no `ocrBy`, so `media.ocr.stale` passes it by and `read-text` refuses it
   even with `-f`.
   Nothing under `/home/<user>/staging/` is read while it is staged: the triggers' `unless`
   skips it before any shell runs, so an import costs no OCR and no filter evaluation per write.
   The same `unless` leaves out EiN's own paths (`/var`, `/etc`, `/usr`, `/dev`, `/tmp`),
   dotfiles, a trash among them, and the pipeline's own `metadata/content`.
   A file is read when it leaves staging, by the `moved` trigger; staging's own filing (promote,
   `album add`) moves the files themselves, a `moved` event each. A directory moved out whole
   publishes `moved` for the directory alone: the bridge binds `directory.moved` and announces
   `media.text.missing` for each file within it that has no `textIndexedAt` (one subtree query,
   `deriveTextGap` per file). A write while the engine was down reaches no trigger: for that
   `media-scan` announces the same fact (the filter's mimetypes and every picture as
   `isTextIndexedMimetype`). The fact is a trigger of both pipelines, each for its mimetypes, with
   the same `unless`, so a directory moved within staging reads nothing. `textIndexedAt` is written whether text was found or not, so a file is read once.

   **Picture search.** `embed-picture` writes a SigLIP2 vector per photo, or per video keyframe,
   under `<file>/metadata/picture/` (`embedding`, or `k0`… with `atSeconds`), typed by model in
   [embedding-types.ts](../lib/media/embedding-types.ts) and stamped `embeddedBy` on
   the directory last. `search-media` embeds the query through SigLIP2's text tower as well and
   answers the matches as the `picture` channel, beside its `content`, `transcript`, `authored` and
   `name` channels; `search` fuses them by rank (below). Picture cosines have their
   own floor (0.08), since a clear SigLIP2 match is 0.1-0.2. `media-scan` announces `picture.stale` for a
   photo or video with no vectors or vectors from another embedder (`imageEmbedGeneration()`).
   The model choice and the weights come from a retrieval eval over the archive.
   core's `src/lib/search` — core's since ein/core#442, its text from the modules' `search-*` providers — is a faceted **candidate-source pipeline**:
   text, tags, a time window, a map region, a content kind (a file's by its mimetype —
   `photo`, `video`, `audio`, `document` — or else a node's type: `album`, `person`, `location`),
   a subject (`--subject <kind>:<ref>` — a person, a location, a device), a container (`--under <album>`) and a creator (`--creator <user>`,
   the node's birth uid) are independent facets and **any subset is a valid query** — a year range alone needs no
   text, and no facet at all is the newest-first browse of everything with a capture time.
   `--within <dir>` is the media in the tree under a directory, however deep (`NodeQuery.within`): a
   place, not a membership, so it narrows the indexed timeline itself and takes no words, `--like`,
   tag, subject, `--under` or region. With no date window the undated follow the dated, in the
   order they arrived; `--undated` lists only those, with or without a subtree. With no `--kind`
   both list pictures, videos and recordings, not the directories and other files beside them, and
   `--facets` counts that set in the store, each media kind a named count of the aggregate. `--layout` with it answers the whole subtree when
   it holds at most 20,000 nodes (`countWithin`), and `truncated` at once otherwise, which a caller
   pages instead. Whatever drives, nothing in an unlisted tree (a staging area) is an answer unless
   the `--within` asked for is inside it or `--under` a container links it
   (unlisted trees (core's `docs/architecture.md`)). `--missing <attr>` (repeatable; a nested
   attr dotted, `duplicate.deferred`) keeps only what lacks the attr: a condition of the store
   query when the timeline drives, `--within` and `--facets` included, and a test of each node
   read under any other driver.

   The seek is only fast because the planner is told how common `sourceId IS NULL` is: `PgStore`
   creates an extended-statistics object for that expression (no index carries stats for it, and
   PostgreSQL otherwise assumes one row in two hundred), and the SQL builder drops the redundant
   `IS NOT NULL` on the ordering attr when a range on it is already present. Without both, a seek
   matching 100,000 rows was estimated at 37 and sorted rather than read in order — 600 ms against
   1 ms (`src/stores/pg/index.ts`, the `_source_stats` block).

   The creator is a node column, not an attr, so it is the one facet `NodeQuery` carries beside
   `types` (`birthUid`) rather than in `where`; both stores apply it as an equality on the nodes
   row. It rides inside the indexed query whenever the timeline drives — the media page's **My**
   scope over a whole archive — and degrades to a predicate only when a more selective source
   drives, like every other facet.

   Exactly one source _drives_ (priority `text → tag → subject → container → geo → timeline`) and every other
   active filter degrades to a predicate over its candidates. `textSource` fans out to the
   search providers (every `search-*` command on `PATH`); `timelineSource` is the indexed `vfs.query` and the only one with true keyset
   paging — and therefore the only one that cannot be paged upward by position, so `--above <token>`
   reads the same keyset query the other way from the token and turns the page round. A seeked
   (`--at`) page carries a page's worth of rows above its bound in the same answer — read upward
   from the bound, turned round, put in front, with `anchorIndex` saying where the seek itself
   begins — so a reader lands with somewhere to scroll up into without a second round trip; it and
   every upward page report `above`, the token for the page over them, until nothing is left; `geoSource` runs a bbox `findWithin` then refines exactly in JS (haversine or ray-cast,
   reusing `src/registries/position/geo.ts`) — no geo primitive was added to the registry.

   **Text is fused by rank.** A provider answers one row per hit and channel (`SearchChannel`:
   `name`, `description`, `authored`, `content`, `transcript`, `picture`, `members`), each
   with a score on that channel's own scale and its own floor, applied by the provider. `textSource`
   keeps a file's best score per channel across the providers — `search-media` and
   `search-document` both answer `content` — ranks each channel by score, then path, and sums
   `weight / (60 + rank)` over the channels that found a file (`CHANNEL_WEIGHTS` in
   core's `src/lib/search/sources.ts`). A name — exact, or a prefix that ends a word of
   it — weighs enough that alone it leads a file found first by both its picture and its text; a
   name hit below 0.75 on the `name` scale — the query begins a longer word or is inside the name
   — counts at a lower weight. A hit its provider
   marks `confident` counts as a name does, whatever its channel: `search-media` marks a transcript
   hit at or above the text space's confident similarity (0.55, `embedQuery`), the recording meant
   rather than one where something like the query was said. What is said and what is written are also matched by
   their words: the query as a phrase in the `text` a transcript chunk's or an extracted text's
   vector node carries (`contains`, served by archive's `spoken_text` trigram index), from three
   characters. Such a hit scores above every similarity on its channel's scale (1.2, or 1.1 inside
   a longer word) and a transcript hit seeks to the first minute that says it; as words of their
   own it is confident, since a name said once in a minute of speech, or on a sign in a picture,
   barely moves that vector. A subject whose name matched
   confidently adds its media as the `subject` channel, each at its subject's `name` rank.
   The fused score is divided by the answer's best, so the first hit scores 1; the order is fused
   score, then path, the same on every page. `--fields channels` reports a hit's rank per channel.

   **More like this.** `search --like <path>` asks a picture instead of words. It drives as text
   does — the same fan-out, page and cursor, and every other filter narrows it the same way,
   `--within` included — but only to the providers that answer `like: true` (`search-media`), as
   `<provider> --like <path> -l <limit>`; words with it are refused. `search` reads the path first,
   so a picture the caller may not open is refused before a provider is asked about it.
   `search-media` takes the file's own picture vectors (`metadata/picture/`: a photo's one, a
   video's keyframes), runs each through `findSimilar` on the picture type and answers the `picture`
   channel only, a file scored by its best pair's similarity, so a video asks with its keyframes and
   is found by its best one; `search` ranks that channel as it ranks any other. A file with no
   vectors — not embedded yet, or a picture put in `/tmp` only to search with — is embedded on the
   spot through `vision.embed` at interactive priority and the vectors kept nowhere. The picture
   itself, a copy of its bytes (the same `sha256`) and the rest of its stack (its album's
   `mediaStacks`) are left out. Image-to-image cosines in SigLIP2's space run high (in production
   the 2000th nearest picture to a photo still scores 0.75), so no floor is applied: the answer is
   the nearest files in order, and inside a set every member is ranked rather than cut. The Media
   page sends a picture from the device to `/tmp` (drawn upright and at most 1024 px in the browser,
   since EMS never applies EXIF orientation itself) and searches `--like` it; the lightbox's Similar
   strip is the same search's first dozen, and its Show all opens the Media page on it. The core
   `tmp-sweeper` service removes a file left in `/tmp` after `CFG_TMP_RETENTION_HOURS` (24).

   **Like a label.** `--like /archive/tags/<label>` asks with the label's model (`label-model`,
   see Label suggestions in `docs/architecture.md`): `search-media` runs its direction through
   `findSimilar` from its own floor, and `search-album` scores albums by their members against it
   as `members` does for words. `search` sends a tag directory to the `like: true` providers and
   to those that answer `likeLabel: true` (`search-album`), which rank by a label but not by a
   picture. What carries the label — itself or through an album — and what was rejected for it are
   left out.

   **Text inside a subject.** The text driver pulls one page (`TEXT_HIT_LIMIT`, 500) of the
   providers' best hits, so a person's picture that ranks below it was never found: "segelbåt"
   with a person of 8 868 pictures came back empty in production. With a person, location or album present,
   `search` writes the intersected file ids (up to `WITHIN_LIMIT`, 50 000) to a `/tmp` file and
   hands it to every provider that declares `within: true` in its `--kinds` answer
   (`search-media`), which ranks inside it: its embeddings are found by walking the known layouts
   with `getChildLinksByIds`, and `findSimilar(…, within)` ranks exactly those ids — a
   primary-key lookup with an exact distance per row, no HNSW `ef_search` ceiling. The region is
   left out of the set and stays a predicate, so the set is always a superset of the answer.
   In production "segelbåt" within one person's 8 879 pictures answers in 1.6–2 s warm: 0.4 s to find
   their 9 176 embeddings, 0.1 s to rank them, the rest resolving the person.

   Kinds are `photo video audio document person location album device track`. The last five are
   **timeless** — they carry no `takenAt`, and `orderBy` drops rows missing the ordering attr, so a
   kind set made only of those defaults to `--sort name`, and under a time sort pages on the store's
   default id order. A name sort on the timeline orders the store query by `name` and then, as a
   second keyset phase, lists the nodes without one in id order — a `/locations` node is not
   guaranteed a name, and would otherwise vanish. Names are sorted in the archive's language
   (`CFG_LANGUAGE`, read as policy when the search runs, English when unset): the store's collation
   for it — in Swedish, `sv-x-icu`, case does not split the list and Å, Ä, Ö follow Z — and the
   one the materialized sources sort names with too. Core declares a `name_sorted_<language>` index
   for each language (partial on `name`, held in its collation), so a name-sorted page of the whole
   archive is an index walk whichever the archive is in. A page of one kind by name — people,
   albums — is a walk of a second index per language, `type_name_sorted_<language>`, over the attrs
   row's own copy of the node type (`node_type`) and the name in that collation. No attrs index
   holds the joined nodes' type, and with the type filtered there the planner, taking type and name
   as independent, reads every name after the cursor and sorts it (ein/core#544). Several
   kinds at once filter on the node.

   A subject, a year, an area or a label is something a picture has, so a kind set made only of
   timeless kinds cannot meet one directly. With such a filter `search` first asks
   `search --group-by <their node types>` of the files (the same filters, 100 000 media at most)
   and lets an album through only when it holds a match; a text query still ranks the albums by
   their own name and description. A kind of subject (`person`, `location`) answers through the
   pictures the same way: the people the matching pictures have, the locations they are linked
   to. In production "boat" in 2011 answers in 2.4 s warm, 2 s of it the tally.
   What meets the filter itself joins them: when labels are the only picture filter, the entities
   carrying every one of them (labels are mostly given to albums); when an area is, the entities
   inside it by a position of their own.
   `--group-by` climbs from where each file sits and from every softlink filing it (a file added
   to an album with `album add` is a link there), cover links aside, so an album that links a
   match is found like one that holds it. For a kind a module answers `subject-<kind>` for, it
   climbs nothing: `subject-<kind> --of <ids file>` says which subjects each match has
   (`SubjectsOf`; archive's reads them outwards from the files with `readSignals`, plus the voices
   naming each recording). A subject nobody has named — a group of faces under `people/unknown/`
   — is no group: the answer's `unnamed` counts the matches showing one, pictures rather than
   people, since such a group is as often a stranger in the background as someone who was there. So
   `search --under <album> --group-by person` is who was at an occasion, in one call.

   **Text outside the unlisted trees.** A staging area is no part of the library's searches
   (`src/lib/search/unlisted.ts`), and its hits must not use up a provider's `-l` either: an inbox
   of thousands of boats would push every boat in the library out of the 500. So `search` hands
   each unlisted root to the providers that answer `notWithin: true` (`search-media`,
   `search-document`, `search-album`) as `--not-within <dir>`. A store query of files takes it as
   `notWithin`; a vector or a text's words sit under their file, where `notWithin` does not reach,
   so those lookups drop what resolves into a tree and ask again for four times as many, up to
   50 000 rows, until the library fills the page (`listedRows` in
   [listed.ts](../lib/search/listed.ts)). `search` still drops an unlisted hit
   from any provider.

   **Albums match on what their pictures show, as well as what they are called**: `search-album`
   scans `/albums` for a substring match over name and description, and its `members` channel
   ranks albums by their pictures: the query in the
   pictures' space against every picture (the nearest 2000 above the picture floor, whatever `-l`
   is), each hit's file mapped to the albums holding it in one pass (`albumsHolding` in
   [album-members.ts](../lib/media/album-members.ts): the album or its `files/`
   holds the file, or links to it other than as its cover, found by one backlink query per 2000
   files), and each album scored by its mean member likeness — the members outside the pool, and ten
   more, at the floor — so an album that is mostly the query outranks one holding as many of it
   among thousands (`mediaCount` from `album-span` is the size). `search` weighs `members` at 0.5,
   below a name.

   **Providers say what they can answer.** A provider is a module command named `search-*`,
   answering `--kinds` with the content kinds it returns (and
   `within: true` when it ranks inside a set `search` hands it, `notWithin: true` when it leaves
   out the trees `search` names, `like: true` when it ranks by a picture or a label,
   `likeLabel: true` when by a label only); `search` probes every provider once
   (together, memoized in module scope), drops the ones that do not answer, and fans out only to
   the ones that can contribute to the requested `--kind`. Without the kind filter a narrow query
   paid every provider to embed the same string — which is also what makes the UI's per-keystroke
   `@`-completion affordable. Before the probe, a command that merely shared the `search-` prefix was
   consulted on every search: `search-facets` (now `facets`) ran its whole-corpus aggregates beside the real
   providers, and the search waited for the slower of the two to discard the answer. Core's own
   commands keep out of the prefix since.

   **One query embed per search and space.** `search-media`, `search-document` and `search-album`
   rank the same query vector, each against its own embedding type, so `embedQuery`
   (module-ems's `lib/text-embedding.ts`) makes one `text.embed` request per
   query text and shares it; `embedPictureQuery` does the same for the pictures' space
   (`vision.embed_text`), which `search-media` and `search-album` both rank. The providers are
   commands in one process, so the request lives in module scope, and its vector stays for a minute
   afterwards, which also answers the next page's fan-out. A request ends when the command that made
   it is interrupted; a provider that was waiting on it then makes its own.

   **Providers' warnings reach the caller.** A provider that degrades its answer — `search-media`
   dropping the content half when EMS cannot embed the query — says so on a stderr
   that `search` captures. `textSource` collects those lines and `search` reports them as
   `warnings` in its JSON (and re-emits them in text mode) beside `elapsedMs`, its own wall time;
   the media page shows both, because a page of filename matches otherwise looks like the answer
   to the question asked.

   **Text matching is names _and_ content.** `search-media` scores the filename and `name` attr
   alongside the content channels, because nothing in a picture will ever say `DSC_4471` — and
   because the name half needs no model, a search still answers when the media
   service is down. That half is a `contains` query against the trigram index, ranked in the store by how well
   the name matches (an `orderBy` with `match`), so it costs the number of files that matched rather
   than a scan budget, and keeps the best of them however many there are. The substring ladder the entity providers share
   weights fields by role: a name is a claim about identity, a description is prose that happens to
   contain a word, and unweighted an album whose _description_ merely opened with a person's name
   scored as highly as one actually named after them.

   **A date typed into the box is a time filter**, not text to match — `sailing 2011` means sailing,
   in 2011. Deliberately narrow (a plausible four-digit year or an ISO date, and only when no
   explicit `--from`/`--to` was given), reported back as `filters.dateFromQuery`. It is the one part
   of the natural-language parser worth keeping without a model.

   **A person or location the query names brings its media with it.** A confident name match on a
   subject expands into `subjectMedia`, scaled below the subject itself — searching someone's name
   and getting only their person node back is the wrong answer to the obvious question, since a face
   is how a picture knows about a person.

   **A time or name sort orders the answer, not the page.** `--sort time`/`-time`/`name` on a
   materialized source (text, tag, geo; a subject or container for `name`, being time-ordered
   already) hydrates the whole set — one batched `getNodesByIds` for candidates carrying an id,
   parallel `get` for the rest — and sorts it before paging, so page 2 continues where page 1
   stopped. A name is the `name` attr, else the last path segment, as the hit shows it.

   The subject sources (`search/subjects.ts`) know no kind of subject. A module that has one puts
   `subject-<kind>` on `PATH` — found by that name, like `members-<type>` and the `search-*`
   providers — and `search --subject <kind>:<ref>` (or a path, whose node's kind is used) asks it
   with `JSON_OUTPUT=1 subject-<kind> <ref>...`, one run per kind. It answers a `SubjectListing`
   (`@ein/client`): per ref, the subject's path and either the **ids** of its media or one attr
   **match**. Archive's `subject-person` and `subject-location` (`modules/archive/lib/subjects.ts`)
   answer ids, the **reverse** of the file-node link conventions below: `vfs.findLinks` finds the
   `location` / `people/<slug>` softlinks pointing at a subject, the `personId` attr index finds its
   assigned faces, and batched parent-link rounds walk those up to the files that hold them. Its
   `subject-device` answers the match `devicePath = <device>`, which `search` pushes into the
   timeline query like any other condition, so a camera with 20k photos pages and counts in the
   store; elsewhere it is tested per candidate. An id set is joined to `takenAt` in core, ordered
   (undated media sort last rather than vanishing, as they do from a store-ordered timeline) and
   paged by offset. `--subject-name <kind>:<words>` asks the text providers that answer that kind
   for every subject the words match in the `name` channel (50 at most), then their subject command, and
   unions them into one group.
   **That offset is why these two sources can be read in both directions**: `--at <date>` starts a
   page at a date rather than at the top, the answer reports the `offset` it started from, and the
   page _above_ one is simply the one starting `limit` earlier — no second ordering, no reversal.
   `--at` works on **every** source now: the other materialized ones seek by the same position
   lookup once they are time-ordered, and the keyset timeline driver expresses the seek the only way
   an ordered store can — as another bound on `takenAt` in the direction the list runs. It requires
   a time sort, and refuses a timeless kind, because a seek into an order with no dates in it is not
   a seek.
   `--facets` buckets the same set into per-day, per-month and per-year counts, plus a per-kind
   tally and the twenty labels most carried (`attrs.labels`, so a suggestion nobody accepted is not
   counted); the date buckets are shaped like `find-within --facets` and `timeline-facets` because the same rail draws all
   three. When the timeline drives and every filter was pushed into the store (time, a single media
   kind, a match subject), the store counts it — four `vfs.aggregate` calls, no scan limit,
   counting only what the caller may reach, as `timeline-facets` does. Otherwise the driver is walked: a materialized
   source (subject, container, tag, text) to its end, since its whole set is in memory and
   `truncated` then reports whether the source itself was capped; a cursored one up to `--max-scan`,
   reporting `truncated` only when a further candidate actually exists. `total`, kinds and labels count
   undated media too, even though it contributes to no calendar bucket: `total` describes the
   complete answer, while kinds size a _type_ filter (which kinds an album actually holds). Kinds
   need not sum to `total`, because not every result is a classified media kind.
   An id set is re-materialized per page — the deliberate trade against denormalizing subject ids
   onto every file: no write path to keep in sync and nothing to reindex when a person is renamed or
   merged, since ids are what it matches on. Good into the low tens of thousands of media per
   subject; a subject larger than that answers with a match instead.

   The container source (`search/containers.ts`) is the same shape asked of a place in the tree:
   who the members are, ordered by `takenAtUtc` with undated last. For a plain directory core lists
   them itself: one level, original media only, softlink members followed. For a node of a type some
   module gives a `members-<type>` command for, found on `PATH` by that name, the command answers
   with the members (`ContainerListing` in `@ein/client`) and core loads them in one batch by id,
   then orders and pages as for a directory. Archive's is `members-album`, so an album's own rules
   stay in archive's media area
   (`modules/archive/lib/media/album-members.ts`): a lone `files/` child descended into (the imported
   layout), softlink members followed (so a file added to an album, or a staging suggestion's members,
   answer like held ones), the
   `coverPhoto` link and the `previous`/`next` links to the albums beside it in a series left out
   (`NON_MEMBER_LINK_NAMES`), stacks folded. `album-span`, `album-cover` and `album-stack` call
   the same library directly. Core's `members <path>` answers with either listing, for anyone else
   who asks. **This is what the album page browses** — it is why an album has an order and dates, none
   of which a directory listing carries. Ordinary callers can page it by position. The album UI
   instead asks for `--layout`: one complete JSON-only metadata index, dictionary-compressed by
   directory, mimetype and ownership and tuple-encoded without repeated field names. It carries the
   ordered dates, display dimensions and membership paths needed to compute the exact justified
   scroll extent while media bytes remain viewport-loaded, and each file's ownership and pin, so the
   page offers only the changes the reader may make and marks what keeps its own sharing. A container above the 20,000-entry source
   ceiling, or whose encoded response exceeds the 2 MiB layout wire budget, reports `truncated`;
   the UI then keeps the paged path rather than presenting a partial index as complete. As a
   predicate the container is set membership, not a path prefix: a member can live anywhere.

   The loaded members are kept, per viewer and `PATH`, for the eight containers asked about last,
   so the next page, the facets and the layout of one album do not list it and resolve every link
   again. A VFS event drops a kept container when it is written at or under the container, on one
   of its members wherever that lives, or on an ancestor that moves, goes or changes mode or owner;
   a minute's age drops it too, for a write the VFS never announced.

   A followed member is reported under **both** identities — `path` is the file, `memberPath` is
   the link inside the container — because they are acted on differently. Everything that touches
   the picture wants the first; unfiling it wants the second, and a caller told only about `path`
   deletes the photo where it really lives when it means to remove it from an album.

   **Photo stacks are album-local read projections.** `album-stack refresh` walks the complete
   oldest-first `takenAtUtc` container order and joins adjacent timestamped photos when their
   `sscd-image` fingerprints have cosine similarity at least 0.75 and their capture times are no more
   than ten seconds apart. Each comparison is against the preceding accepted photo, so a rolling
   burst can span longer than ten seconds overall. Missing fingerprints, dates, non-photos, and explicit
   album-local exclusions break a chain. A group can also be made by hand (`album-stack stack`,
   the album view's selection bar): it is flagged `manual` in the manifest, its members are left
   out of the similarity chains (they break one like an exclusion does), and a refresh carries it
   forward as it is, dropping members that left the album or were kept separate and dissolving it
   below two. Stacking a photo that is already in a stack merges the selection into that stack
   and keeps its front; `album-stack unstack` drops the hand-made group and re-derives.

   The versioned `attrs.mediaStacks` manifest is authoritative. It stores detector settings, an
   input signature, excluded file ids, ordered groups of file ids, and each group's selected front
   id; it stores no paths. For browsing, each group is also materialized as managed softlinks under
   `<front>/stack/<album-id>/`. A marker on that directory is the ownership boundary: reconciliation
   replaces and removes only marked directories and refuses to overwrite unmanaged content. It
   builds the new view before publishing the manifest and repairs missing or orphaned managed views
   after interruption. It finds an album's marked directories by the marker's `mediaStack.albumId`
   (the `media_stack_album` index), not by looking under each member. Originals and their paths
   are never changed.

   The manifest format is archive's media area's (`modules/archive/lib/media/media-stacks.ts`); core never
   reads it. `members-album` marks each hidden member with the front that stands for it and the
   front with its `stackCount`, and album `search --under` collapses each group to its front and carries `stackCount` through
   ordinary and compact-layout responses. A selective hit on a hidden member is remapped to the
   front after predicates run, then deduplicated. This affects only the album that owns the manifest;
   global media and another album still expose every original. The internal `--include-stacked`
   mode retains all originals for aggregate readers such as album descriptions; `album-span` reads
   every member through `@archive/media/album-members` directly. Thus facets count visible tiles while `mediaCount`, spans,
   and descriptions keep describing the underlying media.

   `-l` is a **page size, never a scan budget**: a refill loop keeps pulling until the page fills or
   `--max-scan` is hit (then `truncated: true`). The response cursor anchors to the last _consumed_
   candidate, not the source's read position — the loop over-pulls deliberately, so those differ.

   `facets` returns per-year and per-kind bucket counts via `vfs.aggregate`, for sizing the
   UI's filters without paging results. It honours kind and time but not region, which would need a
   per-node child read an aggregate cannot do.

   **The global timeline** (`node/timeline/`) is the other question asked of time: not "which media"
   but "what happened". Albums, births, deaths, recurring birthdays and wedding anniversaries, life
   events, moves and tracks are
   separate node types under separate attr names, so unlike `search` there is no single driver —
   each is an ordered source and they are **merged**. What makes that work is that they all sort on
   the same thing, an ISO date string, so one page boundary positions every source at once.

   Three consequences worth knowing, each documented at the code:

   - The boundary is a `lte` on the date attr, **not** a keyset `after`. PG compares
     `(sortExpr, n.id)` with `COLLATE "C"` on only the first half, so a cross-source cursor resting
     on the id half would depend on glibc agreeing with JS about ULID order. The tie-break happens
     in JS instead — which is what `LocalNodeVFS.query`'s own sort does anyway. Entry keys are
     `<nodeId>#<kind>[#<year>]`, because a node id is not unique here: one person contributes both a
     birth and a death, and a birthday one per year.
   - A short pull is **not** exhaustion. `query` answers fewer rows than asked only when the store
     has none left, but a source drops rows of its own (`toEntries`) and stops at its scan budget
     (`SOURCE_SCAN_BUDGET`), so only an empty pull ends a source; each keeps its own refill loop.
   - `--dir asc` walks the same merge forward in time, for a client growing an anchored feed back
     _upward_ towards the present.
   - `--year` bounds the merge below as well as above. A span — an album, a track — is in every year
     it touches, so its lower bound is on where it ends (`timeEnd`, `lastTs`) while it still orders
     on where it starts; an album from the last days of December is also January's. An album that
     reaches past the year stays only if `search --under` finds media taken in it: a span says when
     the first and last pictures were taken, not that any fall between, and a box of negatives
     spanning 1954–1980 would otherwise be in all 26 years.
   - Birth and death are ordered from `person.born` / `died` (indexed, and everyone has them) but
     **enriched** from the event file next to the person, which is where the body and the location are.
     Titles are composed from the people rather than read: the stored names are formulaic
     ("Födelse", "Giftermål") and cannot be phrased for a recurring entry.

   **Birthdays and wedding anniversaries are the same walk** (`recurring.ts`): something happened on
   a day in a year, and every later year up to today holds an occurrence of it. Neither has a node
   to query, so each source loads its subjects once — hundreds, not millions — and then walks
   calendar years out from the page boundary, emitting lazily like any other source. `--birthdays`
   and `--anniversaries` each take `all | milestone | none`; milestone is the default, because one
   birthday per person per year buries everything else at a few hundred people. A recurrence stops:
   at an assumed lifespan (or the death) for a birthday, and at `relation.to`, the first of the two
   deaths, or an assumed span for a partnership — "100 years married" is a false sentence about two
   people who did not live to say it.

   An anniversary is read from the **partner relation**, not from the wedding's event file
   (`partnerships.ts`). The event names one spouse and never both, so it is missing from the other's
   page; it cannot end, so a couple who parted keeps having anniversaries; and a partnership dated by
   hand with `person-set-partner --from` has no event at all. Both halves of the pair carry identical
   relation attrs, so a query over `relation.from` returns two rows per couple — unlike a residence,
   which denormalizes onto one half, the pair is collapsed after the read, keyed on the two people it
   names. The set is hundreds of rows, there is nothing to page, and an asymmetry stored on one half
   is one more thing that can drift. `_relation_from_idx` serves the read.

   On a person's own page a wedding is therefore recorded twice — the event file under one spouse,
   the dated relation on both — and `person-timeline` folds them: the event survives, because it is a
   real node with a story in it, and takes the second person from the relation, which is the only
   location the archive says who it was. The match is a day and a partnership event type, deliberately
   not a `generic` story about the same day: two authored nodes with different bodies are two things
   somebody wrote.

   Moves are the other kind that only exists because of a denormalization, and a sharper one. A
   residence is a relation pair — `<person>/homes/<location>` ↔ `<location>/residents/<person>` — with its
   span on `attrs.relation.{from,to}`. Nested `AttrRef` paths can query that span directly, but both
   halves carry identical relation attrs, so doing so would emit every move twice. `person-set-home`
   therefore also writes flat `movedIn` / `movedOut` attrs on the **person-side half only**: those
   attrs are the discriminator as well as the targets of two partial indexes. The entry points at
   the location while its `ownerPath` is the person. `modules/archive/lib/people/residence.ts` is the only
   writer, and `person-check` reports a `home-date-drift` if the projection and the relation ever
   disagree. See ein/core#104 for the nested-ref boundary that used to
   make the flat projection necessary for queryability too.

   Albums can only take part because `album-span` denormalizes their span — `timeStart`, `timeEnd`,
   `mediaCount` — onto the album node. An album's date is a property of the media it holds, one
   listing away from the node, and ordering albums by time would otherwise mean listing every album
   in the corpus before the first row. `album-span` is the only writer of those attrs and lists
   every album through `@archive/media/album-members`, auto albums included: the clusterer's
   `attrs.autoAlbum` span records what it grouped and goes stale when a member is retimed. A span
   reaches out to the days set by hand with `album set <album> spanStart|spanEnd <day>` — a trip
   starts before its first photo, and the album's map draws its devices' routes over its span —
   which may widen it but never narrow it: `album set` refuses a day inside the media, and
   `album-span` drops one once a capture reaches it (`@archive/media/album-span`). Spans ignore capture
   dates before 1826, the floor `@archive/media/exif-date` and the assistant's search parse also use: one member dated
   to the year zero would otherwise date a 2015 album to the year zero.

   **Album metadata is denormalized in coordinated passes.** Photo stacks are reconciled first, then
   the span and the cover follow.

   None of them survives a membership change, and most ways membership changes — an upload, a `mv`
   into an album, an `rm` of the only dated member — go through nothing that could recompute them.
   Stacks, span and a missing cover are therefore kept by the **`media-album` pipeline**, whose subject is the album
   node: `archive-bridge` derives `media.album.members-changed` from the album's own
   `child-attached` / `child-detached` events (which carry the parent, so an album's level is two
   exact routing keys), from a file arriving in an imported album's `files/`, and — because an
   attachment fires long before the member can be placed — from the member's metadata, fingerprint
   and retime, one fact per album holding it (`containersOf`: hard-link parents plus softlink
   referrers). The pipeline runs `album-stack refresh`, then `album-span`, `album-cover` and
   `album-profile`; all no-op when nothing changed. `album-profile` keeps a library album's
   matching profile, its `.profile` child (`album-profile` node type): its members' times, days,
   cells, locations and people, and up to four member picture vectors (by embedding id) found by a
   short k-means, which staging matches its suggested groups against; it passes over anything but
   an album under `/archive/albums` that staging did not suggest, and writes nothing while the
   signature of what it read is unchanged. `album-cover` gives an album that has no `coverPhoto` link — or a
   dangling one — a **random** visible member (a stack's front, images before videos before
   recordings), so every album has a picture that stands for it in the grid, the search card and
   the timeline; an explicit cover, set by the importer, `album set <path> cover <file>` or "Set as
   cover" on a single selected picture in the album grid, is never replaced. Random rather than
   first because the first file of an album is the first frame of the first morning. The link it
   creates is a `child-attached` on the album, which the bridge cannot tell from a member (the
   event does not say which child), so the pipeline folds one further no-op run — once per album.
   A crawl announcing one album once per file is absorbed by the engine: `options.debounceMs` holds the deduped trigger job so the burst is one run, and
   `options.coalesce: rerun` folds a fact arriving during a live run into one further run instead
   of dropping it as self-inflicted (see the pipeline section). The `album-metadata`
   service is the reconciler — `album-stack refresh --all`, `album-span --all --stale`,
   `album-cover --all --stale` and `album-profile --all --stale` hourly — filling what the bridge
   cannot see (a hard link into `files/`, a fact lost while the bridge was down, and for a profile
   a face named or a position arriving, which reach it once a week).

   `timeline` also **filters**: `--q` over an entry's title and description, and `--person`,
   `--location`, `--tag`. A subject matches two ways — an entry _about_ them (`ownerPath`, `people`)
   and an album _holding_ their media — and the second half comes from
   `search --subject … --group-by album`, so there
   is no second reverse lookup here. The filter runs _after_ enrichment, because a birth, a death or
   a move has no title until enrich composes one; the page is therefore a refill loop over a
   merger whose per-source buffers survive between batches, bounded by a scan limit.

   `timeline-facets` is to `timeline` what `facets` is to `search`: per-day, per-month and
   per-year occupancy for the adaptive time scrubber. Same caveat — the counts are not
   access-filtered, they size a control. It takes the same
   filter flags, or the rail would size a feed it is no longer showing; a filtered rail is computed
   by **walking** the filtered feed through the `timeline` command rather than aggregating, which
   keeps one definition of what the filters mean, and reports `truncated` when the walk hits its cap.

   `search --subject` is **repeatable and intersected** ("Anna _and_ Bo in the picture"), which
   falls out of the driver/predicate split for free: the first id subject drives, the rest are
   membership predicates over its candidates.

   **Natural language on Media commit.** [`archive-parse`](../lib/search/parse.ts)
   (archive, the command `CFG_SEARCH_PARSER` names) turns a written request into visible filters, never into results. The Media field calls it only on
   Enter, while explicit `@` completion remains the deterministic path available before commit.
   The parser then rewrites resolved people and locations back into those same visible mentions and
   sends only the remaining subject to the content search. Other search fields continue to
   use explicit mentions only.

   Three stages, and the narrow split is the design. The rules (`lib/search/rules.ts`) read years,
   media kinds and their edge glue immediately; the page searches on that at once
   (`archive-parse --rules`). A language model — the command `CFG_LANGUAGE_MODEL` names, the
   assistant's `llm-chat` when it is installed — with a short prompt of its own
   (`lib/search/proposal.ts`) proposes people, locations and the words that describe the pictures;
   a name that is not words the user wrote is dropped, and a description that is not the user's own
   words gives way to theirs. The names are then turned into identifiers by **lookup**, never by
   the model (`lib/search/names.ts`): a name that is one person is that person, one that is several
   is a partial name (`--subject-name person:…`, the union), and a name that matches nothing is
   reported as `unresolved` and searched as words; so is a kin word no proposed person carries,
   since a relation is not a filter. A location with no node is geocoded to a Nominatim bounding
   box, which is the useful shape for a country. The account of the result (`explain`) is in the
   language the search is written in, Swedish or English. Without a model the rules result stands,
   so a model server that is down may reduce name recognition but cannot take search offline. The
   chat's fast path reads a request for pictures through the same `parse-search`.

   Temporal commands `latest [n]`, `dayinhistory [MM-DD]` and `onthisday-media [MM-DD]` read the
   `takenAtUtc` index: `latest` is one ordered query, `dayinhistory` one single-day range per year,
   newest first, stopping after `--years` years with media (`lib/media/on-this-day.ts`);
   `onthisday-media` is the same walk answering one home-page entry a year.

   **Locations.** A location is archive's `location` node under `/locations`; its shape (point, circle or
   polygon) is its `position` child, content in the position registry, never attrs. A location without
   one is findable by nothing, so `location-locate` (archive's location area) fills it in from two
   sources, in order, because they fail in opposite directions:

   1. **Media centroid.** Where the geotagged files already linked to the location actually are,
      reached through the `<file>/location` backlinks the legacy import wrote. Measured rather than
      looked up, needs no network, cannot invent a position for an unphotographed location, and it is
      the only source that knows a location's _extent_ — the derived radius is the p90 of the inlier
      spread, so a park gets a park-sized circle. Robust by construction: the centre is a **median**
      (a minority of outliers cannot move it), points past `max(250 m, 3 × median distance)` are
      dropped, and a result under `--min-points` or wider than `--max-spread` is refused rather than
      guessed. Rule in `@archive/location/centroid`, apart from the VFS so it is testable.
   2. **The address**, via `geocode-location` (Nominatim `/search`, the forward counterpart of media's
      reverse `geocode-position`). The only option for a location carrying a name and nothing else.
      Deliberately **conservative**: a hit is applied only when pinned to a building _and_
      corroborated by the house number or postcode the address already contained, with no
      comparably-ranked rival elsewhere — a wrong coordinate is worse than none, since
      `location-link-media` would drag media onto it. Anything less certain lands in
      `geocodeCandidates` + `geocodeStatus: 'review'` for the locations UI to offer as one-click
      choices. `geocodeAttemptedAt` stops a re-run from hammering the geocoder.

      One lookup is **up to three requests**, because the corpus breaks free-text search in two
      opposite ways. Sweden-first (`countrycodes=se`), since a legacy address is unqualified and
      without it the wrong country wins; then **worldwide**, since a bare name is as likely to be
      abroad as not (Amsterdam, Seattle, Innsbruck) and restricting those answers confidently and
      wrongly; then the **street line alone**, since a legacy address qualifies its street with a
      district Nominatim cannot match (a postal name OSM does not file the street under), an
      apartment number or an old internal code — and free-text search returns _nothing_ rather than
      something weaker. A fourth and last attempt spells out abbreviations OSM writes in full
      (`Dr` → `Doktor`), which is the difference between no result and a confirmed address. Those
      retries rescue 22 of the 29 addresses that found no hit at all. They also drop the
      disambiguator, so a **relaxed answer must be confirmed by the postcode** from the written
      address (`requirePostcode`, recorded as `geocodeRelaxed`); the house number is not evidence
      when every street has a number 6.

      The 1 req/s pacing lives in `nominatimSearch`, not in the loop over locations: pacing the caller
      let those retries go out back-to-back and Nominatim answered **429 to 78 of 115 locations**. Only
      the public instance is throttled, so a loopback stub costs the tests nothing.

   `locationSource` (`media-centroid` | `nominatim`) records which won, with `locationPoints` /
   `locationSpread` behind a centroid; the locations UI shows it, because how a pin was arrived at is
   what says whether to argue with it. `location-locate --all` walks `/locations` in **three batched
   passes for the whole corpus** — one registry scan, one `resolveIdEntries`, one `findLinks` over
   every location at once — joined on the file's node id, not one query per location. That gives the chain
   media/address → shape → `location-link-media` → `<file>/location` → `search --subject location:…`, and is what lets
   the staging organizer name a suggested group after the location it happened at.
   It is the last step of `remote-import`, for the bulk of a fresh corpus. After that locations keep
   themselves up to date: `archive-bridge` announces a location whose inputs changed, and
   `location-upkeep` runs `location-locate --refresh` (re-derive, write only what moved, never touch
   `locationSource: manual`; an edited address is looked up again against `geocodeInput`, and a
   position from an address that no longer resolves is dropped) then `location-link-media --location`
   (link the photos inside the shape, drop the shape links it no longer covers). A photo whose
   point is written is linked by `location-link-point` (`location-link-media --point`). A link a person
   made is never replaced; see "Domain events" in `data-flow.md` for why shape links are marked.

   Coordinates live in exactly one place — the `position` child node the position registry indexes.
   Region search stays fast by **batching**, not duplicating: see "Batch resolution" above. A
   Gothenburg bbox went from ~23s to **0.6s** with no denormalized copy to keep in sync.

`regenerate <path>` re-runs derivative generation over existing media (backfill); add `--force
--prune` after a format or size change to rebuild the set and drop the renditions it replaced.
`--size a,b` narrows it to named sizes and `--mime 'video/*'` to one media type, so adding a size
that only one type has does not cost a `generate-derivatives` exec per photo in the corpus.

`promote-exif-attrs <path>` copies `width`/`height`/`duration` from a file's `metadata/exif` node
onto the file node itself, for everything indexed before `exif-extract` started promoting them.
Two reads and a write per file, against a full exiftool run for `exif-extract -f`. It deliberately
leaves `angle` and the capture time alone: both are resolved from sources a blind sweep would
paper over (`angleManual`, `whenManual`) —
`--angle` opts a _video's_ container rotation in (no heuristic, no override to lose) and `--codec`
its picture codec, both re-derived from the `raw` dump already stored on the exif node.

**Technical metadata (`metadata/`).** The derived/technical metadata is grouped under a `metadata/`
child directory: `metadata/exif` (the `exif`-type node, described in `mod.json`'s `nodeTypes`),
`metadata/sscd-image` and `metadata/sscd-video-keyframe-<n>` (SSCD descriptors, embedding nodes, found by cosine), `metadata/chromaprint` (a recording's whole
chromaprint as little-endian uint32s in a db-tier `file` typed `application/x-chromaprint`, which
`duplicates --fuzzy` aligns pair by pair rather than looking up as a vector; a recording under about
2.5 s has none, and `fingerprintedAt` on the file says `compute-fingerprint` ran all the same, so the
gap scan does not re-announce it), `metadata/content` (text extracted by `index-document`, a
db-tier `file`), `metadata/transcript` (a db-tier `file` holding **WebVTT**, written by
`transcribe-file` for audio and video) and a video's `metadata/chapters` (below). Keeping these here deliberately separates them from the
**manual** `description` file attr (shown in the lightbox sidebar) so no extraction ever overwrites
a hand-written one.

**A video's chapters (`metadata/chapters`).** `detect-chapters`, a step of `media-transcode` after
the transcode, asks EMS where the 1080p rendition cuts from one shot to the next (`video.shots`:
TransNetV2 over every frame at 48×27, and its rules — a peak over 0.6, leader as a gap, a lasting
change of colour, cuts under a second apart merged, no shot under three seconds — measured on the
archive's own film transfers and phone clips, wow `notes/lessons-media.md`). The rendition, not the
original: its clock is the player's and it is upright. The node is a db-tier `file` holding one
WebVTT cue per chapter, with the cuts on it (`boundaries`: `{t, score, kind}`, `kind: leader` at the
end of black or white leader), `detectedBy`, `detectedWith` (the rules) and `detectedAt`, which marks
it done. A cut's `t` is the new shot's first frame. A video with no cut gets the node with no
boundaries, so it is not looked at again; one EMS cannot decode, or will not within its CPU budget,
gets it with `unreadable` and no `detectedAt`, and any other failure fails the step. `media-details` reads the cuts off the
node as `chapters`, the lightbox player's segments and skip buttons. Not forced when a video is
turned, which moves no cut in time; no gap term, as for the storyboard.

**Duplicate findings on staged media.** A staged media original carries `duplicate`
(`DuplicateFinding` in `@archive/media/api`), and `@archive/staging/duplicates` is its one writer.
Among the byte twins of a checksum, the original of an inbox is the smallest-id library twin
(under `/archive/albums`) its owner can reach and read, else the smallest-id twin staged in that
inbox; every other twin staged there is an `exact` copy naming it by id (`of`, `where` `library`
or `inbox`), and the original carries a marker (`{inbox, sha256, at}`, no `kind`), so a move inside
the inbox never needs a recheck. A finding is decided for one checksum at a time, from one indexed
`sha256` lookup (plus one read of which library twins the owner may see, when there are any), and
the decisions about one checksum are made one at a time in a process, from the lookup to the last
write, so two twins checked at once cannot overwrite each other's result.

- **Arrival.** `exif-extract` checks every staged media file before it probes it: a hash it had
  to measure is written first, so a twin checked at the same moment finds it, then it decides the
  checksum's twins in the inbox and writes the ones that changed. A file that is no copy is checked
  again right before its file update, where its own finding rides, since a twin's check may change
  it during the probe: two lookups more per staged file, none for a library one. A file it indexes
  outside staging loses a finding it still carries.
- **Byte copies are not indexed.** A staged file the check finds to be an exact copy is recorded
  `deferred` (with its original, `of`) and `exif-extract` stops there: no probe, no exif node, no
  position, and so no `media.metadata.extracted` and nothing downstream of it — no stills,
  renditions, faces, picture or text vectors, transcript or fingerprint. Two round trips instead of
  the pipeline: an album copied twice into a Takeout export costs nothing more to take in the
  second time. `-f` indexes a copy anyway. The **deferral gate**
  (`@archive/staging/deferral`) keeps it that way: discovery passes by a file not yet indexed whose
  finding is `deferred` for the bytes it has now while it is staged, so the bridge and the
  `media-scan` reconciler announce nothing for it (`deriveGaps` needs an exif node in any case, and
  `document-index` reads nothing staged). A decision keeps `deferred` on a twin while it stays a
  copy, of the same original or another, and in the trashed form; one that stops being a copy loses
  it — its original discarded (`staging discard`, a dedupe), trashed or deleted some other way and
  found by the hourly repair, or no longer readable by the owner — and that write is an update of
  a file with no exif, which discovery announces like any other, so the file is indexed where it
  lies. So are new bytes (the finding is for other bytes) and a copy filed or moved out of staging
  (its finding is cleared). Crawl coverage leaves deferred copies out of its denominator
  (`entryPoint.exempt: duplicate.deferred`), `staging status` does not count them as `indexing`, and
  the organizer neither groups them nor counts them as pending. Staging's Files tab lists media
  with `search --within <folder> --missing duplicate.deferred`, which the PostgreSQL store plans as
  it plans the listing without the condition, given the statistics archive declares on the attr
  (`duplicate_deferred`, `using: statistics`); the Duplicates tab shows a copy with its original's
  renditions and size in pixels.
- **The fact.** The staging rules of the bridge (`@archive/staging/facts`, first of the archive's
  rule sets) publish `media.duplicates.stale` when a finding may be wrong: a file moved into an
  inbox from outside it (a restore from a trash, an `mv`, a move between users) whose finding is
  not this inbox's for these bytes; a directory moved into an inbox from outside it, as itself (a
  move publishes no event for what is inside); a file or directory moved into the library from
  outside it, whose twins in every inbox may now be copies of a library file. A moved event
  carries the path it came from (`fromPath`), so a move inside an inbox, between categories too,
  reads nothing and announces nothing.
- **The pipeline.** `media-duplicates` runs `duplicates --record $NODE_PATH`: a staged file's
  checksum is decided in its inbox and the file checked for look-alikes, a library file's checksum
  in every inbox and the staged files the index finds near it checked with it (the **reverse
  check**), a directory's files one by one, and a file elsewhere loses its finding.
- **Fingerprints landing.** `compute-fingerprint`, once every print is written and
  `fingerprintedAt` stamped, decides the same findings as `duplicates --record` for its file
  itself, inside its own step: a staged file is then checked for look-alikes, and a library file —
  taken in after it came into the library some other way, an upload or a copy — rechecks the
  staged files that copy it or look like it. No fact is announced for it, so a file costs no
  `media-duplicates` instance of its own; a check that fails is reported and leaves the prints,
  and `staging duplicates --refresh` finds the staged finding older than them.
- **Near findings.** A staged original with fingerprints — a picture's `sscd-image`, a video's
  `sscd-video-keyframe-<n>`, a recording's `chromaprint` — is checked for look-alikes (`recordNear`): the files whose prints
  the embedding index finds nearest to its own (`findSimilar`, an HNSW scan, 100 per print), the
  files taken within two seconds of it (off the capture-time index, so a copy the approximate walk
  passes over is still found when it kept its time), and any a caller names
  (`@archive/staging/near-candidates`, about a dozen batched round trips whatever the archive's
  size). A recording has no index: it is compared with the 200 recordings nearest it in length of
  at most 2,000 within the lengths it may have (off the mimetype index, its `duration` filtered
  there), each chromaprint read once (`chromaprintsOf`), and one without a known length only with
  those a caller names. Each is verified by `@archive/media/near-duplicates`: a picture is near another when their
  SSCD cosine is at least 0.75 — a re-encode, a downscale or a mild crop — unless they are two shots:
  capture times from one kind of clock a second or more apart, or one size from one camera in one
  second with sub-second times (`SubSecTimeOriginal`, read from the exif node for those pairs
  only) that differ, or without them less alike than a re-save (0.95). A video is near another when
  three in four of its keyframes match one of the other's at 0.80 and they last as long, and a
  recording when their chromaprints, aligned, are at least 0.70 alike and they last as long;
  neither when they were timed a second or more apart by one kind of clock. A candidate counts when it is a media original in the library or staged in the same inbox, readable
  by the owner, not an exact copy or a hub, and not separated from it by a person
  (`duplicateDecision.separate`, written by `staging separate` on staged files only). The finding
  keeps up to 29 (`kind: near`, `peers` with method and score, `where: library` when any is
  there); 30 or more make the file a `hub` with none. A look-alike is one both ways: each staged
  peer that does not list the file yet, and each it no longer lists, is checked again with it (one
  level of cascade). The near part rides along every exact decision about an original; a file that
  becomes a copy hands its look-alikes to a recheck; filing, discarding and the repair recheck the
  look-alikes of what they touched. A near check is written stamped later than the prints it
  compared, so `staging duplicates --refresh` announces exactly the files fingerprinted since.
- **Staging's own exits** keep findings true as they happen (`@archive/staging/file`): filing
  clears the filed files' findings and decides their twins left in the inbox again, so a copy of
  a filed file reads as a copy of a library file; a discard, and `merge-duplicates` for staged
  drops, first gives each file the trashed form (no `inbox`, `kind` or `where`, so it is in no
  inbox's findings), then decides the twins of the originals that went; `staging undo` of a
  discard decides the files that came back again at once.
- **Repair.** `staging duplicates --repair --all`, hourly in the `staging-organizer` service,
  checks every finding with a `kind` against where its file is now: one in a trash (a plain
  `trash put`) gets the trashed form, one no longer staged loses it, and a copy whose bytes
  changed or whose original is gone, unreadable or other bytes is decided again, and a look-alike's
  file whose peers are not all in the library or the inbox any more is checked again.
  `staging duplicates --refresh` announces the staged media whose finding is missing or stale
  (`withPrints` counts those with fingerprints).
- **Before an upload**, `duplicates --checksum <sha256>…` names the media originals carrying each
  checksum that the caller reads in the library or their own inbox, so a client can skip a file.

The findings are read through archive's `duplicate_found` index over `duplicate.inbox`, `.kind`
and `.where`, partial on `kind`, so markers and trashed forms are not in it.
`@archive/staging/duplicate-read` pages one class at a time off it — exact copies of library
photos, exact copies within the inbox, look-alikes of library photos, look-alikes within the inbox
— in node-id order (a near set is anchored at its smallest-id staged member of the class that its
look-alikes list back, so a chain shows one set at a time; a suggested group is read whole, its
members' sets at once) (within a
category or folder by `within`; for a whole inbox straight off the index), builds the sets of a
batch of copies from one `sha256 in` lookup (which PostgreSQL reads as an indexed lookup per
checksum, so the plan never depends on how many), and answers a set on the page of its first copy
in the folder read, so each comes once; a page's children, stars and library albums are read in
one batched call each. Counts are one aggregate over the same index; `staging status` counts each
category's copies in the aggregate it makes anyway. `@archive/staging/dedupe` resolves sets —
`merge-duplicates`' fill-only merge into the kept file, then a discard — as one journal entry and
one trash batch per call, planned from the files as the call read its sets, every set's reads and
writes batched with the others', so a call costs a few statements per batch of files, not per
set. Deciding findings again (after a discard, an undo, a filing or `--record`) takes up to 500
checksums at a time: one lookup, one read of what each owner reads in the library, one batch of
writes.

**Duplicate scans.** Beyond the staged findings, `duplicates` finds copies when asked. One
file's copies are one `sha256` lookup and, for a picture or video, one `findSimilar` per print; a
recording's chromaprint is aligned against every stored chromaprint. A subtree is what is within it
(`NodeQuery.within`). The exact scan counts its checksums in the store, `aggregate({within, group:
[sha256], minCount})`, and reads the copies of those it holds at least twice within it (`sha256
in`, 500 to a query, on the checksum index); with `--against` it looks the copies up anywhere, of
every checksum a subtree of at most 20,000 nodes (`countWithin`) holds, and for a larger one, or
`/`, of the checksums held at least `minCount` times store-wide, since a copy in each root makes
that many. `/` is the same aggregate store-wide. The fuzzy scan lists
a subtree's media originals a page at a time and looks up only their prints (two child-link hops to
`metadata/sscd-*`, then one `findSimilar` per print, four at a time), keeping the pairs that touch
the subtree; chromaprints are aligned against every other print, and only when the subtree has one.
`/`, and a subtree of more than 20,000 nodes (`countWithin`), take `findAllPairs` over every print
instead, narrowed to the subtree. A rendition (`sourceId`) or
a print or other metadata stored under a file is never a copy, so twins among them are not
reported: `within` does not reach them, and a store-wide lookup climbs each page's parent links,
one batched level at a time, and drops what meets a file. Any other file with bytes is an original,
a document as much as a picture. The staging inbox's Duplicates tab does not scan: it reads the stored
findings (below) through `staging duplicates` ([staging.md](../docs/staging.md)).

**Merging duplicates.** `merge-duplicates <keep> <drop>… [--batch [<id>]] [--label <text>]
[--dry-run]` (`@archive/media/merge-duplicates`, answering `MergeDuplicatesResult`) keeps one file of
a set and drops the others, on any files. First it fills the kept file in, never overwriting it,
through the command that owns each field, the first drop in the order given winning: a description
where it has none (`file-set-description`), a hand-typed time and its note where it has no
`whenManual` (`file-set-time`), a place where it has neither `positionManual` nor a `position`
child (`file-set-position`, from a drop's `positionManual` or its `position`), the labels it lacks
(`label add`), and the caller's star where a drop has one (`star`, and the drops are unstarred).
The people a person named on a drop follow, each once: a drop's region whose person was given by
hand or imported (not `auto` or `cluster`, which recognition guesses again) names its person on the
kept file's region it overlaps (IoU ≥ 0.5) that has nobody or only a machine's guess, or else on a
new `manual-<n>` region with the drop's box and crop; a drop's `people/` tag joins the kept file's
when nothing there names that person. The drops' comments move to the kept file, keeping author and
time. A plan that would write the kept file is refused when the caller cannot write it, and nothing
is written for a path that is not a file, is in a trash or is both kept and dropped. Then the staged
drops leave their inbox's duplicate findings (the trashed form) and their category's suggested
groups (`leaveSuggestedAlbums` in `@archive/staging/file`); a
kept file staged in the same category takes each one's place, as a member and as a cover that
showed it, and the group's member key is recomputed so the change does not read as a person's edit.
The library albums holding a drop — in the album or its `files/`, or by a link — lose the drop's
links and gain the kept file (`album add`, which files a staged one there), and a cover showing a
drop shows the kept file (`album set … cover`). Last the drops go to the trash, 500 to a
`trash put --batch`, into one batch, a new one past 2,000 entries; `trash restore <batch>` undoes the
drop, though not the comments and album places the kept file took. Merging before trashing means
nothing a person wrote lives only in the trash.

**Refused before EMS is asked.** What EMS makes of a file or an album is kept under it, so each
command that asks for it — `transcribe-file`, `detect-faces`, `embed-picture`, `voiceprint-file`,
`compute-fingerprint`, `exif-extract`, `generate-derivatives`, `index-document` — first checks that
the caller may write the file
(`@archive/media/writable`, on `verifyAccess` from `@ein/client`), and the passes over the archive
(`media-reembed`, `regenerate-face-crops`) skip what the caller may not write. A
write refused only after EMS answered would let anyone who may read a file, the guest included,
spend the service's time on it as often as they asked. The pipeline runs these as the
administrator, who is never refused.

**The text space.** Every text
is embedded by EMS's current text embedder (`text.embed` `model: current`, jina-embeddings-v5-text-small)
into a type per model, at a node named after the type beside the text:
`metadata/content/text_jina5s` and `metadata/transcript/text_jina5s/t<second>` (a directory stamped
`embeddedBy` last). An extracted text longer than 6 000 characters is embedded in
parts of about 400 tokens instead: `metadata/content/text_jina5s/c<N>`, a directory like the
transcript's, each part cut at paragraphs and sentences and carrying its character `offset`
(`contentParts`); `search-media` and `search-document` score the file by its best part. The
**hand-written** `description` attr is embedded as `metadata/authored/text_jina5s` (no text node;
the attr stays the one copy of the text) with an `authoredHash` of the text it was made from;
`file-set-description` writes it on save and removes it on clear, and `search-media` ranks it as a
channel of its own at the picture channel's weight, counting only hits from 0.50.

A vector carries nothing but `embeddedBy` and `embeddedAt`, and a transcript chunk's its start and
end seconds and its `text`, the words it was made from, which search matches a phrase against. So a
transcript whose chunks are not embedded yet is found by neither, until `media-reembed` embeds them.
What a text is and where it came from
is on its **text node**: a transcript's `transcribedBy`, `transcribedWith` and `transcribedAt`,
the last written once the cues are, are both the "already transcribed" marker (the transcribe
pipeline's guard, `transcribe-file`'s own skip, the staleness rule) and what announces a transcript
(`media.transcript.generated` fires when `transcribedAt` is written). So a new embedding model is a
re-embed and never a re-transcription: `media-reembed` walks the text nodes and embeds what is
missing or another model's, from the stored text alone. `media-scan` announces
`media.text-embedding.stale` for a media file whose extracted text, transcript
(also when cut at another `chunkSeconds`) or hand-written description has no vector from the
embedder EMS runs now (`textEmbedGeneration()`), naming which in `data.stale`; `media-embed-text`
runs `media-reembed <file>`, the same rules for that one file. A text with nothing to embed (an
empty text node, a transcript with `speech: false`) is never announced. Search has a
floor of 0.35 on this space, measured on the retrieval eval's judgements.
`@ems/text-embedding` (module-ems's `lib/text-embedding.ts`) holds the types, the layout and the
query side.

The transcript is WebVTT rather than a JSON of segments because that is the format `<video>` already
understands: `get-file` serves the node with the mimetype it carries, so the lightbox's video
player and the sidebar's transcript panel both read `/file/<path>/metadata/transcript` with no
route, no converter and no second copy (one request between them, `useTranscriptCues`). The player
draws the subtitles itself; its `<track>` is shown only in an iPhone's fullscreen, which is the
system's player. Its `text_jina5s/t<second>` children are embedding nodes, one
per minute of speech (`CHUNK_TARGET_SECONDS`; it was 30 s, sized to MiniLM's 128-token window), so
a hit says where in the recording it matched. A set carries the length it was cut at
(`chunkSeconds`), and `media-reembed` re-chunks a set cut at another. Each chunk node is **named for
its start second**, which is what lets a vector hit carry its own seek target:
[search-media](../bin/search-media) resolves a hit to a path and nothing else, so
reading an attr per hit would put a node read back on the search path. The timecode travels out as
`atSeconds` on the search hit, and the lightbox opens the player there. Composition rules
(WebVTT in and out, chunking, chunk-path resolution) are pure and tested in
[modules/archive/lib/media/transcript.ts](../lib/media/transcript.ts). Hot queryable scalars (`width`, `height`, `duration`, `angle`, `sar`, `devicePath`) are still promoted
onto the file node's attrs by `exif-extract`; the raw exiftool output stays on `metadata/exif` so it
doesn't bloat every file-node read. Exiftool is the primary duration source, but some containers
(notably MPEG-1/2 program streams) expose no duration there. `@archive/media/media-probe` falls back to
ffprobe only when a video's duration is missing or invalid; audio folds the same fallback into the
ffprobe call it already makes for normalized stream facts. The `metadata/exif` child's existence doubles as the pipeline's
cheap "already indexed" marker (`skipIf`), and `exif-extract` skips on it too unless given `-f` —
which `media-reindex` passes, that pipeline existing precisely for the case where exif is there and
stale. Because `vfs.update` merges, a re-extract writes **every derived attr, null when absent** —
`width`/`height`/`duration`/`codec`/`angle` on the file node, `deviceinfo`/`deviceSerialNumber`/
`fileinfo`/`where`/`angle` on the exif node — and removes the `position` child when the new bytes
carry no fix; skipping an absent key would keep the previous bytes' answer. The manual overrides
are the exception: with `angleManual` the file's `angle` is not written at all, and with
`positionManual` the `location` child is neither rewritten from a GPS fix nor removed
(`file-set-position` owns it). **Capture time.** A file carries one capture time, resolved from four sources and promoted onto
the node; the sources stay sources and nothing queries them. `whenManual` is what somebody typed
(the precedent is `angleManual`), `metadata/exif.when.{device,gps}` is what the camera and the
receiver said, `whenName` is the date the file's name spells, and a device's clock comes from its IANA `timezone` or, failing that, the
`configuration` log the legacy importer backdates to the epoch — so an offset is time-varying by
construction, which a single attr cannot be (`@archive/device/device-zone`). Media's `resolveTime`
(`@archive/media/capture-resolve`) weighs them, `manual > gps > device > name`, and writes three attrs:

| attr            | meaning                                                                                                                                                                                                                    |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `takenAt`       | the **wall clock**. Its length is its precision — `1975`, `2004-03`, `2003-04-30`, `…T14:03`, `…T14:03:11`, the last two optionally carrying `±HH:MM`. Never padded: 1,023 files in this archive are known only to a year. |
| `takenAtUtc`    | the **instant**, always a complete `YYYY-MM-DDTHH:MM:SSZ`.                                                                                                                                                                 |
| `takenAtSource` | `manual`, `gps`, `device` or `name`.                                                                                                                                                                                       |

The split between the two is what makes both questions answerable. `--from`/`--to`, the year facet
and every rendered caption read `takenAt`, because "which year is this photograph from" is a
question about what the calendar said where it was taken. Ordering, keyset cursors and the three
PostgreSQL expression indexes read `takenAtUtc`, because ordering on wall clocks interleaves
timezones wrongly — a Tokyo noon sorts after a Stockholm breakfast that happened four hours later.
Being fixed width, `takenAtUtc` byte-sorts exactly as an epoch integer would, which is what lets
the text-only comparisons in `vfs/query.ts` serve it with no cast. `TAKEN_AT` and `TAKEN_AT_UTC` in
`search/filters.ts` name the two; `lib/capture-time` owns the vocabulary and the bound arithmetic,
shared with `search`, the timeline and genealogy through `@ein/client`.

GPS leads, because it is the only source that knows the instant — but a fix is cross-checked
against the camera clock and disbelieved beyond 26 hours (14h of real offset plus a generous clock
error). The failure that check exists for is a **stale fix**, not a wild one: 18 of the 22,192
legacy files carrying both dates fail it, and five files shot on 2014-11-21/22 all carry the same
`2014-11-19T11:41:01Z`, the receiver's last lock. Where both dates exist the pair also recovers the
offset the photographer was standing in, from `device − gps` rounded to the hour — +1h on 12,561
files and +2h on 7,537, while the sub-hour residue (1,478 files at exactly +1h15m) is camera drift
and is deliberately left in the wall clock rather than promoted to a timezone nobody keeps.

The exif half comes from `@archive/media/exif-date`, which is mostly a list of dates to disbelieve: a
camera with a dead clock writes `0000:00:00 00:00:00` (or a unix/QuickTime epoch) rather than
omitting the tag, and a zeroed capture time is worse than none — it sorts first everywhere and reads
as real. Rejected there, and the `when` block is written as an **empty object** rather than as
`null` so that a re-extract clears what an older version wrote: a null attr write removes the key,
which would make "examined, has no date" indistinguishable from an exif node that predates `when`
entirely — the first is a statement `media-resolve-time` may act on, the second is silence it must
not.
The same module also picks _which_ tag to believe (`pickCaptureDate`), because only
`DateTimeOriginal` means "when the photograph was taken" — `CreateDate` is EXIF DateTimeDigitized,
the same instant for a camera and the scan or save date for everything else, which dated every
scanned negative in the corpus to the day it was digitised. So a still image is believed on
`DateTimeOriginal`, and on `CreateDate`/`CreationDateValue` only when the file also carries
camera-exposure tags (`FNumber`, `ExposureTime`, `SubSecTimeOriginal`, …) — the one signal no
scanner or editor writes, and notably _not_ `ExifVersion`, which they do. Video and audio keep the
full chain unconditionally: a container's `CreateDate` is written by the recorder while recording,
and is usually the only date such a file has. The QuickTime format keeps that tag in UTC, and
phones (Apple, or a file carrying Android's `com.android.*` keys) and ffmpeg (`Encoder: Lavf…`) do;
from them it is written with timezone `Z`, and `resolveTime` places it on the wall clock of the
device's registry zone, else the archive zone. Every other recorder's `CreateDate` is read as its
local clock, which is what most cameras write there, unless its registered device carries
`quicktimeUtc=true`: every container `CreateDate` reading is marked `quicktime` in `when.device`, and
`resolveTime` reads a marked reading without a timezone as UTC for such a device. A phone that writes
no make, model or serial cannot be matched, so `device-link --device <device> <file|dir>…` links its
files by hand. Two scanners (`ENVY Inspire 7200`, `HP ScanJet 3500`)
defeat this by writing the scan time into `DateTimeOriginal` itself, which no EXIF rule can catch.
Their registered device nodes carry `digitizer=true`; `device-link` then suppresses
`metadata/exif.when.device` while retaining a valid GPS date, if one exists. `device-update`
reapplies a changed flag over the files already carrying that `devicePath`, using the indexed
reverse lookup and the normalized `metadata/exif.when` to clear or restore `takenAt` without
exiftool. `whenManual` is a source and is never touched by any of this. Keeping the exception at
link time preserves the file-local capture-time query and its PostgreSQL indexes — there is no
device join on the media read path.
A staged file's trust in its clocks is its staging category's (`time: {digitized, filenameDates}`
on the category, `@archive/staging/category`), stamped onto the file by `exif-extract` in the
same write as its time: `digitized: true` drops every clock recorded while digitizing (device,
GPS and name; a person's date stands), and `whenName` is the date `@archive/media/filename-date`
reads off the name where the category's names are dates. The stamps are inputs like `whenManual`:
every resolver reads them off the node, so they keep a scan undated after it is filed into the
library. A move into a category with other rules is announced by the bridge
(`staging.retime.requested`, `@archive/staging/facts`) and `staging retime` restamps and
re-resolves what changed, a page of 500 files in a fixed number of store calls.
Consumers: `device-link` re-resolves through `@archive/media/resolve-time`; `device-relink` links and
then runs `media-resolve-time --device` over the device's files (a command rather than an import,
from when device and media were separate modules and media depended on device), and
`device-update` does the same through `device-relink --reapply` whenever `digitizer`, `timezone`
or `quicktimeUtc` changes; `media-resolve-time` re-resolves a whole corpus from the stored `when` blocks, with no exiftool
and no file reads, which is the repair pass for rules that changed under an already-indexed
archive; and `device-link` and `device-relink` both end with `device-cover <device>`, which points
the device's `coverPhoto` at its newest image (by `takenAtUtc`, on the `device_taken_utc` index),
or, for a device with no image, at its newest video that has `thumbnails/`, unless somebody chose
the cover — a link it writes carries `autoCover: true` and is picked again
on the next run. A video's poster frame usually lands after its `device-link`, so `media-stills`
ends with `device-cover --media <file>` for a video that has device information, which offers
the new poster to the device it is linked to;
the archive bridge treats `metadata/exif` existence as the boundary between `media.file.discovered` and `media.metadata.extracted`, and stores the `sourceSha256` it indexed so a changed file is detected by content, not timestamp.

**File-node children (conventions).** Besides the `thumbnails/` (renditions, posters and a video's
storyboard sheet) and `metadata/` directories and the
`position` node, an image may carry `regions/`: every box on it is a `media-region` node there
(`@archive/media/regions`). `face-N` is a detection; `manual-N` is a box a human drew in the lightbox or
the legacy import carried. A **video** carries `regions/` too, one `face-N` for each person
`detect-faces` tells apart in it (ein/core#410): EMS samples a frame a second (`faces.detect_video`,
sparser past half an hour), follows each face from frame to frame and groups the sightings of one
file by vector, never joining two faces seen in the same frame. The region's box, landmarks and
pose are its clearest sighting, at `atSeconds`; `appearances` are when it is on screen; its vector
is the mean of its best sightings, compared with photos' faces like any other; and its child
`track` (`application/x-ndjson`) logs its box in every sampled frame, a `[t, x, y, width, height]`
line each, which the lightbox follows between the seconds. The gate below
judges that clearest sighting, and assignment rules a person out of a video face only for a face
of the same video on screen at the same time — one person the grouping left as two faces is two
faces of one person, not two people. The lightbox draws no boxes over a playing video but the one
face its sidebar is asked to follow: paused first on that face's clearest frame, then boxed wherever
its track has it, and not at all while it is off screen. A region that shows a usable face has the face's 512-d vector as a
child named `embedding` (`embeddingType: face`), the way `metadata/description` has one — that
child is what makes a region a **face**, and a region without one is a **tag**: a box and a
person, which recognition never searches or votes with. The box, landmarks, pose, detector and
every person field live on the region; the embedding carries only its type and capacity, and
nothing stores an id in either direction — a face found by vector search is mapped to its region
with one batched `getParentLinksByIds`, and a region to its embedding with `getChildLinksByIds`.
Only detections that pass the **quality gate** (`@archive/media/face-quality`: confidence ≥
`CFG_FACE_MIN_CONFIDENCE` 0.7, shorter side ≥ `CFG_FACE_MIN_SIZE` 24 px, head turn ≤
`CFG_FACE_MAX_YAW` 80° estimated from the five landmarks) are stored at all; the measurements
behind those numbers are in `wow/history/media-regions.md`. An import may create named
manual regions with a `detectedBy` of its own; `face-add` creates a
manual region with a singleton unnamed person so the ordinary naming and merge tools can curate
it; on a video it takes `--at`, the second of the frame the box was drawn on, which becomes the
region's `atSeconds`, with an appearance of half a second either side and the crop cut from that
frame. `face-set-box` updates stored geometry, regenerates its crop and, on a detection, deletes the
embedding: the vector described the box the detector drew, so a moved face keeps its person and
stops voting. `face-remove` recursively deletes one region and deletes its person only when
that person is still unnamed and has neither another region nor a voice; if other regions remain,
a removed representative advances to one of them. Only the detected kind is reproducible, so
the prefixes are load-bearing: `detect-faces -f`
drops `face-*` and leaves `manual-*` alone, and "has detection run here?" is the
`facesAt` attr on the **file**, not the existence of `regions/` — a directory the importer also
writes, and one a photo or video with nobody in it never gets. Which old boxes are named is decided by the
legacy `tags/<faceId> -> /people/<slug>` links and not by the box's detector
(`resolveFaceTags` in `@importer/legacy`): a machine-drawn box a human named carries exactly as
much identity as a hand-drawn one. Also `people/<slug>` softlinks
(a tagged person with no box — never written beside a box for the same person, since
`media-details` resolves a link ahead of a face), `photographer` softlink (`file-set-photographer` / import), `device`
softlink (+ `devicePath` attr), `location` softlink (manual link to a `/locations` node — distinct from the
lat/lng `position` child), and `versions/<name>` (related originals, e.g. RAW; frozen + `derived=true`
so the pipeline skips them). Every one of these points _outwards_ only; `vfs.findLinks(target)` is the
backlink lookup that answers "what refers to this person/location?", served by an index on the softlink
column that stores the target. Archive's `subject-person` / `subject-location`, which `search --subject` asks, are built on it. Manual time/position overrides live in the `whenManual` /
`positionManual` attrs. A file's `name` attr is its **filename, which is not its node name**: the
legacy import places the node under the old entry name (whitespace slugified, `_<n>` on collision)
and keeps the filename in the attr, so anything displaying a file reads `attrs.name` and falls
back to the node name only when it is absent.

**Orientation, and the frame coordinates live in.** A file node's `angle` (0/90/180/270) plus
`mirror` define the **display frame**: the raster rotated counter-clockwise by `angle`, then
flopped. `exif-extract` derives `angle` from the EXIF Orientation tag — through
`angleFromExifOrientation`, and from a HEIF's `irot` through `angleFromHeifRotation`, the same
reading EMS subtracts back out for the turn libheif already made, so the tag has one reading
and not two — but a manual override
(`angleManual`, which the legacy import sets) always wins and after that step the tag is never
read again: every renderer and every model call rotates by the node's angle instead
([@archive/media/orientation](../lib/media/orientation.ts)). A **video**'s angle comes from the
container display matrix rather than a tag, through `angleFromVideoRotation` — the one mapping
`exif-extract`, `promote-exif-attrs --angle` and the legacy importer all read it with, and one
that must only ever be applied to a `video/` mimetype because the ungrouped `Rotation` key means
something else on a still and on a HEIF. That single authority is the point:
OpenCV's `imread` silently applies the EXIF tag, so before this the detector worked in one frame
while the cropper worked in another, and every face cutout on a rotated image (~20% of the
corpus) came from the wrong part of the picture.

**The pixel shape, `sar`.** A quarter turn is not the only difference between a stored raster and
the picture it stands for: a video stream can declare a **sample aspect ratio**, and then the
picture is the raster times that ratio (AVCHD records 1080 lines in 1440 coded columns at SAR 4:3
and _is_ 1920x1080). What `width`/`height` hold depends on the container — exiftool reads a
QuickTime track header, which already has the ratio applied, and an `.MTS`'s H.264 sequence
header, which has no ratio in it at all — so the node stores `sar` **relative to its own raster**
(`sarForRaster`): 1 for everything whose stored numbers are already the shape, and 4/3 for the
`.MTS` album. `exif-extract` reads it off the dump where it can (`sarFromExifRaw`) and pays for
one ffprobe where it cannot, which is the only container family that needs it. `pictureDims`
applies it, `displayDims` deliberately does not — the crop paths measure real pixels of the
original — and the UI's `displayAspect` mirrors the first so a grid tile is laid out at the shape
it will paint at instead of reflowing when the picture decodes. Every path that writes a _still_
from a video frame bakes the ratio into the pixels instead, because an image file has nowhere to
put it.

Derivatives are rendered in that frame, and **face boxes and landmarks are stored as fractions
(0..1) of it** — the convention the legacy archive used. The same numbers therefore apply to the
original and to every rendition in the `srcset` with no dimensions attached, which is what makes them
directly usable for overlays — the lightbox draws them as percentages over the rendered image.
Pixels are computed only where a tool needs them: EMS's crop (rotate the raster, _then_ cut the
box out of it — the box reaches it as a fraction, `@archive/media/face-crop`), the size gate in
`regenerate-face-crops`, and `assign-faces`' minimum-size gate.

Beside the box and landmarks a face stores its **head pose** (`pose: { pitch, yaw, roll }`,
degrees, from EMS `faces.detect` — buffalo_l's 3D landmark model; `@archive/media/face-pose`): all three
0 faces the camera. Angles, not fractions, but still of the display frame: roll is the head's
tilt measured clockwise on screen. Faces detected before EMS reported it, and boxes drawn by
hand or imported, have none, and readers treat that as unknown, never as frontal. The cover
ranking (`@archive/people/cover`) is its reader; crops also carry their encoded `width`/`height`.

`file-set-orientation` is the write path: it rewrites `angle` **and** `angleManual` (both, since
every reader consults the plain `angle` while `angleManual` is only the sentinel that stops
`exif-extract` overwriting it), **remaps every face box and landmark through the raw frame**
(`boxDisplayToRaw` at the old orientation, `boxRawToDisplay` at the new one — the pixels do not
move, only the frame describing them) and carries each face's pose across (`remapPose`: a
quarter turn turns roll with it, a mirror flips yaw and roll; pitch never changes), regenerates the preview renditions inline — the face
crops among them, since a crop is a `preview`-class target and comes out sideways once the
frame changes. A video's re-encode is not its to start: the `angleManual`/`mirror` write is
what the bridge reads as `media.file.turned` (an indexed video only), and `media-transcode`
re-encodes on it with `-f`, as the administrator, whoever turned the file — the old rendition
stays playable, turned the old way, until the new one lands.

The legacy importer is the one place `angle` is _computed_ rather than read. The legacy archive let ffmpeg
apply the container matrix before turning by its stored angle, so a legacy **video**'s angle is a
residual and `import-files` probes the original to store `(legacy + matrix) % 360` — writing a
resulting 0 as `angleManual` too, since without that sentinel `exif-extract` re-derives the matrix
angle on the first index. A legacy **still**'s angle was already absolute (`convert` was called
without `-auto-orient`) and is carried across untouched. See
ein/core#142.

**Face recognition.** A region carries `personId` (a person **node id**, resolved with
`vfs.resolveId`) plus the provenance of how it got there: `personSource`
(`transfer` | `cluster` | `auto` | `manual`), `personConfidence`, `personAssignedAt`, and
`assignLocked` when a human has untagged it (written by `person-detach`, read by
`cluster-faces` and `assign-faces`). That provenance is what makes a bad run
undoable — `face-reset --source cluster` clears one run's work and leaves the legacy tags
and every human correction alone — and naming a person promotes their regions to `manual`, so
an undo can never strip the faces of someone already named. Recognition reads and writes these
on the region but searches only embeddings, so a tag — a hand-drawn box, a moved box, or a
detection the gate found too weak to vote — names a person in a photo without pulling any other
face toward them.

Two paths write it, both sharing the voting logic in `@archive/media/face-cluster` so they cannot
drift apart, and an import may name a detection too, as `transfer`: by pairing a named box with
the detection inside it (`@archive/media/face-match`, which takes the largest detection wholly
inside the box, and none narrower than a fraction of it). A `transfer` is a name a human typed,
so recognition treats it as an anchor and `face-reset` clears it only with `--source transfer` or `all`.
`assign-faces` runs per image from `detect-faces`:
`findSimilar` over the whole face space, attach on a clear win, otherwise mint an unnamed
person — self-reinforcing, since the next photo of that stranger joins the person the first
one created. `cluster-faces --create-people` is the batch form for a backfill. All three
refuse to put one person on two faces of the same image, and creation is gated on
detection size/confidence so a crowd shot cannot mint forty people. Cluster creation is
additionally fenced by mutual-kNN, a stricter `--cluster-threshold` for grouping than for
voting, and `--max-cluster`, because clusters are single-link components: one weak edge
chains two people together.

**Undoing a fused person.** Those fences narrow the failure without closing it, so there is a
repair. `subcluster-faces <person>` (read-only) re-clusters one person's own faces with
**average linkage** over _every_ pairwise distance — affordable because a person is thousands of
vectors, not millions, and correct because re-running single-link at a stricter bar shatters a
person into fragments long before it separates the two people inside them. Up to 3000 faces the
build is exact; past that its n² matrix is not affordable, so the faces are first divided into
cells of near neighbours, each cell's own tightest merges are kept until 3000 groups remain, and
the exact build joins those groups, scoring two of them by the mean over all their pairs from
their vector sums. Every level at which two people could part is still exact; 11 000 faces take
about four seconds. It returns a
dendrogram rather than groups: cutting one costs nothing, so a reviewer re-cuts it at any
threshold without asking again, and "split in two" is the final merge undone. The default cut
comes from the largest gap in the top merges (`suggestCut`), because no fixed threshold can
work — average-link similarities depend entirely on the person, and on the real `Unknown
KA0J5R` the two people join at 0.015 while their own merges sit near 0.33. No gap means no
split suggested. Vectors arrive through `vfs.getVectors`, one query for the set, rather than an
`open`/`read` round trip per face. `subcluster-voices <person>` is the same over a person's voices,
one per recording they are heard in, for a person `cluster-voices` fused the same way.

`person-detach <facePath...>` is the write side and the only thing in the archive that moves
identity at face granularity: `--to-new-person` mints an unnamed person for a sub-group,
`--to <person>` sends it to someone known, and with neither it clears the assignment and sets
`assignLocked` — for the hands and slices of watermelon that are not a person at all, which
clearing `personId` alone would let the next `assign-faces` run re-tag. Both targeted modes
write `personSource: manual`, so no automatic pass undoes the decision. Two UIs drive it, both
through `lib/person-detach.ts` (chunked, and minting exactly one person however many chunks a batch
takes): `SplitPersonModal` acts on whole sub-groups of a named person, from their page, and the
unidentified-person popup's own crop grid picks individual faces — the
unit for one wrong face in an otherwise clean person, which no threshold need isolate. Every
person a face leaves is tidied up: an unnamed one left holding nothing is removed. Moving _every_
face of a person somewhere is naming them or merging them, so the popup offers those instead; saying
none of it is a person is `person-discard <person...>`, which unassigns and locks every region and
voice an unnamed person holds and removes the entry — the whole cluster at once, however many faces
the popup has loaded. It is the popup's "Not a person" beside the name box, what the foot bar's
"Not a person" becomes with everything picked, and an action on clusters picked in the overview.

`--rematch` is the fourth mode, for a reviewer who knows who a face is _not_ but not who it is:
it clears the assignment (unlocked), appends the person it leaves to the face's
`rejectedPersonIds`, and runs `assign-faces` on each image at once. `propagateLabels` in
`@archive/media/face-cluster` drops a rejected person's votes for that face, so both `assign-faces` and
`cluster-faces` honour it: the face joins whoever else it looks like, seeds a new unnamed person,
or — below the seeding gate — stays unassigned for the next clustering pass, and never goes back.
A named person's **Faces** tab drives it (`NotThisPersonAction`, beside Download and Set as cover
over a grid of that person's crops), with the other three modes as the alternatives; it then asks
`person-cover` again, since the cover may have been one of the faces that left.

**Doubtful faces.** A `transfer` that landed on the wrong face is an anchor like any other, and
nothing in recognition questions an anchor. An audit of the named faces may put a `doubt` on a
region (`FaceDoubt` in `@archive/media/regions`): who it was on, who it looks like, and both
similarities. A doubt counts (`liveDoubt`) only while the face is still a `transfer` on the
person it was audited on. `person-faces --doubtful --sort doubt` lists one person's doubtful
faces, the widest gap first, and every answer counts them. The Faces tab switches to that list
(`?faces=doubtful`), labelled with who each face looks like. "Not <name>" offers that person as
the destination. `face-confirm` ("Is <name>") keeps a face, now as `manual`, and drops its
doubt.

**Comments (convention).** Any node may carry `comments/<slug>` children: markdown `file` nodes (db
tier) whose content is the body, author in `props.uid` and time in `props.birthtime` — no bespoke attrs. The core
`comment <list|add|remove>` command owns them (`--body-base64` for bodies that would not survive shell
quoting); reading is `readComments` (`src/lib/comments`), exported to modules through `@ein/client` for
aggregators such as `media-details`. Owners are typically files
and albums (the legacy importer writes the same shape).

**Read aggregator.** `media-details <file>` returns everything the UI lightbox sidebar shows in one
call — description, capture time, `location` + `location`, `photographer`, the device with its owners,
the albums holding the file, the people tagged via `people/<slug>` links and `regions/*` `personId`
(each with their age at capture time, computed by `ageAt` in `@archive/people/genealogy`), the comments, and
`hashes` + fingerprint provenance for the sidebar's "More" section. `hashes` is a map rather than one
field because the corpus has two lineages: `sha256` comes from the write path, `exif-extract` or
`file-sync` (it is also the ETag), while the legacy import brought `md5`/`sha1` over and wrote no
sha256 — asking only for sha256 shows an empty row on every file imported before it was re-indexed. People that recognition invented
but nobody has named come back separately as `unknownFaces` — listing them among `people` would fill
the sidebar with "Unknown …" rows. Every section is best-effort so a half-indexed file
still renders. Walking these children per-section from the client would cost a round-trip each while
arrowing through an album.

`albums` is two questions, because albums hold members two ways. The album a file _lives_ in is
found by climbing the hierarchy by id, a generation per round trip, bounded at four levels
(`<album>/<file>` or `<album>/files/<file>`) — the same shape as `search --group-by`'s `groupsAbove`,
written locally because a module carries no dependency on core. An album a library file was added to
(`album add`), or a staging suggestion, _links_ it instead, invisible to any climb from the file,
so those come from `vfs.findLinks` —
the indexed backlink lookup — followed by the same climb from each link's own directory. A member
link is reported as `memberPath` beside the album's `path`, since unfiling acts on the link and
opening acts on the album. A `coverPhoto` link is skipped: an album may use a picture that lives
elsewhere as its cover, and that is not membership. So are an album's `previous` and `next` links.

**Albums in a series.** An album links to the albums before and after it in a series with
`previous` and `next` softlink children, set by `album set <album> previous|next <other>` (an empty
value unlinks). The command keeps both ends agreeing: the other album gets the link back, and an
album either end pointed at before stops pointing back; a neighbour the caller may not write is
left as it was and named on stderr. Only library albums take part, not suggestions. `album info`
answers `previous` and `next` with the rest of the album's row.

**Writing the description.** `file-set-description <file> [--text | --text-base64]` sets the
hand-written `description` attr. The UI
uses the base64 form for the same reason `comment add` has one: a description is arbitrary
multi-line text on its way through a shell command string. Empty text clears the attr rather than
storing an empty string, because every reader tests it for truthiness.

## Speaker recognition

The voice counterpart of face recognition, and deliberately the same contract. A **speaker** is
one voice of one recording — what a face region is to a photo — and the unit a person is named
on (ein/core#516). It is an `embedding` node at
`<file>/metadata/transcript/speakers/s<n>` (in the order the voices are first heard) carrying one
voiceprint for all of that voice, the turns it spoke as data (`turns: [[start, end], …]`),
`talkSeconds`, and the person fields `personId`, `personSource`, `personConfidence`,
`personAssignedAt` and `assignLocked`, so `person-detach` and the correction tooling built for
faces work on voices without knowing which they hold. Turns are not nodes: a tape side has a
thousand of them, and nothing names a turn. The few turns no voice could be told for stay on the
`speakers` directory as `unattributed`.

`voiceprint-file` writes them from one `speech.voiceprint` call per recording: EMS runs
[Sortformer](https://huggingface.co/nvidia/diar_sortformer_4spk-v1) to find who speaks when and
TitaNet to embed each turn into a 192-dim voiceprint, stitches its windows into file-wide voices
and answers each with its turns and one voiceprint — its turns' vectors weighted by length. The
diarizer cannot take a whole file (a 12-minute recording asked for 18 GiB on a 15.5 GiB card), so
EMS runs it in windows sized for its card and undoes them itself (`ems/ops/_voices.py`: never
merge two labels of the same window, the diarizer's own statement that they differ); EiN never
sees a window. `personId` is left null for `assign-speakers`, exactly as `detect-faces` leaves it
for `assign-faces` — except what a person decided: a re-run carries each assignment named by hand
or locked to the new voice it shares the most speech with. `speakersAt` on the file is written
last, and announces the voices (`media.speakers.detected`); `media.speakers.missing` is the
reconciler's gap for a recording with speech and no voices.

**Whisper is untouched by any of this.** The transcript keeps its own segmentation, which breaks
on pauses and says nothing about who is talking; the two are joined by time when shown
(`attachSpeakers` in the archive's `ui/media/lib/vtt.ts`), so re-deciding a voice never rewrites
the transcript. The lightbox's video player draws its subtitles from the same join, each line led by
the speaker's name in the speaker's colour when the recording has more than one voice.

On a video, `voiceprint-file` also asks EMS who is seen speaking (`speech.active_speakers`, one
call per recording): EMS scores up to 4 s of each voice's longest turns at 25 fps with LR-ASD,
decoding the video once, and answers per voice the face whose lips moved with it and that face's
embedding. The model only reads what it was trained on, so EMS feeds it as LR-ASD's own pipeline
does — the lower face cropped square from the smoothed track, MFCCs of 16-bit samples; fed a
whole-head crop and float samples it scored a woman talking to the camera at 0.1. The face is
tied to the video's own face region it is (`@archive/media/speaker-faces`): of the regions on
screen when it was seen (their `appearances` cover its `t`), the one whose vector is nearest, if
near enough (cosine 0.5) — the voice's `asdRegionId`. Faces on screen together are different
people, so the nearest of them is the one even where another video shows the same person more
alike. The face is also searched among all the archive's faces, its person read from the region
the hit belongs to — the voice's `asdPersonId`. The faces the video shows are found apart from
this, by `media-video-faces`: lip-sync looks only at a few seconds of each voice, and only to tie
a voice to a face.

The two usually come the other way round: `media-video-faces` runs in the `faces` kind below every
photo's faces, transcription and diarization in kinds of their own, so on an import a video's
voices are printed long before its faces are detected (ein/core#728). The bridge announces
`media.faces.completed` for a video on the write that sets its `facesAt`, with the file's
`speakersAt`, and `media-speaker-faces` takes the ones that have voices: `see-speakers` asks EMS
again over the voices as they are (`speech.active_speakers` alone, no diarization) and writes each
voice's `asd*` fields anew, then `assign-speakers` decides the voices the faces now say something
new about. A face whose person changes later — assigned after the voices were decided, named,
corrected, locked as no one — is `media.speakers.face-changed` on its video, when the video has
voices: the bridge binds `media-region.updated` and drops every write that leaves `personId`,
`assignLocked` and `rejectedPersonIds` alone on the names the event carries. `media-speaker-assign`
takes it, folding the faces of one video, assigned one after another, into one run
(`coalesce: rerun`, a 5 s hold).

`assign-speakers` and `cluster-voices` mirror `assign-faces` and `cluster-faces` and share their
voting core. A voice is decided as a whole, on far more voice than any turn carries, and the
diarizer's word holds as a photo's does for faces: two voices of one recording never vote for each
other and never go to the same person automatically — a diarizer that split one person in two is
a merge to fix, two people fused into one would have to be found first. The gate on founding a new
identity is how long the voice spoke in all (`CFG_VOICE_MIN_CREATE_SECONDS`, 10 s). A recognised
face seen speaking (`asdScore` at least `CFG_VOICE_ASD_MIN_SCORE`, 0.6) is one more vote: for the
person of the voice's region as it is when the voice is decided, so naming the face names the
voice; for nobody when a person locked the region as no one or rejected the archive-wide match;
for that match while the region names no one or is gone. Against the face only voices a person
named or locked are counted: automatic assignments are earlier
runs' guesses, and an unnamed voice that has swept up a few hundred recordings would outvote any
face. Neighbours vote, but a voice joins the person they elect only when it is also like the mean
of every voice that person already holds (`CFG_VOICE_PERSON_THRESHOLD`, cosine 0.7): each
attached voice is a neighbour for the next, and on neighbours alone a person drifts across
speakers one loosely similar voice at a time. The person a confident lip-sync match names meets a
lower bar (`CFG_VOICE_ASD_PERSON_THRESHOLD`, 0.5), and one who holds no voice yet meets none —
the cold start the face is there for. Lip-sync on home video often names the face in frame while
the camera operator talks; that voice is plainly someone else's, and the bar catches it.
`media-speaker-assign` runs it
once per recording when its voices are written and again when a face of the video changes person,
on the CPU pool, under the `person-mint` exclusive key faces share.

An automatic voice whose face disagrees with it — the face names someone else now, or names
nobody where the decision leaned on it (`asdAssisted`) — is decided again as if new, and the
outcome stands even when it is undecided, so the order faces and voices arrive in does not change
who a voice is. The person it leaves, unnamed and holding nothing else, is deleted
(`releasePerson`).

`media-details` returns the recording's `speakers` (each with its turns and person) and the
`unattributedTurns`; people only heard join the file's `people` with `source: 'voice'`, and
`subjectMediaIds` counts a recording a person is heard in, so search by person finds it.
`person-voices` lists the recordings a person is heard in, each with its talk time and its
longest turn for the player to open at; there is no audio-clip route, and a voice heard in
context is more recognisable than one cut out of it.

A person minted from a voice carries `origin: 'voice'` and no `representativeFaceId` — there is
no crop to show, because what identified them was a span of audio. Anything resolving a
thumbnail for an unnamed person has to branch on that rather than assume a face exists.
