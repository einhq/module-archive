/**
 * The bridge's rules table: which VFS mutations are facts and which are noise.
 *
 * Table-driven against synthetic node snapshots — no harness — because these
 * rules are the contract every media pipeline triggers on, and they have to be
 * cheap enough to exercise exhaustively.
 */

import { ALBUMS_ROOT, PEOPLE_ROOT } from '@archive/paths';
import { assertEquals } from '@std/assert';
import { deriveEvents, deriveGaps, MEDIA_EVENTS, type NodeSnapshot, type RuleContext, type VfsEventInput } from '../../lib/media/event-rules.ts';
import type { DomainEvent } from '@ein/client';

const parentOf = (path: string): string => path.slice(0, path.lastIndexOf('/')) || '/';

const tree = (nodes: Record<string, NodeSnapshot>, extra: Partial<RuleContext> = {}): RuleContext => ({
  getNode: (path) => Promise.resolve(nodes[path]),
  exists: (path) => Promise.resolve(path in nodes),
  childNames: (path) =>
    Promise.resolve(
      Object.keys(nodes)
        .filter((p) => p.startsWith(`${path}/`) && !p.slice(path.length + 1).includes('/'))
        .map((p) => p.slice(path.length + 1)),
    ),
  ...extra,
});

const file = (id: string, attrs: Record<string, unknown> = {}): NodeSnapshot => ({
  id,
  type: 'file',
  attrs: { mimetype: 'image/jpeg', size: 1024, sha256: 'abc', ...attrs },
});

const event = (nodeType: string, path: string, type = 'created'): VfsEventInput => ({
  type,
  path,
  nodeId: 'n1',
  nodeType,
  timestamp: 1,
});

const IMG = `${ALBUMS_ROOT}/x/a.jpg`;
const VID = `${ALBUMS_ROOT}/x/a.mp4`;
const SND = `${ALBUMS_ROOT}/x/a.wav`;

Deno.test('rule: nothing in /tmp is a fact', async () => {
  // Put there to search with (`search --like`): its vectors would answer every search.
  const scratch = '/tmp/like-print.jpg';
  const ctx = tree({ [scratch]: file('f1') });

  assertEquals(await deriveEvents(event('embedding', `${scratch}/metadata/picture/embedding`), ctx, 100), []);
});

Deno.test('rule: an already-indexed file is silent', async () => {
  const ctx = tree({
    [IMG]: file('f1'),
    [`${IMG}/metadata/exif`]: { id: 'e1', type: 'exif', attrs: { indexedAt: 'now', sourceSha256: 'abc' } },
  });

  assertEquals(await deriveEvents(event('file', IMG, 'updated'), ctx, 100), []);
});

Deno.test('rule: a zero-face detection completion is a fact', async () => {
  const ctx = tree({
    [IMG]: file('f1', { facesAt: '2026-09-07T07:00:00Z', faceCount: 0 }),
    [`${IMG}/metadata/exif`]: { id: 'e1', type: 'exif', attrs: { indexedAt: 'now', sourceSha256: 'abc' } },
  });

  const facts = await deriveEvents(event('file', IMG, 'updated'), ctx, 100);

  assertEquals(facts.map((fact) => fact.type), [MEDIA_EVENTS.facesCompleted]);
  assertEquals(facts[0].data?.faceCount, 0);
});

Deno.test('rule: a multi-face detection completion carries the final count', async () => {
  const ctx = tree({
    [IMG]: file('f1', { facesAt: '2026-09-07T07:00:00Z', faceCount: 3 }),
    [`${IMG}/metadata/exif`]: { id: 'e1', type: 'exif', attrs: { indexedAt: 'now', sourceSha256: 'abc' } },
  });

  const facts = await deriveEvents(event('file', IMG, 'updated'), ctx, 100);

  assertEquals(facts.map((fact) => fact.type), [MEDIA_EVENTS.facesCompleted]);
  assertEquals(facts[0].data?.faceCount, 3);
});

Deno.test('rule: a file whose bytes changed says nothing of its old faces while it is read again', async () => {
  const ctx = tree({
    [IMG]: file('f1', { sha256: 'def', facesAt: 'then', faceCount: 2 }),
    [`${IMG}/metadata/exif`]: { id: 'e1', type: 'exif', attrs: { indexedAt: 'now', sourceSha256: 'abc' } },
  });

  assertEquals(await deriveEvents(event('file', IMG, 'updated'), ctx, 100), []);
});

