# Explore: four ways of asking one question

The archive module's pages for finding things: Search, Timeline, Map and Media, the lightbox, albums and the staging page.

`Search`, `Timeline`, `Map` and `Media` are the same faceted query pointed at different axes.
**Search** finds the things that _hold_ media — albums, people, locations, devices, tracks — and
**Media** finds the files themselves; **Timeline** asks it of when and **Map** of where. Splitting
Search and Media is what lets each have controls that suit it, rather than one page whose filters are
half-irrelevant whatever you came for.
With nothing asked, Search is a landing rather than a search for everything (`SearchLanding`): the
reader's recent searches — kept per browser under `ein.search.recent` (`lib/recent-searches.ts`),
each its URL parameters and a label made from the box's text, years and kinds once the answer is
in — then the `search.explore` panels, each a module route that reads its own command into an
`ExploreSection` (a titled row with "See all"). An `ExploreRow` shows, with a mouse, only the items
that fit whole, and on a touch screen is swiped sideways, with no scrollbar. Archive gives four: the
most pictured people (`person-list --sort count --min 1`) as faces, the mapped locations with the
most pictures as small maps (`location-list`), every year with something in it (`timeline-facets`),
and every label, the most used first, then the vocabulary's words that pictures look like but nothing
carries yet (`label-model list`), then a few words a picture search understands without labels. A
label or a suggested word opens Search asking for it, which finds the albums that carry it or hold a
picture that does; there is no page of labels of its own.
On Search a person, a location or a year finds the albums holding matching pictures (see the timeless
kinds in `media-ingestion.md`). Every page with the box — Search, Media, Year, Map — puts what it was
understood to mean behind an info icon beside it (`components/Search/InterpretedFilter.tsx`), shown
only while there is a filter and never below `sm`, where the box has no room to spare; a page's
own controls (kind, order, year) are left out of it.

All four share one box. **`components/Search/SearchInput.tsx`** is a plain Mantine `TextInput` whose
value may contain `@Label` runs, with the entities those runs resolved to held beside it. Typing `@`
opens a completion list backed by one `search --kind person,location,album,device,track` per settled
keystroke — affordable only because providers declare their kinds and the fan-out is narrowed to
them. Committing splits text from mentions and turns the mentions into filters.

