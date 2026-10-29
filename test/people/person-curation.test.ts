/**
 * The curation half of face recognition: listing the people it invented,
 * naming one, merging two, and undoing a run.
 */

import { PEOPLE_ROOT } from '@archive/paths';
import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS } from '@ein/testing';
import { captureTime, createTestContext } from '@ein/testing';

const testCtx = createTestContext({ modules: ['archive'] });

type FaceThumb = { facePath: string; confidence: number };
type UnknownPerson = { id: string; path: string; name: string; faceCount: number; faces: FaceThumb[] };
type UnknownList = { total: number; offset: number; nextOffset?: number; people: UnknownPerson[] };
type NameResult = { ok: boolean; id: string; path: string; slug: string };
type MergeReport = { src: string; dst: string; faces: number; events: number; relations: number; links: number; conflicts: number; deleted: boolean; dryRun: boolean };
type MergeResult = {
  ok: boolean;
  dst: string;
  merged: MergeReport[];
  failed: { src: string; error: string }[];
  faces: number;
  events: number;
  relations: number;
  links: number;
  conflicts: number;
  dryRun: boolean;
};
type ResetResult = { source: string; cleared: number; peopleDeleted: number };
type DetachResult = {
  ok: boolean;
  detached: number;
  locked: number;
  person: { id: string; path: string; name: string } | null;
  removedPeople: string[];
  failed: { facePath: string; error: string }[];
  dryRun: boolean;
};
type DiscardResult = { ok: boolean; discarded: { path: string; regions: number; voices: number }[]; failed: { person: string; error: string }[]; dryRun: boolean };
type PersonFace = { facePath: string; hasFace: boolean; filePath?: string; takenAt?: string; confidence: number; personSource?: string };
type FaceList = {
  person: { id: string; path: string; name: string; unnamed: boolean; faceCount: number };
  total: number;
  offset: number;
  nextOffset?: number;
  faces: PersonFace[];
};