Deno.test("rule: the archive's reading of a file's metadata is a fact, on the write that finished it", async () => {
  const ctx = tree({
    [IMG]: file('f1', { width: 4032, height: 3024, takenAt: '2020-01-01T00:00:00Z', interpretedAt: 'now' }),
    [`${IMG}/metadata/exif`]: {
      id: 'e1',
      type: 'exif',
      attrs: { indexedAt: 'now', deviceSerialNumber: 'SER1', where: { gps: { lat: 1, lon: 2 } } },
    },
  });
  const updated = (changedAttrs: string[]): VfsEventInput => ({ ...event('file', IMG, 'updated'), changedAttrs });

  const facts = (await deriveEvents(updated(['takenAt', 'interpretedAt']), ctx, 100)).filter((f) => f.type === MEDIA_EVENTS.metadataInterpreted);
  // Subject is the file, so $NODE_PATH is what the steps operate on.
  assertEquals(facts.map((f) => [f.subject, f.data]), [[IMG, {
    mimetype: 'image/jpeg',
    interpretedAt: 'now',
    takenAt: '2020-01-01T00:00:00Z',
    hasGps: true,
    cameraSerial: 'SER1',
    cameraKey: 'SER1',
    digitized: false,
  }]]);
  assertEquals((await deriveEvents(updated(['description']), ctx, 100)).filter((f) => f.type === MEDIA_EVENTS.metadataInterpreted), []);
});

Deno.test('rule: a camera with no serial still carries a camera key', async () => {
  // What `media-camera` triggers on: a serial, or make and model for a phone that writes no serial.
  const ctx = tree({
    [IMG]: file('f1', { takenAt: '2020-01-01T00:00:00Z', interpretedAt: 'now' }),
    [`${IMG}/metadata/exif`]: { id: 'e1', type: 'exif', attrs: { indexedAt: 'now', deviceinfo: { make: 'Apple', model: 'iPhone 12' } } },
  });

  const facts = (await deriveEvents({ ...event('file', IMG, 'updated'), changedAttrs: ['interpretedAt'] }, ctx, 100))
    .filter((f) => f.type === MEDIA_EVENTS.metadataInterpreted);
  assertEquals(facts.map((f) => [f.data?.cameraSerial, f.data?.cameraKey]), [['', 'iPhone 12']]);
});

Deno.test('rule: a position node reports availability without reading coordinates', async () => {
  const ctx = tree({
    [IMG]: file('f1'),
    [`${IMG}/position`]: { id: 'l1', type: 'position', attrs: {} },
  });

  const facts = await deriveEvents(event('position', `${IMG}/position`), ctx, 100);

  assertEquals(facts.length, 1);
  assertEquals(facts[0].type, MEDIA_EVENTS.positionAvailable);
  // Subject is the position node — the geocode step reads lat/lng from it
  assertEquals(facts[0].subject, `${IMG}/position`);
  assertEquals(facts[0].data?.filePath, IMG);
});

Deno.test('rule: each face is its own fact', async () => {
  const ctx = tree({
    [IMG]: file('f1'),
    [`${IMG}/regions/face-0`]: {
      id: 'rg0',
      type: 'media-region',
      attrs: { fileId: 'f1', confidence: 0.9 },
    },
    [`${IMG}/regions/face-0/embedding`]: {
      id: 'fa0',
      type: 'embedding',
      attrs: { embeddingType: 'face_transface', capacity: 512 },
    },
  });

  const facts = await deriveEvents(event('embedding', `${IMG}/regions/face-0/embedding`), ctx, 100);

  assertEquals(facts.length, 1);
  assertEquals(facts[0].type, MEDIA_EVENTS.faceDetected);
  // Subject is the region, so assignment retries one face rather than re-detecting, and the
  // `skipIfAttr: personId` guard reads the region, where the person is written.
  assertEquals(facts[0].subject, `${IMG}/regions/face-0`);
  assertEquals(facts[0].nodeId, 'rg0');
  assertEquals(facts[0].data?.filePath, IMG);
  assertEquals(facts[0].data?.fileId, 'f1');
  assertEquals(facts[0].data?.confidence, 0.9);
});

Deno.test('rule: a tag region is no face fact', async () => {
  // Only the embedding's arrival is a detection; a region written on its own is a tag.
  const ctx = tree({
    [IMG]: file('f1'),
    [`${IMG}/regions/manual-0`]: { id: 'rg1', type: 'media-region', attrs: { fileId: 'f1' } },
  });
  assertEquals(await deriveEvents(event('media-region', `${IMG}/regions/manual-0`), ctx, 100), []);
});

