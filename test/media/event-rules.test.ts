/**
 * The bridge's rules table: which VFS mutations are facts and which are noise.
 *
 * Table-driven against synthetic node snapshots — no harness — because these
 * rules are the contract every media pipeline triggers on, and they have to be
 * cheap enough to exercise exhaustively.
 */

import { DOCS_PATH } from '@ein/paths';
import { ALBUMS_ROOT, PEOPLE_ROOT } from '@archive/paths';
import { assertEquals } from '@std/assert';
import {
  deriveEvents,
  deriveGaps,
  deriveTextGap,
  MEDIA_EVENTS,
  type NodeSnapshot,
  type RuleContext,
  TRANSCODE_REFUSED_ATTR,
  type VfsEventInput,
} from '../../lib/media/event-rules.ts';
import type { DomainEvent } from '@ein/client';
import { authoredHash } from '@ems/text-embedding';
import { CHUNK_TARGET_SECONDS } from '@archive/media/transcript';

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

Deno.test('rule: a media file with bytes and no exif is discovered', async () => {
  const ctx = tree({ [IMG]: file('f1') });

  const facts = await deriveEvents(event('file', IMG), ctx, 100);

  assertEquals(facts.length, 1);
  assertEquals(facts[0].type, MEDIA_EVENTS.fileDiscovered);
  assertEquals(facts[0].subject, IMG);
  assertEquals(facts[0].nodeId, 'f1');
  assertEquals(facts[0].data?.mimetype, 'image/jpeg');
});

Deno.test('rule: nothing in a trash is discovered or indexed again', async () => {
  const trashed = '/home/anna/.trash/01J/01K/a.jpg';
  const ctx = tree({ [trashed]: file('f1') });

  assertEquals(await deriveEvents(event('file', trashed, 'updated'), ctx, 100), []);
  assertEquals(await deriveEvents(event('file', trashed), ctx, 100), []);
});

Deno.test('rule: a deferred exact copy is not discovered while it is one', async () => {
  const staged = '/home/anna/staging/files/inbox/upload/IMG_0002.jpg';
  const deferred = { inbox: 'anna', sha256: 'abc', at: 'then', kind: 'exact', where: 'inbox', of: 'f0', deferred: true };
  const discovered = async (path: string, attrs: Record<string, unknown>) =>
    (await deriveEvents(event('file', path, 'updated'), tree({ [path]: file('f1', attrs) }), 100)).map((fact) => fact.type);

  assertEquals(await discovered(staged, { duplicate: deferred }), []);
  // Other bytes than the copy's: discovered, and decided again when it is read.
  assertEquals(await discovered(staged, { duplicate: deferred, sha256: 'def' }), [MEDIA_EVENTS.fileDiscovered]);
  // No longer staged, its finding not cleared yet: discovered where it lies.
  assertEquals(await discovered(`${ALBUMS_ROOT}/x/IMG_0002.jpg`, { duplicate: deferred }), [MEDIA_EVENTS.fileDiscovered]);
  // Undeferred: a copy indexed, or the original it became.
  const { deferred: _deferred, ...undeferred } = deferred;
  assertEquals(await discovered(staged, { duplicate: undeferred }), [MEDIA_EVENTS.fileDiscovered]);
  assertEquals(await discovered(staged, { duplicate: { inbox: 'anna', sha256: 'abc', at: 'then' } }), [MEDIA_EVENTS.fileDiscovered]);
});

Deno.test('rule: an indexed copy whose bytes changed is reindexed, deferred or not', async () => {
  const staged = '/home/anna/staging/files/inbox/upload/IMG_0002.jpg';
  const ctx = tree({
    [staged]: file('f1', { sha256: 'def', duplicate: { inbox: 'anna', sha256: 'def', at: 'then', kind: 'exact', where: 'inbox', of: 'f0', deferred: true } }),
    [`${staged}/metadata/exif`]: { id: 'e1', type: 'exif', attrs: { indexedAt: 'now', sourceSha256: 'abc' } },
  });

  assertEquals((await deriveEvents(event('file', staged, 'updated'), ctx, 100)).map((fact) => fact.type), [MEDIA_EVENTS.fileContentChanged]);
});

Deno.test('rule: a derivative is never discovered', async () => {
  // Thumbnails, transcodes and face crops all carry sourceId. Without this the
  // pipelines would recurse on their own output.
  const ctx = tree({ [IMG]: file('f1', { sourceId: 'f0' }) });

  assertEquals(await deriveEvents(event('file', IMG), ctx, 100), []);
});

Deno.test('rule: a non-media file is ignored', async () => {
  const ctx = tree({ [`${DOCS_PATH}/a.pdf`]: file('f1', { mimetype: 'application/pdf' }) });

  assertEquals(await deriveEvents(event('file', `${DOCS_PATH}/a.pdf`), ctx, 100), []);
});

Deno.test('rule: a picture in /tmp is never discovered, nor anything else there', async () => {
  // Put there to search with (`search --like`): indexed, its vectors would answer every search.
  const scratch = '/tmp/like-print.jpg';
  const ctx = tree({ [scratch]: file('f1') });

  assertEquals(await deriveEvents(event('file', scratch), ctx, 100), []);
  assertEquals(await deriveEvents(event('embedding', `${scratch}/metadata/picture/embedding`), ctx, 100), []);
});

