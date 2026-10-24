/**
 * `label-model` and `search --like /archive/tags/<label>`: a label learns a direction from the
 * pictures it is on and the members of the albums it is on, keeps it on its tag directory, and
 * ranks the rest of the archive by it.
 *
 * Pinned here: what carries the label (itself, or through an album) and what was rejected for it
 * are never suggested; `search-album` ranks albums by their members and leaves out the labeled
 * ones; a changed label reads as stale until it is trained again; a tag directory with no
 * model is refused with a pointer to `label-model train`; and a vocabulary word in the archive's
 * language is asked by its prompt before anything carries it, and dropped when the language
 * changes.
 */

import { ALBUMS_ROOT } from '@archive/paths';
import { TAGS_ROOT } from '@ein/paths';
import { assert, assertEquals } from '@std/assert';
import { ADMIN_ACCESS, createTestContext, testCommands } from '@ein/testing';
import type { LabelModelSummary, LabelTrainResult } from '@archive/labels/api';
import { seededRandom, unit } from '@archive/labels/classifier';
import { startStubEms } from '@ems/testing';

const testCtx = createTestContext({ boot: true, modules: ['archive'] });

type Hit = { path: string; score: number; type?: string };
type SearchAnswer = { results: Hit[] };

const SIGLIP2 = 'ViT-SO400M-16-SigLIP2-384__webli';
const DIM = 8;

