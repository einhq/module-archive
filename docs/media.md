# Media

EiN handles photos and videos: it reads what's embedded in your
files, makes them fast to browse, and helps you find and organize them.

## What it does for you

- **Thumbnails and previews** — when you upload a photo or video, smaller
  versions are generated automatically so galleries load quickly.
- **Subtitles** — a video or recording that has been transcribed shows what is
  said as subtitles, over the picture or under the waveform, with who says it
  when there is more than one voice. They are on until you turn them off with the
  CC button or `c`, and stay as you left them.
- **Reads embedded details** — capture date, camera, and GPS location are pulled
  from the file so photos land on the right day and location without extra work.
- **Locations on the map** — photos with a location are matched to nearby locations and
  shown on the **Map**.
- **Faces** — faces in photos can be detected to help connect images to the
  [people](people.md) in them.
- **Finding similar and duplicate images** — near-identical and byte-identical
  files can be spotted so you can tidy up your collection.

## Albums

Photos and videos live in **albums** — `album` nodes under `/archive/albums`. Give an album a
cover image to make it recognizable in listings. To add files, use **Upload** in the album's
header or drop them anywhere on the album page; both are there when you may change the album,
and both put the files straight into it rather than into [staging](staging.md).

`album create <path> [--name <title>] [--share default|private|shared|everyone]` makes
one, shared as your new albums are unless `--share` says otherwise: `private` is yours
alone, `shared` your group's, `everyone` every account's. `album add <album> <file...>`
puts files in an album: it links them, except files from your
[staging area](staging.md), which move into the album and can be put back with
`staging undo` (its answer names the journal entries). With `--create [--name <title>]
[--share ...]` it makes the album first when it is not there.

### Album profiles

Every album of the library keeps a **profile** beside it, a hidden `.profile` child of the
`album-profile` node type, which [staging](staging.md) matches its suggested groups against. It
summarises the album's members: their capture times (up to 1,024, at least one for each day it has
photos of) and how many fall on each day, where they were taken (0.01° cells, and the locations
they are linked to), who is in them, how many there are, and up to four of their pictures that stand
for how the album looks, named by their picture vectors rather than copying them. Listings and
`search --under` leave it out.

The album's own pipeline (`media-album`, its `profile` step) builds it again whenever the album's
members change, and writes nothing when they are as they were. Naming someone on a face or a
position arriving tells no album, so the hourly sweep also builds again any profile not checked for
a week. `album-profile <album>…` builds the ones named; `album-profile --all` every library album, a
batch at a time, and `--stale` only those missing or not checked for a week; `--force` builds them
even when nothing changed. A staging suggestion has none.

## Capture times

Every photo, video and recording is dated by the best source it has, and its **time source**
(`takenAtSource`) says which; the viewer's details panel (`i`) shows it in words, as **Time
source** under its **Details** fold:

- `manual` — a date someone typed: with **Set time**, to the second, or with `file-set-time` in
  the shell, as vague as it really is (`1975`, `2004-03`); it always wins;
- `sidecar` — what the file's [sidecar](#sidecars) says: a date an editor wrote into an XMP
  file, at its own precision, next after a typed one; a date someone set in Google Photos
  (a Takeout time more than 26 hours from the camera's clock, or with no camera clock from the
  upload), next too; and otherwise, after the GPS fix, the Takeout's reading of the camera's
  clock, which gives the clock its zone. A Takeout time that is only the upload's is never used;
- `gps` — the GPS receiver's clock, the one source that knows the exact instant;
- `device` — the camera's or phone's own clock (`DateTimeOriginal`, or a video's recording
  time);