Deno.test('rule: the voices of a recording are one fact, when speakersAt is written', async () => {
  // Who each voice is gets decided once per recording, so the fact is the file's — and only on
  // the write that set the marker, not on every later attr write to the file.
  const ctx = tree(indexedVideo({ speakersAt: '2026-10-10T08:00:00Z', speakerCount: 3 }));
  const updated = (changedAttrs: string[]): VfsEventInput => ({ ...event('file', VID, 'updated'), changedAttrs });

  const facts = (await deriveEvents(updated(['speakersAt', 'speakerCount']), ctx, 100)).filter((f) => f.type === MEDIA_EVENTS.speakersDetected);
  assertEquals(facts.length, 1);
  assertEquals(facts[0].subject, VID);
  assertEquals(facts[0].data?.speakerCount, 3);

  const later = await deriveEvents(updated(['description']), ctx, 100);
  assertEquals(later.filter((f) => f.type === MEDIA_EVENTS.speakersDetected).length, 0);
});

Deno.test("rule: a video's faces complete on the write that finished detection, saying whether its voices are there", async () => {
  const updated = (changedAttrs: string[]): VfsEventInput => ({ ...event('file', VID, 'updated'), changedAttrs });
  const completed = (facts: Omit<DomainEvent, 'id'>[]) => facts.filter((f) => f.type === MEDIA_EVENTS.facesCompleted);
  const nodes = indexedVideo({ speakersAt: '2026-10-10T08:00:00Z' });
  nodes[VID].attrs.facesAt = '2026-10-11T08:00:00Z';
  nodes[VID].attrs.faceCount = 2;

  const facts = completed(await deriveEvents(updated(['facesAt', 'faceCount']), tree(nodes), 100));
  assertEquals(facts.length, 1);
  assertEquals(facts[0].subject, VID);
  assertEquals(facts[0].data, { mimetype: 'video/mp4', facesAt: '2026-10-11T08:00:00Z', faceCount: 2, speakersAt: '2026-10-10T08:00:00Z' });

  // Any later write to the video is not another completion.
  assertEquals(completed(await deriveEvents(updated(['description']), tree(nodes), 100)), []);

  // Faces first: the voices are not there to tie yet.
  delete nodes[VID].attrs.speakersAt;
  assertEquals(completed(await deriveEvents(updated(['facesAt', 'faceCount']), tree(nodes), 100))[0].data?.speakersAt, '');
});

Deno.test("rule: a face of a video with voices changing person is a fact about the video's voices", async () => {
  const REGION = `${VID}/regions/face-0`;
  const changed = (facts: Omit<DomainEvent, 'id'>[]) => facts.filter((f) => f.type === MEDIA_EVENTS.speakersFaceChanged);
  const updated = (changedAttrs: string[], path = REGION): VfsEventInput => ({ ...event('media-region', path, 'updated'), changedAttrs });
  const nodes = indexedVideo({ speakersAt: '2026-10-10T08:00:00Z' });
  nodes[REGION] = { id: 'rg0', type: 'media-region', attrs: { personId: 'p-anna' } };

  for (const attrs of [['personId', 'personSource', 'personAssignedAt'], ['assignLocked'], ['rejectedPersonIds']]) {
    const facts = changed(await deriveEvents(updated(attrs), tree(nodes), 100));
    assertEquals(facts.length, 1, attrs.join());
    assertEquals(facts[0].subject, VID);
    assertEquals(facts[0].nodeId, 'f1');
    assertEquals(facts[0].data, { mimetype: 'video/mp4', regionPath: REGION });
  }

  // A write that leaves the person alone is no fact, and needs no read to tell.
  const untouched = tree(nodes, { getNode: () => Promise.reject(new Error('read')) });
  assertEquals(await deriveEvents(updated(['doubt']), untouched, 100), []);
  assertEquals(await deriveEvents(updated(['faceBox']), untouched, 100), []);
  assertEquals(await deriveEvents(event('media-region', REGION, 'deleted'), untouched, 100), []);

  // No voices yet: `voiceprint-file` reads the faces as they are when it ties them.
  const silent = indexedVideo();
  silent[REGION] = nodes[REGION];
  assertEquals(changed(await deriveEvents(updated(['personId']), tree(silent), 100)), []);

  // A photo's face has no voices to decide.
  const photo = indexed();
  assertEquals(changed(await deriveEvents(updated(['personId'], `${IMG}/regions/face-0`), tree(photo), 100)), []);
});

