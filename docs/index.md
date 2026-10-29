# Archive

The archive is everything your collection holds and the ways into it: the people in it
and their family tree, the photos, videos and documents, the locations and tracks, the
cameras and phones that took them — and search, the year view and the map for finding
things among them.

- [People](people.md) — profiles, family relationships, homes and the faces that tie
  people to their photos.
- [Media](media.md) — photos and videos: previews, embedded details, faces, albums,
  similar and duplicate pictures.
- [Staging](staging.md) — your private inbox for new files, and the
  [auto albums](auto-albums.md) suggested from them.

Everything lives under `/archive`: people under `/archive/people`, albums under
`/archive/albums`, locations under `/archive/locations`, and devices under `/archive/devices`,
each with the route it recorded as its `track`.

A location's shape and a device's route are stored in the system's own `position` and `track`
nodes, because those keep a map index the archive could not keep itself; the archive decides
where they hang and what they mean: a location's outline is its child `position`, a photo's GPS
point is the photo's `position`, and the route a device recorded is the device's `track`.

## Organizing content

- Group related photos into an **album**.
- Connect a photo or event to the **people** and **locations** it involves.
- Give an album a cover image so it stands out in listings — select one picture and choose **Set as cover**; an album without one gets a random picture of its own.
