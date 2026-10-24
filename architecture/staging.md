# Staging

How the archive module's staging area works: the private inbox new files land in before they join the archive.

Archive's `staging` area (the `staging` module until ein/core#442) owns a private, per-user ingest topology:

```
/home/<user>/staging/                  0700, the home's uid and gid, like every directory below
  files/<category>/<any batch tree>/…  staged files; files/ holds category directories only
  albums/<category>/<slug>             the category's suggested groups (auto-album nodes, each 0700,
                                       the user's) with softlink members
  albums/<category>/.organizer         the organizer's checkpoint: a db-tier JSON file, 0600, whose
                                       attrs hold the summary staging status shows
  journal/<ulid>                       one entry per decision: a db-tier JSON file, 0600, whose
                                       attrs.stagingJournal say what was decided and whose body
                                       is the plan that undoes it
  routes/                              GPX files waiting for the device that recorded them
```

A category is a directory under `files/`, its settings (`kind`, `label`, a default
`destinationId`, and how it is grouped, `group: {strategy, significance}`) in
`attrs.stagingCategory`; its name is its key and never changes.
`files/inbox` is the default category, of the `inbox` kind, and cannot be removed;
browser uploads land in its `upload-YYYY-MM-DD/`. Only
[`lib/staging/paths.ts`](../lib/staging/paths.ts) knows this shape
(`stagingRoots`, `parseStagedPath`, `stagedPlace`, `isStagingGroup`, `uploadPathFor`);
everything else asks it. `staging init` makes an area whole and is idempotent: the
directories, the default category, a category's settings for any other directory under
`files/`, and with every link following (`renameMany`) a loose entry of `files/` into the
default category's loose batch, a loose group of `albums/` into `albums/inbox/`, and a GPX
file waiting for a device into `routes/`. `staging status` reads an area without writing:
one aggregate within each category counts its originals (media, other files, those not
indexed yet by the file's `indexedAt`, the undated, bytes), one read of each category's
checkpoint its organizer summary, and one aggregate over the journal what was decided per
category (`decided`). `staging check` reports what
breaks the layout's rules, a group's link outside its category or to nothing among them.
`staging category <name>` reads a category, and with `--create`, `--kind`, `--label`,
`--destination`, `--no-destination`, `--strategy`, `--significance`, `--lane` or `--remove` changes it.
The bridge puts every fact about a file of a category whose `lane` is `bulk` in the bulk lane
(`stampLanes`, [`lib/staging/facts.ts`](../lib/staging/facts.ts)), reading the
category's settings at most once a minute, so the work on it runs below everything else
(Lanes (core's `docs/architecture.md`)).

The organizer (`staging organize`, [`lib/staging/organizer.ts`](../lib/staging/organizer.ts))
keeps every indexed staged medium of a category in exactly one group: an event, a trip, a seed
(a folder a person named), a scan run, or a lane — Everyday by year or month, clutter, period and
undated lanes. A full build reads the category in one `within` query a page at a time and its
signals in batched lookups by node id (`vfs.getPoints` for GPS), never a file at a time and never
a library-wide scan of points; plans with the category's strategy
([`lib/staging/strategy.ts`](../lib/staging/strategy.ts), the rules of
[`cluster.ts`](../lib/staging/cluster.ts)); pairs each planned group with a
group there already (a lane by its key, an event by its members), so paths are never renamed;
and writes only what differs, owned by the user (the home's uid and gid) however it runs. An
incremental run reads what changed since the last run from the audit trail (`vfs.audit` with
`after`, its watermark ten minutes behind), plans again only the timeline's segments, seed
folders and lanes that touches, with the same `planCategory`, and gives the groups a full build
would. Its checkpoint, `albums/<category>/.organizer`, keeps what the next run starts from and the
summary `staging status` reads. archive-bridge announces `staging.category.changed` for the
category (`lib/staging/facts.ts`) and the `staging-organize` pipeline runs it, coalesced and
held two minutes, on the `organize` worker kind; `staging organize <c> --queue` writes the
category's `albums/<c>/.request`, which the bridge announces too, so its owner can ask for a run.
The `staging-organizer` service asks for a run every 15 minutes of each category anything waits
for (`--queue --if-pending`); each user and category is on its own, and one failing does not stop
the others. A group pinned, or whose members no longer fit its `memberKey` (a hand edit), is left
alone with its members.
`auto-album-cluster <path>…` plans the same way and writes nothing: an analysis of any readable
media (`modules/archive/docs/auto-albums.md`).

Edits last: `staging split`, `regroup`, `merge`, `delete`, `rename` and `pin`
([`lib/staging/edits.ts`](../lib/staging/edits.ts)) change the groups at once
and are journaled, and split, regroup, merge and delete also keep a constraint on their entry
(`attrs.stagingEdit`: a cut, a join, an assignment or a dismissal, by file node ids) that the
organizer applies on every run until the entry is undone, read off the `staging_edit` index. The
organizer, the edit verbs and every decision that takes files out of groups
([`lib/staging/membership.ts`](../lib/staging/membership.ts)) change a
category's groups holding its in-process category lock
([`lib/staging/lock.ts`](../lib/staging/lock.ts)).

Promotion is an identity-preserving move, not an import. Every way out of staging is a
decision in [`lib/staging/decide.ts`](../lib/staging/decide.ts) —
`staging promote <group>... (--into <album> | --name <title>)`, `staging accept`,
`staging discard`, and `album add` of staged files — and is journaled by
[`lib/staging/journal.ts`](../lib/staging/journal.ts), the one writer
of `journal/`: the entry (`stagingJournal`: inbox, category, time, action, files, summary,
albums, groups, trash batches, state) is made `planned` with its whole undo plan before
the first change, and finished `done` or `partial` however the decision ends. The plan
names every file by node id with where it was staged, where it goes and its sharing
before, and every group link that leaves (`GroupSnapshot`); entries are listed by an
indexed keyset query (`staging_journal`, on inbox, category and time) and never deleted.
`staging undo` ([`lib/staging/undo.ts`](../lib/staging/undo.ts))
resolves each file by id, moves back the ones still where the decision put them (with
`renameMany`, so links follow back), restores trash batches, gives the groups their
links back with their member keys XOR-ed right — never pinned — and makes a group the
decision emptied again under its slug; then it sets `undoneAt`.

Filing goes through [`lib/staging/file.ts`](../lib/staging/file.ts)
(`planFiling`, `applyFiling`, `fileStagedMany`): an album directory the caller cannot
write into is refused before anything changes, the files take its access
(`share-set --reference`) and leave their category's groups (`leaveSuggestedAlbums`, which
deletes a group left empty and gives one that lost its cover another), then one
`renameMany` moves them, each under its own name or the first free `name (2).ext`, and
re-points every other softlink at or under each of them — a relation link's `peerLink`
with it — in the same transactions. A promote with `--name` renames the first group's
node into the library as the album, so it keeps its id; its member links are then
removed, its auto-origin metadata cleared, and the default sharing (or, with
`--share private`, the owner alone) applied recursively, respecting access-pinned
descendants. A move keeps the node id and therefore all metadata and derivative
descendants. `discardStagedMany` takes files out of the groups the same way, then puts
them into trash batches of at most 2,000 whose ids it chose beforehand. `staging move`
moves staged entries to another category, out of their old category's groups first.
A group named with its member key (`--expect`) is decided only while the key is the same.
The module's `/staging` route opens on Sort, the stream of the default category's
groups with its destination column (the group's candidate albums and the highlighted one's compare
strip from `album info`), beside Duplicates, Files and Done tabs
over this command surface — each decision one command through the page's serial queue
(the kit's `useCommandQueue`), the Done tab `staging journal <category>`;
its Upload, and the Media page's, go to today's upload folder of the default
category: when files are dropped, `staging init --layout-only`, `staging status`'s
`uploadPath` (the archive's day) and `mkdir -p` make it, then the queue sends them.