Deno.test('gap: a recording with speech and no voices is a gap; one without speech is not', async () => {
  const transcript = (speech: boolean): NodeSnapshot => transcribed({ speech });

  const spoken = indexedVideo();
  spoken[`${VID}/metadata/transcript`] = transcript(true);
  assertEquals((await deriveGaps(VID, tree(spoken), 100)).map((f) => f.type), [MEDIA_EVENTS.speakersMissing]);

  const silent = indexedVideo();
  silent[`${VID}/metadata/transcript`] = transcript(false);
  assertEquals(await deriveGaps(VID, tree(silent), 100), []);

  const voiced = indexedVideo({ speakersAt: '2026-10-10T08:00:00Z' });
  voiced[`${VID}/metadata/transcript`] = transcript(true);
  assertEquals(await deriveGaps(VID, tree(voiced), 100), []);
});

Deno.test('rule: a fingerprint embedding or a chromaprint reports nothing of its own', async () => {
  const print = `${SND}/metadata/chromaprint`;
  const ctx = tree({
    [IMG]: file('f1'),
    [`${IMG}/metadata/sscd-image`]: { id: 'p1', type: 'embedding', attrs: { embeddingType: 'sscd-image', label: 'primary' } },
    [SND]: file('f2', { mimetype: 'audio/wav' }),
    [print]: { id: 'c1', type: 'file', attrs: { mimetype: 'application/x-chromaprint', computedAt: '2026-10-10T10:00:00Z' } },
  });

  assertEquals(await deriveEvents(event('embedding', `${IMG}/metadata/sscd-image`), ctx, 100), []);
  assertEquals(await deriveEvents({ ...event('file', print, 'updated'), changedAttrs: ['computedAt'] }, ctx, 100), []);
});

Deno.test('rule: an unrelated embedding produces nothing', async () => {
  const ctx = tree({
    [`${PEOPLE_ROOT}/alice/embedding`]: { id: 'x1', type: 'embedding', attrs: { embeddingType: 'face_transface' } },
  });

  // embeddingType is 'face' but it is not the embedding of a region of a file
  assertEquals(await deriveEvents(event('embedding', `${PEOPLE_ROOT}/alice/embedding`), ctx, 100), []);
});

Deno.test('rule: node types with no media meaning are ignored', async () => {
  const ctx = tree({ [`${ALBUMS_ROOT}/x`]: { id: 'd1', type: 'directory', attrs: {} } });

  assertEquals(await deriveEvents(event('directory', `${ALBUMS_ROOT}/x`), ctx, 100), []);
  assertEquals(await deriveEvents(event('tty', '/dev/tty1'), ctx, 100), []);
});

// --- Album membership: the one fact whose subject is an aggregate.

const ALBUM = `${ALBUMS_ROOT}/x`;
const IMPORTED = `${ALBUMS_ROOT}/imported`;
const albumNode = (id: string): NodeSnapshot => ({ id, type: 'album', attrs: {} });
const dirNode = (id: string): NodeSnapshot => ({ id, type: 'directory', attrs: {} });
const albumFacts = (facts: Omit<DomainEvent, 'id'>[]) => facts.filter((f) => f.type === MEDIA_EVENTS.albumMembersChanged).map((f) => [f.subject, f.nodeId, f.data?.cause]);

Deno.test('album: a child attached to or detached from an album is a membership fact on the album', async () => {
  const ctx = tree({ [ALBUM]: albumNode('al1') });

  const attached = await deriveEvents({ ...event('album', ALBUM, 'child-attached'), nodeId: 'al1' }, ctx, 100);
  assertEquals(albumFacts(attached), [[ALBUM, 'al1', 'member-attached']]);
  assertEquals(attached.length, 1);

  const detached = await deriveEvents({ ...event('album', ALBUM, 'child-detached'), nodeId: 'al1' }, ctx, 100);
  assertEquals(albumFacts(detached), [[ALBUM, 'al1', 'member-detached']]);
});

Deno.test("album: an imported album's files/ directory answers for the album", async () => {
  const ctx = tree({ [IMPORTED]: albumNode('al2'), [`${IMPORTED}/files`]: dirNode('d2') });

  const facts = await deriveEvents(event('directory', `${IMPORTED}/files`, 'child-detached'), ctx, 100);
  assertEquals(albumFacts(facts), [[IMPORTED, 'al2', 'member-detached']]);
});