Deno.test('rule: a file node with no bytes yet is ignored', async () => {
  const ctx = tree({ [IMG]: file('f1', { size: 0 }) });

  assertEquals(await deriveEvents(event('file', IMG), ctx, 100), []);
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

Deno.test('rule: an indexed file whose bytes changed reports content-changed', async () => {
  const ctx = tree({
    [IMG]: file('f1', { sha256: 'def' }),
    [`${IMG}/metadata/exif`]: { id: 'e1', type: 'exif', attrs: { indexedAt: 'now', sourceSha256: 'abc' } },
  });

  const facts = await deriveEvents(event('file', IMG, 'updated'), ctx, 100);

  assertEquals(facts.length, 1);
  assertEquals(facts[0].type, MEDIA_EVENTS.fileContentChanged);
  assertEquals(facts[0].data?.previousSha256, 'abc');
});

Deno.test('rule: an exif node under a text file extracts nothing', async () => {
  // An album's description: a text node, once given an exif child, that no media step can render.
  const text = `${ALBUMS_ROOT}/x/metadata/description`;
  const ctx = tree({
    [text]: file('f2', { mimetype: 'text/plain' }),
    [`${text}/metadata/exif`]: { id: 'e2', type: 'exif', attrs: { indexedAt: 'now' } },
  });

  assertEquals(await deriveEvents(event('exif', `${text}/metadata/exif`, 'updated'), ctx, 100), []);
});

Deno.test('rule: a populated exif node extracts metadata', async () => {
  const ctx = tree({
    [IMG]: file('f1', { width: 4032, height: 3024, takenAt: '2020-01-01T00:00:00Z' }),
    [`${IMG}/metadata/exif`]: {
      id: 'e1',
      type: 'exif',
      attrs: {
        indexedAt: 'now',
        deviceSerialNumber: 'SER1',
        where: { gps: { lat: 1, lon: 2 } },
        fileinfo: { duration: 12 },
      },
    },
  });

  const facts = await deriveEvents(event('exif', `${IMG}/metadata/exif`, 'updated'), ctx, 100);

  assertEquals(facts.length, 1);
  assertEquals(facts[0].type, MEDIA_EVENTS.metadataExtracted);
  // Subject is the file, so $NODE_PATH is what the steps operate on
  assertEquals(facts[0].subject, IMG);
  assertEquals(facts[0].data?.hasGps, true);
  assertEquals(facts[0].data?.deviceSerial, 'SER1');
  assertEquals(facts[0].data?.deviceKey, 'SER1');
  assertEquals(facts[0].data?.width, 4032);
  assertEquals(facts[0].data?.duration, 12);
});

Deno.test('rule: a camera with no serial still carries a device key', async () => {
  // What `media-device` triggers on: a serial, or make and model for a phone that writes no serial.
  const ctx = tree({
    [IMG]: file('f1', { takenAt: '2020-01-01T00:00:00Z' }),
    [`${IMG}/metadata/exif`]: {
      id: 'e1',
      type: 'exif',
      attrs: { indexedAt: 'now', deviceinfo: { make: 'Apple', model: 'iPhone 12' } },
    },
  });

  const facts = await deriveEvents(event('exif', `${IMG}/metadata/exif`, 'updated'), ctx, 100);

  assertEquals(facts.length, 1);
  assertEquals(facts[0].data?.deviceSerial, '');
  assertEquals(facts[0].data?.deviceKey, 'iPhone 12');
});

Deno.test('rule: an exif node created empty is not yet a fact', async () => {
  // ensure() creates it, a following update fills it — only the filled state counts
  const ctx = tree({
    [IMG]: file('f1'),
    [`${IMG}/metadata/exif`]: { id: 'e1', type: 'exif', attrs: {} },
  });

  assertEquals(await deriveEvents(event('exif', `${IMG}/metadata/exif`), ctx, 100), []);
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
      attrs: { embeddingType: 'face', capacity: 512 },
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

Deno.test('rule: an indexed video turned or flipped by hand is turned; any other write is not', async () => {
  const updated = (changedAttrs: string[], path = VID): VfsEventInput => ({ ...event('file', path, 'updated'), changedAttrs });
  const turned = (facts: Omit<DomainEvent, 'id'>[]) => facts.filter((f) => f.type === MEDIA_EVENTS.fileTurned);
  const ctx = tree(indexedVideo({ angle: 90, angleManual: 90, mirror: true }));

  const facts = turned(await deriveEvents(updated(['angle', 'angleManual']), ctx, 100));
  assertEquals(facts.length, 1);
  assertEquals(facts[0].subject, VID);
  assertEquals(facts[0].data, { mimetype: 'video/mp4', angle: 90, mirror: true });
  assertEquals(turned(await deriveEvents(updated(['mirror']), ctx, 100)).length, 1);

  // The angle `exif-extract` derives on every index is not a turn, nor is any other write.
  assertEquals(turned(await deriveEvents(updated(['angle']), ctx, 100)), []);
  assertEquals(turned(await deriveEvents(updated(['speakersAt']), ctx, 100)), []);
  assertEquals(turned(await deriveEvents(event('file', VID, 'updated'), ctx, 100)), []);

  // Not yet indexed: the transcode the index queues reads the new orientation itself.
  const unindexed = tree({ [VID]: file('f1', { mimetype: 'video/mp4', angleManual: 90 }) });
  assertEquals(turned(await deriveEvents(updated(['angleManual']), unindexed, 100)), []);

  // A turned photo has no rendition to re-encode.
  const photo = tree(indexed({ angleManual: 90 }));
  assertEquals(turned(await deriveEvents(updated(['angleManual'], IMG), photo, 100)), []);
});

Deno.test('rule: a read picture whose text language is set by hand is announced; any other write is not', async () => {
  const updated = (changedAttrs: string[]): VfsEventInput => ({ ...event('file', IMG, 'updated'), changedAttrs });
  const set = (facts: Omit<DomainEvent, 'id'>[]) => facts.filter((f) => f.type === MEDIA_EVENTS.textLanguageSet);
  const read = tree(indexed({ textIndexedAt: '2026-10-19T10:00:00Z', ocrLanguageManual: 'en' }));

  const facts = set(await deriveEvents(updated(['ocrLanguageManual']), read, 100));
  assertEquals(facts.length, 1);
  assertEquals([facts[0].subject, facts[0].data], [IMG, { mimetype: 'image/jpeg', language: 'en' }]);
  // Cleared, the language is told from the text again.
  const cleared = tree(indexed({ textIndexedAt: '2026-10-19T10:00:00Z' }));
  assertEquals(set(await deriveEvents(updated(['ocrLanguageManual']), cleared, 100))[0].data?.language, null);

  assertEquals(set(await deriveEvents(updated(['textIndexedAt', 'ocrBy']), read, 100)), []);
  // Never read: the reading it waits for asks in the language anyway.
  assertEquals(set(await deriveEvents(updated(['ocrLanguageManual']), tree(indexed({ ocrLanguageManual: 'en' })), 100)), []);
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

Deno.test('rule: a fingerprint embedding reports the file, not the embedding', async () => {
  const ctx = tree({
    [IMG]: file('f1'),
    [`${IMG}/metadata/sscd-image`]: {
      id: 'p1',
      type: 'embedding',
      attrs: { embeddingType: 'sscd-image', label: 'primary' },
    },
  });

  const facts = await deriveEvents(event('embedding', `${IMG}/metadata/sscd-image`), ctx, 100);

  assertEquals(facts.length, 1);
  assertEquals(facts[0].type, MEDIA_EVENTS.fingerprintComputed);
  assertEquals(facts[0].subject, IMG);
  assertEquals(facts[0].data?.kind, 'sscd-image');
});

Deno.test('rule: a chromaprint gaining its computedAt reports the recording, once per print', async () => {
  const print = `${SND}/metadata/chromaprint`;
  const nodes: Record<string, NodeSnapshot> = {
    [SND]: file('f1', { mimetype: 'audio/wav' }),
    [print]: { id: 'c1', type: 'file', attrs: { mimetype: 'application/x-chromaprint' } },
  };
  const ctx = tree(nodes);

  // compute-fingerprint writes the values first: nothing to announce yet.
  assertEquals(await deriveEvents(event('file', print), ctx, 100), []);

  nodes[print] = { id: 'c1', type: 'file', attrs: { mimetype: 'application/x-chromaprint', computedAt: '2026-10-10T10:00:00Z', label: 'primary' } };
  const facts = await deriveEvents({ ...event('file', print, 'updated'), changedAttrs: ['computedAt', 'computedBy', 'label', 'values'] }, ctx, 100);
  assertEquals(facts.length, 1);
  assertEquals(facts[0].type, MEDIA_EVENTS.fingerprintComputed);
  assertEquals(facts[0].subject, SND);
  assertEquals(facts[0].data?.kind, 'chromaprint');

  // Rewriting the values leaves computedAt alone and says nothing.
  assertEquals(await deriveEvents({ ...event('file', print, 'updated'), changedAttrs: ['size'] }, ctx, 100), []);
});

Deno.test('rule: a transcript gaining its transcribedAt reports the recording, once per transcription', async () => {
  const transcript = `${VID}/metadata/transcript`;
  const nodes: Record<string, NodeSnapshot> = {
    [VID]: file('f1', { mimetype: 'video/mp4' }),
    [transcript]: { id: 't1', type: 'file', attrs: {} },
  };
  const ctx = tree(nodes);

  // transcribe-file writes the cues first: nothing to announce yet.
  assertEquals(await deriveEvents(event('file', transcript), ctx, 100), []);

  nodes[transcript] = transcribed({ speech: true, language: 'sv' });
  const facts = await deriveEvents({ ...event('file', transcript, 'updated'), changedAttrs: ['mimetype', 'transcribedAt', 'speech', 'language'] }, ctx, 100);
  assertEquals(facts.length, 1);
  assertEquals(facts[0].type, MEDIA_EVENTS.transcriptGenerated);
  assertEquals(facts[0].subject, VID);
  assertEquals(facts[0].data, { mimetype: 'video/mp4', speech: true, language: 'sv' });

  // Its chunks are written beneath it; an update that leaves transcribedAt alone says nothing.
  assertEquals(await deriveEvents({ ...event('file', transcript, 'updated'), changedAttrs: ['size'] }, ctx, 100), []);
});

Deno.test('rule: an unrelated embedding produces nothing', async () => {
  const ctx = tree({
    [`${PEOPLE_ROOT}/alice/embedding`]: { id: 'x1', type: 'embedding', attrs: { embeddingType: 'face' } },
  });

  // embeddingType is 'face' but it is not the embedding of a region of a file
  assertEquals(await deriveEvents(event('embedding', `${PEOPLE_ROOT}/alice/embedding`), ctx, 100), []);
});

Deno.test('rule: node types with no media meaning are ignored', async () => {
  const ctx = tree({ [`${ALBUMS_ROOT}/x`]: { id: 'd1', type: 'directory', attrs: {} } });

  assertEquals(await deriveEvents(event('directory', `${ALBUMS_ROOT}/x`), ctx, 100), []);
  assertEquals(await deriveEvents(event('tty', '/dev/tty1'), ctx, 100), []);
});

Deno.test('rule: a deleted event without the attrs it had produces nothing', async () => {
  const ctx = tree({});

  assertEquals(await deriveEvents(event('file', IMG, 'deleted'), ctx, 100), []);
});

const deleted = (path: string, attrs: Record<string, unknown>): VfsEventInput => ({ ...event('file', path, 'deleted'), attrs });

Deno.test('rule: a removed media file is a fact, read from the attrs it had', async () => {
  // The tree is empty: the node is gone, and the rule must not need it.
  const facts = await deriveEvents(deleted(IMG, file('n1').attrs), tree({}), 100);

  assertEquals(facts.length, 1);
  assertEquals(facts[0].type, MEDIA_EVENTS.fileRemoved);
  assertEquals(facts[0].subject, IMG);
  assertEquals(facts[0].nodeId, 'n1');
  assertEquals(facts[0].data, { mimetype: 'image/jpeg', size: 1024, sha256: 'abc' });
});

Deno.test('rule: a removed derivative, non-media or empty file is no fact', async () => {
  for (const attrs of [{ sourceId: 'f0' }, { mimetype: 'application/pdf' }, { size: 0 }]) {
    assertEquals(await deriveEvents(deleted(IMG, file('n1', attrs).attrs), tree({}), 100), []);
  }
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
  // The file's own discovery still rides the same event.
  assertEquals(created.some((f) => f.type === MEDIA_EVENTS.fileDiscovered), true);

  const moved = await deriveEvents(event('file', path, 'moved'), ctx, 100);
  assertEquals(albumFacts(moved), [[IMPORTED, 'al2', 'member-attached']]);
});

Deno.test("album: a file created directly in an album is the album key's job, not the file's", async () => {
  const ctx = tree({ [ALBUM]: albumNode('al1'), [IMG]: file('f1') });

  assertEquals(albumFacts(await deriveEvents(event('file', IMG, 'created'), ctx, 100)), []);
});

Deno.test('album: extracted metadata and a computed fingerprint announce every album holding the member', async () => {
  const linked = `${ALBUMS_ROOT}/picked/a.jpg`;
  const ctx = tree({
    [ALBUM]: albumNode('al1'),
    [`${ALBUMS_ROOT}/picked`]: albumNode('al3'),
    [IMPORTED]: albumNode('al2'),
    [`${IMPORTED}/files`]: dirNode('d2'),
    [IMG]: file('f1', { takenAt: '2020-01-01T00:00:00' }),
    [`${IMG}/metadata/exif`]: { id: 'e1', type: 'exif', attrs: { indexedAt: 't' } },
    [`${IMG}/metadata/sscd-image`]: { id: 'p1', type: 'embedding', attrs: { embeddingType: 'sscd-image', label: 'primary' } },
  }, {
    // Hard-linked at its own path and under the imported album's files/, softlinked from an album it was added to.
    containersOf: () => Promise.resolve([ALBUM, `${IMPORTED}/files`, parentOf(linked)]),
  });

  const exif = await deriveEvents(event('exif', `${IMG}/metadata/exif`, 'updated'), ctx, 100);
  assertEquals(exif[0].type, MEDIA_EVENTS.metadataExtracted);
  assertEquals(albumFacts(exif), [[ALBUM, 'al1', 'member-indexed'], [IMPORTED, 'al2', 'member-indexed'], [`${ALBUMS_ROOT}/picked`, 'al3', 'member-indexed']]);

  const printed = await deriveEvents(event('embedding', `${IMG}/metadata/sscd-image`), ctx, 100);
  assertEquals(printed[0].type, MEDIA_EVENTS.fingerprintComputed);
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
 * `media.metadata.extracted`. Written out here rather than assembled per test, because the gap
 * rule is exactly the complement of it and a term missing from both sides would pass silently.
 */
const indexed = (attrs: Record<string, unknown> = {}, path = IMG): Record<string, NodeSnapshot> => ({
  [path]: file('f1', { facesAt: '2026-08-23T00:00:00Z', ...attrs }),
  [`${path}/metadata/exif`]: exifNode(),
  [`${path}/metadata/sscd-image`]: { id: 'p1', type: 'embedding', attrs: { embeddingType: 'sscd-image' } },
  [`${path}/thumbnails`]: { id: 't1', type: 'directory', attrs: {} },
});

/** A finished transcript: `transcribe-file` writes `transcribedAt` once the cues are in. */
const transcribed = (attrs: Record<string, unknown> = {}): NodeSnapshot => ({
  id: 'tr',
  type: 'file',
  attrs: { mimetype: 'text/vtt', transcribedAt: '2026-08-23T00:00:00Z', speech: false, ...attrs },
});

/** A rendition under `thumbnails/` — it carries the id of the file it was made from. */
const rendition = (id: string): NodeSnapshot => ({ id, type: 'file', attrs: { sourceId: 'f1', size: 4096 } });

/**
 * Complete for a video: its transcript, the poster frame `media-stills` writes, and both renditions
 * `media-transcode` writes beside it — the 1080p one the lightbox plays and the muted hover
 * clip a tile plays. They share `thumbnails/` with the poster frames, which is exactly why the
 * derivatives term cannot stand in for a transcode term.
 *
 * No `facesAt`: a video indexed before its faces were looked for has none, so an image's marker
 * must not creep in here and hide a term that reads it.
 */
const indexedVideo = (attrs: Record<string, unknown> = {}): Record<string, NodeSnapshot> => {
  const nodes = indexed({ mimetype: 'video/mp4', duration: 42, ...attrs }, VID);
  delete nodes[VID].attrs.facesAt;
  nodes[`${VID}/thumbnails/512x512.avif`] = rendition('r0');
  nodes[`${VID}/thumbnails/1920x1080.mp4`] = rendition('r1');
  nodes[`${VID}/thumbnails/480x480.mp4`] = rendition('r2');
  nodes[`${VID}/metadata/transcript`] = transcribed();
  return nodes;
};

/** Complete for audio: its transcript, the waveform picture, and the one normalised track. */
const indexedAudio = (attrs: Record<string, unknown> = {}): Record<string, NodeSnapshot> => {
  const nodes = indexed({ mimetype: 'audio/x-wav', duration: 180, ...attrs }, SND);
  delete nodes[SND].attrs.facesAt;
  nodes[`${SND}/thumbnails/512x512.avif`] = rendition('r0');
  nodes[`${SND}/thumbnails/128k-44100.m4a`] = rendition('r1');
  nodes[`${SND}/metadata/transcript`] = transcribed();
  return nodes;
};

Deno.test('gap: a fully indexed file needs nothing', async () => {
  assertEquals(await deriveGaps(IMG, tree(indexed()), 100), []);
});

Deno.test('gap: a video or a recording without a transcript re-opens the fan-out', async () => {
  const video = indexedVideo();
  delete video[`${VID}/metadata/transcript`];
  assertEquals((await deriveGaps(VID, tree(video), 100)).map((f) => f.type), [MEDIA_EVENTS.metadataExtracted]);

  const audio = indexedAudio();
  delete audio[`${SND}/metadata/transcript`];
  assertEquals((await deriveGaps(SND, tree(audio), 100)).map((f) => f.type), [MEDIA_EVENTS.metadataExtracted]);
});

Deno.test('gap: exif but no face detection re-opens the fan-out', async () => {
  // An image indexed before face detection could run on it: no event was ever emitted for it,
  // and `skipIfAttr: facesAt` cannot help a pipeline nothing announces. Without a term here the
  // file is complete as far as the reconciler is concerned, forever.
  const nodes = indexed();
  nodes[IMG] = file('f1', { mimetype: 'image/x-fujifilm-raf' });
  const ctx = tree(nodes);

  const facts = await deriveGaps(IMG, ctx, 100);

  assertEquals(facts.map((f) => f.type), [MEDIA_EVENTS.metadataExtracted]);
  assertEquals(facts[0].data?.mimetype, 'image/x-fujifilm-raf');
});

Deno.test('gap: a video without a face marker is not a gap', async () => {
  // A video indexed before its faces were looked for is left for the next import to detect.
  assertEquals(await deriveGaps(VID, tree(indexedVideo()), 100), []);
});

Deno.test('gap: a video with poster frames but no transcode re-opens the fan-out', async () => {
  // The one-way door this term exists for: the renditions live under `thumbnails/` next to the
  // poster frames, so a video that got its still frames and nothing else has a `thumbnails/`
  // directory and reads as complete to every other term.
  const nodes = indexedVideo();
  delete nodes[`${VID}/thumbnails/1920x1080.mp4`];
  delete nodes[`${VID}/thumbnails/480x480.mp4`];

  const facts = await deriveGaps(VID, tree(nodes), 100);

  assertEquals(facts.map((f) => f.type), [MEDIA_EVENTS.metadataExtracted]);
  assertEquals(facts[0].subject, VID);
  assertEquals(facts[0].data?.mimetype, 'video/mp4');
});

Deno.test('gap: a video missing only its hover clip is still a gap', async () => {
  // Both renditions come out of one step, so a half-done transcode is a failed one.
  const nodes = indexedVideo();
  delete nodes[`${VID}/thumbnails/480x480.mp4`];

  assertEquals((await deriveGaps(VID, tree(nodes), 100)).map((f) => f.type), [MEDIA_EVENTS.metadataExtracted]);
});

Deno.test('gap: a clip too short for a hover preview is complete with one rendition', async () => {
  // `generate-derivatives` skips the clip below MIN_PREVIEW_SECONDS because the poster frame
  // already is the whole video. Asking for it anyway would republish the file on every scan.
  const nodes = indexedVideo({ duration: 1.2 });
  delete nodes[`${VID}/thumbnails/480x480.mp4`];

  assertEquals(await deriveGaps(VID, tree(nodes), 100), []);
});

Deno.test('gap: a video indexed before `duration` was promoted still owes a hover clip', async () => {
  const nodes = indexedVideo({ duration: undefined });
  delete nodes[`${VID}/thumbnails/480x480.mp4`];

  assertEquals((await deriveGaps(VID, tree(nodes), 100)).map((f) => f.type), [MEDIA_EVENTS.metadataExtracted]);
});

/** The budget signature as EMS reports it in `capabilities.encode.cpu_budget`. */
const BUDGET = '4000/170/64';

/** A video whose 1080p rendition was refused, with the refusal recorded on the file node. */
const refusedVideo = (budget = BUDGET): Record<string, NodeSnapshot> => {
  const nodes = indexedVideo();
  delete nodes[`${VID}/thumbnails/1920x1080.mp4`];
  nodes[VID].attrs[TRANSCODE_REFUSED_ATTR] = {
    '1920x1080.mp4': { reason: 'a CPU decode of 125675 frames projects to 21364MB', budget, at: 1 },
  };
  return nodes;
};

Deno.test('gap: a rendition refused at the budget in force is not a gap', async () => {
  // The whole point of the marker: EMS will refuse this source identically every time, so
  // announcing it again only spends two more `media-transcode` attempts on it.
  assertEquals(await deriveGaps(VID, tree(refusedVideo(), { cpuEncodeBudget: BUDGET }), 100), []);
});

Deno.test('gap: a refusal recorded at a different budget re-opens the gap', async () => {
  // Raising EMS_CPU_ENCODE_MAX_MB on the service is exactly the act that should make the file
  // worth another attempt, and it must not need anyone to clear the attr by hand.
  const ctx = tree(refusedVideo('4000/170/64'), { cpuEncodeBudget: '8000/170/64' });

  assertEquals((await deriveGaps(VID, ctx, 100)).map((f) => f.type), [MEDIA_EVENTS.metadataExtracted]);
});

Deno.test('gap: a refusal is not trusted when the host budget is unknown', async () => {
  // No `cpuEncodeBudget` in the context means nothing can be compared, and the safe direction is
  // to re-announce: that costs attempts, where wrongly excluding costs the rendition forever.
  assertEquals((await deriveGaps(VID, tree(refusedVideo()), 100)).map((f) => f.type), [MEDIA_EVENTS.metadataExtracted]);
});

Deno.test('gap: a refusal for one rendition does not excuse the other', async () => {
  const nodes = refusedVideo();
  delete nodes[`${VID}/thumbnails/480x480.mp4`];

  const ctx = tree(nodes, { cpuEncodeBudget: BUDGET });

  assertEquals((await deriveGaps(VID, ctx, 100)).map((f) => f.type), [MEDIA_EVENTS.metadataExtracted]);
});

Deno.test('gap: a stale refusal for a rendition that exists cannot mask a missing one', async () => {
  // A refusal left behind after the rendition was made by hand must not be counted a second
  // time — otherwise the pair reads as complete while one of them is genuinely absent.
  const nodes = indexedVideo();
  delete nodes[`${VID}/thumbnails/480x480.mp4`];
  nodes[VID].attrs[TRANSCODE_REFUSED_ATTR] = {
    '1920x1080.mp4': { reason: 'over budget', budget: BUDGET, at: 1 },
  };

  const ctx = tree(nodes, { cpuEncodeBudget: BUDGET });

  assertEquals((await deriveGaps(VID, ctx, 100)).map((f) => f.type), [MEDIA_EVENTS.metadataExtracted]);
});

Deno.test('gap: a non-object refusal attr is ignored rather than thrown on', async () => {
  const nodes = indexedVideo();
  delete nodes[`${VID}/thumbnails/1920x1080.mp4`];
  nodes[VID].attrs[TRANSCODE_REFUSED_ATTR] = 'over budget';

  const ctx = tree(nodes, { cpuEncodeBudget: BUDGET });

  assertEquals((await deriveGaps(VID, ctx, 100)).map((f) => f.type), [MEDIA_EVENTS.metadataExtracted]);
});

Deno.test('gap: an audio file with no rendition re-opens the fan-out', async () => {
  const nodes = indexedAudio();
  delete nodes[`${SND}/thumbnails/128k-44100.m4a`];

  assertEquals((await deriveGaps(SND, tree(nodes), 100)).map((f) => f.type), [MEDIA_EVENTS.metadataExtracted]);
});

Deno.test('gap: a fully transcoded audio file needs nothing', async () => {
  assertEquals(await deriveGaps(SND, tree(indexedAudio()), 100), []);
});

Deno.test('gap: a recording fingerprinted with no print to show is complete', async () => {
  const unprinted = indexedAudio();
  delete unprinted[`${SND}/metadata/sscd-image`];
  assertEquals((await deriveGaps(SND, tree(unprinted), 100)).map((f) => f.type), [MEDIA_EVENTS.metadataExtracted]);

  const tooShort = indexedAudio({ fingerprintedAt: '2026-10-11T10:00:00Z' });
  delete tooShort[`${SND}/metadata/sscd-image`];
  assertEquals(await deriveGaps(SND, tree(tooShort), 100), []);
});

Deno.test('gap: an image is never asked for a transcode', async () => {
  // The term must not reach for a listing on a media type that has no transcode at all — an
  // image's `thumbnails/` holds only .avif, so counting mp4s there would make every photo a gap.
  const nodes = indexed();
  nodes[`${IMG}/thumbnails/512x512.avif`] = rendition('r0');

  assertEquals(await deriveGaps(IMG, tree(nodes), 100), []);
});

Deno.test('gap: an undecodable video is not a transcode gap', async () => {
  const nodes = indexedVideo({ undecodable: 'moov atom not found' });
  delete nodes[`${VID}/thumbnails/1920x1080.mp4`];
  delete nodes[`${VID}/thumbnails/480x480.mp4`];

  assertEquals(await deriveGaps(VID, tree(nodes), 100), []);
});

Deno.test('gap: an undecodable source is not a gap', async () => {
  // Nothing downstream can ever fill these in, so announcing them again on every scan only
  // republishes the same file — the redundancy media-scan is built to avoid.
  const nodes = indexed();
  nodes[IMG] = file('f1', { mimetype: 'video/quicktime', undecodable: 'moov atom not found' });
  delete nodes[`${IMG}/metadata/sscd-image`];
  delete nodes[`${IMG}/thumbnails`];

  assertEquals(await deriveGaps(IMG, tree(nodes), 100), []);
});

Deno.test('gap: exif but no derivatives re-opens the fan-out', async () => {
  const nodes = indexed();
  delete nodes[`${IMG}/thumbnails`];
  const ctx = tree(nodes);

  const facts = await deriveGaps(IMG, ctx, 100);

  assertEquals(facts.length, 1);
  assertEquals(facts[0].type, MEDIA_EVENTS.metadataExtracted);
  assertEquals(facts[0].subject, IMG);
});

Deno.test('gap: exif but no fingerprint re-opens the fan-out', async () => {
  const nodes = indexed();
  delete nodes[`${IMG}/metadata/sscd-image`];
  const ctx = tree(nodes);

  const facts = await deriveGaps(IMG, ctx, 100);

  assertEquals(facts.map((f) => f.type), [MEDIA_EVENTS.metadataExtracted]);
});

Deno.test('gap: a picture marked fingerprinted without a print of its own is not done', async () => {
  // Only a recording can be too short for a print; a picture always gets one.
  const nodes = indexed({ fingerprintedAt: '2026-10-11T10:00:00Z' });
  delete nodes[`${IMG}/metadata/sscd-image`];
  nodes[`${IMG}/metadata/other-print`] = { id: 'o1', type: 'embedding', attrs: { embeddingType: 'other-print' } };

  assertEquals((await deriveGaps(IMG, tree(nodes), 100)).map((f) => f.type), [MEDIA_EVENTS.metadataExtracted]);
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

Deno.test('gap: an unindexed file is discovery, not a gap', async () => {
  const ctx = tree({ [IMG]: file('f1') });

  assertEquals(await deriveGaps(IMG, ctx, 100), []);
});

// --- transcript staleness --------------------------------------------------------------
//
// A transcript decoded with settings EMS no longer uses is transcribed again. What these pin is
// that the comparison is inert without EMS's own answer and compares only transcripts that were
// actually decoded, and that a transcript an interrupted run left is redone whatever EMS says.

const DECODE = 'whisper-large-v3:vad=0.2/800/2000,nospeech=0.8,lang=auto,words=0';
const OLD_DECODE = 'whisper-large-v3:vad=0.5/400/500,nospeech=1.0,lang=auto,words=0';

const transcribedVideo = (attrs: Record<string, unknown>): Record<string, NodeSnapshot> => {
  const nodes = indexedVideo();
  nodes[`${VID}/metadata/transcript`] = transcribed(attrs);
  return nodes;
};

Deno.test('transcript: no generation configured means transcripts are never stale', async () => {
  // Undefined is what media-scan passes when EMS cannot be asked, or with
  // CFG_MEDIA_TRANSCRIPTS_CURRENT=off; a guessed value here would re-transcribe the archive
  // against a literal nothing writes.
  const nodes = transcribedVideo({ transcribedBy: 'whisper-large-v3', transcribedWith: OLD_DECODE });

  assertEquals(await deriveGaps(VID, tree(nodes), 100), []);
});

Deno.test('transcript: other decode settings are a gap', async () => {
  const nodes = transcribedVideo({ transcribedBy: 'whisper-large-v3', transcribedWith: OLD_DECODE });

  const facts = await deriveGaps(VID, tree(nodes, { transcriptGeneration: DECODE }), 100);

  assertEquals(facts.map((f) => f.type), [MEDIA_EVENTS.transcriptStale]);
  assertEquals(facts[0].data?.transcribedWith, OLD_DECODE);
  assertEquals(facts[0].data?.expectedTranscribedWith, DECODE);
});

Deno.test('transcript: one written before stamping is a gap', async () => {
  // A transcript decoded with no record of how.
  const nodes = transcribedVideo({ transcribedBy: 'whisper-large-v3' });

  const facts = await deriveGaps(VID, tree(nodes, { transcriptGeneration: DECODE }), 100);

  assertEquals(facts.map((f) => f.type), [MEDIA_EVENTS.transcriptStale]);
  assertEquals(facts[0].data?.transcribedWith, '');
});

Deno.test('transcript: the current decode settings are not a gap', async () => {
  // The termination condition.
  const nodes = transcribedVideo({ transcribedBy: 'whisper-large-v3', transcribedWith: DECODE });

  assertEquals(await deriveGaps(VID, tree(nodes, { transcriptGeneration: DECODE }), 100), []);
});

Deno.test('transcript: a file with no audio track is not a gap', async () => {
  // transcribe-file writes the node with both provenance attrs null when whisper never ran, and
  // transcribing again writes the same nulls back — so comparing it would re-announce forever.
  const nodes = transcribedVideo({ transcribedBy: null, transcribedWith: null, segmentCount: 0 });

  assertEquals(await deriveGaps(VID, tree(nodes, { transcriptGeneration: DECODE }), 100), []);
});

Deno.test('transcript: one an interrupted run left without transcribedAt is a gap, whatever EMS says', async () => {
  const nodes = transcribedVideo({});
  delete nodes[`${VID}/metadata/transcript`].attrs.transcribedAt;

  for (const ctx of [tree(nodes), tree(nodes, { transcriptGeneration: DECODE })]) {
    assertEquals((await deriveGaps(VID, ctx, 100)).map((f) => f.type), [MEDIA_EVENTS.transcriptStale]);
  }
});

Deno.test('transcript: audio is checked too', async () => {
  const nodes = indexedAudio();
  nodes[`${SND}/metadata/transcript`] = transcribed({ transcribedBy: 'whisper-large-v3', transcribedWith: OLD_DECODE });

  const facts = await deriveGaps(SND, tree(nodes, { transcriptGeneration: DECODE }), 100);

  assertEquals(facts.map((f) => f.type), [MEDIA_EVENTS.transcriptStale]);
});

Deno.test('transcript: an undecodable source is never transcribed again', async () => {
  const nodes = transcribedVideo({ transcribedBy: 'whisper-large-v3', transcribedWith: OLD_DECODE });
  nodes[VID] = { ...nodes[VID], attrs: { ...nodes[VID].attrs, undecodable: 'ffprobe: moov atom not found' } };

  assertEquals(await deriveGaps(VID, tree(nodes, { transcriptGeneration: DECODE }), 100), []);
});

const SIGLIP = 'ViT-SO400M-16-SigLIP2-384__webli';
const pictureFacts = (facts: Omit<DomainEvent, 'id'>[]) => facts.filter((f) => f.type === MEDIA_EVENTS.pictureStale);

Deno.test('picture: a photo without picture vectors is announced', async () => {
  const facts = pictureFacts(await deriveGaps(IMG, tree(indexed(), { pictureGeneration: SIGLIP }), 100));
  assertEquals(facts.length, 1);
  assertEquals(facts[0].subject, IMG);
  assertEquals(facts[0].data, { mimetype: 'image/jpeg', embeddedBy: '', expected: SIGLIP });
});

Deno.test('picture: vectors from the current embedder are not a gap', async () => {
  const nodes = indexed();
  nodes[`${IMG}/metadata/picture`] = { id: 'pic', type: 'directory', attrs: { embeddedBy: SIGLIP } };
  assertEquals(pictureFacts(await deriveGaps(IMG, tree(nodes, { pictureGeneration: SIGLIP }), 100)), []);
});

Deno.test('picture: another embedder, or a half-written directory, is re-embedded', async () => {
  for (const attrs of [{ embeddedBy: 'ViT-B-32__openai' }, {}]) {
    const nodes = indexedVideo();
    nodes[`${VID}/metadata/picture`] = { id: 'pic', type: 'directory', attrs };
    const facts = pictureFacts(await deriveGaps(VID, tree(nodes, { pictureGeneration: SIGLIP }), 100));
    assertEquals(facts.map((f) => f.data?.embeddedBy), [String((attrs as { embeddedBy?: string }).embeddedBy ?? '')]);
  }
});

Deno.test('picture: audio, undecodable sources and an unanswering EMS ask nothing', async () => {
  assertEquals(pictureFacts(await deriveGaps(SND, tree(indexedAudio(), { pictureGeneration: SIGLIP }), 100)), []);
  assertEquals(pictureFacts(await deriveGaps(IMG, tree(indexed({ undecodable: 'no frame table' }), { pictureGeneration: SIGLIP }), 100)), []);
  assertEquals(pictureFacts(await deriveGaps(IMG, tree(indexed()), 100)), []);
});

const PPOCR = 'PP-OCRv6_medium';
const ocrFacts = (facts: Omit<DomainEvent, 'id'>[]) => facts.filter((f) => f.type === MEDIA_EVENTS.ocrStale);
const READ_AT = '2026-10-18T08:00:00Z';

Deno.test('ocr: a picture read by another engine is read again', async () => {
  const facts = ocrFacts(await deriveGaps(IMG, tree(indexed({ textIndexedAt: READ_AT, ocrBy: 'PP-OCRv6_small' }), { ocrGeneration: PPOCR }), 100));
  assertEquals(facts.map((f) => [f.subject, f.data]), [[IMG, { mimetype: 'image/jpeg', ocrBy: 'PP-OCRv6_small', expected: PPOCR }]]);
});

Deno.test('ocr: a picture read by the current engine or by Tesseract, never read, undecodable, or with EMS silent asks nothing', async () => {
  assertEquals(ocrFacts(await deriveGaps(IMG, tree(indexed({ textIndexedAt: READ_AT, ocrBy: PPOCR }), { ocrGeneration: PPOCR }), 100)), []);
  // Tesseract stamped no engine: its reading stays until a reset reads the picture anew.
  assertEquals(ocrFacts(await deriveGaps(IMG, tree(indexed({ textIndexedAt: READ_AT }), { ocrGeneration: PPOCR }), 100)), []);
  // Never read is the text gap's, not this one.
  assertEquals(ocrFacts(await deriveGaps(IMG, tree(indexed(), { ocrGeneration: PPOCR }), 100)), []);
  assertEquals(
    ocrFacts(await deriveGaps(IMG, tree(indexed({ textIndexedAt: READ_AT, ocrBy: 'PP-OCRv6_small', undecodable: 'no frame table' }), { ocrGeneration: PPOCR }), 100)),
    [],
  );
  assertEquals(ocrFacts(await deriveGaps(IMG, tree(indexed({ textIndexedAt: READ_AT, ocrBy: 'PP-OCRv6_small' })), 100)), []);
  assertEquals(ocrFacts(await deriveGaps(VID, tree(indexedVideo(), { ocrGeneration: PPOCR }), 100)), []);
});

const JINA = 'jina-embeddings-v5-text-small';
const textFacts = (facts: Omit<DomainEvent, 'id'>[]) => facts.filter((f) => f.type === MEDIA_EVENTS.textEmbeddingStale);
const textVector = (attrs: Record<string, unknown> = {}): NodeSnapshot => ({ id: 'tv', type: 'embedding', attrs: { embeddedBy: JINA, ...attrs } });

/** A video whose extracted text and transcript have current vectors. */
const embeddedVideo = (): Record<string, NodeSnapshot> => {
  const nodes = indexedVideo();
  nodes[`${VID}/metadata/content`] = { id: 'c1', type: 'file', attrs: { size: 120 } };
  nodes[`${VID}/metadata/content/text_jina5s`] = textVector();
  nodes[`${VID}/metadata/transcript`] = transcribed({ size: 900, speech: true });
  nodes[`${VID}/metadata/transcript/text_jina5s`] = { id: 'ts', type: 'directory', attrs: { embeddedBy: JINA, chunkSeconds: CHUNK_TARGET_SECONDS } };
  return nodes;
};

Deno.test('text: texts with vectors from the current embedder are not a gap', async () => {
  assertEquals(textFacts(await deriveGaps(VID, tree(embeddedVideo(), { textGeneration: JINA }), 100)), []);
});

Deno.test('text: a missing vector, another model and another chunk length are announced, per text', async () => {
  const nodes = embeddedVideo();
  nodes[`${VID}/metadata/transcript/text_jina5s`].attrs.chunkSeconds = 30;
  nodes[`${VID}/metadata/content/text_jina5s`] = textVector({ embeddedBy: 'another-text-model' });

  const facts = textFacts(await deriveGaps(VID, tree(nodes, { textGeneration: JINA }), 100));

  assertEquals(facts.length, 1);
  assertEquals(facts[0].subject, VID);
  assertEquals(facts[0].data, { mimetype: 'video/mp4', stale: ['content', 'transcript'], expected: JINA });
});

Deno.test('text: a hand-written description needs a vector of its text as it is now', async () => {
  const text = 'Anna Andersson on a sailboat';
  const nodes = embeddedVideo();
  nodes[VID].attrs.description = `${text} `;
  const ctx = tree(nodes, { textGeneration: JINA });
  assertEquals(textFacts(await deriveGaps(VID, ctx, 100)).map((f) => f.data?.stale), [['authored']]);

  nodes[`${VID}/metadata/authored`] = { id: 'a1', type: 'directory', attrs: {} };
  nodes[`${VID}/metadata/authored/text_jina5s`] = textVector({ authoredHash: await authoredHash('an earlier text') });
  assertEquals(textFacts(await deriveGaps(VID, ctx, 100)).map((f) => f.data?.stale), [['authored']]);

  nodes[`${VID}/metadata/authored/text_jina5s`] = textVector({ authoredHash: await authoredHash(text) });
  assertEquals(textFacts(await deriveGaps(VID, ctx, 100)), []);
});

Deno.test('text: a text with nothing to embed is never a gap', async () => {
  // A silent recording keeps no chunk set and an empty text node gives no vector, so announcing
  // either would republish the file on every scan.
  const nodes = embeddedVideo();
  delete nodes[`${VID}/metadata/content/text_jina5s`];
  delete nodes[`${VID}/metadata/transcript/text_jina5s`];
  nodes[`${VID}/metadata/content`].attrs.size = 0;
  nodes[`${VID}/metadata/transcript`].attrs.speech = false;
  assertEquals(textFacts(await deriveGaps(VID, tree(nodes, { textGeneration: JINA }), 100)), []);
});

Deno.test('text: no answer from EMS, or a model with no type, asks nothing', async () => {
  const nodes = embeddedVideo();
  delete nodes[`${VID}/metadata/content/text_jina5s`];
  assertEquals(textFacts(await deriveGaps(VID, tree(nodes), 100)), []);
  assertEquals(textFacts(await deriveGaps(VID, tree(nodes, { textGeneration: 'a-model-nothing-knows' }), 100)), []);
});

Deno.test('text: a file announced for a new transcript is not also announced for its vectors', async () => {
  // A new transcript embeds its chunks again, and the next scan finds whatever else is left.
  const nodes = embeddedVideo();
  nodes[`${VID}/metadata/transcript`].attrs.transcribedBy = 'whisper-large-v3';
  nodes[`${VID}/metadata/transcript`].attrs.transcribedWith = 'old-settings';
  delete nodes[`${VID}/metadata/transcript/text_jina5s`];
  const facts = await deriveGaps(VID, tree(nodes, { textGeneration: JINA, transcriptGeneration: 'new-settings' }), 100);
  assertEquals(facts.map((f) => f.type).includes(MEDIA_EVENTS.transcriptStale), true);
  assertEquals(textFacts(facts), []);
});

Deno.test('gap: a document or picture with no textIndexedAt is a text gap; other media and derivatives are not', () => {
  const PDF = `${ALBUMS_ROOT}/x/a.pdf`;
  const gap = (attrs: Record<string, unknown>) => deriveTextGap(PDF, file('f1', attrs), 100).map((fact) => fact.type);

  assertEquals(gap({ mimetype: 'application/pdf' }), [MEDIA_EVENTS.textMissing]);
  assertEquals(gap({ mimetype: 'image/jpeg' }), [MEDIA_EVENTS.textMissing]);
  assertEquals(deriveTextGap(PDF, file('f1', { mimetype: 'text/plain' }), 100)[0].data, { mimetype: 'text/plain' });

  assertEquals(gap({ mimetype: 'application/pdf', textIndexedAt: '2026-10-17T08:00:00Z' }), []);
  // A camera RAW is read through its preview, like any picture.
  assertEquals(gap({ mimetype: 'image/x-canon-cr2' }), [MEDIA_EVENTS.textMissing]);
  assertEquals(gap({ mimetype: 'video/mp4' }), []);
  assertEquals(gap({ mimetype: 'application/json' }), []);
  assertEquals(gap({ mimetype: 'image/jpeg', sourceId: 'f0' }), []);
  assertEquals(gap({ mimetype: 'application/pdf', size: 0 }), []);
  // A node's own metadata is no document: an album's description, a file's extracted text.
  assertEquals(deriveTextGap(`${ALBUMS_ROOT}/x/metadata/description`, file('f1', { mimetype: 'text/plain' }), 100), []);
  assertEquals(deriveTextGap(`${PDF}/metadata/content`, file('f1', { mimetype: 'text/plain' }), 100), []);
});

Deno.test('rule: a directory moved whole announces the text gap of each unread file within it', async () => {
  const dir = `${ALBUMS_ROOT}/x/files/trip`;
  const within: Record<string, NodeSnapshot> = {
    [`${dir}/menu.pdf`]: file('f1', { mimetype: 'application/pdf' }),
    [`${dir}/day-2/IMG_0001.jpg`]: file('f2'),
    [`${dir}/IMG_0002.cr2`]: file('f3', { mimetype: 'image/x-canon-cr2' }),
    [`${dir}/clip.mp4`]: file('f4', { mimetype: 'video/mp4' }),
  };
  const asked: string[] = [];
  const ctx = tree({}, {
    unreadFilesWithin: (path) => {
      asked.push(path);
      return Promise.resolve(Object.entries(within).map(([path, node]) => ({ path, node })));
    },
  });

  const facts = await deriveEvents(event('directory', dir, 'moved'), ctx, 100);

  assertEquals(asked, [dir]);
  assertEquals(facts.map((fact) => [fact.type, fact.subject]), [
    [MEDIA_EVENTS.textMissing, `${dir}/menu.pdf`],
    [MEDIA_EVENTS.textMissing, `${dir}/day-2/IMG_0001.jpg`],
    [MEDIA_EVENTS.textMissing, `${dir}/IMG_0002.cr2`],
  ]);
  // Any other change to a directory is not a move.
  assertEquals(await deriveEvents(event('directory', dir, 'updated'), ctx, 100), []);
  assertEquals(asked, [dir]);
});
