# Staging

Staging is your private inbox for new photos, videos, and audio. Files uploaded
there are indexed normally, but they do not enter the shared album library
until you choose to promote an album or add a file to an existing album, and every
such decision can be undone. The
one thing that waits is reading text: a scanned letter or a sign in a photo is
read when promoting or **Add to album** files it, not while it is here.

The albums suggested for your staged files are auto albums; see
[Auto albums](auto-albums.md). They exist only here: the shared library holds
none until you promote one.

What is in staging stays out of the library's own views until it is filed: the Media page and
its counts, the map, On this day, the newest pictures and the search results leave it out,
because `staging/` is **unlisted** (`staging init` marks it). Staging itself lists it, and so
does a search that names a place in it, `search --within /home/<you>/staging/files/inbox`. A
person's count of pictures still includes the faces found in staged files
([Media](media.md#what-staging-hides)).

Open **Staging** in the sidebar, below Media. It opens on the **overview** of your
categories (see [Layout and categories](#layout-and-categories)), or, while you have only
the inbox, on the inbox itself. Each category is a card: what it is called and what it
holds, a bar of its files by how far along they are — **being prepared** (their metadata is
still being read), **to sort**, **needs a date** (read, but with no capture time) and
**other files** (not pictures, videos or recordings) — how many files and bytes, and where
the files on their way in are: **arriving** (uploading from this browser, so many of so
many), **being prepared**, with about how long that takes, and **being grouped** (read, and
waiting for the organizer to put them in a group). **Continue** (**Open** while it is empty)
opens the category, **Import** imports into it, and the gear opens its settings. The **New category** card
starts one of a kind: a Google Photos export, scans, a phone, a camera, messaging,
screenshots, or another. Below the cards the page says when a GPS track waits for its
device, and where to copy files over SFTP. The page reads `staging status` once, again
after an upload or a change made in one of its dialogs, and every 30 seconds while files
are uploading into staging or being prepared and the page is in view; less often when a read
takes longer than 3 seconds, as it does for a category of a few hundred thousand files, so the
reads take at most a tenth of the database's time.

Drag files or folders over the overview and a tile appears for each category: drop them on
one and they go into its folder of today, folders and all.

A category's page has the category's name as its title: click it to switch to another
category, to **All categories**, or to **New category…**. The same thin bar of its files,
and what is arriving, being prepared and being grouped, stands above its four tabs:

- **Sort** shows the category's suggested albums one after another, oldest first, and is
  where you decide them: see [Sorting](#sorting) below. Every category's files are grouped
  and sorted here.
- **Duplicates** lists the category's exact copies and look-alikes — of photos already in the
  library, and of photos elsewhere in staging — and resolves them: see [Duplicates](#duplicates)
  below.
- **Files** shows the category a folder at a time, its subfolders as cards above
  (see [Files](#files) below).
- **Done** lists what was decided in the category and how its groups were changed, newest
  first, with **Undo** on each not undone yet (**Regrouping** shows the changes of the groups
  alone): see [Undo and the journal](#undo-and-the-journal).

The header's **Upload**, on every tab, adds files to today's folder of the category on
screen, `files/<category>/upload-YYYY-MM-DD` (the archive's day); the Media page's adds to
the inbox's. **Upload a folder**, under ⋮, adds a folder and everything in it, and a folder
dropped on the page keeps its structure the same way: `Trip/day 2/IMG_0001.jpg` lands in
`upload-YYYY-MM-DD/Trip/day 2/`, and the folder names help grouping. The folders are made
when files are dropped, so a day without uploads leaves none; four files upload at a time,
and a name already taken in a folder is stored as `name (2).ext`, never replaced.

## Importing

**Import media** — in the top bar's **Create** menu, on the overview, on a category's card
(**Import**), in a category's ⋮ menu, in an empty **Files** tab, and on the Home page while it
has no news — opens a dialog: choose the category, or make a new one there (what it holds and
what it is called; its folder name is made from that), then **Choose files** or **Choose a
folder**, and **Upload**. The files go to the category's folder of today, a folder keeping
its structure there, and upload in the background, with their progress, per category, under
the top bar's upload button, while the category's **Files** tab opens. A new category is
made with `staging category <name> --create --kind K --label L` first; the upload makes the
folders it needs.

For more files than a browser should carry — a whole export — the dialog gives the
category's folder to copy them into over SFTP or scp instead, folders and all, with a
button that copies the path; see [Over SFTP](#over-sftp) below. A zip copied or
uploaded into a category is expanded where it lands, once its upload has ended, and removed
(`staging-unzip`); a Takeout's parts can be copied in as they are (see
[Takeout and sidecars](#takeout-and-sidecars)).

## Files

The **Files** tab shows one folder of the category at a time, `?dir=` in the address; the
line above it leads back up, to the category itself. Its subfolders are cards, each with
the number of entries in it (`find <folder> -mindepth 1 -maxdepth 1 -type d`). Below them,
**Media** shows every staged picture, video and recording in the folder however deep in
folders, by date with the undated last, but for the exact copies that are not processed (see
[An exact copy shows its original](#an-exact-copy-shows-its-original); `search --within <folder>
--missing duplicate.deferred`); **Folder** and **Duplicates** list them. Up to 20,000 files are laid out
at once; a larger folder pages as you scroll. Selected files can be put in an album or given
a capture time. **Folder** lists every entry of the folder itself instead, whatever its type
— a PDF, a sidecar, anything else that is not media — 200 at a time in name order
(`ls -l --limit 200 --after`), with a box to select each.

A folder card's ⋯ menu, the **Actions** menu beside the line above (for the folder you are
in) and the same menu over a selection in **Folder** offer:

- **Move to folder…** — another folder of the category, or a new one named there;
- **Move to category…** — a folder of another category, its own folder by default;
- **Discard…** — to your trash.

A move within the category is one `mv -n <sources...> <folder>`: every link to what moves
and to anything below it follows, so albums, relations and suggested groups keep pointing at
it, and a name already taken where it goes is left where it was and said. A move to another
category is `staging move <sources...> <folder>`: the same, but what moves first leaves the
suggested groups of its old category, which hold only what is in it. A discard is
`staging discard <paths...>` (see [Discarding](#discarding)): one row on the Trash page,
labelled with the category and what went, with **Undo** in the message and on the **Done**
tab, and **Restore** on the Trash page.

In the inbox, a GPX file dropped in is a route, not media: it joins the track of the device
that recorded it, matched by the device's name, make and model, or serial number in the
file, and the file itself goes. When the file names no device the archive knows, it waits in
`/home/<user>/staging/routes/`, and the inbox's **Files** tab asks which device it was.

Every directory of a staging area is mode `0700` and yours: another user cannot
traverse it. Background media pipelines can still index its contents because those
jobs run with administrative VFS access.

Files from your personal area in the legacy archive are imported into the inbox
category's `legacy-import` folder. Existing files can be moved into a category with
`mv <sources...> /home/<user>/staging/files/inbox/`, which preserves node identities
and rewrites the links to them.

## Layout and categories

```
/home/<user>/staging/
  files/<category>/…        your staged files, in any folders you like
  albums/<category>/<slug>  the groups suggested for that category's files
  journal/                  decisions made in staging
  routes/                   GPX files waiting for the device that recorded them
```

A **category** is a folder under `files/`: all your Google Photos in one, a box of
scanned prints in another. Its name is its key and never changes; its settings —
what it holds (`kind`), what it is called (`label`), the library album its files
go to by default (`destination`), and how its files are grouped (`group`) — are kept on the
folder. The kind fills in what a category does by default; every kind starts as its preset,
and a setting that is missing or unreadable reads as the kind's. `inbox` is always there, of
the `inbox` kind, and cannot be removed: uploads go there, and so does anything not put in a
category of its own. Every category's files are grouped by the [organizer](auto-albums.md):
by time and place (`events`, most kinds), by folder and file-name run (`folders`, scans), or
into monthly lanes alone (`none`, messaging and screenshots); `--significance fewer|normal|more`
says how readily a day becomes a group of its own rather than part of an Everyday lane.

A category's `sidecars` says whether the [sidecars](#takeout-and-sidecars) arriving there are
paired with their files (`pair`, every kind but two) or left as they are (`ignore`, where
`messaging` and `screenshots` start).

A category's `lane` says how its files are processed. In the `bulk` lane — where `google-photos`
and `scans` start, as they arrive by the thousand — reading, thumbnails, faces and the rest wait
behind everything else, so photos uploaded to the inbox meanwhile are ready first, and the
import goes on whenever nothing else is waiting. Every other kind starts in the `normal` lane.
A change applies to work announced from then on, within a minute; work already queued keeps its
place.

On the Staging page, **New category** makes one and a category's **Category settings**
(the gear on its card, or its ⋮ menu) change what it is called, what it holds and the
album its files go to; a change of what it holds also puts its grouping, time rules, lane and
sidecars back to the new kind's. **Remove category** there removes an empty one.

| Command                                                                                             | What it does                                                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `staging category <name>`                                                                           | shows a category                                                                                                                                                                                                                   |
| `staging category <name> --create [--kind K] [--label L]`                                           | makes one, with its folder of groups; the name is lowercase letters, digits and dashes                                                                                                                                             |
| `staging category <name> --kind K` / `--label L`                                                    | changes it; a new kind resets every other setting to the kind's — label, grouping, time rules, lane and sidecars — but the destination and what the same call sets                                                                 |
| `staging category <name> --destination <album>` / `--no-destination`                                | sets or clears where its files go by default                                                                                                                                                                                       |
| `staging category <name> --strategy S` / `--significance P`                                         | how its files are grouped (`events`, `folders`, `none`) and how readily a day is a group of its own (`fewer`, `normal`, `more`); a run of the organizer is asked for, which follows them                                           |
| `staging category <name> --lane bulk` / `--lane normal`                                             | puts its files' processing behind everything else, for a large import, or back among the rest                                                                                                                                      |
| `staging category <name> --sidecars pair` / `--sidecars ignore`                                     | whether sidecars arriving there from then on are paired with their files                                                                                                                                                           |
| `staging organize [--user U \| --all] [<category>…] [--full] [--dry-run]`                           | groups each category's indexed files, every one into exactly one group, planning again only what changed since the last run, or everything with `--full` ([auto-albums.md](auto-albums.md)); `--dry-run` says what it would do     |
| `staging organize [<category>…] --queue [--if-pending]`                                             | asks for a run, which the organizer's pipeline makes within minutes: **Group now**. Yours to ask for your own categories; `--if-pending` only where something waits for one (an administrator's safety net)                        |
| `staging category <name> --remove`                                                                  | removes an empty category and its empty folder of groups                                                                                                                                                                           |
| `staging status [--user U]`                                                                         | each category's files, other files, those still being read (`indexing`) and those read (`indexed`), the undated, bytes, the exact copies by where their originals are (`copies`), what was decided (`decided`); the routes waiting |
| `staging init [--user U \| --all] [--loose-batch N] [--layout-only] [--idle-minutes M] [--dry-run]` | sets a staging area up and puts it right (below)                                                                                                                                                                                   |
| `staging check [--user U]`                                                                          | lists what is out of place, and changes nothing                                                                                                                                                                                    |

The kinds are `inbox`, `google-photos`, `scans`, `phone`, `camera`, `messaging`,
`screenshots` and `generic`. `--user` acts on another user's staging area, which
only an administrator may.

**`staging init`** makes every directory above, yours and `0700`, marks `staging/`
unlisted, and makes the inbox. A folder found directly under `files/` is adopted as a `generic` category named after
it. Then what is out of place moves, with every link to it following, so albums,
relations and suggestions keep pointing at it: a file left directly in `files/` goes
to `files/inbox/<loose batch>/` (`unsorted` unless `--loose-batch` names another), a
group left directly in `albums/` to `albums/inbox/`, and a GPX file waiting for a
device to `routes/`. A name already taken there gets `-2`, `-3`. Run again, it finds
nothing to do. `--dry-run` says what it would do and does none of it. `--layout-only`
makes the directories and categories and moves nothing; the pages run it when files are
dropped, and the Staging page when it opens on an area not set up. `--idle-minutes M` leaves
a loose file changed within the last `M` minutes where it is, counted as `recent`: it may still
be being copied. `staging-organizer` runs `staging init --all --idle-minutes 360` hourly, so a
file copied straight into `files/` lands in `files/inbox/unsorted/` within a few hours.

**`staging check`** reports, each with a code: a directory `missing`, `not-directory`,
or with the wrong `mode` or `owner`; `staging/` `not-unlisted`; a `loose-entry` in
`files/` or `albums/`;
`no-inbox`; `orphan-albums`, a folder of groups with no category; `cross-category`, a
group linking to a file outside its own category; `dangling-link`, one linking to
nothing; `waiting-route`, a GPX file waiting outside `routes/`. Up to 20,000 group
links are checked. `staging init` puts right all but the links.

## Detection

A folder that lands in the inbox — dropped in a browser, or copied over SFTP — is looked at to
see where it came from, and when it looks like one source, its card on the Files tab and the
Staging overview say so: “Takeout” looks like Google Photos, with **Move to** your category of
that kind (the Move dialog), or **Make a … category**, which makes one and moves the folder
into it. Nothing is moved by itself. The first three are shown, the rest behind **N more**, and
the ✕ on one keeps that folder where it is and stops asking: it sets `detectDismissed` on the
folder (`attrs -J detectDismissed=true <folder>`; `attrs -d detectDismissed <folder>` asks again).

| Source        | What says so                                                                                                                         |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| google-photos | a `Takeout/Google Photos` (or `Google Foto`) folder, `Photos from 2019` folders, `*.supplemental-metadata.json` names, Google's JSON |
| scans         | `scan0001`, `FastFoto_0001`, `IMG_20190601_0001` names, mostly TIFF, a scanner in the EXIF, no device in it, one size throughout     |
| phone         | `DCIM/Camera` or `DCIM/100APPLE`, `PXL_…`, `IMG_20190601_123456`, `20190601_123456` names, HEIC, a phone in the EXIF                 |
| camera        | `DCIM/100NIKON` and the like, `DSC_0001`, `DSCN0001`, `P1010001`, `GOPR0001` names, RAW files, a camera in the EXIF                  |
| messaging     | `WhatsApp Images` and the like, `IMG-20190601-WA0001`, `signal-…` names                                                              |
| screenshots   | a `Screenshots` folder, `Screenshot_…` names, mostly PNG                                                                             |

`IMG_0001` alone is a camera's or an iPhone's; the EXIF, or HEIC beside it, says which. A
folder costs a few reads however large it is: three levels of folders (the first few of each),
one count of its files by type, 500 of their names, three JSON files and eight EXIF records.

| Command                                 | What it does                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `staging detect [<folder>…] [--user U]` | what each folder (at most 20, staged or not) looks like: the `kind`, how sure (`high`, `medium`, `low`), the `evidence`, and your `category` of that kind. Without a folder, the 12 newest arrivals in the inbox: each folder directly in it but an upload folder, and each folder directly in an upload folder, but those `dismissed` |

## Takeout and sidecars

A Google Photos Takeout is a set of zips, each holding `Takeout/Google Photos/` with a folder
per year (`Photos from 2019`) and one per album, and beside every photo and video a JSON file
with what Google knows of it: when it was taken, where, its caption, the people named in it,
whether it was a favourite. Make a `google-photos` category for it
(`staging category google-photos --create --kind google-photos`; it pairs sidecars and works in
the bulk lane) and copy the zips into it: each is expanded where it lands, and the parts fill
one tree.

As the files land, each JSON is **paired** with its photo (`staging-sidecars`, a moment after
the last of a folder's files lands): it moves under the photo, as `<photo>/sidecar`, and the
photo is dated and placed by it ([Media](media.md#sidecars)). The pairing knows Google's names:
`IMG_0001.jpg.json` and `IMG_0001.jpg.supplemental-metadata.json`; a name cut at 51 characters
(`…supplemental-metad.json`, or a long photo name cut short); the second photo of a name,
`IMG_0001(1).jpg`, whose JSON is `IMG_0001.jpg(1).json`; an edited copy
(`IMG_0001-edited.jpg`, and its other languages' names) and a Live Photo's video
(`IMG_0001.MP4` beside `IMG_0001.HEIC`), which share their original's. An album folder's
`metadata.json` gives the folder its title, which names the group the organizer makes of it. A
caption becomes the photo's description where it has none, and a favourite your star. An XMP
file from a photo editor or a scanning tool is paired the same way: `IMG_0001.jpg.xmp`, or
`IMG_0001.xmp` for the one file named `IMG_0001` (the RAW, beside a RAW and its JPEG).

A JSON that matches no photo, or one two photos could claim, is left where it is and counted
as `unmatched`; one that is no Takeout JSON at all as `other`. A second copy of a sidecar
already paired (the same bytes, from another part) is removed.

| Command                                 | What it does                                                                                                                                                                                                                                                                                                                                |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `media-sidecars [<folder>] [--dry-run]` | pairs the unpaired sidecars in a folder, at any depth (the working directory by default), and answers how many it `found`, `paired`, `shared`, read as album titles (`albums`), removed as `duplicates`, left `unmatched` (the first 50 by path) and found `other`; `--dry-run` counts and writes nothing. A second run finds nothing to do |

## Dates and time rules

A file's capture time comes from what knows it best: a date you typed, then a date its sidecar
gives, the GPS fix, the camera's clock, and last a date its file name spells (see
[Media](media.md#capture-times)).
Which of these a category's files may be dated by is the category's **time rules** (`time`),
two switches its kind sets and you can change:

| Kind                                         | `digitized` | `filenameDates` |
| -------------------------------------------- | ----------- | --------------- |
| `scans`                                      | on          | off             |
| `inbox`, `phone`, `messaging`, `screenshots` | off         | on              |
| `google-photos`, `camera`, `generic`         | off         | off             |

- **`digitized`**: the files are copies made long after the picture, scans of prints or
  negatives. Every clock that ran while they were digitized says when the copy was made, not
  the picture: the scanner's own `DateTimeOriginal` (some write the scan day there), a scanning
  app's GPS fix, the file name, and when the bytes were written or uploaded. None of
  them dates a scan; only a date you give it does, and until then it waits under **Needs a
  date**.
- **`filenameDates`**: a date the file name spells counts when nothing better is known: a
  phone's `IMG_20190601_123456.jpg` or `20190601_123456.jpg`, a Pixel's
  `PXL_20190601_103456789.jpg` (UTC), WhatsApp's `IMG-20190601-WA0001.jpg` (the day only),
  Signal's, Android's and macOS's screenshots, Facebook's `FB_IMG_…`, a saved
  `image-20190601_123456.jpg` or `download_20190601_123456.jpeg`, and an uploader's
  `2019-06-01 12.34.56.jpg` or `2019-06-01_12.34.56.jpg`. A scanner's running number (`IMG_20190601_0001.jpg`) is not a
  date. A time without a zone is read in the zone the device keeps, else the archive's.

Each staged picture, video and recording carries what its category's rules made of it:
`digitized: true`, and `whenName`, the date its name spells where names are dates. They are
written as it is indexed, and they go with it when it is filed into the library, so a scan
stays undated there too and `media-resolve-time` keeps it so. The viewer's **Time source**
says which source dated a file, and that a scan's clocks were set aside.

When files move into a category with other time rules — a folder moved from the inbox into a
scans category, say — they are dated again by the new rules in the background
(`staging-retime`); a move within a category, or between two with the same rules, changes
nothing. Changing a category's rules dates its files again before the command answers.

| Command                                                      | What it does                                                                                                                                                                         |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `staging category <name> --digitized on\|off`                | sets whether its files are digitized copies, and dates them again                                                                                                                    |
| `staging category <name> --filename-dates on\|off`           | sets whether its file names are dates, and dates them again                                                                                                                          |
| `staging retime [<category or path>] [--user U] [--dry-run]` | dates the media in a category, a folder or a file of one (every category by default) again by its rules; `--dry-run` counts and writes nothing. A second run finds nothing to change |

`staging retime` answers how many media it read (`scanned`), how many it stamped anew
(`policyChanged`), how many changed date (`retimed`), by the source that dates them now
(`bySource`, so `bySource.name` is how many are now dated by their names), and how many were
left with no date (`cleared`).

## Sorting

The **Sort** tab is a stream of the category's suggested albums, under
`/home/<user>/staging/albums/<category>`, oldest first (**Newest first** turns it round; the
undated come last either way). One group is open: its name, when it was and how many
photos it holds, and every photo in it, a grid per day — or, in a group of more than 40 days
(an Everyday lane of a year), a grid per month whose header lists its days as chips (click one
to select that day's photos) — with the photos without a date last, under **No date**. Each
day or month after the first has **Split here**; in a lane, each has **New group**. The others are closed to their
name and two rows of their photos, spread over the whole group, with "+N" for the rest.
Click a closed group, or step to it, to open it. A photo that has not been processed yet
shows as a grey placeholder rather than being fetched in full; when a group's photos cannot
be read, it says why, with **Retry**. A long stream has a time rail at its right edge once
every group is loaded, counted in groups: drag it to a date to bring the groups from then up.
While a group shown by month is open, the rail is that group's own, counted in photos: a date on
it brings its first photo from then up under the group's header.

On a page wide enough, the **destination column** stands beside the stream: where the open
group can go. First its **proposal** — what **Enter** does — with how sure it is (three dots:
sure, likely, unsure). A group made mostly of copies of library photos is proposed to keep the
library copies (see [Duplicates](#duplicates)); clutter, to be discarded; an Everyday lane, to
file its matched days (see below). An event or a trip goes to the library album it was
[matched](#candidates-and-compare) to when you may add to it and the match is likely or sure,
else to the category's destination album when it has one you may add to, else to a new album
under the group's name. A folder you named takes only a sure match, else becomes a new album
under its name; a scan run takes only a sure match, else the destination, else a new album.
Then its **candidates**, up to three library albums it may belong in, best first, each with how likely and why, and the pictures of
the highlighted one around the group's days (see [Candidates and compare](#candidates-and-compare)). Then a new album (**N**), a new private one (**P**), the
**target** that **B** files into, the albums you filed into lately, **Add to album…** (**A**,
any album you may add to, or a new one), the neighbouring groups to merge with, **Later** and
**Discard**; for the group, its time (**T**) and **Not a group…**, and for photos of it the
keys act on, a split, the groups above and below and **Move to a group…**. The target is the album you chose with **Shift+B** for this category, else the
category's destination, else the album you filed into last; it and the recent albums are kept
in your browser.

On a keyboard, the line at the foot of the stream says what each key does to the group
on screen (**hide** folds it away; **?** lists every key):

| Key     | What it does                                                                    |
| ------- | ------------------------------------------------------------------------------- |
| J / K   | the next / previous group                                                       |
| Enter   | apply the proposal: file into its album, or name a new one                      |
| 1 2 3   | file into the candidate of that number                                          |
| , / .   | highlight the candidate above / below                                           |
| R       | not this album: the highlighted candidate is not offered for the group again    |
| C       | widen the column to compare the highlighted album's pictures, or narrow it      |
| N       | a new album from the group: name it, and its photos move to the library         |
| P       | a new private album, only yours (its name is listed among the albums)           |
| A       | add to any album, or a new one; 1–8 pick a recent one                           |
| B       | file into the target; Shift+B chooses the target                                |
| X       | discard the group's photos (200 or more asks first)                             |
| L       | put the group aside for later; in **Later**, bring it back                      |
| Z       | undo the last decision of this visit                                            |
| E       | rename the group in place                                                       |
| M       | merge the group into the one above                                              |
| Shift+M | merge the group below into this one                                             |
| T       | set the time of the group's photos (or of those selected, or of the part)       |
| [ / ]   | step through the open group's parts: its days, or its months                    |
| arrows  | step through the open group's photos; O opens the one you are on, Esc goes back |
| Space   | select the photo you are on, or the part's photos                               |

With a part of the open group (**[** or **]**), or photos of it selected — **Space** on one,
then a click toggles others — **Enter**, **N**, **P**, **A**, **B** and **X** act on those
alone; the rest of the group stays where it is, kept as yours (pinned). They can also be
regrouped, and so can the photo you are on:

| Key   | What it does                                                                                                                            |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------- |
| S     | split the group before them (before the part, the first selected, or the photo you are on); in a lane, they become a group of their own |
| < / > | move them into the group above / below                                                                                                  |
| G     | move them into any group: the ones around this one, or one found by name, or a new group                                                |
| Esc   | leave the part, or clear the selection                                                                                                  |

Under the open group, **New group of N pictures** makes those you act on a group of their own.
`<` and `>` are matched as typed, so they work on any keyboard layout, and so are `[` and `]`
(AltGr or Option with 8 and 9 on a Swedish one). A merge keeps the name a person gave, else
one that says what or where over bare dates, else the larger group's.

The ⋯ menu on each group has the same, and **Not a group…**, which removes only the
grouping: its photos stay in staging and go back to their lanes, and the organizer will not
suggest them as a group again. On a phone there are no keys: tap a group to open it, and use
its button (the proposal) or ⋯ menu.

The stream has **lanes**: **To sort** (events, trips, folders you named, scan runs),
**Everyday** (each year's ordinary days), **Needs a date** (pictures with no date, or dated
only to a year or a month), **Clutter** (screenshots and saved images) and **Later**, each with
its count of groups, which is the organizer's count of groups of those kinds
(`organizer.byKind` in `staging status`). A lane is no album of its own. An Everyday lane is
matched a day at a time: when some of its days are likely to belong in library albums, its
proposal files those days, each into its album, and the rest stay (**Enter**, or
`staging accept <lane>`); each of those days shows its album over its photos, with **File**,
and **Enter** on that day files it there. Otherwise a lane's proposal is the category's
destination when it has one you may add to, else none. Clutter's proposal is to discard it
(200 photos or more asks first), which accepting many groups never does. A lane is not split,
merged or said to be no group: take a day out of it with **New group** (**S** on its part), or
move photos out with `<`, `>` and **G**. In **Needs a date**, **T** gives the photos a time (the
**Set time** dialog: a start, from which they keep their spacing, or follow a minute apart
where they have none), and the organizer then puts them where they belong.

A decision takes the group out of the stream at once and the next one slides up into its
place; its one command waits its turn behind the ones before it, so decisions never race,
and the line above the stream says how many are still applying. Leaving or reloading the
page while any is waiting asks first. A group named with its member key
(`--expect`) is filed only while its members are still the ones you saw: one the organizer
changed meanwhile comes back with "it changed while you were deciding; look again". When a
decision fails, the group comes back with the reason, **Retry** and **Dismiss**. Each one
done says so in a message with **Undo**; **Z** undoes the decisions of this visit one by
one, newest first, and one still waiting is cancelled instead. The stream keeps up with
the organizer as it works: a group it changes or makes is read again, one it removes goes,
and when that is the open group the next one opens. Where you were is kept in the address
(`/staging?c=<category>&g=<group>`), and per category in the browser, so a reload or a link
returns to it; the page of one of your suggested albums has **Sort in Staging** for the same.

**Later** (**L**, `staging later <group>... [--off]`, at most 100 at a time) puts a group
aside: it leaves its lane for the **Later** lane, and the organizer's rewrites of it keep it
there. Nothing moves.

**Selecting many groups.** On a desktop each group's header has a box that selects it whole;
a click on its name or its strip with Ctrl or Cmd does the same. With **Shift** (on the box, a
name, a strip or a photo of the open group) the selection runs on from where it started: the rest
of that group from the photo it started on, every group between whole, and the open group up to
the photo clicked. **Shift+J** and **Shift+K** (or **Shift** with an arrow) select on to the next
or previous group and move there. **Select** above the stream takes every group of the lane, or
those whose proposal is sure; **Esc** clears. A **lasso** — press on the background, or on a
photo that is not selected, and drag — selects the closed groups whose header it touches or
half of whose photos it covers, and the photos of the open group it touches; **Shift** as it
starts adds to the selection, **Alt** takes from it, otherwise it replaces it, and **Esc**
while drawing puts back what was selected. Near the top or bottom of the window the page scrolls
under it. Moving between groups keeps the selection; one that has left the lane is let go.

**Deciding many groups at once.** Once the selection reaches past the open group's photos, the
line at the foot and the destination column decide on all of it:

| Key   | What it does                                                                                     |
| ----- | ------------------------------------------------------------------------------------------------ |
| Enter | accept the proposals of the groups selected whole, after a plan (below)                          |
| N / P | one new album, shared or private, of everything selected                                         |
| A / B | add everything selected to any album / to the target                                             |
| X     | discard everything selected (it asks first, saying how many photos)                              |
| L     | put the selected groups aside for later; when every one of them is in **Later**, bring them back |
| Esc   | clear the selection                                                                              |

Enter first shows what it would do, read with `staging accept --dry-run` 50 groups at a time:
each existing album with the groups and photos it would get, the groups that would become new
albums under their own names, and those left as they are (changed since you looked, without a
proposal, or less sure than you chose: every proposal, likely and sure, or only sure). The work
then runs in calls within each verb's cap — `staging accept`, `promote` and `discard` 20 groups
a call, `staging later` 100, photos one by one 500 — in the same queue as single decisions, while
a message says how far it has come ("Filing 1,840 of 9,830 photos · 37 of 214 groups") with
**Cancel**, which stops after the call in flight. A new album is made by the first call and
filled by the rest. Once done, the message has **Undo all**, which undoes every journal entry
the run made, newest first (for a run of Later, brings the groups back); **Z** does the same.

**Dragging.** Selected photos, or a group's grip ⠿ (which carries the group, or the whole
selection when the group is in it), can be dragged onto the destination column — the proposal,
**New album**, **New private album**, the target, a recent album, **Add to album…**, **Later**,
**Discard** — and onto another group's header, which merges dropped groups into it or moves
dropped photos into it (`staging merge`, `staging regroup`). Each target says what the drop
would do as the pointer arrives, and the drop runs the same command its key would, with Undo.

## Candidates and compare

Every suggested group is weighed against the albums of the library (see [Matching in auto-albums](auto-albums.md#matching)): when its photos were taken next to an album's, whether
that album has many other days around them, where they were taken, who is in them, how alike
the pictures look, copies already in an album, and how well a folder's name matches an album's.
What is found is kept on the group: up to three **candidates**, best first, each with how likely
it is, how far ahead of the next, and its reasons in words ("within 40 min of its photos for 12
of 12", "same places for 8 of 10 located photos", "2 of 3 people appear in it", "looks alike",
"3 exact copies are in it"); how likely it is that none of them is right, a **new album**; and
how sure the best is, which the proposal shows as dots: sure when it is at least 0.85 likely and
0.25 ahead of the next, likely when it is at least even odds and 0.1 ahead, unsure otherwise.
Nothing is ever filed by a match: the person decides.

In the destination column the candidates are listed under the proposal, the highlighted one
marked; **1**, **2** and **3** (or a click) file into one, **,** and **.** move the highlight, and
an album you may only look at is listed as **view only** and not offered. Under them is the
highlighted album's own **compare strip**: its pictures from the day before the group's first,
by day, the group's own days marked, with **Earlier** and **Later** to page through the album and
**Open album**; a picture there opens in the lightbox over the strip. **C** widens the column to
half the page and the strip to taller rows, to compare side by side; **C** again narrows it.

**R** — or the ✕ on the highlighted candidate — says **not this album**:
`staging reject <group> <album>` keeps it as a journal entry naming the album and the group's
photos. The album leaves the group's candidates at once, and is not offered for any group of the
category made mostly of those photos — the group as the organizer rebuilds it, a piece split off
it — until the entry is undone (**Done**, or `staging undo`), which gives the group its candidates
back.

`staging match [<group>…]` weighs the groups named now and keeps what it finds; without groups,
every group of yours (`--all`, every user's, for an administrator). The organizer does this for
the groups it writes; filing a group into a new album also weighs the category's groups around
its days again at once, so the next day of a trip offers the album its first day went into. A
group's matches stand only while its photos are the ones they were found for: once the organizer
changes it, it is as unmatched until weighed again. What can be weighed is what the one running
it may read; the organizer, as an administrator, reads every signal of your photos, and the
albums offered are always those you may read.

## Grouping

The organizer's groups are suggestions, and you can change them; each change is one journal
entry, undone like a decision, and those that change who is grouped with whom are kept: the
organizer applies them on every run until they are undone. In the **Sort** tab, **M** merges
the open group into the one above it and **Shift+M** merges the one below into it; **E**
renames it; **S** splits it, `<`, `>` and **G** move photos between groups, and **New group**
makes some a group of their own (see Sorting); **Not a group…** in its ⋯ menu dismisses it.
Each goes through the same queue as a decision, says so with **Undo**, and is listed in
**Done**, where **Regrouping** shows these changes alone. The commands, each answering
`StagingEditResult` (the entry, the groups made, changed and removed, and those refused by
`--expect`):

| Command                                        | What it does now, and from then on                                                                                                                  |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `staging split <group> --at <file> [--name N]` | the file and those after it become a new group; the organizer keeps the cut. A folder you named splits into two groups kept as they are             |
| `staging regroup <group> <file>...`            | the files move into the group, and stay with it                                                                                                     |
| `staging regroup --new [--name N] <file>...`   | the files become a group of their own; it lasts as a run of the timeline when nothing else is dated between them, else it is kept as it is (pinned) |
| `staging merge <keep> <other>... [--name N]`   | the others' files move into the kept group, and the others go; side by side in time it stays one group, else the kept one is pinned                 |
| `staging delete <group>`                       | not a group: its files go to their lanes, and no group of mostly them is suggested again                                                            |
| `staging rename <group> <name>`                | its name, which the organizer keeps; its files stay the organizer's to regroup                                                                      |
| `staging pin <group> [--off]`                  | the organizer leaves it and its files as they are, or manages it again                                                                              |

A lane (Everyday, clutter, undated) is not split, merged or deleted: move a picture out of it
with `regroup`. `--expect <memberKey>` (one per group named) refuses a group the organizer
changed since you read it. A group whose members someone changed by hand is kept as it is
(pinned). The staged files themselves never move.

## Promotion

**N** (or **Enter** on a proposed new album) names the open group, and
`staging promote <group> --name <title>` makes it a library album with that title, at
`/archive/albums/<title>` (a slash written as a dash; `(2)`, `(3)` when the name is taken).
Without `--name` the group's own name is the title. The group's node itself becomes the album,
so it keeps its id. **P** does the same with `--share private`: the album is yours alone
(mode `0700`) — "keep private" — though its name is listed among the albums. **A**, **B**,
a recent album and a proposed existing album file the group into an album that is there:
`staging promote <group> --into <album>`, into the album's `files/` when it keeps its media
there. Several groups of one category can be named at once; they all go into the one album.

The member files are moved into the album — a new album's `files/` directory — and become
direct children instead of softlinks, each under its own name, or `name (2).jpg` beside a
file of the same name. These are VFS renames, so file identities and all metadata,
thumbnails, face crops, locations, and other descendants survive without being
re-indexed; only the text in them is read now, as it is for a file added to an
album, and so is that of a folder moved out of staging whole with `mv`. The files leave your
other suggested albums, as a file added to an album does; every other link to a
moved file — another album's, a relation's — is rewritten to its new path. A group they
leave empty is deleted; one that loses its cover shows another of its photos.

A new album then receives the default sharing (the **Sharing** card under Settings →
Permissions), narrowed or widened by its creator's own preference, as an album created directly in the shared library
does, unless it was made private. It is no longer marked as machine-generated, so the
organizer will not rewrite it later.

| Flag                   | What it does                                                              |
| ---------------------- | ------------------------------------------------------------------------- |
| `--name <title>`       | the new album's title; its path is made from it                           |
| `--to <dir>`           | where the new album is made (default `/archive/albums`)                   |
| `--into <album>`       | file into an album that is there instead                                  |
| `--share private`      | the new album is yours alone; `default` shares it as your new albums are  |
| `--except <file>`      | that member stays in its group, which is then pinned (repeatable)         |
| `--expect <memberKey>` | file each group only while its member key is this one, in group order     |
| `--dry-run`            | say which album, how many files, and which groups changed; change nothing |

**`staging accept <group>...`** (at most 20; 50 with `--dry-run`) applies each group's
proposal, as the page shows it, each group its own decision: into the album proposed, or a
new album under the group's name. A proposal less sure than `--confidence` (`medium` by
default; `high` takes only the sure ones) is left alone, and said; `--dry-run` lists the
plan.

## Discarding

**X** discards the open group's photos: `staging discard <group> --expect <key>`. They first
leave every suggested group of the category (one left empty is deleted), then go to your trash
as one batch — one row on the Trash page — of at most 2,000 entries; more make several, all
of one decision. `staging discard` also takes staged files and folders, which is what the
**Files** tab's **Discard…** runs, and `--except <file>` keeps a member of a group back.
Nothing in staging is deleted outright: **Undo**, or **Restore** on the Trash page, brings
it back.

## Duplicate findings

Every staged photo, video and recording carries a **finding** (`duplicate`), recorded when its
metadata is read: either a mark that it is checked and is no copy, or that it is an **exact
copy** (the same bytes) of another file, named by id. A copy of a library photo you can open is
a copy of that one (`library`); otherwise, among identical files in your staging area, the
oldest (smallest id) is the original and the others its copies (`inbox`). Copies elsewhere — in
another person's staging, or in a library album you cannot open — do not count.

Findings stay true as files come and go:

- filing a file (promote, accept, `album add`) takes its finding off, and its copies still in
  staging become copies of the library file;
- discarding one takes it out of your findings while it is in the trash, and when it was the
  original, the next of its copies becomes the original; restoring it brings its finding back;
- moving files or folders into staging from elsewhere, or into the library, has them checked
  again; moving them between your categories does not, as a finding is about your staging
  area, not a category.

**`staging duplicates --repair [--user U | --all]`** checks each finding against where its file
is now and fixes what a move made outside staging left wrong; the organizer's service runs it for
everyone every hour. **`staging duplicates --refresh [<folder>] [--user U]`** has every staged media file
whose finding is missing or stale checked again (`--force`: every one), 5,000 a call
(`--limit`, `--cursor` to go on); `--dry-run` counts them. Before uploading, a client can ask
**`duplicates --checksum <sha256>...`** which photos with those checksums you already have in
the library or in your staging area, and skip them. `staging status` counts each category's
copies by where their originals are (`copies`), and its look-alikes by where what they look like
is (`near`); the **Duplicates** tab lists them.

### Near duplicates

A photo or video that is no exact copy may still be the **same picture in other bytes**: a
smaller version a phone app or a cloud service saved, a re-save as another format, a mild crop.
A recording may be the same sound re-encoded. Once its fingerprint is made
(`compute-fingerprint`, a moment after its metadata, which compares it in the same step) it is
compared with the library and the rest of your staging area — a recording with those about as
long — and its finding lists what it looks like (`near`, each with how alike, 0–1), library
photos first in the counts. A photo filed into the library later has your staged photos that
look like it found again.

Two shots of a **burst** are not the same picture, however alike: two photos from the same
camera taken a second or more apart are two shots, and so are two of the same size taken in the
same second whose cameras recorded different fractions of it. A burst is a
[stack](auto-albums.md#model) in its group instead. A picture that looks like thirty files or more
— a dark frame, a test chart — is alike to none.

**`staging separate <file> <other>...`** says that files are not duplicates of one another: it is
kept on each staged one (`duplicateDecision`), and no later check pairs them again; `--off` takes it
back. Exact copies cannot be separated: the bytes are the same.

### An exact copy shows its original

A file that arrives as an exact copy of a photo you can open — in the library, or earlier in
your staging area — is not processed: its metadata is not read, and it gets no previews, no
faces, nothing to search it by. It costs a moment instead of minutes, which is what makes a
second copy of a large export cheap to take in. Its finding says so (`deferred`), it does not
count as still being read in `staging status` (`indexing`) or on the system dashboard's crawl, it
joins no suggested group, and **Media** leaves it out. On the **Duplicates** tab it is shown with
its original's picture and size, as it is the same picture.

When it stops being a copy of something you can open — its original discarded, removed or filed
where you cannot open it — it loses `deferred` and is processed where it is, like any new file:
at once when you discard the original in staging, within the hour (the repair) when it went some
other way. Filing the copy itself has it processed in the library. `exif-extract -f` processes a
copy anyway.

## Duplicates

The **Duplicates** tab reads the [findings](#duplicate-findings) the category's photos already
carry, so it opens at once, however large the category: no scan runs. It has four lists, each
with its count:

- **Copies of library photos** — a staged photo with the same bytes as one in the library;
- **Copies within this import** — a staged photo with the same bytes as another staged one, the
  one that arrived first being the original;
- **Like library photos** — a staged photo that is the same picture as one in the library, in
  other bytes ([Near duplicates](#near-duplicates));
- **Alike within this import** — staged photos that are the same picture as each other.

A set of look-alikes is a photo and what it looks like, with how alike they are. The library photo
is kept; between staged ones the better is: more pixels, then a better format (RAW, HEIC, TIFF or
PNG, JPEG, WebP, GIF), a surer time, a larger file, a name that is not a copy's (`(2)`, `-1`,
`copy`), and else the one that came first. Where they may be two shots — the same size, the same
camera, the same second — the set says so. A staged photo with more pixels than the library's says
so too: the library photo is still kept. **Compare** (or **C**) shows the files of a set side by
side, large, with their sizes, times and cameras; **←** and **→** move between them, **K** keeps the
one in focus, **Enter** removes the others, and for look-alikes **Not duplicates** (**X**) keeps
them apart. A look-alike's own byte copies go with it when it is removed.

Each **set** is an original and its copies, shown side by side: the file **kept** first, marked
with where it is (a library photo with its album), then each copy, with its picture size, file
size, name and time. A copy that has not been processed shows its original's picture and size:
the bytes are the same ([An exact copy shows its original](#an-exact-copy-shows-its-original)). Under them, why the kept file is kept — _it is in the library_, _it came first_,
or _you chose it_ — and what it would gain from the copies. A set is listed where its copies
are: a category's tab shows the copies in that category, and a copy in another category stays,
said under the set.

**Remove** on a set merges its copies into the kept file and puts them in your trash:

- the kept file is **filled in, never overwritten**: a description, a typed-in time or a place
  it lacks, labels it lacks, your star, the copies' comments and the people named in them, as
  `merge-duplicates` does;
- the copies leave the category's suggested groups (a staged kept file takes their place there),
  and go to the trash as one batch.

In a set within the import, and in a set of look-alikes, **Keep this one** on another staged photo keeps it instead.
A library photo is always kept, and nothing in the library is changed but filled in. **J** and
**K** move between sets, **C** compares the marked set, **Enter** removes its copies, **Z**
undoes.

**Remove all** resolves every set of the list on screen, with a bar of its progress, in calls of
at most 500 sets and 2,000 copies, each read again as it runs. It leaves alone, and says so, a
set whose original is gone or is other bytes now, and one whose kept file would gain something
you may not write; it never removes a photo that is not an exact copy, and never touches a
library photo but to fill it in. Of look-alikes it removes only smaller versions of a library
photo that are all but the same picture (a likeness of 0.95 or more: a re-encode or a downscale)
and cannot be two shots of a burst; look-alikes within the import, and any set it leaves, are
for you to look at one by one.

**In the Sort stream** the open group's photos that copy or look like others carry a badge — ⧉ for
one already in the library, 2× for one with another copy here — which opens **Compare**, and its
header a chip with how many ("⧉ 4 in library"), whose menu compares them, **keeps the library
copies** (removes the group's photos the library already has) or selects them. A group that is
mostly such copies is proposed for just that: **Enter** keeps the library copies, and the rest of
the group stays to be sorted.

Each **Remove** and each call of **Remove all** is one decision in the
[journal](#undo-and-the-journal) (`dedupe`) and one row on the Trash page. Its message has
**Undo**, as does the **Done** tab: the copies come back where they were, with their findings and
their places in their groups. What the kept file gained stays: it overwrote nothing.

| Command                                                                                            | What it does                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `staging duplicates [<category or folder>] [--exact\|--near] [--where library\|inbox] [--limit N]` | a page of sets (50, at most 200), copies before look-alikes and library ones first; `--cursor` for the next page. Without a folder, the whole staging area                                                                                                            |
| `staging duplicates <group>`                                                                       | every set of a suggested group's photos (at most 500)                                                                                                                                                                                                                 |
| `staging duplicates <file>...`                                                                     | the sets those staged files belong to, in the whole staging area (at most 200 files)                                                                                                                                                                                  |
| `staging duplicates [<category or folder>] --counts`                                               | how many copies and look-alikes, by where what they copy or look like is                                                                                                                                                                                              |
| `staging dedupe [<category, folder or group>] exact:<id>... near:<id>...`                          | resolves the sets named (a copy set by its original's id, a look-alike set by its first photo's), dropping their files in the folder or group (the inbox by default); `--keep <id>` keeps another staged file of the one set named; `--dry-run` says what it would do |
| `staging dedupe <category or folder> --apply [--exact\|--near] [--where W] [--limit N]`            | resolves the sets that need no look, at most 500 sets and N files (2,000) a call; call again with `--cursor` while `more` is true                                                                                                                                     |
| `staging separate <file> <other>... [--off]`                                                       | the files are not duplicates of one another (`--off`: they may be again)                                                                                                                                                                                              |

A dedupe works in one category, and only the owner of the staging area runs it: the copies go
to the trash of whoever runs it.

## Undo and the journal

Every decision that takes staged files out of a category — `staging promote` (and
`accept`), `staging discard`, `staging dedupe`, and `album add` of staged files — every
change of the groups (`split`, `regroup`, `merge`, `delete`, `rename`, `pin`), and every
**not this album** (`staging reject`) is one **journal entry**,
`/home/<user>/staging/journal/<id>`: a small file only you can read, written before the
decision changes anything, that says what was decided (when, in which category, how many
files, into which album, which groups) and holds the plan that undoes it. Entries are never
deleted; a decision that stopped part-way is marked **in part**, and undoes what it did.

**`staging undo <entry>...`** (at most 20) undoes decisions, newest first, after a reload
as before one:

- filed files move back to where they were staged, with their own sharing, wherever they
  have not moved since — one that has stays where it is, and is reported;
- a promoted group's album goes back to being the group, with its id, its name and its
  members; an album the decision made is deleted once nothing is left in it;
- discarded files come back out of the trash, as long as their batch is still there, and their
  duplicate findings are decided again at once;
- the groups the files left get them back; one the decision emptied is made again under its
  own name (with a new id);
- a change of the groups gives each group it changed its files, name and pin back, and its
  kept edit no longer applies: the next organizer run does not make it again;
- a "not this album" gives the group its candidates back, and the other groups made mostly of
  its photos are weighed again with the album among their candidates.

Undo never pins a group: each group's member key is put right for the members it gets back,
so the organizer treats it as before. An entry undone once is refused a second time.

**`staging journal [<category>]`** lists entries, newest first, 50 a page (`--limit`, at
most 200; `--cursor` for the next page; `--action promote|file|discard|dedupe|edit|reject`), each
change of the groups with the edit it keeps (`edit`), each rejection with the album and photos
it names (`reject`), and the totals of files filed and
discarded (copies removed count as discarded) and not undone — what **Done** shows, and what
`staging status` counts per category as `decided`.

## Adding a file to an album

A staged file added to an album outside staging — from a candidate or **Add to album…** in the
**Sort** tab, or with **Add to album** on the **Files** tab (`album add <album> <file...>`, with
`--create --name <title>` for a new album) — moves there, as one journal entry per
category it came from, which the message's **Undo** and the **Done** tab undo: into the album's `files/` directory when it has one. Left in the inbox
and linked, it would be a link nobody else can follow. It first takes the
album's group, mode and access list (`share-set --reference`), so it is shared
as the album is and stays yours; it leaves the suggested albums here that held
it; and every other link to it follows it to its new path. An album you cannot
add to is refused before any of that, with the files left as they were. A file
that already lives in the library is linked instead, as from anywhere else. A
staged file added to one of your own suggested albums is linked too, as their
members are.

Staging will not automatically add a file to a curated album, delete a shared
library file, or bulk-discard a perceptual match.

## Over SFTP

New photos you have not sorted yet go into your staging area, in a category: a
folder under `/home/<you>/staging/files/`. `inbox` is always there; a category
of your own, such as one for a box of scanned prints, is made on the Staging
page (**New category**) or with `staging category box-3 --create --kind scans`;
the page's **Import media** dialog shows the folder to copy into, with a button
that copies its path. Copy whole folders into a category, keeping their names,
and they wait there, seen only by you. A folder directly in the category is a batch, as an
upload's `upload-YYYY-MM-DD` is; the names of the folders inside a batch help grouping, so
copy a named folder into a batch folder of your own:

```
ssh -p {{ssh.port}} {{user}}@{{host}} 'mkdir -p /home/{{user}}/staging/files/inbox/from-laptop'
scp -P {{ssh.port}} -r "Summer 2020" {{user}}@{{host}}:/home/{{user}}/staging/files/inbox/from-laptop/
```

`staging status` says what each category holds and how much of it is still being
read. Put files in a category's folder rather than straight in `files/`: anything
left there is moved into `inbox/unsorted/` the next time the staging area is set
up (`staging init`). A GPX route you copy into staging joins the track of the
device that recorded it; one naming no device EiN knows waits in
`/home/<you>/staging/routes/` until you say which it was.

A zip needs no unpacking first. Copy it into a category as it is — a Google Takeout comes as
several, and they can go in one after another — and EiN expands each into the folder it was copied
to, then removes it:

```
scp -P {{ssh.port}} takeout-001.zip takeout-002.zip {{user}}@{{host}}:/home/{{user}}/staging/files/inbox/
```

The parts of one Takeout fill one tree. A zip is expanded only when the disk has room for what it
holds and a tenth more; one that does not fit, or that would put a file outside its folder, is left
as it is, and the pipeline overview says why. A file the folder already holds at the same size is
left alone, so a zip whose expansion was cut off is finished on the next attempt. One of another
size is not written over: the rest of the zip is expanded, and the zip stays. The same command
works by hand anywhere you may write, in the [shell](../../guide/shell-commands.md):

```
unzip -d /home/{{user}}/staging/files/inbox /home/{{user}}/staging/files/inbox/takeout-001.zip
```

It goes on where an earlier run stopped, and `-o` writes over the files that are there.