Deno.test("album: a directory that is not an album files/ is nobody's membership, without a read", async () => {
  let reads = 0;
  const ctx = tree({ [`${ALBUM}/sub`]: dirNode('d3'), [ALBUM]: albumNode('al1') }, {
    getNode: (path) => {
      reads++;
      return Promise.resolve(path === ALBUM ? albumNode('al1') : dirNode('d3'));
    },
  });

  assertEquals(await deriveEvents(event('directory', `${ALBUM}/sub`, 'child-detached'), ctx, 100), []);
  assertEquals(await deriveEvents(event('directory', `${IMG}/thumbnails`, 'child-detached'), ctx, 100), []);
  assertEquals(reads, 0);
});

Deno.test('album: a file created or moved into files/ reports the album from the child side', async () => {
  const path = `${IMPORTED}/files/a.jpg`;
  const ctx = tree({ [IMPORTED]: albumNode('al2'), [`${IMPORTED}/files`]: dirNode('d2'), [path]: file('f1') });

  const created = await deriveEvents(event('file', path, 'created'), ctx, 100);
  assertEquals(albumFacts(created), [[IMPORTED, 'al2', 'member-attached']]);
  // The file's own discovery is the media module's bridge's, from the same event.
  assertEquals(created.some((f) => f.type === MEDIA_EVENTS.fileDiscovered), false);

  const moved = await deriveEvents(event('file', path, 'moved'), ctx, 100);
  assertEquals(albumFacts(moved), [[IMPORTED, 'al2', 'member-attached']]);
});

Deno.test("album: a file created directly in an album is the album key's job, not the file's", async () => {
  const ctx = tree({ [ALBUM]: albumNode('al1'), [IMG]: file('f1') });

  assertEquals(albumFacts(await deriveEvents(event('file', IMG, 'created'), ctx, 100)), []);
});

Deno.test("album: the archive's reading of the metadata and the file's fingerprinting done announce every album holding the member", async () => {
  const linked = `${ALBUMS_ROOT}/picked/a.jpg`;
  const ctx = tree({
    [ALBUM]: albumNode('al1'),
    [`${ALBUMS_ROOT}/picked`]: albumNode('al3'),
    [IMPORTED]: albumNode('al2'),
    [`${IMPORTED}/files`]: dirNode('d2'),
    [IMG]: file('f1', { takenAt: '2020-01-01T00:00:00', interpretedAt: 't' }),
    [`${IMG}/metadata/exif`]: { id: 'e1', type: 'exif', attrs: { indexedAt: 't' } },
    [`${IMG}/metadata/sscd-image`]: { id: 'p1', type: 'embedding', attrs: { embeddingType: 'sscd-image', label: 'primary' } },
  }, {
    // Hard-linked at its own path and under the imported album's files/, softlinked from an album it was added to.
    containersOf: () => Promise.resolve([ALBUM, `${IMPORTED}/files`, parentOf(linked)]),
  });

  const read = await deriveEvents({ ...event('file', IMG, 'updated'), changedAttrs: ['interpretedAt'] }, ctx, 100);
  assertEquals(read[0].type, MEDIA_EVENTS.metadataInterpreted);
  assertEquals(albumFacts(read), [[ALBUM, 'al1', 'member-indexed'], [IMPORTED, 'al2', 'member-indexed'], [`${ALBUMS_ROOT}/picked`, 'al3', 'member-indexed']]);

  const printed = await deriveEvents({ ...event('file', IMG, 'updated'), changedAttrs: ['fingerprintedAt'] }, ctx, 100);
  assertEquals(albumFacts(printed).map((f) => f[2]), ['member-fingerprinted', 'member-fingerprinted', 'member-fingerprinted']);
});

Deno.test('album: a retime is a membership fact; any other attr write is not', async () => {
  let lookups = 0;
  const ctx = tree({
    [ALBUM]: albumNode('al1'),
    [IMG]: file('f1', { takenAt: '2020-01-01T00:00:00' }),
    [`${IMG}/metadata/exif`]: { id: 'e1', type: 'exif', attrs: { indexedAt: 't', sourceSha256: 'abc' } },
  }, {
    containersOf: () => {
      lookups++;
      return Promise.resolve([ALBUM]);
    },
  });

  const retimed = await deriveEvents({ ...event('file', IMG, 'updated'), changedAttrs: ['takenAt', 'takenAtUtc', 'takenAtSource'] }, ctx, 100);
  assertEquals(albumFacts(retimed), [[ALBUM, 'al1', 'member-retimed']]);

  assertEquals(await deriveEvents({ ...event('file', IMG, 'updated'), changedAttrs: ['facesAt'] }, ctx, 100), []);
  assertEquals(await deriveEvents(event('file', IMG, 'updated'), ctx, 100), []);
  assertEquals(lookups, 1);
});

