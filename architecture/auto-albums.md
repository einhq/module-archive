# Auto albums

The groups EiN suggests for what you upload to [staging](staging.md). The **organizer** puts
every indexed medium of a category into exactly one group: an event, a trip, a folder you named,
or a lane — your everyday pictures, your screenshots and saved images, and what still needs a date.
Groups are a staging feature only: the organizer reads `/home/<user>/staging/files/<category>/`
and writes only that category's groups, `/home/<user>/staging/albums/<category>/`. The shared
library under `/archive/albums` holds none; a group reaches it when you file it, and is then an
ordinary album holding its files.

## Model

A group is an **`album` node** (it reuses the album substrate, UI and softlink membership) marked
`attrs.origin = 'auto'`, at `/home/<user>/staging/albums/<category>/<slug>`, with what the
organizer knows of it in `attrs.autoAlbum`.

It belongs to the inbox's owner, whoever runs the organizer: the album, its member links and its
cover carry the home's uid and gid, and the album is mode 0700 (the links 0777, as links are). The
organizer runs as the administrator, and what it makes is still the owner's to list and edit. A
new group is written whole — node, member links and cover — in one transaction.

```
attrs.origin    = 'auto'
attrs.name      = display name
attrs.autoAlbum = { kind, key?, timeStart?, timeEnd?, precision?, folderId?, locationPath?,
                    memberKey, memberCount, shots, scores?, generatedName, nameLocked?,
                    generatedAt, generatedBy, provisional, pinned?, days?, away?, parts?,
                    dayCounts?, significance?, seed?, cover }
```

- **Members** are `softlink` children pointing at each medium's path, so nothing moves; a
  `coverPhoto` softlink names the cover (`cover` says how it was picked: the first picture with a
  face, else the earliest).
- **`memberKey`** is the XOR of the 64-bit FNV-1a hashes of the members' **node ids**, as 16 hex
  digits. Ids, not paths: `mv` re-points the links to a moved file and its id stays, so the key
  stays exact. XOR lets a member leave without the rest being read — filing a staged file XORs its
  hash out of every group it was in — and a key that disagrees with its members (a link added or
  removed by hand) keeps disagreeing by the same amount after later members leave.
- `autoAlbum.timeStart` / `timeEnd` are the group's as of the organizer's last run. The top-level
  `timeStart` / `timeEnd` / `mediaCount` the timeline orders by are `album-span`'s, from the members,
  like any album's.
- **Bursts stack inside a group.** A group is an album like any other to `media-album`, so
  `album-stack` folds its consecutive similar photos (SSCD cosine 0.75, within ten seconds) into
  stacks in its own `mediaStacks`, refreshed as members join, leave or get their fingerprints: the
  Sort stream shows a burst as one tile with its count. A burst is not a duplicate — its shots
  are kept apart by when they were taken — so it is a stack to look
  through, never a set to resolve; the same picture twice in other bytes is a look-alike, and its
  tile carries a badge.
- `album list` gives each group's row with, under `staging`, its `memberKey`, `kind`, `precision`,
  `shots` and `significance`; `album info <path>…` reads up to 50 at once. The row's own `kind` is
  `trip` or nothing, as the albums grid knows them.

Curated albums (no `origin`) are never modified.

## Kinds and lanes

| kind      | what it is                                                                                       | lane on the Sort page                   |
| --------- | ------------------------------------------------------------------------------------------------ | --------------------------------------- |
| `event`   | a happening on the timeline worth a group of its own                                             | To sort                                 |
| `trip`    | a run of two or more days away from home                                                         | To sort                                 |
| `seed`    | a folder you named (`…/upload-2026-10-01/Lake weekend/`), or one an export titled                | To sort                                 |
| `folder`  | a run of scans in one folder, in file-name order                                                 | To sort                                 |
| `loose`   | the Everyday lane of a year (or month); with `precision`, pictures dated only to a year or month | Everyday; Needs a date with `precision` |
| `clutter` | screenshots and images saved from messages, by year                                              | Clutter                                 |
| `undated` | pictures with no capture time, per folder                                                        | Needs a date                            |