Deno.test({
  name: 'label-model',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);
  const random = seededRandom('label-model-test');

  /** Near the first axis: what every picture of a boat shares here. */
  const boat = () => unit([1, ...Array.from({ length: DIM - 1 }, () => 0.15 * (random() * 2 - 1))]);
  /** Well away from the first axis. */
  const elsewhere = () => unit([-0.2 - 0.8 * random(), ...Array.from({ length: DIM - 1 }, () => random() * 2 - 1)]);

  const write = async (at: string, vector: ArrayLike<number>) => {
    const handle = await vfs.open(ADMIN_ACCESS, at, { mode: 'w' });
    try {
      await handle.write(new TextEncoder().encode(JSON.stringify(Array.from(vector))));
    } finally {
      await handle.close();
    }
  };
  const album = async (slug: string) => {
    await vfs.create(ADMIN_ACCESS, 'album', ALBUMS_ROOT, slug, { attrs: { name: slug } });
    await vfs.create(ADMIN_ACCESS, 'directory', `${ALBUMS_ROOT}/${slug}`, 'files');
    return `${ALBUMS_ROOT}/${slug}`;
  };
  /** A photo with its picture vector where `embed-picture` puts it. */
  const photo = async (albumPath: string, name: string, vector: ArrayLike<number>) => {
    const dir = `${albumPath}/files`;
    // Every stored file has a sha256; the negatives are sampled by it.
    const sha256 = Array.from({ length: 64 }, () => Math.floor(random() * 16).toString(16)).join('');
    await vfs.create(ADMIN_ACCESS, 'file', dir, name, { attrs: { name, mimetype: 'image/jpeg', sha256 } });
    const path = `${dir}/${name}`;
    await vfs.create(ADMIN_ACCESS, 'directory', path, 'metadata');
    await vfs.create(ADMIN_ACCESS, 'directory', `${path}/metadata`, 'picture');
    await vfs.create(ADMIN_ACCESS, 'embedding', `${path}/metadata/picture`, 'embedding', { attrs: { embeddingType: 'picture_siglip2', capacity: DIM } });
    await write(`${path}/metadata/picture/embedding`, vector);
    await vfs.update(ADMIN_ACCESS, `${path}/metadata/picture`, { attrs: { embeddedBy: SIGLIP2 } });
    return path;
  };
  const paths = (hits: Hit[]) => hits.map((hit) => hit.path);

  try {
    for (const service of ['archive-bridge', 'album-metadata']) await cmd.shouldSucceed(`service stop ${service}`);

    const sailing = await album('sailing');
    const sailed = await Promise.all(Array.from({ length: 6 }, (_, i) => photo(sailing, `s${i}.jpg`, boat())));
    const harbour = await album('harbour');
    // Fewer unlabeled boats (these two and the stray) than the floor lets through, so it is
    // always set among the fields.
    const harbourBoats = await Promise.all(Array.from({ length: 2 }, (_, i) => photo(harbour, `h${i}.jpg`, boat())));
    const mixed = await album('mixed');
    const labeledHere = await Promise.all(Array.from({ length: 3 }, (_, i) => photo(mixed, `m${i}.jpg`, boat())));
    const strayBoat = await photo(mixed, 'stray.jpg', boat());
    const fields = await album('fields');
    for (let i = 0; i < 300; i++) await photo(fields, `f${i}.jpg`, elsewhere());

    await cmd.shouldSucceed(`label add ${sailing} segla`);
    for (const path of labeledHere) await cmd.shouldSucceed(`label add ${path} segla`);

    await t.step('a tag directory without a model is refused, with what to run', async () => {
      await cmd.shouldFailWith(`search-media --like ${TAGS_ROOT}/segla`, 'label-model train segla');
    });

    await t.step('train learns from the labeled files and the labeled album, and keeps the model', async () => {
      const [result] = await client.execJson<LabelTrainResult[]>('label-model train segla');
      assert(result.trained);
      assert('pictures' in result);
      assertEquals(result.pictures, sailed.length + labeledHere.length);
      assertEquals(result.groups, 1 + labeledHere.length);
      assertEquals(result.stale, false);
      assert(result.measured, 'measured over held-out files and the album');
      assert(result.learnable, `learnable: ${JSON.stringify(result.measured)}`);
      // At least the unlabeled boats: the harbour's two and the stray one.
      assert(result.matches >= harbourBoats.length + 1, `matches ${result.matches}`);
      const tagDir = await vfs.get(ADMIN_ACCESS, `${TAGS_ROOT}/segla`);
      assertEquals((tagDir.attrs.model as { weights: number[] }).weights.length, DIM);
    });

    await t.step('search --like the label finds the boats that do not carry it yet', async () => {
      // The unlabeled boats first, and none of the labeled ones: a field may follow above a
      // floor set on a few hundred pictures.
      const out = await client.execJson<SearchAnswer>(`search --like ${TAGS_ROOT}/segla --kind photo -l 20`);
      assertEquals(paths(out.results).slice(0, 3).sort(), [...harbourBoats, strayBoat].sort());
      for (const path of [...sailed, ...labeledHere]) assert(!paths(out.results).includes(path), path);
    });

    await t.step('a rejected picture is not suggested, and the label reads as stale until trained again', async () => {
      await cmd.shouldSucceed(`label-model reject segla ${strayBoat}`);
      const out = await client.execJson<SearchAnswer>(`search --like ${TAGS_ROOT}/segla --kind photo -l 20`);
      assert(!paths(out.results).includes(strayBoat));
      assertEquals(paths(out.results).slice(0, 2).sort(), [...harbourBoats].sort());
      assertEquals((await client.execJson<LabelModelSummary>('label-model show segla')).stale, true);
      const [again] = await client.execJson<LabelTrainResult[]>('label-model train segla --if-stale');
      assert(again.trained && again.stale === false);
      assertEquals((again as LabelModelSummary).rejected, 1);
      const [kept] = await client.execJson<LabelTrainResult[]>('label-model train segla --if-stale');
      assertEquals(kept.trained, false);
      await cmd.shouldSucceed(`label-model unreject segla ${strayBoat}`);
      assertEquals((await client.execJson<LabelModelSummary>('label-model show segla')).rejected, 0);
    });

    await t.step('search-album ranks albums by their members, without the labeled one', async () => {
      const out = await client.execJson<SearchAnswer>(`search --like ${TAGS_ROOT}/segla --kind album`);
      // The two albums holding unlabeled boats, before the fields if those are there at all.
      assertEquals(paths(out.results).slice(0, 2).sort(), [harbour, mixed].sort());
      assert(!paths(out.results).includes(sailing));
      // A picture asks for no albums: nothing ranks them by one.
      await cmd.shouldFailWith(`search --like ${sailed[0]} --kind album`, 'by a picture');
    });

    await t.step('list reports every kept model', async () => {
      const list = await client.execJson<LabelModelSummary[]>('label-model list');
      assertEquals(list.map((entry) => entry.label), ['segla']);
    });

    await t.step('a vocabulary word is asked by its prompt before anything carries it', async () => {
      const stub = startStubEms({ ops: { 'vision.embed_text': { result: { embedding: [1, 0, 0, 0, 0, 0, 0, 0] }, producer: SIGLIP2 } } });
      try {
        const [result] = await client.execJson<LabelTrainResult[]>(`CFG_EMS_URL=${stub.url} CFG_LANGUAGE=sv label-model train båt`);
        assert(result.trained && 'source' in result);
        assertEquals(result.source, 'vocabulary');
        assertEquals(result.prompt, 'a photo of a boat');
        assertEquals(result.pictures, 0);
        // Every boat, labeled or not: nothing carries this word yet.
        assertEquals(result.matches, sailed.length + harbourBoats.length + labeledHere.length + 1);
        assertEquals(stub.requests.filter((request) => request.op === 'vision.embed_text').map((request) => request.body.text), ['a photo of a boat']);
        // An empty tag directory is no label.
        assert(!(await client.execJson<{ label: string }[]>('label list')).some((entry) => entry.label === 'båt'));
        const out = await client.execJson<SearchAnswer>(`search --like ${TAGS_ROOT}/båt --kind photo -l 20`);
        assertEquals(paths(out.results).length, result.matches);

        // In English the archive has no word båt: its model goes, and boat gets one.
        await cmd.shouldSucceed(`CFG_EMS_URL=${stub.url} CFG_LANGUAGE=en label-model train --all`);
        const list = await client.execJson<LabelModelSummary[]>('label-model list');
        assert(!list.some((entry) => entry.label === 'båt'));
        assertEquals(list.find((entry) => entry.label === 'boat')?.source, 'vocabulary');
        assertEquals(list.find((entry) => entry.label === 'segla')?.source, 'examples');
      } finally {
        await stub.close();
      }
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