Deno.test('album: the reconciler, which has no reverse lookup, derives no member facts', async () => {
  const ctx = tree({
    [IMG]: file('f1'),
    [`${IMG}/metadata/exif`]: { id: 'e1', type: 'exif', attrs: { indexedAt: 't' } },
  });

  const facts = await deriveEvents(event('exif', `${IMG}/metadata/exif`, 'updated'), ctx, 100);
  assertEquals(albumFacts(facts), []);
});

// --- Gap filling: the reconciler's extra rule, for files whose indexing stopped
// part-way through (interrupted crawl, bridge down, an older pipeline set).

const exifNode = (): NodeSnapshot => ({
  id: 'e1',
  type: 'exif',
  attrs: { indexedAt: 'now', sourceSha256: 'abc' },
});

/**
 * What "indexing finished with this file" looks like: one marker per pipeline hanging off
 * `media.metadata.extracted` and `media.metadata.interpreted`. Written out here rather than assembled per test, because the gap
 * rule is exactly the complement of it and a term missing from both sides would pass silently.
 */
const indexed = (attrs: Record<string, unknown> = {}, path = IMG): Record<string, NodeSnapshot> => ({
  [path]: file('f1', { facesAt: '2026-08-23T00:00:00Z', interpretedAt: '2026-08-23T00:00:00Z', ...attrs }),
  [`${path}/metadata/exif`]: exifNode(),
});

/** A finished transcript: `transcribe-file` writes `transcribedAt` once the cues are in. */
const transcribed = (attrs: Record<string, unknown> = {}): NodeSnapshot => ({
  id: 'tr',
  type: 'file',
  attrs: { mimetype: 'text/vtt', transcribedAt: '2026-08-23T00:00:00Z', speech: false, ...attrs },
});

/**
 * Complete for a video: its transcript. No `facesAt`: a video indexed before its faces were looked
 * for has none, so an image's marker must not creep in here and hide a term that reads it.
 */
const indexedVideo = (attrs: Record<string, unknown> = {}): Record<string, NodeSnapshot> => {
  const nodes = indexed({ mimetype: 'video/mp4', duration: 42, ...attrs }, VID);
  delete nodes[VID].attrs.facesAt;
  nodes[`${VID}/metadata/transcript`] = transcribed();
  return nodes;
};

/** Complete for audio: its transcript. */
const indexedAudio = (attrs: Record<string, unknown> = {}): Record<string, NodeSnapshot> => {
  const nodes = indexed({ mimetype: 'audio/x-wav', duration: 180, ...attrs }, SND);
  delete nodes[SND].attrs.facesAt;
  nodes[`${SND}/metadata/transcript`] = transcribed();
  return nodes;
};

Deno.test('gap: a fully indexed file needs nothing', async () => {
  assertEquals(await deriveGaps(IMG, tree(indexed()), 100), []);
});

Deno.test("gap: a video or a recording without a transcript is not the archive's gap", async () => {
  // The media module finds it by its marker.
  const video = indexedVideo();
  delete video[`${VID}/metadata/transcript`];
  assertEquals(await deriveGaps(VID, tree(video), 100), []);

  const audio = indexedAudio();
  delete audio[`${SND}/metadata/transcript`];
  assertEquals(await deriveGaps(SND, tree(audio), 100), []);
});

Deno.test('gap: exif but no face detection re-opens the fan-out', async () => {
  // An image indexed before face detection could run on it: no event was ever emitted for it,
  // and `skipIfAttr: facesAt` cannot help a pipeline nothing announces. Without a term here the
  // file is complete as far as the reconciler is concerned, forever.
  const nodes = indexed();
  nodes[IMG] = file('f1', { mimetype: 'image/x-fujifilm-raf', interpretedAt: 'then' });
  const ctx = tree(nodes);

  const facts = await deriveGaps(IMG, ctx, 100);

  assertEquals(facts.map((f) => f.type), [MEDIA_EVENTS.metadataInterpreted]);
  assertEquals(facts[0].data?.mimetype, 'image/x-fujifilm-raf');
});