Completion is backed by `completion-entity` (core's `src/managers/exec/commands/completion/completion-entity.ts`),
not by `search`. It began as a search per keystroke, which is the honest way to write it and
unusable: **4 s warm in production and over two minutes cold**, because a text search discovers providers,
spawns a subshell each, and `search-album` embeds the prefix through the media service on the
way. A completion wants names, not semantics — so this is one command, no subshells, no embeddings,
one indexed `vfs.query` per kind in parallel (`children` would pay a link-count join per row, which
is most of what makes listing 929 people cost a second).

It scores names only, and word-prefix above substring, because typing `ander` should offer
"Anna B Andersson-Berg" ahead of a name that merely contains the letters. Several words count as a
prefix when each starts a word of the name in order, words skipped between them: `anna andersson`
finds "Anna B Andersson-Berg" as surely as `anna b` does. Results are interleaved across kinds so one
populous kind cannot fill the list — with 3611 albums and 929 people, any common word would otherwise
return nothing but albums. That only holds between equal scores: a person whose name the words reach
by a weaker kind of match loses every place to albums named after them.

The codec is **`lib/mentions.ts`**, pure and unit-tested: `parseMentions` strips known labels
longest-first (so `@Anna Lindberg` is never eaten as `@Anna`), `filtersFromMentions` folds them into
the filter set, and `textFromFilters` is the inverse — what rebuilds `sunglasses @Anna B
Andersson-Berg` in the box when a shared link is opened. A `@run` that matches nothing stays in the
query as text and is reported, rather than being silently dropped. A rich editor was avoided
deliberately: labels contain spaces, and keeping them as ordinary text is what keeps selection, undo
and the caret behaving normally.

Explicit completion replaced the old full-schema instruct-model guess. **Search** and **Media** now
also read the words as natural language, through one hook, **`hooks/useSearchBox.ts`**: on commit
the text left after the mentions goes to `parse-search`, which asks archive's `archive-parse` (the
command `CFG_SEARCH_PARSER` names, which the chat's fast path reads requests through too) in two
passes — `--rules` for years and kinds, searched at once, then the model
for people and locations, re-applied only when it changed a filter. Whatever the box understood, an
`@` pick or a parsed name or year, leaves the box as a removable chip (**`SearchPills`**): an exact
person, a partial name (`@Anna…`, everyone whose name contains it), a location, an area, the years, a
label, a device, an album. The box keeps only the words still searched as a description, and a
new commit adds to the chips rather than replacing them. The Map and the year view keep `@`
completion alone: their filters take one person, location and label each.

Every other text field that narrows a list uses one rule, **`lib/text-match.ts`** (`matchesText`:
case and accents aside, every word in any order): the list pages' **`ListFilterInput`** (people,
albums, labels, locations, devices, tracks), the settings search, label completion, and
**`EntityPicker`** (archive's `ui/components/`), the searchable picker for a person or a location in the
relation, residence, homes, face and merge dialogs, whose options come from `personOptions`.

The **Media page** is two pages behind one filter box, both `MediaTimeline`, which takes a whole
`SearchFilters` rather than a single subject. With the box empty it is the **feed**: everything the
reader may see, newest first in day sections with the time rail, scoped **My** (`--creator`, the
reader's uid from `user-whoami`) or **All**. That scope is a per-browser preference
(`usePersistedState('media.scope')`), not URL state — a shared link keeps the viewer's own scope —
and a first visit lands on My only when a store-counted `search --creator … --facets` says the
reader has added anything. The all-kinds All feed sends no filter at all (`browseAll`): naming every
file kind would post-filter and cap the rail at the scan limit, whereas the bare timeline query is
store-counted. The kind control alone stays in the feed. Seeking with the rail lands on a page that
can be walked back up as well as down: `useSearch` keeps the server's `above` token beside the offset
the position-paged sources report, and the top sentinel spends whichever it has — ungated, unlike
the map: a seeked list has the sentinel on screen at once, so the page
above arrives immediately and the hold keeps the sought date where it landed, which is what makes
the newer pictures simply there to scroll up into (and why there is no "back to the newest" button
on the media lists). The seek answer already carries its lead, so `MediaTimeline` lands the reader
on the section at `anchorIndex` (the sought row starts its own section, via a seam) and pins it with
`holdElement` while the lead's grids take their height. `usePrependHold`
anchors on the dated section (`data-hold-anchor`) rather than a tile, because the grids virtualise
tiles and a prepend of several screens unmounts the held one in the same commit that adds the rows.
Anything the box produces switches to the **search**: relevance-ranked in one continuous grid. The
interpreted filter leaves out the kind and the order: the kind control shows one and the search is
always by relevance.
Feed and search alike show the labels their answer carries (the kit's `LabelFacets`, from the same
`search --facets` the feed's rail asks, so the feed pays nothing extra): a pill per label, with how
many carry it, that adds the label as a `--tag`. A label already asked for, or on every member, is not
offered, since it would narrow nothing. The Search page shows the same row over its entities, where
the labels mostly are: on albums.
A filter on exactly one label adds archive's `LabelSuggestions` above the results — Media draws it
itself, Search as its `search.label` panel: a bar saying how many more pictures the label's kept
model ranks as it (`label-model show`; only a word's, or one measured as learnable), which opens to those pictures and albums (`search --like
<tag directory>`, retrained first with `label-model train --if-stale`) with Label and Not actions,
the rejections the next training learns from. It is closed until asked for, except for a label
nothing carries yet, such as a suggested word from Things, where the suggestions are all there is.
The **Map's** box narrows what is drawn _inside the current viewport_. `find-within` resolves the
filters to a set of media ids once per query (`filterIds`) and every hit is then a membership test —
ids rather than paths because a clustered answer already knows the file above each hit by id, and
comparing on paths would mean resolving one per hit, which is the cost clustering exists to avoid.
A cell of several pictures is drawn as a pile: one of them (`find-within --covers` gives each cell its
first member as `cover`, one more path a cell in the batch the lone pictures already resolve), a
frame behind it and the count on a pill (`pileIcon`); a lone picture stays a thumbnail. A button in
the map's corner lists every picture in the view, in the same full-screen `MediaTimeline` dialog a
pile opens, over the viewport's box instead of the cell's.
A filtered map hides location pins too: a media filter is a statement about pictures, and leaving every
location floating over an emptied map reads as a filter that did not work.

**The timeline's row geometry is the one place Mantine is overridden in CSS**
(`theme/theme.css`, everything else lives in the theme object). The date sits in Mantine's `opposite`
slot, left of the bullet, which switches the row to a grid whose columns Mantine splits evenly — so
the date gutter is pinned narrow, and the connector line, which Mantine draws at 50% of the row, is
told where the bullet actually went. From `sm` up the entry column is a fixed width and the three
columns are centred as a group: that is the only way the block _can_ be centred, since its right edge
is ragged and narrowing the page container just slides a left-aligned block around. It also keeps
every date on one vertical line — each row is its own grid, so an auto-sized column would size itself
per row. All of it lands on a `::before`, out of reach of both the theme object and the `style` prop.

**The `/year` page is a year at a time** (`YearTimeline`), albums browsed by year, and is full-bleed like the other listing pages. Its controls sit in the
common `EntityDetailHeader`, and the year picker is one control drawn in three of its locations
(`YearPicker.tsx`): `YearStepper` — the year as a `RollingNumber` between one-year steps and jumps
to the previous or next year that holds anything — centred in the header's `top` slot; the controls
at its foot, where in the Search page's arrangement the search box fills the left and an exclusive
All / Albums / People choice and the sort sit on the right (both kept per browser); `YearHistogram`,
a faint bar per year from `timeline-facets`, in the header's `backdrop` — over the pattern and its
shade, under the title and controls, taking no input; and `YearSlider` in the header's `edge` slot,
which sits outside the header's clipped box so the slider's track can run along its bottom border
with the histogram standing on it. Slider and histogram share one track (`lib/year-scale.ts`): a
step per year that holds anything, plus the current year, the empty years between collapsed, so
the decades most of the archive is from get the room instead of the centuries before them; the
labels are a few of those years. The picker moves a
draft year that the number and the histogram follow at once; the query waits for it to rest 250 ms,
then the year goes into `?year=` (replace, not push) and `useYearTimeline` reads `timeline --year`
whole — the busiest year in production is one page. What comes back is drawn as the cards the albums and
people pages use (`YearEntryCard`: `AlbumCard`, or a person's `BrowseEntityCard` with a Born/Died
badge) in a `CardGrid`. An album is in a year when it holds media taken in it.

**The timeline scrubber is occupied-bucket proportional, not count- or calendar-linear.**
Archive's `TimelineScrubber.tsx` gives every occupied month equal reach across spans of at least a year and
labels their years. When all precise content fits inside one rolling year, every occupied day gets
equal reach and the labels become months. Empty periods collapse completely; an active month with
one item is therefore as targetable as one with a thousand, while a sparse century does not spend
most of the rail on empty decades. Partial dates keep their known precision: a year-only entry
forces year mode, and a month-only entry is a month target rather than an invented first day.
Only major years (or months in subyear mode) draw ticks; the minor occupied buckets remain
invisible landmarks. Pointer travel is continuous between every pair of landmarks: complete media
layouts and already-loaded feed ranges interpolate their real section offsets and scroll directly,
so the handle can stop among the media between two dates instead of snapping to a header. Its
released fractional position remains visible until the next independent scroll takes ownership of
the marker. Each date's slice of the rail starts at its integer position, so the rail's top pixel is
the first date and its bottom the end of the last slice; when those archive ends are loaded the
first slice is tied to the true scroll start and the last to the true bottom.
Only a held pointer reveals the tick and label layer; ordinary scrolling, hovering and
keyboard focus leave the persistent handle visually quiet. Below the `sm` breakpoint that grip grows from 20×32 px to
60×56 px inside a 64 px overlay rail. The mobile rail overlays the full-width media instead of
reserving a gutter. Only the visible handle accepts pointer input, leaving the rest of that edge
overlay click-through to the media beneath it. While dragging, the date pill and landmark labels
sit beyond the left edge of the entire rail so they remain readable and out of the touch path. The
landmarks use the same pill treatment as the active date rather than bare, low-contrast text.
When a page has content above its first dated section — its own title and filters, an album's
description or folder grid — that lead-in is scrolled through inside the first slice at the same
rate as the media after it, with no separate segment and no seam in the drag speed at the first
label. A press on the handle moves nothing; the drag begins once the pointer has travelled, and the
rail holds still under the finger until release. While the list's top edge is still on screen the
pinned rail starts there rather than at the app header, with the handle resting at its top.

Paged ranges still **re-anchor live** (`--at <date>` on the list's own command) when a drag leaves the geometry that
is currently loaded: the pixels for 1998 do not exist until 1998 is fetched. The fallback date is
calendar-interpolated between occupied landmarks, seeks are leading/trailing throttled to 125 ms,
stale responses are discarded, and an anchor-only refresh keeps the previous page visible until its
replacement lands. One pointer-event path covers mouse, pen and touch; keyboard arrows, Home and End
walk the fixed occupied landmarks.

**The media grid is justified, not a column grid.** `lib/justified-layout.ts` is a pure function
from aspect ratios and a container width to absolutely-positioned tiles: fill a row until its
height would drop below the target, scale it so the widths sum to exactly the container, leave the
last row at target height with a ragged right edge. `components/MediaGrid/` renders it and is the
single grid behind albums (hand-made and suggested alike), search and the subject timelines. A
phone (under 640px) is too narrow for the fill rule to choose well — a 3:2 frame is either one
per row or two, with nothing between — so there the grid asks for a fixed count per row
(`itemsPerRow`, `defaultItemsPerRow`): every row, the last one included, is scaled to the width,
so a lone trailing picture of a day spans the whole row. The count starts at two, and a pinch on the
grid changes it between two and five (`lib/pinch.ts`, kept as `phoneGridColumns`): spread fingers
for bigger pictures, close them for more. The grid takes two-finger gestures from the browser
(`touch-action: pan-x pan-y`), so the page's own pinch-zoom does not happen over it. A caller that
names its own row height (the chat) keeps the fill rule.

The one column grid is opt-in: the media page's **Days** and **Months** layouts pass `square`
(3 and 5), and the grid uses `squareLayout` instead — fixed columns of cropped squares, that
many across a phone and as many more as keep the squares about that size on a wider screen
(`squareColumns`), with a short last row keeping the same squares. They are overviews for
getting around, where the pictures' shapes are not the point; **Default**, by day, stays
justified. The choice is a per-browser preference (`media.layout`).

Three details carry their weight. A tile's aspect is the **display** frame — `width`/`height` on
the node are the raw raster and `angle` swaps the axes, so `displayAspect()` mirrors
`@archive/media/orientation`'s `displayDims` (duplicated, not imported: the shell imports nothing of
a module's). Files indexed before `exif-extract` promoted dimensions have
none, so the tile reports `naturalWidth/naturalHeight` back on load and the grid re-lays out —
but only when the decoded shape disagrees with the one on screen by more than 1%, because
otherwise a correctly-indexed album reflows by a pixel per row for nothing. And the container
width is measured by `useElementWidth`, which floors and drops unchanged values: a fractional
width that changes when a scrollbar appears is enough to start a relayout loop.

**The lightbox keeps its chrome off the picture.** Only close and details float over the image in
normal viewing. A compact bar below the media holds `n / total`, face pinning, capture date and time,
a named location or reverse-geocoded location, and the slideshow control. On a phone the bar keeps the
counter and location only; slideshow, face pinning and fullscreen are a ⋮ menu in the top-right corner.
There a swipe sideways walks the pictures, a swipe up pulls the details sheet with the finger, and a
swipe down closes the sheet when it is open and otherwise closes the lightbox, as Back would.
On a desktop the details panel slides in from the right as its room opens beside the picture
(`.mrx-lightbox-side`), and out again before it unmounts, when it is toggled over an open picture;
the lightbox opening with it open shows it at once, so the picture zooms in to where it stays. The pictures either side of the one shown
sit one frame away as a share of their own box rather than in pixels measured at render, so a resize
— the panel opening or closing — never leaves them peeking in.
**A video plays in the lightbox's own player** (`VideoPlayer`), not under the browser's controls: a
timeline and a bar that fade while it plays (after the mouse stops, or on a tap) and stay while it is
paused, scrubbed, pointed at or tabbed through; under the picture when the letterbox below has the
room, over its bottom edge otherwise. Pointing at the timeline, or dragging it, shows the time there
and, when the video has a storyboard sheet (`media-details`' `storyboard`), the frame: a tile of the
sheet, which is fetched once the video can play; with frames to show, a drag seeks only where it ends.
A video with cuts (`media-details`' `chapters`) has its timeline drawn in chapters, a gap between
each (a tick at each start when they are too many to draw apart), skip buttons to the previous and
next chapter (on a phone in place of ±10 s), Shift+←/→, and PageUp/PageDown on the focused timeline;
"previous" restarts the chapter after its first two seconds.
Subtitles of the transcript are drawn over the picture by the
player, with the speaker's name when the recording has more than one voice; off until the viewer turns
them on (CC, `c`), then remembered. What the browser's controls offered besides stays: a speed menu
(`<`/`>`, the video's own), a volume slider beside mute on a desktop (remembered; not where the page
cannot set it, as on an iPhone), and picture-in-picture (`p`) and casting (the Remote Playback API:
Cast or AirPlay), each shown only where the browser has it — casting only while a screen is
reported; on a phone they share one menu. The menus open inside the bar and keep the keys pressed in
them, so Escape closes the menu, not the lightbox. Space and `k` play and pause from anywhere in the
lightbox but its details; `j`/`l` skip 10 s, `m` mutes; the timeline and the volume take the arrow
keys only while a keyboard user is on them, so ←/→ stay previous and next. A tap shows and hides the controls, a swipe on the picture still
walks the album, and fullscreen is the lightbox's (an iPhone's is Safari's player, with the
subtitles as a native track). The audio player shares the transport and the keys.
The details carry a "Similar" strip (`SimilarMedia`): the first dozen of `search --like <picture>
--kind photo,video`, so without the picture itself, a copy of it or the rest of its stack, and a video by its best
keyframe; a click opens one and the lightbox then walks those pictures. Show all opens the Media page
on the same search (`/media?like=<path>`), where the other filters narrow it. Nothing shows for a
picture that cannot be compared. The Media page's picture button beside the search box asks with a
picture from the device instead: it is drawn upright and small in the browser, posted to `/tmp`, and
searched `--like` (the `like` chip shows it).
A page whose list is loaded a window at a time (the media page) sets `lightboxCountHidden`, since its
`n / total` would only count what has loaded. Slideshow preloads the next
still, holds the outgoing still until its replacement has decoded, then crossfades them and starts
the replacement's three-second dwell; audio/video advance when playback ends. It requests browser
fullscreen, applies a restrained alternating pan/zoom to stills,
expands the media across the sidebar, hides close/details/arrows/face boxes, and moves that same
information bar onto the bottom of the media. A media click or Escape stops it (and exiting browser
fullscreen does the same). If faces were pinned before starting, their names follow the moving
image without drawing the boxes. Nothing that _acts on the file_ sits over the picture in normal
viewing: rotate and mirror live in the
sidebar, downloading is what the filename links to, and the albums the file belongs to are a list
rather than a jump button. On desktop, the edit menu can explicitly enter face-editing mode. A
drag over the contained image becomes a new draft in display-frame fractions, while selecting any
existing box makes that face the draft. It can be moved or resized by its edges and corners before
floating controls add, update, discard, or remove it; removal requires a second confirming click.
For an existing face the controls also name who it is, and that button asks who it really is
(`FacePersonDialog`, over `person-detach`): someone named, someone new, or, for a detected face,
whoever recognition matches it to without the person it leaves. The existing unknown-person dialog
opens after a new face is saved, or a face is moved to someone new, for naming or merging.
One `media-details` read serves both halves and carries an uncollapsed `faces` list for the editor,
because the sidebar's `people` list intentionally remains one row per person.

`MediaSidebar` is ordered the way somebody looks for things: filename (with size and a one-line
`resolution · MP · ISO · exposure` summary) → capture time → the hand-written description, editable
in place through `file-set-description` and omitted while empty → the device with its owners and the photographer → the
albums holding it, each with its cover → the people in it with their age, **unidentified faces
included as named crops** so it is visible where in the frame they are → location and map → comments
(written under the file as their author, so the box to add one is for whoever may change the file,
as the description is; anyone else reads them) → a
collapsed "More" holding the OCR text, the content hashes, fingerprint
provenance and the lazily-fetched raw exiftool dump. The VFS path is first in More and opens the
dropdown terminal on a fresh tab whose one-shot startup command changes to the file's containing
directory. Terminal tab ids, titles, cwd, active tab, and pane open state live in a versioned
`sessionStorage` record, so a reload reconstructs each xterm and reattaches it to the retained
server shell without replaying the one-shot command. Transport state is deliberately not persisted:
a disconnect marks the tab offline and retries, while a copied browser tab is detected before
connecting and starts a fresh terminal workspace. Explicit tab closure sends a terminate
control. Raw EXIF loads with More and is not hidden behind a second accordion. Every section is
an unruled icon gutter over a content column. Empty descriptions are created from the sidebar's
permission-gated Edit menu. An unidentified crop opens its complete split/name/merge review dialog
over the lightbox; the URL-addressed unknown-people route can still resolve the same cluster even
when it falls outside the loaded pages. That overview reads `person-unknown` a page at a time
(Load more appends the next), sorted by how often the person was found (faces and the recordings
a voice is heard in together) or newest and filtered by a smallest count, both header choices kept
in the URL. A card shows one big glimpse and up to three small, the best faces first and then the voices
heard longest (`person-unknown` gives a few of each); a voice is a round button that plays its
longest turn and is a stop while it plays (`VoiceClip`, over one shared player in
`lib/clip-player.ts`: the rendition with a `#t=start,end` fragment, one clip at a time). Each card
has a "Who is this?" box (`QuickName`), at the card's foot whatever is above it: Enter names the
person (`person-name`), or, when the name is someone already named, folds them into that person
(`person-merge`), without opening the review. The review (`UnknownPersonModal`) is the same box at
its top, with a button saying which it will do, over every face and every recording the voice is
heard in (`VoiceTile`: play, the recording's name and date on hover, open in the lightbox), each
pickable; what is picked, faces and recordings together, is split off as someone new, moved to
someone, or marked not a person from a bar at the foot (`EvidenceSelectionBar`, over
`person-detach`). "Not a person" beside the name box says it of the whole cluster
(`person-discard`): everything they hold is locked and the entry goes; the overview's selection bar
does the same for the clusters ticked there, next to merging them. "Adjust group threshold", on the
faces and on the voices each, re-clusters them against each other once (`subcluster-faces`,
`subcluster-voices`) and lays them out in groups cut wherever the slider says, a group's box picking
all of it, so two people fused into one come apart with the same actions. The person page's Heard in
tab is the same tiles. Ages under one year use completed months rather than
displaying zero years. Hovering a person's row lights their box on the
image and vice versa (`faceKeyForPerson`, and `u-<faceId>` for an unnamed one).

The albums index walks compact, 1,000-entry `album list` pages, which come in the store's name
order, and sorts the whole list by title once it has every page. Each entry contains only card
metadata plus the `hasFilesDir` structural hint; full node props and child-edge arrays stay on the
server. Covers and item counts are then probed only for cards entering the viewport and cached for
the browser session.

`MediaTimeline` is the shared subject, album and directory-tree media view. People, locations and albums request one
compact `search --subject person:… --layout`, `search --subject location:… --layout` or
`search --under … --layout` index through `useSearch`, and a directory tree (`within`, the
staging Files tab) `search --within … --layout`, every picture, video and recording however deep with the undated last;
subjects group it by month, albums and trees by day. Their complete row geometry exists after that response, so scrolling neither crosses a page
boundary nor shows a pagination loader. A source over either the 20,000-entry ceiling or the 2 MiB
encoded-response budget falls back to cursor paging rather than presenting a partial index as
complete. While that first whole-source response is being built, the otherwise empty grid area
shows an indeterminate loading indicator. `MediaGrid` still
mounts only tiles in and around the viewport. Its tile window samples smoothed scroll velocity:
deliberate movement below 0.8 px/ms
updates every 60 ms, while a faster fling keeps the old window mounted and commits 150 ms after it
settles. Rows passed during fast travel therefore do not start thumbnail requests that cannot be
cancelled usefully, but slowly browsing a feed continues filling images without requiring a full
stop. Each appended page in a paged fallback is pushed into `albumMediaList` when the lightbox is
open on that list, so arrowing past the first page keeps working. Each date bucket is its own grid, so a
short bucket ends ragged instead of being stretched; the group's `startIndex` maps a tile back to
its position in the flat list, and the selection is owned above the grids so a shift-range can run
across a bucket boundary. An album that would exceed 240 day grids coarsens to months, then years
if needed. Item count therefore does not accidentally recreate thousands of observers through date
fragmentation; ordinary albums keep their more useful day headings.

**Albums, auto-albums, people, locations and the map's cluster popup all draw the same list** —
`MediaTimeline` over `search`, with the timeline's adaptive rail. The rail is sized by `search --facets`, which walks the
same ordered set a page comes from and buckets the dates (no enrichment, no path resolution, one pass
over a list the command has materialized anyway); `facets` cannot answer it, being a
corpus-wide aggregate with no subject, container or month. For paged fallbacks, seeking sets
`search --at <date>` and the answer reports the `offset` it started from. **Climbing back up is a
smaller offset, not a second direction**: the cursor is already a position in a materialized order,
so the page above is the one starting `limit` earlier, arriving in the order the list already has —
rows already loaded are dropped by path, because a post-filter can make a page reach past where it
was asked to stop. An exact-layout rail instead scrolls to the matching already-rendered date
header. The
rail runs the way its list does (an album sorted oldest-first gets its earliest date at the top),
and a drag walks only occupied months or days, so no part of it points at an empty period. The
holding-in-place machinery for paged views (`usePrependHold`) works against the window on a page
and against a column in the map's popup.

**A layout can say which files have renditions.** `search … --layout --fields derivatives` adds
`derivatives` beside the rows of the compact layout (`SearchLayoutIndex`): per row, 1 when its file
has a `thumbnails/` child and 0 while it has none, from one `getChildLinksByIds` per 1,000 files. It
is a list of its own rather than a seventeenth column of the rows because only an answer that asked
carries it; an older decoder ignores it like any field it does not know. The shell's decoder
(`lib/search-layout.ts`) sets `hasDerivatives` from it, which `mediaItemFrom` otherwise takes to be
true. A grid given `originals={false}` then draws a placeholder for a file with none and asks for
nothing, and stops its fallback chain before the original for the rest — a fresh upload's large and
often undrawable originals are never fetched by a grid of it.

**The staging page decides groups one at a time.** `/staging` (archive's `ui/staging/`) is the
overview of the reader's categories while no `?c=` names one (or the one category's page when there
is only one): a card per category with a `StackedBar` of its files from `staging status`
(`lib/overview.ts`: being prepared, to sort, needs a date, other files) and the stages of what is on
its way in (`categoryStages`, drawn by `ArrivalStages`): arriving, the uploads into it from this
browser (`uploadsUnder` its path); being prepared, `counts.indexing`; being grouped, the read media
(`counts.indexed`) no group holds yet (`organizer.members`). A file dragged over the overview raises
an `UploadDropzone` tile per category, into its upload folder of today (`uploadPath`), folders kept;
a last card opens `/staging/categories/new?kind=…`. One `useStagingStatus` reads that status for the
page and its dialogs: again when a dialog changed the area (`refreshStagingStatus`), when an upload
into it is done, and every 30 s while files are uploading into it or being prepared and the page is
visible, or ten times as long as the last read took when that is longer; between reads it measures how fast they are prepared, for the "about 2 h" a card and the
progress strip say. The category's dialogs are routes: `/staging/import` (files or a folder into a
category, or a new one made first, queued with `keepFolders` into its upload folder of today; and
the folder to copy into over SFTP), `/staging/categories/new` (a `CommandForm` over `staging category
--create`) and `/staging/categories/:slug` (label, kind, destination, remove). A category's page
switches category from its title, has the same bar and stages as a progress strip above its tabs: Sort;
Duplicates (`DuplicatesTab`), the category's exact copies read from their stored findings a page of
sets at a time (`staging duplicates <category> --where library|inbox --cursor`), the two classes
counted by `staging status` (`counts.copies`), each set a `DuplicateSetView` drawn from its members'
`previewPath` and `thumbnails`, resolved one set or a whole class at a time through the page's
serial `useCommandQueue` (`staging dedupe <category> <key>`, or `--apply` calls looped while `more`,
with progress), each answer's journal entry undone by the toast, Z or the Done tab; Done; and Files, one folder of the category at a
time (`?dir=`): its subfolders as `DirectoryCard`s
(`find -mindepth 1 -maxdepth 1 -type d`), then `MediaTimeline within` the folder with Set time for a
selection — its tiles badged as the Sort stream's, a file kept over copies the list leaves out too (`useFileDuplicates`: the tiles a grid draws, read
together a moment later with `staging duplicates <file>…`, at most 200 a call; the badge opens
`CompareDialog`) — or, as Folder (`?view=folder`), every entry of the folder (`ls -l --limit 200 --after`).
A folder, or a selection of entries, moves to a folder of this or another category (`MoveDialog`,
`mv -n`, which relinks) or goes to the trash as one batch (`DiscardDialog`, `trash put --batch
--label`). A staged file of the reader's own opened in the lightbox, from any of these, has the
sets it belongs to in its sidebar (`StagedDuplicates`, `staging duplicates <file>`): whether it is
kept or what it copies or looks like, the others as thumbnails, Compare (the same `CompareDialog`,
resolving with `staging dedupe <its category> <key> --keep`) and Not duplicates; the files dropped
leave the lists through `mediaMoved`, and the lightbox closes when its own file is one. Sort is a stream of the category's suggested albums drawn from a complete
index the page holds (`useGroupIndex`): `album list <albums dir> --limit 1000`, page after page in the
background and each shown as it lands, then kept current by one non-recursive `useNodeEvents`
subscription on the directory. A group created or updated there is read again with
`album info <paths…>` (coalesced over a second, at most 50 a call), one deleted leaves, and one whose
`staging.memberKey` changed has its pictures forgotten. The order is by start time, then name, the
undated last (`lib/stream-order.ts`); lanes by kind (`lib/lanes.ts`: events, trips, seeds and scan runs
To sort, `loose` Everyday, `loose` with a `precision` and `undated` Needs a date, `clutter` Clutter, and
what was put aside Later) make its To sort view, with a lane control and each lane's count once another
lane has groups. A group's proposal is one pure rule shared with `staging accept`
(`@archive/staging/proposal`, from the row's `staging`: its stored matches' top album as the reader
sees it, how sure, how likely a new album, an Everyday lane's matched days): a likely match, the
category's destination, a new album, an Everyday lane's matched days (`staging accept`), clutter's
discard, or none. The cursor's group and the next two have their parts and candidates read with one
`album info` (`hooks/useGroupDetails.ts`, again when a row's member key or match time changes); the
destination column lists the candidates (1–3 file into one, `,`/`.` move the highlight, R is
`staging reject <group> <album>`) and the highlighted album's `CompareStrip`, its own pictures from
the day before the group's (`search --under <album> --sort time --at <day>`, paged with `--cursor`
and `--above`, grouped by day by `lib/compare.ts`, the group's days marked); C widens the column to
half the page. A lane's day with a match shows it over its grid, with File. Each section is a `GroupSection`: closed, a two-line header and
a `MediaStrip` of two 104 px rows, 300 px in all (76 px rows and 260 px on a phone, with the main action
as a button); open — only the cursor's group — the header kept in sight under the page's headers and a
`MediaGrid` per part (`lib/part-sections.ts`): a day, or past 40 days a month whose header carries
its days as chips, the undated last; each part after the first has Split here (in a lane, every
part has New group). A decision hides its group at once and moves the cursor to the next group neither
being decided nor failed, which slides up into its place in 120 ms (at once under reduced motion),
while its command runs: Enter names the group in a dialog and runs
`staging rename` when the name was edited, then `staging promote <group> --name <name>` (the toast offers
Open album); E renames in place; M and ⇧M are `staging merge` of the group above or below, kept
under the name `lib/merge-name.ts` picks (a person's, then one with a place over bare dates, then
the larger group's); the ⋯ menu's Not a group is `staging delete`; T opens the media area's
`SetTimeAction` over the group's pictures, one `file-set-time` call per 200 (written in one
batched update each). Inside the open group, `[`/`]` put a cursor on a part; a part, a selection
or the picture under the arrows' cursor is what S (`staging split <group> --at <first>`, in a
lane `staging regroup --new`), `<`/`>` (`staging regroup <neighbour> <files…>`), G (a
`GroupPickerDialog` of the neighbours, any group by name, or `--new`) and the New group zone under
the grids act on. Each is journaled, goes through the same queue and is undone by its toast, Z or
the Done tab, whose Regrouping filter is `staging journal --action edit`. A lane's group
(Everyday, clutter, undated) is not merged, split or deleted. A selection that reaches past the open
group's pictures (a header's box, Shift-click or Shift+J/K across groups, the lasso, the Select menu's
whole lane or sure proposals) is a `groups` scope of the key table, turned into commands by
`lib/selection-command.ts`, pure: groups whole as one `staging promote`, `discard` or `accept` per 20,
`staging later` per 100, a group but for some pictures as one call with `--except`, pictures one by
one as `album add` or `staging discard` per 500; Enter first reads the plan with `staging accept
--dry-run` per 50 (`BulkConfirmDialog`, summed by destination at the confidence chosen), and a new
album is made by the first call and filed into by the rest. `hooks/useBulkRun.ts` runs such a run
through the same queue under one `notifyProgress` toast with Cancel, keeps the journal entries every
answer names, and its Undo all (Z too) runs `staging undo` over them newest first, 20 a call, or
`staging later --off` for a run of Later. Selected pictures, or a header's grip, drag
(`startMediaDrag`) onto the destination column's rows and onto other groups' headers (merge, or
`staging regroup`), each as the same command. Events for a group being decided are let pass, so what
the page did stands until the command answers; a failure brings the group back with its reason and
Retry. A cursor whose group leaves without a decision on this page (the organizer removed it, another
session decided it) goes where a decision would have sent it. The cursor is `?g=<slug>` in the URL, written once it has rested 400 ms, and kept per viewer
and category (`usePersistedState`); the reader's own suggested album's page links to it (Sort in Staging). Once
the index is complete, a stream of 30 groups or more has the archive's time rail (`TimelineScrubber`), its facets counted in groups from the index
(`lib/scrubber-facets.ts`): a date on it brings the first group from then up to the reading line, and
the stream's `onReadingLine` says which group stands there, which is where the rail's handle is.
While an open group is shown by month the rail is that group's, its facets counted in pictures
(vaguer dates as far as they are known), a date bringing its first picture from then under the
group's header and the part at that line placing the handle.

One table, `lib/triage-keys.ts`, gives the page's keydown listener its keys (J/K, Enter, 1–3, `,`/`.`,
R, C, E, M, ⇧M, T, `[`/`]` for the part cursor, the arrows for a cursor over the open group's pictures
with `gridNeighbour`, O to open one, S, `<`, `>`, G, Esc) in four scopes — group, part, tile, selection —
a sign such as `<` or `[` matched as typed whatever Shift, AltGr or Option it took, the `?`
overlay its list and the docked `ShortcutLegend` its line, each entry named for the group on screen
("New album “Lake weekend”"). The listener stands aside while the lightbox, the shell's dialog or one
of the page's own dialogs is open, for a field, a menu or a list box, and for Enter on a focused
button or link and an arrow on a focused tab, which are the control's own; it listens on the window in
the capture phase, before Mantine's own Escape there, so it still sees a dialog open that the same key
closes. The pictures of a section are asked for once it has stayed in view 150 ms, and for the cursor's
group and the next two ahead, from the kit's media sets (`lib/media-set.ts`): one
`search --under <group> --sort time --layout --fields derivatives` per group, kept in an LRU of 24 and
fetched at most 4 at a time, on a budget of its own rather than the shared queue the album covers
use. A set ahead of the cursor is given up once the cursor moves more than three groups away from
it. The grids pass `tileKeys={false}`, so a tile neither takes focus nor opens on Enter, which is the
page's, and `originals={false}`.

**The map is a view of three layers, and the URL is its only state.** `/map` draws media, locations
and tracks; archive's `ui/lib/map-params.ts` is the codec (`c`, `z`, `layers`, `from`/`to`, `base`) on the same
pattern as the search page, so a view is linkable and survives a reload — defaults are written as
absence, and only an explicit `layers=none` means a blank map. The type menu sets them as one exclusive
choice like the Search page's type (All, Media, Locations or Tracks); a link naming two layers draws
both and shows All. Media and locations come from one
`find-within` per viewport, **clustered by the server**: the page sends `--cell`, a grid size in
degrees derived from its zoom (only the client knows what a degree is worth in pixels), and gets
back one row per occupied cell — `{key, lat, lng, count}`, plus a resolved path only for a cell
holding a single picture, because that is the only one drawn as a picture. A count costs a
bounding-box scan and nothing else, so the viewport has no cap; it used to ask for a flat 400 hits,
which the registry truncated before anything was ranked, so every zoom level got a different
arbitrary few hundred and the rest flickered in and out. Clicking a count opens the pictures behind
it — the page derives the cell's own bounds from the key the server grouped it under. Clicking never
zooms: the map's own controls do that, and guessing which of the two a click meant got it wrong
either way.

**That popup is the album's timeline, asked of the cell** (`MapClusterMedia`). It renders the same
`MediaTimeline` as the album, person and location pages, with the cell as `search --bbox`, the map's
year slider as `--from`/`--to` and its search box as the matching filters — so the date dividers,
floating date, selection, lightbox and rail are the ones those pages have, and change with them. It
used to be a copy with its own `find-within` paging, its own facets and its own upward-paging
intent gate, and it had fallen behind on all of that. Two things differ from a page. The headers are
months, as on a location page: a cell is a location, not an afternoon. And the list scrolls in its own
column inside the modal, passed to `MediaTimeline` as `scrollRoot`: paging and the header observer
measure against it, the floating date sticks to its top instead of under the app header, and the
rail stands `inline`, absolute against the modal body — positioned, and outside the scroller, so the
rail stays put while the column moves. `search --bbox` was once the slow road here (3.8s a page
against `find-within`'s 0.98s); measured in production now, a page of 60 from a 1,201-picture cell takes
about 0.1s and one from a 9,784-picture box about 0.7s, and `--facets` counts the same 1,201 the
cluster shows.

Tracks are read per track, and only for tracks whose stored `bbox`
intersects the viewport, at a `--tolerance` chosen from the zoom (about 1.5 screen pixels in
degrees). The track registry does the rest server-side: the bbox filter hits its GiST index, a
per-day `ST_Simplify` drops the vertices that could not be drawn apart at that zoom, and the result
comes back already cut into per-day, per-pause segments — so what crosses the wire is drawable.
`lib/track-colors.ts` colours each segment (tracker.js's scheme: a track gets a palette, its days
cycle through it), drawn by `MapTracks` as a colour over a black casing in Leaflet's own `casing`
pane. The gap rule scales with the sampling: a fixed threshold turns a simplified track into
one-point segments and erases it, so the cut is the low quartile interval times a factor.