A lane is found again on every run by its **key**: `loose:2014`, `loose:2014-06`,
`clutter:2019`, `clutter:undated`, `period:1975:<folder id>`, `undated:<folder id>`,
`seed:<folder id>`, and in a category grouped by month `none:<folder id>:2019-03`. A year's
Everyday or clutter lane switches to monthly lanes, once and for good, when it has held more than
400 items; a month over 1,000 is chunked at day boundaries (`#2`, `#3`). Lane names: `Everyday ·
2014`, `Screenshots and saved images · 2019`, `1987 · <folder>`, `Undated · <folder>`.

A lane is no album of its own. On the Sort page an Everyday lane whose days were matched to
library albums proposes filing those days, each into its album; clutter proposes discarding; else
a lane's proposal is the category's destination when you may file into it, else none. It is not
split, merged or deleted; a picture leaves it by `staging regroup`.

## The strategy

Each category's settings say how its files are grouped (`stagingCategory.group`, set with
`staging category <name> --strategy S --significance P`; every kind's default significance is
`normal`):

| strategy  | for                                          | each medium goes to the first that claims it                  |
| --------- | -------------------------------------------- | ------------------------------------------------------------- |
| `events`  | inbox, Google Photos, phone, camera, generic | a seed, clutter, the timeline, a period lane, an undated lane |
| `folders` | scans                                        | a run of its folder: capture time never groups scans          |
| `none`    | messaging, screenshots                       | a lane per folder and month, a period lane, an undated lane   |

- **Clutter** is decided per item from its name, folders, type and size, and never stored: a
  `Screenshot…`/`Skärmavbild…` name or a `Screenshots` folder; a PNG or WebP of a phone's screen size
  with no camera and no GPS time; `IMG-…-WA…`, `FB_IMG_…`, `received_…`, `signal-…` names, or a
  WhatsApp, Telegram, Messenger or Signal folder.
- **Seeds**: a folder below a batch folder (two or more levels under the category), holding at
  least three media, whose name a person gave it — not `DCIM`, `100CANON`, a year, a date, an
  `upload-…` batch, `Takeout` and the like — or a folder an export titled. Its media are held out of
  the timeline. Batch folders (`upload-2026-10-01`, `old-scans`) are never seeds.
- **Period and undated lanes**: a medium dated only to a year or a month (`takenAt` `1975`,
  `1975-06`) goes to a period lane per value and folder, and one with no time to an undated lane
  per folder. Neither is ever placed at an instant: `1975` is not 31 Dec 1974 anywhere.
- **Scan runs** split where the file-name stem changes, the counter jumps by more than 20, two
  neighbours carry dates set by hand in different years, or a person cut; a run above 300 splits at
  its largest jump, and one of fewer than three joins the run before it.

## The timeline: boundaries, stays and days

Media in `(time, id)` order; three rules decide every boundary between neighbours:

1. **A time gap over 4 h always cuts.**
2. **A pause long for its neighbourhood cuts** (the adaptive cut): at least 20 minutes, and 17
   times the geometric mean of the gaps within ten either side of it, up to the nearest gap over
   4 h, which is a cut already.
3. **Everything else cuts only on a low boundary score** — the weighted `combineScores` over the
   time gap, the distance and the people in frame, below 0.5. Distance is evidence, not a verdict:
   the same faces a minute later is stronger evidence the other way. Four guards keep bad
   coordinates from deciding anything: windows, not points; a move confirmed by two media; a
   plausible speed (under 1,000 km/h); and one-way — a phone flickering between a good fix and a
   stale one is noise.

A person's edits come first: a cut always cuts, a joined run is never cut. A cut across a pause of
more than two days changes nothing: there is a boundary there already.

Those rules give _parts_ — a morning, an afternoon. They are rolled up:

- **A stay**: consecutive parts further than 30 km from home and at most 48 h apart are one
  album; a GPS-less part between two away parts joins it. Two or more days of it are a `trip`. A
  stay over 21 local days splits at its longest pause, until every piece fits.
- **A day**: at home, one local day is one album, unless the casts share less than a fifth _and_
  each part was at its own place more than 2 km apart.
- **Days at home together**: consecutive days at home (or of unknown place) are joined when the
  night between is at most 36 h, the run stays within 4 days, and they share something — the same
  guest on both; both at one place 5 km or more from home and within 2 km of each other (a
  cottage); two days of one holiday (Christmas Eve, Christmas Day and Boxing Day; New Year's Eve
  and Day; Midsummer Eve and Day; Easter Saturday and Sunday); or both significant on their own
  and not apart. The household alone never joins days.