Deno.test('gap: a file read and never interpreted re-opens the media fan-out, which interprets it', async () => {
  const nodes = indexed();
  delete nodes[IMG].attrs.interpretedAt;

  const facts = await deriveGaps(IMG, tree(nodes), 100);

  assertEquals(facts.map((f) => [f.type, f.subject, f.source]), [[MEDIA_EVENTS.metadataExtracted, IMG, 'archive-bridge']]);
});

Deno.test('gap: a video without a face marker is not a gap', async () => {
  // A video indexed before its faces were looked for is left for the next import to detect.
  assertEquals(await deriveGaps(VID, tree(indexedVideo()), 100), []);
});

Deno.test('gap: a fully indexed recording needs nothing', async () => {
  assertEquals(await deriveGaps(SND, tree(indexedAudio()), 100), []);
});

Deno.test('gap: an undecodable source is not a gap', async () => {
  // Nothing downstream can ever fill these in, so announcing them again on every scan only
  // republishes the same file — the redundancy media-scan is built to avoid.
  const nodes = indexed();
  nodes[IMG] = file('f1', { mimetype: 'video/quicktime', undecodable: 'moov atom not found' });

  assertEquals(await deriveGaps(IMG, tree(nodes), 100), []);
});

Deno.test('gap: renditions, picture vectors and fingerprints are no term of the walk', async () => {
  // A file with no rendition, picture vector or print and no marker reads as complete here: the
  // media module's scans find it by its marker, in every tree, and announce it to their own
  // pipelines alone.
  assertEquals(await deriveGaps(IMG, tree(indexed()), 100), []);
  assertEquals(await deriveGaps(VID, tree(indexedVideo()), 100), []);
});

Deno.test('gap: an ungeocoded position is its own gap', async () => {
  // Nothing re-emits position.available once the node exists, so a geocode that
  // never ran would otherwise stay missing forever.
  const ctx = tree({ ...indexed(), [`${IMG}/position`]: { id: 'l1', type: 'position', attrs: {} } });

  const facts = await deriveGaps(IMG, ctx, 100);

  assertEquals(facts.map((f) => f.type), [MEDIA_EVENTS.positionAvailable]);
});

Deno.test('gap: an already-geocoded position is not a gap', async () => {
  const ctx = tree({ ...indexed(), [`${IMG}/position`]: { id: 'l1', type: 'position', attrs: { geocodedAt: 'yesterday' } } });

  assertEquals(await deriveGaps(IMG, ctx, 100), []);
});

Deno.test('gap: a dated photo with a point is owed its weather while lookups are on', async () => {
  const geocoded = { id: 'l1', type: 'position', attrs: { geocodedAt: 'yesterday' } };
  const dated = { ...indexed({ takenAtUtc: '2024-07-14T14:40:00Z' }), [`${IMG}/position`]: geocoded };

  const facts = await deriveGaps(IMG, tree(dated, { weather: true }), 100);
  assertEquals(facts.map((f) => [f.type, f.subject]), [[MEDIA_EVENTS.weatherOwed, `${IMG}/position`]]);

  // Lookups off, or the setting not known: nothing is owed.
  assertEquals(await deriveGaps(IMG, tree(dated), 100), []);
  assertEquals(await deriveGaps(IMG, tree(dated, { weather: false }), 100), []);

  // No capture time: nothing to look up.
  assertEquals(await deriveGaps(IMG, tree({ ...indexed(), [`${IMG}/position`]: geocoded }, { weather: true }), 100), []);
});

Deno.test('gap: a photo whose weather is for its capture time is not owed it, one retimed is', async () => {
  const position = (time: string): NodeSnapshot => ({ id: 'l1', type: 'position', attrs: { geocodedAt: 'yesterday', weather: { lat: 1, lng: 2, time } } });
  const nodes = (time: string) => ({ ...indexed({ takenAtUtc: '2024-07-14T14:40:00Z' }), [`${IMG}/position`]: position(time) });

  assertEquals(await deriveGaps(IMG, tree(nodes('2024-07-14T14:40:00.000Z'), { weather: true }), 100), []);
  assertEquals((await deriveGaps(IMG, tree(nodes('2024-07-14T09:05:00.000Z'), { weather: true }), 100)).map((f) => f.type), [MEDIA_EVENTS.weatherOwed]);
});

Deno.test('gap: an unindexed file is discovery, not a gap', async () => {
  const ctx = tree({ [IMG]: file('f1') });

  assertEquals(await deriveGaps(IMG, ctx, 100), []);
});

