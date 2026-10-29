# People

EiN lets you document the people in your collection and how they
relate to one another — a living family tree connected to your photos, locations,
and events.

## What it does for you

- **People profiles** — record each person and the details you want to keep about
  them.
- **Family relationships** — set parents, partners, and children, and EiN can
  work out how any two people are related.
- **Home locations** — connect a person to the [locations](/docs/node-types#type-location)
  they've lived, with the years they lived there.
- **Events** — attach events to a person's timeline.
- **Connections to photos** — link people to the photos they appear in, so a
  person's page gathers their pictures over time.

## Where people live

People are listed under **People** in the sidebar (stored under `/archive/people`). Opening
a person gives you a header with who they are — their age or the years they lived,
where they live now, how to reach them, how many photos they appear in — and
tabs beneath it:

- **Timeline** — their life in order: birth and death, events, moving house,
  partnerships, their children's births, and the albums they appear in.
- **Info** — everything recorded about them in one place: their names and dates, every way
  to reach them, their homes with the years, their family and the whole description.
- **Media** — every photo and video they are tagged in, newest first, with the year
  rail beside it for jumping decades.
- **Faces** — every face recognised as them, as a grid of face crops. Click one to
  open the photo it came from; select some to download the crops, pick one and
  _Set as cover_ to make it their picture, or say _Not <name>_ for faces that are
  somebody else. Then choose: let recognition match them again (they join whoever
  they look like, or become unidentified — never back to this person), move them to
  someone you pick, make them one new unidentified person, or say they are not a
  face at all.
- **Heard in** — the recordings their voice is heard in, the ones they speak most in first;
  play a clip, or open the recording where they speak.
- **Family** — an interactive tree. Ancestors above, descendants below, couples side
  by side. Drag it around, and pinch, scroll or double-click to zoom
  (Shift+double-click zooms out); the buttons in its corner open it full screen and
  fit the whole family. A chevron on top of a card shows their parents, one
  underneath their children, and once shown it turns round to hide them again. For an
  administrator, the menu on a card adds a parent, partner or child, or removes a relation.
- **Homes** — everywhere they have lived, current first, with the years. An administrator
  adds one, corrects the dates, or removes one from there. The same list is on a location's
  own page, as its **Residents** tab, which whoever may change the location can edit, and
  edits from either side write the same thing. A location has a **Timeline** tab too: who
  moved in and out, stories written on the location, and the albums with photos taken there.

The dates are what make a move something that happened. A home with no dates says
where somebody lived and nothing about when, so it stays on the header and on the
Homes list — but it cannot appear on their timeline, or on the archive's, because there
is no moment to put it at. Add a _moved in_ and a move appears on all three: theirs,
the location's and the archive's.

## Good to know

- A named person without a picture gets one automatically: the crop of one of their
  own faces, preferring faces somebody confirmed, then photos where they are the
  only face, then the largest. A picture you choose yourself is never replaced.
- Building out relationships (parents and partners) is what powers the family
  tree, and what lets the assistant or `person-how-related` say how two people are
  related.
- The family tree loads a couple of generations at a time. That is deliberate: a
  tree reaching back to the 1600s would arrive as more than anyone can read at
  once, so it grows where you ask it to.
- A partnership can carry dates. Adding them puts it on both people's timelines — as a
  wedding, for a married couple.
- People connect naturally with [photos and videos](media.md): faces
  detected in photos can be tied back to the right person.