**Home** is decided per year: `--home` (the analysis only), else the owner's residence covering
most of that year (`/etc/users/<user>/person` and that person's `homes/`), else the densest 0.05°
cell holding a quarter of the category's own points that year, else the year before's. Without
one, nothing that year is away. Nothing here reads beyond the category and the owner's own records.

## Significance

An event or trip is a group of its own when the first of these holds; its `significance.reason`
says which:

1. `trip` — away, two or more days;
2. `away` — away, with at least three shots;
3. `size` — shots ≥ max(floor, mult × the year's usual day);
4. `merged` — days at home joined, with at least `floor` shots;
5. `place` — at a named location or point of interest that is not home, with at least `floor` shots;
6. `occasion` — a holiday, or the birthday of someone in its pictures, with at least three shots;
7. `guests` — at least three pictures of guests: people outside the household in at most 0.5% of
   the library's faces;
8. `edited` — bounded or made by a person's edit;
9. `seed` — a folder a person named.

**Shots** count members a few seconds apart from one camera once. **The year's usual day** is the
median of the shots of each photographed day of the category that year, rounded down to 1, 2, 3, 4,
6, 8, 12, 16, 24, 32, 48 or 64. The presets: `fewer` (mult 3, floor 5), `normal` (2, 4), `more`
(1.5, 3). A planned event at least 80% of whose members a person dismissed is not a group.
Everything else goes to its year's Everyday lane.

## Names and covers

A name is `<what> · <where> · <when>`, each part only when known:

- **what**: a seed's or a scan run's label; an occasion (`Christmas Eve`, `Midsummer`, `Easter`,
  `<Name>'s birthday`); at home, `With <A> and <B>`, the two rarest guests seen in at least 30% of
  the pictures; when nothing else names it, the weekday and part of the day of a single day
  whose pictures all fall in one part (`Saturday evening`: morning from 5, afternoon from 12,
  evening from 17), or `Weekend` for a Saturday and Sunday with or without the Friday;
- **where**: the location most of its members' `location` links name, else the nearest location
  within 500 m — only one the owner can open; else a point of interest shared by half the located
  members; away, the city half of them were in, else the country;
- **when**: the dates at the precision the members have — `3 Aug 2014`, `3–9 Aug 2014`, `Jun
  1975`, `1975`.

The cover is the first picture with a face, else the earliest picture. A group is `provisional`
while more than a tenth of its pictures wait for face detection (`facesAt`).

## Edits last

A person's edits are journal entries ([staging.md](staging.md)), and those that change grouping
keep a constraint, `attrs.stagingEdit`, which the organizer applies on every run until the entry is
undone (`staging undo` sets its `undoneAt`):

| verb                         | at once                                     | from then on                                                                                 |
| ---------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `split <g> --at <file>`      | the file and those after it are a new group | `cut`: a boundary before the file                                                            |
| `regroup <g> <file>…`        | the files move into `g`                     | `assign`: they go with `g`'s members                                                         |
| `regroup --new <file>…`      | the files are a new group                   | `join` bounded both sides, when nothing else is dated between them; else the group is pinned |
| `merge <keep> <other>…`      | the others' members move into `keep`        | `join`, when nothing else is dated between them; else `keep` is pinned                       |
| `delete <g>` ("not a group") | its members go to their lanes               | `dismiss`: no group of mostly them is one                                                    |
| `rename <g> <name>`          | its name, and `nameLocked`                  | the name stays; the members stay the organizer's                                             |
| `pin <g> [--off]`            | `pinned`                                    | the group and its members are left alone                                                     |

A split of a seed pins both pieces. Edits refer to files by node id, so a file moved within the
category keeps its edits; an edit whose files have all left does nothing. The constraints are read
off the `staging_edit` index (`stagingJournal.inbox`, `.category`, `.at`, for entries with a
`stagingEdit.op`).

A group whose members no longer fit its `memberKey` was edited by hand: the organizer pins it. A
pinned group keeps its members, which are left out of planning; its name and attrs stay. A member
link whose file was deleted has no id to check, so such a group is judged by its link count.

Every verb, every decision that takes files out of groups, and the organizer change a category's
groups holding its **category lock** (`@archive/staging/lock`), one promise chain per directory
of groups in the process, so an edit made while the organizer runs waits for it.

## The organizer

`staging organize [--user U | --all] [<category>…] [--full] [--dry-run]` plans a category's
groups: in full on its first run, when the category's grouping settings change, when asked
(`--full`), a week after its last full build, when more than a fifth of it changed, when its groups
are not as the last run left them, and for a caller who may not read the audit trail; else
incrementally, only what changed since the last run. The pipeline runs it as an administrator,
for a category named by path (`staging organize /home/<user>/staging/files/<category>`).

A **full build**:

1. **Reads**, holding the lock: the category's files in one `within` query a page of 1,000 at a
   time; their folders, signals (GPS through `getPoints`, people from regions and `people/` tags,
   location links) and geocodes in batched lookups by id; the existing groups and their links; the
   live edits; the owner's homes, household, locations, and each person's share of the library's
   faces (one aggregate over the `person` index). No read is made per file.
2. **Plans** the media no pinned group holds (`@archive/staging/strategy`).
3. **Pairs** each planned group with one there already: a lane or a seed by its key; an event,
   trip or run by its members (the same key, else at least half in common, best first). A paired
   group keeps its path, a person's name and its other attrs; slugs are never renamed. A new group
   gets a slug from its first local day (`2019-05-11`), its lane (`2014-loose`, `2019-06-clutter`,
   `undated-<folder>`, `1975-period-<folder>`), its seed (`seed-<label>`) or its run
   (`folder-<label>`).
4. **Writes** only what differs: groups no plan claimed deleted (links first), stale links
   unlinked, attrs rewritten in one `updateEach`, new links and new groups each one `createTree`.
5. **Checkpoints** `albums/<category>/.organizer`, a db-tier JSON file of the owner's, 0600: its
   attrs (`stagingOrganizer`) hold the `OrganizerSummary` that `staging status` shows (`lastRunAt`,
   `lastFullAt`, `mode`, `groups`, `members`, `pending`, `byKind`, `error`); its body what the next
   run starts from: the timeline's segments and each day's shots, the seeds, each pinned group's
   members, the lanes split into months, the live edits planned with, each year's home, and where
   the audit trail was read to.

An **incremental run** gives the groups a full build would, planning only the parts a change
touches:

1. **What changed**: the category's audit trail (`audit --after`, files, folders, positions, face
   regions and tag links, oldest first) from the checkpoint's watermark; the writes others made to
   its groups since the organizer's own last (a pin, a link made by hand, a verb); and the edits
   made or undone. A record of a file's child (its `position`, `regions/`, `people/`, `location`,
   `sidecar`) stands for the file; a folder moved in, out or within, for every file in it.
