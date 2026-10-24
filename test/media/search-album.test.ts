/**
 * search-album, and the `album` kind it feeds.
 *
 * Pinned here: name and description matching, the aggregator classifying an album hit as
 * `kind: album`, and the kind-only listing, which would silently return nothing if it were
 * ordered by `takenAt` (no album has one). Against a stub EMS, the `members` channel: an album
 * scores by the share of its pictures that show the query, a linked member counts and the cover
 * does not, and `search` fuses the channel. One search embeds its words in the pictures' space
 * once, for search-media and search-album both.
 */

import { ALBUMS_ROOT } from '@archive/paths';
import { COVER_LINK_NAME } from '@archive/media/types';
import { assert, assertAlmostEquals, assertEquals } from '@std/assert';
import { ADMIN_ACCESS, createTestContext, testCommands } from '@ein/testing';
import { startStubEms } from '@ems/testing';

const testCtx = createTestContext({ boot: true, modules: ['archive'] });

type ProviderHit = { path: string; channel: string; score: number; name: string; description?: string };
type SearchHit = { path: string; kind?: string; type: string; name: string; description?: string; score: number; channels?: Record<string, number> };

const SIGLIP2 = 'ViT-SO400M-16-SigLIP2-384__webli';

Deno.test({
  name: 'search-album',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  const paths = (hits: { path: string }[]) => hits.map((h) => h.path).sort();

  try {
    await client.exec(`mkdir -p ${ALBUMS_ROOT}`);
    await cmd.shouldSucceed(`album create ${ALBUMS_ROOT}/sommaren-2003 --name 'Sommaren 2003' --description 'Segling i Bohuslän'`);
    await cmd.shouldSucceed(`album create ${ALBUMS_ROOT}/jul-1998 --name 'Jul 1998' --description 'Hemma hos mormor'`);

    await t.step('matches an album name', async () => {
      const out = await client.execJson<{ results: ProviderHit[] }>('search-album sommaren');
      assertEquals(paths(out.results), [`${ALBUMS_ROOT}/sommaren-2003`]);
    });

    await t.step('matches an album description', async () => {
      const out = await client.execJson<{ results: ProviderHit[] }>('search-album mormor');
      assertEquals(paths(out.results), [`${ALBUMS_ROOT}/jul-1998`]);
      assertEquals(out.results[0].channel, 'description');
      assertEquals(out.results[0].description, 'Hemma hos mormor');
    });

    await t.step('an exact name outranks a substring', async () => {
      const out = await client.execJson<{ results: ProviderHit[] }>("search-album 'jul 1998'");
      assertEquals(out.results[0].path, `${ALBUMS_ROOT}/jul-1998`);
      assertEquals(out.results[0].score, 1);
    });

    await t.step('no match is an empty list, not an error', async () => {
      const out = await client.execJson<{ results: ProviderHit[] }>('search-album kajakpaddling');
      assertEquals(out.results, []);
    });

    await t.step('search classifies the hit as kind album', async () => {
      const out = await client.execJson<{ results: SearchHit[] }>('search sommaren --fields description');
      const album = out.results.find((r) => r.path === `${ALBUMS_ROOT}/sommaren-2003`);
      assert(album, 'the album did not survive the aggregator');
      assertEquals(album.kind, 'album');
      assertEquals(album.type, 'album');
      assertEquals(album.name, 'Sommaren 2003');
      // --fields description is what the result cards render.
      assertEquals(album.description, 'Segling i Bohuslän');
    });

    await t.step('--kind album lists albums with no query at all', async () => {
      // Ordering by takenAt excludes rows without one, and no album has a takenAt, so albums
      // are ordered by name.
      const out = await client.execJson<{ results: SearchHit[] }>('search --kind album');
      assertEquals(paths(out.results), [`${ALBUMS_ROOT}/jul-1998`, `${ALBUMS_ROOT}/sommaren-2003`]);
    });

    await t.step('--kind photo still excludes albums', async () => {
      const out = await client.execJson<{ results: SearchHit[] }>('search sommaren --kind photo');
      assertEquals(out.results.filter((r) => r.type === 'album'), []);
    });

    await t.step('members: albums by what their pictures show', async () => {
      // The member counts and the cover below are written by hand; an album refresh would rewrite them.
      for (const service of ['archive-bridge', 'album-metadata']) await cmd.shouldSucceed(`service stop ${service}`);

      // The query meets a boat at cosine 1 and a field at 0, below the pictures' floor.
      const boat = [1, 0, 0];
      const field = [0, 0, 1];
      const album = async (slug: string, mediaCount: number) => {
        await vfs.create(ADMIN_ACCESS, 'album', ALBUMS_ROOT, slug, { attrs: { name: slug, mediaCount } });
        return `${ALBUMS_ROOT}/${slug}`;
      };
      const picture = async (dir: string, name: string, vector: number[]) => {
        await vfs.create(ADMIN_ACCESS, 'file', dir, name, { attrs: { name, mimetype: 'image/jpeg' } });
        const file = `${dir}/${name}`;
        await vfs.create(ADMIN_ACCESS, 'directory', file, 'metadata');
        await vfs.create(ADMIN_ACCESS, 'directory', `${file}/metadata`, 'picture');
        await vfs.create(ADMIN_ACCESS, 'embedding', `${file}/metadata/picture`, 'embedding', { attrs: { embeddingType: 'picture_siglip2', capacity: 3 } });
        const handle = await vfs.open(ADMIN_ACCESS, `${file}/metadata/picture/embedding`, { mode: 'w' });
        try {
          await handle.write(new TextEncoder().encode(JSON.stringify(vector)));
        } finally {
          await handle.close();
        }
        await vfs.update(ADMIN_ACCESS, `${file}/metadata/picture`, { attrs: { embeddedBy: SIGLIP2 } });
        return file;
      };
      const link = (dir: string, name: string, target: string) => vfs.create(ADMIN_ACCESS, 'softlink', dir, name, { props: { mode: 0o777, softlink: target } });

      // Mostly boats, in its `files/` directory.
      const trip = await album('battur', 3);
      await vfs.create(ADMIN_ACCESS, 'directory', trip, 'files');
      const tripBoat = await picture(`${trip}/files`, 'boat-1.jpg', boat);
      await picture(`${trip}/files`, 'boat-2.jpg', boat);
      await picture(`${trip}/files`, 'field.jpg', field);
      // A large album with one boat of its own and one linked from the trip.
      const summer = await album('sommarlov', 40);
      await picture(summer, 'boat-3.jpg', boat);
      await link(summer, 'boat-1.jpg', tripBoat);
      // One picture, a boat.
      const single = await album('ensam', 1);
      await picture(single, 'boat-4.jpg', boat);
      // A cover is not a member.
      const covered = await album('omslag', 5);
      await link(covered, COVER_LINK_NAME, tripBoat);

      const stub = startStubEms({ ops: { 'vision.embed_text': { result: { embedding: boat }, producer: SIGLIP2 } } });
      try {
        const out = await client.execJson<{ results: ProviderHit[] }>(`CFG_EMS_URL=${stub.url} search-album 'a boat'`);
        const members = out.results.filter((hit) => hit.channel === 'members');
        // Two boats of three, one of one, two of forty; the field and the cover count for nothing.
        assertEquals(members.map((hit) => hit.path), [trip, single, summer]);
        const floor = 0.08;
        assertAlmostEquals(members[0].score, floor + 2 * (1 - floor) / (3 + 10));
        assertAlmostEquals(members[2].score, floor + 2 * (1 - floor) / (40 + 10));

        const fused = await client.execJson<{ results: SearchHit[] }>(`CFG_EMS_URL=${stub.url} search 'a boat' --kind album --fields channels`);
        assertEquals(fused.results.map((hit) => hit.path), [trip, single, summer]);
        assertEquals(fused.results[0].kind, 'album');
        assertEquals(fused.results[0].channels, { members: 1 });

        // search-media ranks the same words in the same space: one embed between the two.
        await client.execJson(`CFG_EMS_URL=${stub.url} search 'a sailboat'`);
        const asked = stub.requests.filter((request) => request.op === 'vision.embed_text' && request.body.text === 'a sailboat');
        assertEquals(asked.length, 1);
      } finally {
        await stub.close();
      }
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