- `name` — a date the file name spells, such as `IMG_20190601_123456.jpg`, used only when none
  of the above is there and only for files whose [staging category](staging.md#dates-and-time-rules)
  says its names are dates. It is kept on the file as `whenName`.

A file marked `digitized` (a scan, from a staging category of scans) is never dated by the
clocks that ran while it was scanned — the scanner's, a GPS fix, its name, a Takeout's reading of
them — but only by a date someone gives it: typed, in an XMP file, or set in Google Photos. A
scan is undated until then, rather than dated to the day it was scanned. Its GPS fix is not its
place either. The mark, like `whenName`, goes with the file into the library.

## Sidecars

A **sidecar** is a small file beside a picture that says things about it: the JSON Google
Photos writes for each photo of a Takeout (`IMG_0001.jpg.supplemental-metadata.json`, or the
older `IMG_0001.jpg.json`), and the `.xmp` file a photo editor or a scanning tool writes
(`IMG_0001.jpg.xmp` or `IMG_0001.xmp`). Once paired it lives under its file, as
`<file>/sidecar` (`sidecar` and `sourceId` on it say what it holds and whose it is; an edited
copy and a Live Photo's video share their original's through a link), and it is read whenever
the file is:

- its **time** is one of the [capture-time sources](#capture-times) (`sidecar`);
- its **place** gives the file a position where the file's own bytes have no GPS fix — a
  Takeout's only for a file that is no scan, unless someone set the place in Google Photos;
- its **caption** becomes the file's description where it has none, and a Google Photos
  **favourite** a star for the person whose staging area it arrived in;
- the phone folder a Takeout names (`WhatsApp Images`) counts as one of the file's folders when
  staging groups it, so a saved picture lands among the clutter;
- an XMP file's rating, colour label and keywords are kept on the sidecar.

Sidecars arriving in [staging](staging.md#takeout-and-sidecars) are paired by themselves;
`media-sidecars <folder>` pairs those in any folder you name. Merging duplicates carries a
dropped copy's sidecar over to the kept one when it has none.

## What staging hides

Files in your [staging area](staging.md) are not in the library yet, so the views of the whole
library leave them out: the Media page and its counts, the map, On this day, `latest`, the
timeline and search, whether by words, a picture, a label, a person, a place or an area. They
come in when they are filed. Staging lists them, and so does a search that names a place inside
it (`search --within /home/<you>/staging/files/inbox`).

One count still includes them: the **number by a person** in the people list (`person-list`)
counts every face and voice connected to them, those in staged files too. Their pictures, when
you open the person, are the library's only, so the number can be higher than what is listed
until the staged files are filed or discarded.

## Good to know

- Processing (thumbnails, reading details, faces) happens in the background
  shortly after upload; a new photo may take a moment before its thumbnail and
  details appear.
- Uploading the same photo over [SFTP](../../guide/ssh-sftp.md) triggers the same
  processing as the web interface.

## Without a graphics card

EiN runs on a machine without a graphics card, or with a small one, using the
same models, only slower. Everything is made all the same: search by what a
picture shows, faces, voices and transcripts. One thing differs: transcripts
made on the processor use a lighter setting of the speech model, so their
wording can differ a little from ones made on a card.

## What a photo carries

A photo or video is a `file` node, and what is learned about it is kept with
it: its capture time and position, the faces and voices found in it, what is
said in it, and small renditions for the screen. You never need to manage those, and
removing the photo removes them with it.

## Photo stacks in the shell

An album groups rapid, similar photos into stacks. They are refreshed by the
`media-album` pipeline when an album's members change, and reconciled by the
hourly album-metadata service. To inspect them without writing anything:

```
album-stack refresh "/archive/albums/Summer 2020" --dry-run -v
```

Use `album-stack front <album> <file>` to choose the visible photo,
`album-stack separate <album> <file>` to keep one photo out of stacks in that
album, and `album-stack allow <album> <file>` to remove that exclusion.
`album-stack stack <album> <file>...` stacks photos by hand: if one of them is
already in a stack, the rest join it and its front stays; a refresh keeps a
stack made this way as it is, and `album-stack unstack <album> <file>` undoes
it. In the album view, select the photos and use _Stack_ in the selection bar.
The original files never move.

How alike two photos must be, and how close in time, are `--threshold`
(default 0.75) and `--max-gap-seconds` (default 10); the scheduled refreshes read
them from `CFG_ALBUM_STACK_THRESHOLD` and `CFG_ALBUM_STACK_MAX_GAP_SECONDS`.