2. **What that touches, until it is closed**. The timeline falls into **segments**, runs of media
   no pause of more than two days breaks, joined where they share a local day or a person joined
   across one; no rule looks across a segment's edge, so a segment planned alone is planned as in
   the whole, given each year's usual day, which the checkpoint keeps per day. A run plans again
   every segment holding an instant a changed file was or is at (its old one from the trail), the
   seed folders and lanes the changed files were or are in (a lane with the members it keeps), the
   groups that held them (an event's every member), every file an edit puts with one of them, and,
   when a year's usual day moves, every segment of that year.
3. **Plans** those parts with `planCategory`, told what the rest says: which folders are seeds,
   the other days' shots, and which lane members stay as they are (`PlanContext.seedFolders`,
   `dayShots`, `lanes`).
4. **Pairs and writes** as a full build does, among the groups the parts held; a group among those
   holding a file the run did not plan means the groups are not as left, and a full build runs.
5. **Checkpoints** the segments, days, seeds and pinned groups it changed, and the watermark.

The **watermark** lags: it moves to the newest record read that is ten minutes old, never past ten
minutes before the run began, and the records after it already applied are kept, so a write whose
transaction commits after a later one, its id older, is still read; it moves only once the run has
written everything. A dry run moves nothing. Writes to the groups are read from the moment after
the organizer's own last write; a verb makes its writes holding the lock, so none is missed.

What comes from outside the category — the owner's household, each person's share of the
library's faces, people's names, the named places — is read by each run for the parts it plans,
so a part planned before such a change keeps what it was planned with until it is planned again;
each year's home stays as the last full build found it (one found from the category's own GPS
needs the whole year's), and a year new since then takes the owner's residence or the year
before's. The weekly full build reads everything again: `--full --dry-run` then finds nothing to
change but what those inputs changed.

More than 2,000 files changed within ten minutes of the last run, with no run asked for, wait for
the next (`skipped: 'deferred'`), so an upload is planned in a few runs, not one per minute.

