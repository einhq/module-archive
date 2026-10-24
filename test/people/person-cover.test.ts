/**
 * person-cover: a named person without a cover gets the crop of their best face.
 */

import { PEOPLE_ROOT } from '@archive/paths';
import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS, createTestContext } from '@ein/testing';

const testCtx = createTestContext({ modules: ['archive'] });

type CoverResult = { scanned: number; updated: number; skipped: number; people: { path: string; cover: string; replaced?: string }[] };

const ROOT = '/pcover';
const PROPS = { uid: 1000, gid: 1000, mode: 0o775 };

Deno.test({
  name: 'person-cover',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();

  const person = async (slug: string, attrs: Record<string, unknown> = {}) => {
    const node = await vfs.create(ADMIN_ACCESS, 'person', PEOPLE_ROOT, slug, { props: PROPS, attrs: { name: slug, ...attrs } });
    return { id: node.id, path: `${PEOPLE_ROOT}/${slug}` };
  };

  /** One image holding one face of `personId`, with a crop unless `crop` is false. */
  const face = async (
    name: string,
    personId: string,
    opts: {
      box: number;
      source?: string;
      confidence?: number;
      crop?: boolean;
      width?: number;
      faceCount?: number;
      pose?: { pitch: number; yaw: number; roll: number };
      tag?: boolean;
    },
  ) => {
    const image = `${ROOT}/${name}.jpg`;
    await client.exec(`mkdir -p ${ROOT} && echo x > ${image} && mkdir -p ${image}/regions`);
    await vfs.update(ADMIN_ACCESS, image, { attrs: { mimetype: 'image/jpeg', width: opts.width ?? 1000, height: 1000, faceCount: opts.faceCount ?? 1 } });
    const fileId = (await vfs.get(ADMIN_ACCESS, image)).id;
    await vfs.create(ADMIN_ACCESS, 'media-region', `${image}/regions`, 'face-0', {
      props: PROPS,
      attrs: {
        fileId,
        personId,
        personSource: opts.source ?? 'auto',
        confidence: opts.confidence ?? 0.9,
        faceBox: { x: 0.1, y: 0.1, width: opts.box, height: opts.box },
        ...(opts.pose ? { pose: opts.pose } : {}),
      },
    });
    const facePath = `${image}/regions/face-0`;
    // A face has an embedding; a tag (`tag: true`) is a region without one.
    if (!opts.tag) await vfs.create(ADMIN_ACCESS, 'embedding', facePath, 'embedding', { props: PROPS, attrs: { embeddingType: 'face', capacity: 8 } });
    if (opts.crop !== false) await client.exec(`echo crop > ${facePath}/image.avif`);
    return { image, facePath, crop: `${facePath}/image.avif` };
  };

  const coverOf = async (path: string) => {
    try {
      return (await vfs.get(ADMIN_ACCESS, `${path}/coverPhoto`, { readlink: true })).props.softlink;
    } catch {
      return undefined;
    }
  };

  try {
    const anna = await person('Anna_Cover');
    const small = await face('anna-small', anna.id, { box: 0.1 });
    const large = await face('anna-large', anna.id, { box: 0.4 });
    const doubtful = await face('anna-doubtful', anna.id, { box: 0.8, confidence: 0.4 });
    const noCrop = await face('anna-nocrop', anna.id, { box: 0.6 });
    await vfs.unlink(ADMIN_ACCESS, noCrop.crop, noCrop.facePath);

    await t.step('picks the largest confident face that has a crop', async () => {
      const res = await client.execJson<CoverResult>(`person-cover ${anna.path}`);
      assertEquals(res.updated, 1);
      assertEquals(await coverOf(anna.path), large.crop);
      // Neither the doubtful detection nor the uncropped face was chosen.
      assertEquals([small.crop, doubtful.crop, noCrop.crop].includes((await coverOf(anna.path))!), false);
    });

    await t.step('an existing cover that still shows them is kept', async () => {
      await client.exec(`ln -s -f ${small.crop} ${anna.path}/coverPhoto`);
      const res = await client.execJson<CoverResult>(`person-cover ${anna.path}`);
      assertEquals(res.updated, 0);
      assertEquals(await coverOf(anna.path), small.crop);
    });

    await t.step('a face that moved to somebody else stops being the cover', async () => {
      const other = await person('Other_Cover');
      await vfs.update(ADMIN_ACCESS, small.facePath, { attrs: { personId: other.id } });
      const res = await client.execJson<CoverResult>(`person-cover ${anna.path}`);
      assertEquals(res.updated, 1);
      assertEquals(res.people[0].replaced, small.crop);
      assertEquals(await coverOf(anna.path), large.crop);
    });

    await t.step('a human-assigned face outranks a larger guess', async () => {
      const bo = await person('Bo_Cover');
      await face('bo-auto', bo.id, { box: 0.5 });
      const tagged = await face('bo-manual', bo.id, { box: 0.2, source: 'manual' });
      await client.execJson<CoverResult>(`person-cover ${bo.path}`);
      assertEquals(await coverOf(bo.path), tagged.crop);
    });

    await t.step('a photo where they are the only face outranks a larger face in a group', async () => {
      const eva = await person('Eva_Cover');
      await face('eva-group', eva.id, { box: 0.5, faceCount: 4 });
      const alone = await face('eva-alone', eva.id, { box: 0.2, faceCount: 1 });
      await client.execJson<CoverResult>(`person-cover ${eva.path}`);
      assertEquals(await coverOf(eva.path), alone.crop);
    });

    await t.step('a face looking into the camera outranks a larger one turned away, and one of unknown pose', async () => {
      const gus = await person('Gus_Cover');
      await face('gus-profile', gus.id, { box: 0.6, pose: { pitch: 0, yaw: 70, roll: 0 } });
      const unknown = await face('gus-unknown', gus.id, { box: 0.4 });
      await client.execJson<CoverResult>(`person-cover ${gus.path}`);
      // Unknown pose beats a profile, however large the profile.
      assertEquals(await coverOf(gus.path), unknown.crop);

      const frontal = await face('gus-frontal', gus.id, { box: 0.2, pose: { pitch: -5, yaw: 10, roll: 3 } });
      await client.execJson<CoverResult>(`person-cover --repick ${gus.path}`);
      assertEquals(await coverOf(gus.path), frontal.crop);
    });

    await t.step('a tag counts as of unknown pose, whatever pose it stores', async () => {
      // A face moved by hand, or too poor to keep its vector: its stored pose no longer speaks
      // for the box, so a frontal face of the same size wins.
      const ida = await person('Ida_Cover');
      await face('ida-tag', ida.id, { box: 0.5, tag: true, pose: { pitch: 0, yaw: 0, roll: 0 } });
      const frontal = await face('ida-frontal', ida.id, { box: 0.3, pose: { pitch: 0, yaw: 5, roll: 0 } });
      await client.execJson<CoverResult>(`person-cover ${ida.path}`);
      assertEquals(await coverOf(ida.path), frontal.crop);
    });

    await t.step('--repick redoes an automatic pick, never a cover somebody set', async () => {
      const finn = await person('Finn_Cover');
      await face('finn-first', finn.id, { box: 0.3 });
      await client.execJson<CoverResult>(`person-cover ${finn.path}`);
      // A better face arrives; a plain run keeps the cover, a repick moves it.
      const better = await face('finn-better', finn.id, { box: 0.3, source: 'manual' });
      assertEquals((await client.execJson<CoverResult>(`person-cover ${finn.path}`)).updated, 0);
      assertEquals((await client.execJson<CoverResult>(`person-cover --repick ${finn.path}`)).updated, 1);
      assertEquals(await coverOf(finn.path), better.crop);
      assertEquals((await client.execJson<CoverResult>(`person-cover --repick ${finn.path}`)).updated, 0);

      // "Set as cover" writes a plain link, which a repick leaves alone.
      await client.exec(`ln -s -f ${ROOT}/finn-first.jpg/regions/face-0/image.avif ${finn.path}/coverPhoto`);
      assertEquals((await client.execJson<CoverResult>(`person-cover --repick ${finn.path}`)).updated, 0);
      assertEquals(await coverOf(finn.path), `${ROOT}/finn-first.jpg/regions/face-0/image.avif`);
    });

    await t.step('--file covers the people in one image; unnamed people are skipped', async () => {
      const cia = await person('Cia_Cover');
      const unnamed = await person('Unnamed_Cover', { unnamed: true });
      const shot = await face('cia-shot', cia.id, { box: 0.3 });
      await face('unnamed-shot', unnamed.id, { box: 0.3 });
      const res = await client.execJson<CoverResult>(`person-cover --file ${shot.image}`);
      assertEquals(res.updated, 1);
      assertEquals(await coverOf(cia.path), shot.crop);
      await client.execJson<CoverResult>(`person-cover ${unnamed.path}`);
      assertEquals(await coverOf(unnamed.path), undefined);
    });

    await t.step('--all fills everyone missing one and leaves the rest', async () => {
      const dan = await person('Dan_Cover');
      const shot = await face('dan-shot', dan.id, { box: 0.3 });
      const res = await client.execJson<CoverResult>('person-cover --all');
      // Other_Cover holds the face that moved off Anna, so it is covered too.
      assertEquals(res.people.map((p) => p.path).sort(), [dan.path, `${PEOPLE_ROOT}/Other_Cover`]);
      assertEquals((await client.execJson<CoverResult>('person-cover --all')).updated, 0);
      assertEquals(await coverOf(dan.path), shot.crop);
    });
  } finally {
    await client.close();
    await testCtx.teardown();
  }
});