Deno.test({
  name: 'person curation',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();

  const attrsOf = (path: string) =>
    vfs.get<{ personId?: string; personSource?: string; unnamed?: boolean; name?: string; assignLocked?: boolean }>(ADMIN_ACCESS, path).then((n) => n.attrs);

  /** An unnamed person with `count` faces, each in its own image. */
  const seedUnknown = async (tag: string, count: number, source = 'cluster') => {
    const person = await vfs.create(ADMIN_ACCESS, 'person', `${PEOPLE_ROOT}/unknown`, tag, {
      props: { uid: 1000, gid: 1000, mode: 0o775 },
      attrs: { name: `Unknown ${tag}`, unnamed: true, origin: 'face', createdBy: 'cluster-faces', createdAt: '2026-07-01T00:00:00Z' },
    });
    await vfs.ensure(ADMIN_ACCESS, 'directory', `${PEOPLE_ROOT}/unknown/${tag}`, 'events', { props: { uid: 1000, gid: 1000, mode: 0o775 } });

    const facePaths: string[] = [];
    for (let i = 0; i < count; i++) {
      const image = `/img/${tag}-${i}.jpg`;
      await client.exec('mkdir -p /img');
      await client.exec(`echo x > ${image}`);
      await vfs.update(ADMIN_ACCESS, image, { attrs: { mimetype: 'image/jpeg' } });
      await client.exec(`mkdir -p ${image}/regions`);
      const fileId = (await vfs.get(ADMIN_ACCESS, image)).id;
      const facePath = `${image}/regions/face-0`;
      await vfs.create(ADMIN_ACCESS, 'media-region', `${image}/regions`, 'face-0', {
        props: { uid: 1000, gid: 1000, mode: 0o644 },
        attrs: {
          fileId,
          personId: person.id,
          personSource: source,
          confidence: 0.9 - i * 0.1,
          detectedBy: 'insightface-buffalo_l',
        },
      });
      await vfs.create(ADMIN_ACCESS, 'embedding', facePath, 'embedding', {
        props: { uid: 1000, gid: 1000, mode: 0o644 },
        attrs: { embeddingType: 'face', capacity: 8 },
      });
      facePaths.push(facePath);
    }
    return { id: person.id, path: `${PEOPLE_ROOT}/unknown/${tag}`, facePaths };
  };

  try {
    await client.exec(`mkdir -p ${PEOPLE_ROOT}/unknown`);

    const big = await seedUnknown('aaa', 3);
    const small = await seedUnknown('bbb', 1);

    await t.step('person-unknown lists them with face counts and crops', async () => {
      const res = await client.execJson<UnknownList>('person-unknown');
      assertEquals(res.total, 2);
      // Sorted by face count, so the person worth naming first is first.
      assertEquals(res.people[0].id, big.id);
      assertEquals(res.people[0].faceCount, 3);
      assertEquals(res.people[1].faceCount, 1);
      // Crops are ordered best-first.
      assertEquals(res.people[0].faces.length, 3);
      assertEquals(res.people[0].faces[0].facePath, big.facePaths[0]);
    });

    await t.step('--faces caps the crops per person', async () => {
      const res = await client.execJson<UnknownList>('person-unknown --faces 1');
      assertEquals(res.people[0].faces.length, 1);
    });

    await t.step('--limit pages, and nextOffset starts the next page until the last', async () => {
      const first = await client.execJson<UnknownList>('person-unknown --limit 1');
      assertEquals(first.people.map((p) => p.id), [big.id]);
      assertEquals(first.total, 2);
      assertEquals(first.nextOffset, 1);

      const second = await client.execJson<UnknownList>(`person-unknown --limit 1 --offset ${first.nextOffset}`);
      assertEquals(second.people.map((p) => p.id), [small.id]);
      assertEquals(second.nextOffset, undefined);
    });

    await t.step('--min-faces drops smaller clusters from the page and the total', async () => {
      const res = await client.execJson<UnknownList>('person-unknown --min-faces 2');
      assertEquals(res.total, 1);
      assertEquals(res.people.map((p) => p.id), [big.id]);
    });

    await t.step('--sort created still counts the faces of the people on its page', async () => {
      // Created at the same instant, so the id breaks the tie.
      const res = await client.execJson<UnknownList>('person-unknown --sort created');
      assertEquals(res.people.map((p) => [p.id, p.faceCount]), [[big.id, 3], [small.id, 1]]);
    });

    await t.step('--limit 0 answers the total alone', async () => {
      const res = await client.execJson<UnknownList>('person-unknown --limit 0');
      assertEquals(res.total, 2);
      assertEquals(res.people, []);
    });

    await t.step('--person returns that exact cluster outside the overview order', async () => {
      const byId = await client.execJson<UnknownList>(`person-unknown --person ${small.id}`);
      assertEquals(byId.total, 1);
      assertEquals(byId.people[0].path, small.path);

      const byPath = await client.execJson<UnknownList>(`person-unknown --person ${small.path}`);
      assertEquals(byPath.people[0].id, small.id);
    });

    await t.step('person-faces returns every face, not the preview handful', async () => {
      const res = await client.execJson<FaceList>(`person-faces ${big.path}`);
      assertEquals(res.total, 3);
      assertEquals(res.person.faceCount, 3);
      assertEquals(res.person.unnamed, true);
      assertEquals(res.faces.length, 3, 'one page holds a small cluster whole');
      assertEquals(res.nextOffset, undefined, 'the last page names no next one');
      // Best first, and each face names the photo it was cut from.
      assertEquals(res.faces.map((f) => Math.round(f.confidence * 10) / 10), [0.9, 0.8, 0.7]);
      assertEquals(res.faces[0].facePath, big.facePaths[0]);
      assertEquals(res.faces[0].filePath, '/img/aaa-0.jpg');
      assertEquals(res.faces.map((face) => face.hasFace), [true, true, true]);
    });

    await t.step('person-faces pages that order, and takes a bare id', async () => {
      const res = await client.execJson<FaceList>(`person-faces aaa -l 1 --offset 1`);
      assertEquals(res.total, 3, 'total is the whole cluster, not the page');
      assertEquals(res.offset, 1);
      assertEquals(res.faces.length, 1);
      assertEquals(res.faces[0].facePath, big.facePaths[1]);
      assertEquals(res.nextOffset, 2, 'a page short of the end says where the next starts');

      const byFile = await client.execJson<FaceList>(`person-faces aaa --sort file`);
      assertEquals(byFile.faces.map((f) => f.filePath), ['/img/aaa-0.jpg', '/img/aaa-1.jpg', '/img/aaa-2.jpg']);
    });

    await t.step('person-faces sorts chronologically, undated faces last', async () => {
      await vfs.update(ADMIN_ACCESS, '/img/aaa-0.jpg', { attrs: captureTime('2003-05-01T10:00:00Z') });
      // A hand-typed time outranks the camera's, and the resolution is what a reader sees —
      // so the fixture stores the resolution, exactly as `file-set-time` would have written it.
      await vfs.update(ADMIN_ACCESS, '/img/aaa-1.jpg', { attrs: captureTime('1999-01-02T03:04:05Z') });

      const byDate = await client.execJson<FaceList>('person-faces aaa --sort date');
      assertEquals(byDate.faces.map((face) => face.filePath), ['/img/aaa-1.jpg', '/img/aaa-0.jpg', '/img/aaa-2.jpg']);
      assertEquals(byDate.faces.map((face) => face.takenAt), ['1999-01-02T03:04:05Z', '2003-05-01T10:00:00Z', undefined]);

      // The order is over every face; a later page is the same order's continuation.
      const second = await client.execJson<FaceList>('person-faces aaa --sort date -l 1 --offset 1');
      assertEquals(second.faces.map((face) => face.filePath), ['/img/aaa-0.jpg']);
      assertEquals(second.faces[0].takenAt, '2003-05-01T10:00:00Z');
      assertEquals(second.nextOffset, 2);
    });

    await t.step('person-faces refuses a person that is not there', async () => {
      assertEquals((await client.exec(`person-faces ${PEOPLE_ROOT}/unknown/nope`)).success, false);
      assertEquals((await client.exec('person-faces')).success, false);
      assertEquals((await client.exec(`person-faces ${big.path} --sort nonsense`)).success, false);
    });

    let namedPath = '';
    await t.step('person-name moves them into /people, keeping the id', async () => {
      const res = await client.execJson<NameResult>(`person-name ${big.path} --name "Åsa Öberg" --gender female`);
      assertEquals(res.ok, true);
      assertEquals(res.path, `${PEOPLE_ROOT}/asa-oberg`);
      assertEquals(res.id, big.id, 'the node id survives the move');
      namedPath = res.path;

      const attrs = await attrsOf(namedPath);
      assertEquals(attrs.name, 'Åsa Öberg');
      assertEquals(Object.hasOwn(attrs, 'unnamed'), false, 'no longer marked auto-created');

      // The faces still resolve to her without being touched.
      for (const f of big.facePaths) assertEquals((await attrsOf(f)).personId, big.id);
      assertEquals((await vfs.resolveId(ADMIN_ACCESS, big.id))[0].vfsAbsPath, namedPath);
    });

    await t.step('a named person drops out of the unidentified list', async () => {
      const res = await client.execJson<UnknownList>('person-unknown');
      assertEquals(res.total, 1);
      assertEquals(res.people[0].id, small.id);
    });

    // A softlink to the source that is not a face: the photographer of an image.
    const photographer = '/img/aaa-0.jpg/photographer';
    await vfs.create(ADMIN_ACCESS, 'softlink', '/img/aaa-0.jpg', 'photographer', {
      props: { uid: 1000, gid: 1000, mode: 0o777, softlink: small.path },
    });
    const linkTarget = async () => (await vfs.get(ADMIN_ACCESS, photographer, { readlink: true })).props.softlink;

    await t.step('person-merge --dry-run reports without changing anything', async () => {
      const res = await client.execJson<MergeResult>(`person-merge ${small.path} ${namedPath} --dry-run`);
      assertEquals(res.faces, 1);
      assertEquals(res.dryRun, true);
      assertEquals(res.merged[0].deleted, false);
      assertEquals(res.links, 1);
      assertEquals(await linkTarget(), small.path);
      assertEquals((await attrsOf(small.facePaths[0])).personId, small.id);
      assertEquals(await vfs.exists(ADMIN_ACCESS, small.path), true);
    });

    await t.step('person-merge re-points the faces and removes the source', async () => {
      const res = await client.execJson<MergeResult>(`person-merge ${small.path} ${namedPath}`);
      assertEquals(res.faces, 1);
      assertEquals(res.merged[0].deleted, true);
      assertEquals(res.links, 1);
      assertEquals(await linkTarget(), namedPath, 'the photographer link follows to the surviving person');

      const attrs = await attrsOf(small.facePaths[0]);
      assertEquals(attrs.personId, big.id, 'the face now belongs to the surviving person');
      // A human decided this, so no later automatic pass may revisit it.
      assertEquals(attrs.personSource, 'manual');
      assertEquals(await vfs.exists(ADMIN_ACCESS, small.path), false);
      assertEquals((await client.execJson<UnknownList>('person-unknown')).total, 0);
    });

    await t.step('merging a person into themselves is refused', async () => {
      const res = await client.exec(`person-merge ${namedPath} ${namedPath}`);
      assertEquals(res.success, false);
    });

    await t.step('face-reset clears only the named provenance', async () => {
      // Two runs to undo separately: one from clustering, one transferred.
      const fromCluster = await seedUnknown('ccc', 2, 'cluster');
      const fromTransfer = await seedUnknown('ddd', 2, 'transfer');

      const res = await client.execJson<ResetResult>('face-reset --source cluster');
      assertEquals(res.cleared, 2);

      for (const f of fromCluster.facePaths) {
        const attrs = await attrsOf(f);
        // Removed, not falsified: the face looks freshly detected again.
        assertEquals(Object.hasOwn(attrs, 'personId'), false);
        assertEquals(Object.hasOwn(attrs, 'personSource'), false);
      }
      for (const f of fromTransfer.facePaths) {
        assertEquals((await attrsOf(f)).personId, fromTransfer.id, 'the transferred run is untouched');
      }
      // The merged face was marked manual, so it survives every reset.
      assertEquals((await attrsOf(small.facePaths[0])).personId, big.id);
    });

    await t.step('face-reset --delete-unnamed removes the people too', async () => {
      const res = await client.execJson<ResetResult>('face-reset --source all --delete-unnamed');
      assertEquals(res.peopleDeleted, 2);
      assertEquals((await client.execJson<UnknownList>('person-unknown')).total, 0);
      // The named person and her manually merged face are still there.
      assertEquals((await attrsOf(namedPath)).name, 'Åsa Öberg');
      assertEquals((await attrsOf(small.facePaths[0])).personId, big.id);
    });

    await t.step('face-reset requires an explicit source', async () => {
      assertEquals((await client.exec('face-reset')).success, false);
      assertEquals((await client.exec('face-reset --source nonsense')).success, false);
    });

    await t.step('person-merge folds several sources into the last argument', async () => {
      // What the overview does with a multi-select: recognition split one person
      // into a big cluster and a tail of small ones.
      const keep = await seedUnknown('m1', 3);
      const tail1 = await seedUnknown('m2', 2);
      const tail2 = await seedUnknown('m3', 1);

      const res = await client.execJson<MergeResult>(`person-merge ${tail1.path} ${tail2.path} ${keep.path}`);
      assertEquals(res.ok, true);
      assertEquals(res.dst, keep.path);
      assertEquals(res.merged.length, 2);
      assertEquals(res.failed.length, 0);
      assertEquals(res.faces, 3, 'the totals are summed across the sources');

      for (const f of [...tail1.facePaths, ...tail2.facePaths]) {
        assertEquals((await attrsOf(f)).personId, keep.id);
      }
      assertEquals(await vfs.exists(ADMIN_ACCESS, tail1.path), false);
      assertEquals(await vfs.exists(ADMIN_ACCESS, tail2.path), false);
      assertEquals((await client.execJson<FaceList>(`person-faces ${keep.path}`)).total, 6);
    });

    await t.step('a failing source does not abandon the rest of the batch', async () => {
      const keep = await seedUnknown('n1', 1);
      const good = await seedUnknown('n2', 1);

      const res = await client.exec(`person-merge ${PEOPLE_ROOT}/unknown/nope ${good.path} ${keep.path}`);
      assertEquals(res.success, false, 'a failure has to be visible in the exit code');
      // ...but the source that could merge, did.
      assertEquals(await vfs.exists(ADMIN_ACCESS, good.path), false);
      assertEquals((await attrsOf(good.facePaths[0])).personId, keep.id);
    });

    await t.step('person-detach --dry-run writes nothing', async () => {
      const person = await seedUnknown('d0', 2);

      const res = await client.execJson<DetachResult>(`person-detach --dry-run --to-new-person ${person.facePaths[0]}`);
      assertEquals(res.detached, 1);
      assertEquals(res.dryRun, true);
      assertEquals(res.person, null, 'a dry run does not mint a person either');
      assertEquals((await attrsOf(person.facePaths[0])).personId, person.id);
    });

    await t.step('person-detach --to-new-person moves only the named faces', async () => {
      // The split half of a wrongly fused cluster: three faces stay, two leave.
      const person = await seedUnknown('d1', 5);
      const leaving = person.facePaths.slice(3);

      const res = await client.execJson<DetachResult>(`person-detach --to-new-person ${leaving.join(' ')}`);
      assertEquals(res.ok, true);
      assertEquals(res.detached, 2);
      assertEquals(res.person?.path.startsWith(`${PEOPLE_ROOT}/unknown/`), true);

      for (const f of leaving) {
        const attrs = await attrsOf(f);
        assertEquals(attrs.personId, res.person!.id);
        // A human decided this, so face-reset and the automatic passes leave it be.
        assertEquals(attrs.personSource, 'manual');
      }
      for (const f of person.facePaths.slice(0, 3)) {
        assertEquals((await attrsOf(f)).personId, person.id, 'the rest of the cluster is untouched');
      }
      assertEquals((await client.execJson<FaceList>(`person-faces ${person.path}`)).total, 3);
      assertEquals((await client.execJson<FaceList>(`person-faces ${res.person!.path}`)).total, 2);
    });

    await t.step('person-detach --to moves faces to an existing person', async () => {
      const from = await seedUnknown('d2', 3);
      const to = await seedUnknown('d3', 1);

      const res = await client.execJson<DetachResult>(`person-detach --to ${to.path} ${from.facePaths[0]}`);
      assertEquals(res.ok, true);
      assertEquals(res.person?.id, to.id);
      assertEquals((await attrsOf(from.facePaths[0])).personId, to.id);
      // A bare id resolves under /people/unknown, the same rule person-merge uses.
      assertEquals((await client.exec(`person-detach --to d3 ${from.facePaths[1]}`)).success, true);
      assertEquals((await attrsOf(from.facePaths[1])).personId, to.id);
    });

    await t.step('a bare person-detach unassigns and locks the face', async () => {
      // The ears, hands and slices of watermelon: not a person at all, so
      // clearing personId alone would just invite assign-faces to re-tag them.
      const person = await seedUnknown('d4', 2);

      const res = await client.execJson<DetachResult>(`person-detach ${person.facePaths[0]}`);
      assertEquals(res.ok, true);
      assertEquals(res.locked, 1);
      assertEquals(res.person, null);

      const attrs = await attrsOf(person.facePaths[0]);
      assertEquals(Object.hasOwn(attrs, 'personId'), false);
      assertEquals(Object.hasOwn(attrs, 'personSource'), false);
      assertEquals(attrs.assignLocked, true);
    });

    await t.step('person-detach removes an unnamed person it leaves empty', async () => {
      const from = await seedUnknown('d8', 1);
      const to = await seedUnknown('d9', 1);

      const res = await client.execJson<DetachResult>(`person-detach --to ${to.path} ${from.facePaths[0]}`);
      assertEquals(res.removedPeople, [from.path]);
      assertEquals(await vfs.exists(ADMIN_ACCESS, from.path), false);
      assertEquals(await vfs.exists(ADMIN_ACCESS, to.path), true);
    });

    await t.step('person-detach gives a person whose representative face left another', async () => {
      const person = await seedUnknown('d10', 2);
      const [leaving, staying] = await Promise.all(person.facePaths.map((path) => vfs.get(ADMIN_ACCESS, path)));
      await vfs.update(ADMIN_ACCESS, person.path, { attrs: { representativeFaceId: leaving.id } });

      const res = await client.execJson<DetachResult>(`person-detach --to-new-person ${person.facePaths[0]}`);
      assertEquals(res.removedPeople, []);
      const attrs = await vfs.get<{ representativeFaceId?: string }>(ADMIN_ACCESS, person.path).then((node) => node.attrs);
      assertEquals(attrs.representativeFaceId, staying.id);
    });

    await t.step('person-detach refuses contradictory targets and reports bad paths', async () => {
      const person = await seedUnknown('d5', 2);

      assertEquals((await client.exec(`person-detach --to ${person.path} --to-new-person ${person.facePaths[0]}`)).success, false);
      assertEquals((await client.exec('person-detach')).success, false);
      // A face node is required — a person is not one.
      assertEquals((await client.exec(`person-detach ${person.path}`)).success, false);

      // One bad path fails the batch without abandoning the good ones.
      const res = await client.exec(`person-detach --to-new-person /img/nope/regions/face-0 ${person.facePaths[0]}`);
      assertEquals(res.success, false);
      assertEquals(Object.hasOwn(await attrsOf(person.facePaths[0]), 'personId'), true);
      assertEquals((await attrsOf(person.facePaths[0])).personSource, 'manual');
    });

    await t.step('person-discard --dry-run writes nothing', async () => {
      const person = await seedUnknown('x1', 2);

      const res = await client.execJson<DiscardResult>(`person-discard --dry-run ${person.path}`);
      assertEquals(res.discarded, [{ path: person.path, regions: 2, voices: 0 }]);
      assertEquals(await vfs.exists(ADMIN_ACCESS, person.path), true);
      assertEquals((await attrsOf(person.facePaths[0])).personId, person.id);
    });

    await t.step('person-discard locks every region and voice and removes the person', async () => {
      const person = await seedUnknown('x2', 3);
      await client.exec('echo x > /img/x2.mp3 && mkdir -p /img/x2.mp3/voices');
      await vfs.create(ADMIN_ACCESS, 'embedding', '/img/x2.mp3/voices', 'v0', { attrs: { embeddingType: 'voice', personId: person.id, personSource: 'voice' } });
      const empty = await seedUnknown('x3', 0);

      // A bare id names a person under /people/unknown, as person-detach --to takes it.
      const res = await client.execJson<DiscardResult>(`person-discard ${person.path} x3`);
      assertEquals(res.ok, true);
      assertEquals(res.discarded, [{ path: person.path, regions: 3, voices: 1 }, { path: empty.path, regions: 0, voices: 0 }]);
      assertEquals(await vfs.exists(ADMIN_ACCESS, person.path), false);
      assertEquals(await vfs.exists(ADMIN_ACCESS, empty.path), false);

      for (const path of [...person.facePaths, '/img/x2.mp3/voices/v0']) {
        const attrs = await attrsOf(path);
        assertEquals(Object.hasOwn(attrs, 'personId'), false, path);
        assertEquals(Object.hasOwn(attrs, 'personSource'), false, path);
        assertEquals(attrs.assignLocked, true, path);
      }
    });

    await t.step('person-discard refuses a named person and keeps going', async () => {
      const named = await seedUnknown('x4', 1);
      await vfs.update(ADMIN_ACCESS, named.path, { attrs: { unnamed: null } });
      const junk = await seedUnknown('x5', 1);

      const res = await client.exec(`person-discard ${named.path} ${junk.path}`);
      assertEquals(res.success, false);
      assertEquals(await vfs.exists(ADMIN_ACCESS, named.path), true);
      assertEquals((await attrsOf(named.facePaths[0])).personId, named.id);
      assertEquals(await vfs.exists(ADMIN_ACCESS, junk.path), false);
      assertEquals((await client.exec('person-discard /img/nope')).success, false);
      assertEquals((await client.exec('person-discard')).success, false);
    });

    await t.step('person-fixup --delete-orphans clears unnamed people with no faces', async () => {
      // The routine leftover of a name reaching a face after recognition: assign-faces
      // mints a person for a fresh detection, the detection is then given the name it
      // should have had, and the minted person holds nothing.
      const orphan = await seedUnknown('orphaned', 0);
      const keeper = await seedUnknown('keeper', 2);

      assertEquals((await client.exec('person-fixup --dry-run --delete-orphans')).success, true);
      assertEquals(await vfs.exists(ADMIN_ACCESS, orphan.path), true, 'dry run writes nothing');

      // A tag is a region too, and a person found by voice alone has no region at all.
      const tagged = await seedUnknown('tagged', 0);
      await client.exec('echo x > /img/tagged.jpg && mkdir -p /img/tagged.jpg/regions');
      await vfs.create(ADMIN_ACCESS, 'media-region', '/img/tagged.jpg/regions', 'manual-0', { attrs: { personId: tagged.id, personSource: 'manual' } });
      const heard = await seedUnknown('heard', 0);
      await client.exec('echo x > /img/heard.mp3 && mkdir -p /img/heard.mp3/voices');
      await vfs.create(ADMIN_ACCESS, 'embedding', '/img/heard.mp3/voices', 'v0', { attrs: { embeddingType: 'voice', personId: heard.id } });

      assertEquals((await client.exec('person-fixup --delete-orphans')).success, true);
      assertEquals(await vfs.exists(ADMIN_ACCESS, orphan.path), false);
      assertEquals(await vfs.exists(ADMIN_ACCESS, keeper.path), true, 'a real cluster is not debris');
      assertEquals(await vfs.exists(ADMIN_ACCESS, tagged.path), true, 'a tag holds its person');
      assertEquals(await vfs.exists(ADMIN_ACCESS, heard.path), true, 'so does a voice');
    });

    await t.step('a tag is reported as one, and --rematch refuses it', async () => {
      const person = await seedUnknown('t7', 1);
      await vfs.unlink(ADMIN_ACCESS, `${person.facePaths[0]}/embedding`, person.facePaths[0]);

      const res = await client.execJson<FaceList>(`person-faces ${person.path}`);
      assertEquals(res.faces.map((face) => face.hasFace), [false]);

      // Nothing to match it with: rematching would only take its person away.
      assertEquals((await client.exec(`person-detach --rematch ${person.facePaths[0]}`)).success, false);
      assertEquals((await attrsOf(person.facePaths[0])).personId, person.id);
    });
  } finally {
    await client.close();
    await testCtx.teardown();
  }
});