The answer (`StagingOrganizeReport`) gives per category whether it ran in full and why, the media
it planned (`items`), those still indexing (`pending`), how many of the planned ended in a group
(`covered` — all of them), what happened to each group planned, the category's groups by kind, how
many of those planned are named by their dates alone (`bareDates`), the records read, the
segments planned again (`windows`), the watermark, and the groups matched after. With `--dry-run`
it plans and writes nothing. A category that fails is reported, and the others still run.

After a run, with the lock let go, the groups it wrote are matched (see [Matching](#matching)),
with those around the days of library albums whose profiles changed since its last.

### The pipeline, asking for a run, and the service

archive-bridge announces `staging.category.changed` for a category's directory when a file in it
is created, deleted or moved, or updated in what grouping reads (its capture time, its reading,
its faces, its camera, its type), when one gets a GPS fix, and when a folder moves in, out or
within; nothing under `albums/` but a request, so the organizer's own writes start no run. The
`staging-organize` pipeline runs `staging organize <category>` on the `media` pool's `organize`
kind (one slot, reserved, priority 15), held two minutes so an upload's facts arrive first, and a
fact landing while it runs folds into one further run. The fact names the category, which is in no
lane: a bulk category's runs never wait behind its own indexing.

**Group now**: `staging organize <category> --queue` writes the category's request,
`albums/<category>/.request` (a db-tier node of the owner's, 0600, `stagingRequest: {at}`), which
the bridge turns into the fact. Anyone who may write in the category's directory of groups — its
owner — may ask, without reading the trail. A run asked for is never deferred. Changing a
category's grouping settings (`staging category <c> --strategy|--significance`) asks for one.

`staging-organizer` is the safety net, every 15 minutes: `staging organize --all --queue
--if-pending` asks for a run of each category something waits for — records in its trail the last
run did not apply (a face named, a geocode, a tag: writes the bridge does not announce), writes to
its groups by others, edits made or undone, a category never organized or whose settings changed,
or a week since its last full build — then `staging match --all --stale`. Hourly it also runs
`staging init --all --idle-minutes 360` and `staging duplicates --repair --all`
([staging.md](staging.md)). The hourly album sweeps of `album-metadata` leave suggestions out:
`media-album` follows each change the organizer makes.

## Analysis

`auto-album-cluster <path>…` shows how the organizer would group the media at and under the paths
— directories, albums (their members) or files — and writes nothing: the groups it proposes, the
home of each year, the media read, undated, geotagged and with people. It takes the strategy and
significance of the category the paths lie in, or `--strategy` and `--significance`; `--user` for
whose home and household count, `--home lat,lng|<location>`, and `--members` for each group's
member paths. No edits and no pins apply.

`auto-album-assign` scores a file or subtree against existing albums by time, location and
recognised people, and only reports; `album add` puts a file in the album picked.

## Matching

Where a group goes is weighed against the library's albums, each summarised by its **profile**
(`album-profile`, see [media-ingestion.md](media-ingestion.md)): its capture instants and days, the
0.01° cells and locations its photos were taken at, the people in them, and up to four of its
pictures that stand for how it looks (by embedding id). The profiles are held in the process,
indexed by day, person, cell, location and prototype; they are loaded whole once an hour and
brought up to date on each use by one query for those computed since.

**Candidates**, at most 30 for a group, in this order: albums holding a library copy of one of
its photos; albums with a day within two days of the group's (three for a trip), nearest first;
albums whose prototypes stand out among the nearest to the group's representative pictures (up
to three, the members nearest the centres of a short k-means over at most 200 of its vectors);
albums holding its rarest people; albums sharing a place with it that few albums share; albums
whose title matches a seed's label. An album the group's owner cannot read is never a candidate.

**Evidence**, each in [0, 1] and absent where either side lacks what it needs:

| Evidence    | What it is                                                                                                                                   |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `time`      | the mean over up to 200 dated photos of exp(−Δ/τ), Δ to the album's nearest instant; τ 3 h, 12 h or 24 h for an album of 1, ≤ 7 or more days |
| `place`     | the share of the group's located photos, weighted by how rare the place is, taken in an album's cell (or one next to it) or location         |
| `people`    | the share of the group's people, weighted by how rare each is among the albums, the album has: containment, not overlap                      |
| `visual`    | how far the album's prototypes stand above the field of the 21 nearest, for each representative, averaged; none without a spread             |
| `duplicate` | the share of the group's photos with an exact copy in the album                                                                              |
| `text`      | how well a seed's label matches the album's title                                                                                            |
| `breadth`   | how many years the album's days span, of ten: 0 for a day, 1 for a decade or more (what the album is, whatever the group)                    |
| `unsorted`  | 1 when the album's title says it holds whatever was left over (`Unsorted`, `Misc`, `Camera roll`, `Osorterat`)                               |

Each candidate gets a logit z = b + Σ wᵢ·eᵢ over the evidence present, so evidence that is
missing neither raises nor lowers it; breadth and an unsorted name count against an album. The
candidates and a **new album** are one choice: album i is e^zᵢ / (1 + Σ e^zⱼ) likely, and a new
album what is left, so two albums that fit equally well share the probability. The bias and
weights (`@archive/staging/model`) are fitted on albums people made, held out with
`auto-album-assign --holdout`: one set for a group whose pictures were compared, one for a group
with no picture vectors. A candidate with no evidence of time, place, people or copies is ranked
after every one that has some, and is never proposed. Each candidate's **margin** is how far it is
ahead of the next. An existing album is proposed when the best is at least even odds and 0.1
ahead; it is then likely, and sure from 0.85 and 0.25 ahead.

`staging match [<group>…]` weighs groups and keeps the best three candidates, with up to four
reasons each in words that name no one, on the group as `stagingMatches`, stamped with the
member key it was weighed for: once the organizer changes the group, its matches are as absent.
An Everyday lane is weighed a day at a time, on time, place and people, and keeps its days at
least even odds for an album (`stagingMatches.days`); clutter, undated and period lanes are not
weighed. A promote that makes a new album profiles it at once and weighs the category's groups
around its days again (`rematchAround`); the organizer weighs the groups it writes, and those
around the days whose profile changed since it last did (`groupsChangedSince`). What is
weighed is what the one running it may read; the albums offered are those the owner may read,
marked `writable` when they may file into them.

**Not this album** (`staging reject <group> <album>`) is a journal entry (`stagingReject`) naming
the album and the group's members by id. The album leaves that group's stored candidates at once,
and is never a candidate of a group of the category at least half of whose members it names,
until the entry is undone; undoing gives the group its candidates back, and takes the matches of
the other groups holding those members, so they are weighed again with the album among them.
Nothing is ever filed by a match. A promote's journal entry keeps the matches the group had when
the person chose, and what they chose (`stagingMatchDecision`), for calibration.

`auto-album-assign <path>… [--per group|file|set] [--root <dir>] [--top N] [--holdout]
[--evidence]` weighs any media the same way and writes nothing: each path as one subject, each
file, or all of it at once. `--holdout` weighs the albums holding the subjects' media as if those
media were not in them, their profiles built again in memory: how matching is measured against
albums people made.

The code: `@archive/staging/match` (the index, candidates, evidence, `matchGroups`),
`@archive/staging/model` (the constants), `@archive/staging/reject` and `@archive/staging/rows`
(a group's matches as the pages read them); the profiles are `@archive/media/album-profile`'s.

## Library

All are private to staging, which owns its groups.

- `@archive/staging/organizer` — the full build and the incremental run, the checkpoint and its
  summary, asking for a run, the readers the analysis shares, and putting dismissed members into
  their lanes.
- `@archive/staging/facts` — the bridge's staging facts, `staging.category.changed` among them.
- `@archive/staging/strategy` — `planCategory`, the claim order, clutter, seeds, scan runs, lanes,
  significance and edits.
- `@archive/staging/cluster` — boundaries (`clusterMedia`), stays and days (`rollupClusters`),
  `mergeHomeDays`, `shotsOf`, `baselineOf`, `usualLocation`.
- `@archive/staging/naming` — names, dates at their precision, holidays (Easter computed), lanes.
- `@archive/staging/edits` — the grouping verbs.
- `@archive/staging/membership` — which groups hold which files, and taking files out of them.
- `@archive/staging/lock` — the category lock.
- `@archive/staging/auto-album` — the node shape, member keys, `isUserEdited`, `isNameLocked`.
- `@archive/staging/signals`, `@archive/staging/home`, `@archive/staging/scoring` — the batched
  reader, the home ladder, the per-signal similarities.

The commands' JSON answers are typed in `@archive/staging/api`, which the module exports and the UI
imports.