const FACES = 'retinaface-r34+transface';
const facesFacts = (facts: Omit<DomainEvent, 'id'>[]) => facts.filter((f) => f.type === MEDIA_EVENTS.facesStale);
const FOUND_AT = '2026-10-20T08:00:00Z';

Deno.test('faces: a photo or a video whose faces other models found is detected again', async () => {
  const photo = facesFacts(await deriveGaps(IMG, tree(indexed({ facesAt: FOUND_AT }), { faceGeneration: FACES }), 100));
  assertEquals(photo.map((f) => [f.subject, f.data]), [[IMG, { mimetype: 'image/jpeg', facesBy: '', expected: FACES }]]);
  const nodes = indexedVideo();
  nodes[VID] = { ...nodes[VID], attrs: { ...nodes[VID].attrs, facesAt: FOUND_AT, facesBy: 'other-detector+other-recogniser' } };
  const video = facesFacts(await deriveGaps(VID, tree(nodes, { faceGeneration: FACES }), 100));
  assertEquals(video.map((f) => f.data?.facesBy), ['other-detector+other-recogniser']);
});

Deno.test('faces: current faces, a file never detected, an undecodable one, another EMS or a silent one ask nothing', async () => {
  assertEquals(facesFacts(await deriveGaps(IMG, tree(indexed({ facesAt: FOUND_AT, facesBy: FACES }), { faceGeneration: FACES }), 100)), []);
  // Never detected is the first detection's gap, not this one.
  assertEquals(facesFacts(await deriveGaps(IMG, tree(indexed({ facesAt: undefined }), { faceGeneration: FACES }), 100)), []);
  assertEquals(facesFacts(await deriveGaps(IMG, tree(indexed({ facesAt: FOUND_AT, undecodable: 'no frame table' }), { faceGeneration: FACES }), 100)), []);
  // An EMS running models recognition is not tuned for would store nothing on a re-detection.
  assertEquals(facesFacts(await deriveGaps(IMG, tree(indexed({ facesAt: FOUND_AT }), { faceGeneration: 'other-detector+other-recogniser' }), 100)), []);
  assertEquals(facesFacts(await deriveGaps(IMG, tree(indexed({ facesAt: FOUND_AT })), 100)), []);
});

const DAMAGE = 'damage/1+bopb-detection';
const damageFacts = (facts: Omit<DomainEvent, 'id'>[]) => facts.filter((f) => f.type === MEDIA_EVENTS.damageMissing);
const scan = (attrs: Record<string, unknown> = {}) => indexed({ digitized: true, interpretedAt: 'now', ...attrs });

Deno.test('damage: a scan never read, or read by another method than EMS reads with now, is read', async () => {
  const never = damageFacts(await deriveGaps(IMG, tree(scan(), { damageGeneration: DAMAGE }), 100));
  assertEquals(never.map((f) => [f.subject, f.data]), [[IMG, { mimetype: 'image/jpeg', damageBy: '' }]]);
  // Without EMS the scans never read are still found.
  assertEquals(damageFacts(await deriveGaps(IMG, tree(scan()), 100)).length, 1);
  const older = damageFacts(await deriveGaps(IMG, tree(scan({ damageAt: 'then', damageBy: 'damage/0+bopb-detection' }), { damageGeneration: DAMAGE }), 100));
  assertEquals(older.map((f) => f.data?.damageBy), ['damage/0+bopb-detection']);
});

Deno.test('damage: a scan read now, one EMS cannot be asked about, a photo, a HEIF scan or an undecodable one ask nothing', async () => {
  assertEquals(damageFacts(await deriveGaps(IMG, tree(scan({ damageAt: 'then', damageBy: DAMAGE }), { damageGeneration: DAMAGE }), 100)), []);
  assertEquals(damageFacts(await deriveGaps(IMG, tree(scan({ damageAt: 'then', damageBy: 'damage/0+bopb-detection' })), 100)), []);
  assertEquals(damageFacts(await deriveGaps(IMG, tree(indexed({ interpretedAt: 'now' }), { damageGeneration: DAMAGE }), 100)), []);
  assertEquals(damageFacts(await deriveGaps(IMG, tree(scan({ mimetype: 'image/heic' }), { damageGeneration: DAMAGE }), 100)), []);
  assertEquals(damageFacts(await deriveGaps(IMG, tree(scan({ undecodable: 'truncated' }), { damageGeneration: DAMAGE }), 100)), []);
});
