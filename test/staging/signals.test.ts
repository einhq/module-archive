/**
 * The grouping's signals, read in batches by file id: GPS off the file's own `position`, people off
 * its regions and boxless `people/` tags, whether a region still waits for a person, where its
 * `location` link points, and the phone folder its paired Takeout sidecar names, through the
 * softlink an edited copy shares it by too.
 */
import { LOCATIONS_ROOT, PEOPLE_ROOT } from '@archive/paths';
import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS, createTestContext, testCommands } from '@ein/testing';
import { pointsOf, readLocations, readSignals } from '../../lib/staging/signals.ts';

const testCtx = createTestContext({ modules: ['archive'] });

const DIR = '/signals';

Deno.test({ name: 'readSignals', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);
  const idOf = async (path: string) => (await vfs.get(ADMIN_ACCESS, path)).id;
  try {
    await cmd.shouldSucceed(`mkdir -p ${DIR} ${PEOPLE_ROOT} ${LOCATIONS_ROOT}`);
    for (const slug of ['anna-andersson', 'bo-berg']) await cmd.shouldSucceed(`person-create ${PEOPLE_ROOT}/${slug} --name ${slug}`);
    await cmd.shouldSucceed(`mknode -t location ${LOCATIONS_ROOT}/harbour --as name='Old harbour'`);
    await cmd.shouldSucceed(`position-set ${LOCATIONS_ROOT}/harbour/position --lat=57.5 --lng=12.0`);
    const anna = await idOf(`${PEOPLE_ROOT}/anna-andersson`);
    const bo = await idOf(`${PEOPLE_ROOT}/bo-berg`);

    // A photo with a fix, a named face, a face nobody has named, a boxless tag and a location link.
    await cmd.shouldSucceed(`mknode -t file ${DIR}/boat.jpg --as mimetype=image/jpeg`);
    const boat = await idOf(`${DIR}/boat.jpg`);
    await cmd.shouldSucceed(`position-set ${DIR}/boat.jpg/position --lat=57.51 --lng=12.01`);
    await cmd.shouldSucceed(`mkdir ${DIR}/boat.jpg/regions`);
    await cmd.shouldSucceed(`mknode -t media-region ${DIR}/boat.jpg/regions/face-0 --as fileId=${boat} --as personId=${anna}`);
    await cmd.shouldSucceed(`mknode -t media-region ${DIR}/boat.jpg/regions/face-1 --as fileId=${boat}`);
    await cmd.shouldSucceed(`mkdir ${DIR}/boat.jpg/people && ln -s ${PEOPLE_ROOT}/bo-berg ${DIR}/boat.jpg/people/bo-berg`);
    await cmd.shouldSucceed(`ln -s ${LOCATIONS_ROOT}/harbour ${DIR}/boat.jpg/location`);
    // A photo with nothing known about it.
    await cmd.shouldSucceed(`mknode -t file ${DIR}/plain.jpg --as mimetype=image/jpeg`);
    const plain = await idOf(`${DIR}/plain.jpg`);
    // A Google Photos upload from a phone's WhatsApp folder, and its edited copy sharing the sidecar.
    await cmd.shouldSucceed(`mknode -t file ${DIR}/saved.jpg --as mimetype=image/jpeg && mknode -t file ${DIR}/saved-edited.jpg --as mimetype=image/jpeg`);
    const saved = await idOf(`${DIR}/saved.jpg`);
    await vfs.create(ADMIN_ACCESS, 'file', `${DIR}/saved.jpg`, 'sidecar', {
      attrs: { mimetype: 'application/json', sourceId: saved, sidecar: { kind: 'takeout', localFolder: 'WhatsApp Images', pairedAt: '2026-10-18T00:00:00Z' } },
    });
    await cmd.shouldSucceed(`ln -s ${DIR}/saved.jpg/sidecar ${DIR}/saved-edited.jpg/sidecar`);
    const edited = await idOf(`${DIR}/saved-edited.jpg`);

    await t.step('each file gets what is known about it, and every id is answered', async () => {
      const signals = await readSignals(vfs, ADMIN_ACCESS, [boat, plain]);
      const got = signals.get(boat)!;
      assertEquals(got.point, { lat: 57.51, lng: 12.01 });
      assertEquals(got.positionId, await idOf(`${DIR}/boat.jpg/position`));
      assertEquals([...got.persons].sort(), [anna, bo].sort());
      assertEquals(got.location, `${LOCATIONS_ROOT}/harbour`);
      assertEquals(signals.get(plain), { persons: [] });
    });

    await t.step("a paired Takeout sidecar's phone folder is read, an edited copy's through its softlink", async () => {
      const signals = await readSignals(vfs, ADMIN_ACCESS, [saved, edited, plain]);
      assertEquals([signals.get(saved)?.localFolder, signals.get(edited)?.localFolder, signals.get(plain)?.localFolder], ['WhatsApp Images', 'WhatsApp Images', undefined]);
    });

    await t.step('pointsOf reads the position child of any node; readLocations lists the locations with their names', async () => {
      const harbour = await idOf(`${LOCATIONS_ROOT}/harbour`);
      assertEquals([...(await pointsOf(vfs, ADMIN_ACCESS, [harbour, boat, plain])).keys()].sort(), [harbour, boat].sort());
      assertEquals(await readLocations(vfs, ADMIN_ACCESS), [{ path: `${LOCATIONS_ROOT}/harbour`, id: harbour, name: 'Old harbour', lat: 57.5, lng: 12.0 }]);
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
