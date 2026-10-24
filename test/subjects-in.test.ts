/**
 * `subjects-in`: the people, locations, devices and photographers of an album's media, counted
 * over the members the album shows; and `find-within --under`, which narrows the map to them.
 */

import { ALBUMS_ROOT, DEVICES_ROOT, LOCATIONS_ROOT, PEOPLE_ROOT } from '@archive/paths';
import type { ContainerSubjects } from '@archive/media/api';
import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS, createTestContext, testCommands } from '@ein/testing';

const testCtx = createTestContext({ boot: true, modules: ['archive'] });

type Clustered = { clusters: { count: number }[]; total: number };

Deno.test({
  name: 'subjects-in',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  const mklink = (parent: string, name: string, target: string) =>
    vfs.create(ADMIN_ACCESS, 'softlink', parent, name, {
      props: { uid: ADMIN_ACCESS.uid, gid: ADMIN_ACCESS.gid, mode: 0o777, softlink: target },
    });

  const album = `${ALBUMS_ROOT}/summer`;

  try {
    for (const root of [PEOPLE_ROOT, LOCATIONS_ROOT, DEVICES_ROOT, ALBUMS_ROOT, '/elsewhere']) await cmd.shouldSucceed(`mkdir -p ${root}`);
    await vfs.create(ADMIN_ACCESS, 'person', PEOPLE_ROOT, 'anna', { attrs: { name: 'Anna Andersson' } });
    await vfs.create(ADMIN_ACCESS, 'person', PEOPLE_ROOT, 'bo', { attrs: { name: 'Bo' } });
    await vfs.create(ADMIN_ACCESS, 'location', LOCATIONS_ROOT, 'beach', { attrs: { name: 'The Beach' } });
    await vfs.create(ADMIN_ACCESS, 'device', DEVICES_ROOT, 'camera', { attrs: { name: 'Example Camera' } });
    await vfs.create(ADMIN_ACCESS, 'album', ALBUMS_ROOT, 'summer', { attrs: { name: 'Summer' } });
    const boId = (await vfs.get(ADMIN_ACCESS, `${PEOPLE_ROOT}/bo`)).id;
    await cmd.shouldSucceed(`mkdir -p ${PEOPLE_ROOT}/unknown`);
    await vfs.create(ADMIN_ACCESS, 'person', `${PEOPLE_ROOT}/unknown`, 'faces-1', { attrs: { name: 'Unknown 1' } });
    const unknownId = (await vfs.get(ADMIN_ACCESS, `${PEOPLE_ROOT}/unknown/faces-1`)).id;

    // Two photos in the album, one added to it by a link, and one outside it.
    for (const path of [`${album}/a.jpg`, `${album}/b.jpg`, '/elsewhere/c.jpg', '/elsewhere/d.jpg']) {
      await cmd.shouldSucceed(`echo x > ${path}`);
      await vfs.update(ADMIN_ACCESS, path, { attrs: { mimetype: 'image/jpeg', devicePath: `${DEVICES_ROOT}/camera` } });
      await cmd.shouldSucceed(`mknode -t position ${path}/position`);
      await cmd.shouldSucceed(`position-set ${path}/position --lat=57.7 --lng=11.97`);
    }
    await mklink(album, 'c.jpg', '/elsewhere/c.jpg');

    await vfs.ensure(ADMIN_ACCESS, 'directory', `${album}/a.jpg`, 'people', { props: { mode: 0o775 } });
    await mklink(`${album}/a.jpg/people`, 'anna', `${PEOPLE_ROOT}/anna`);
    await vfs.ensure(ADMIN_ACCESS, 'directory', '/elsewhere/c.jpg', 'regions', { props: { mode: 0o775 } });
    await vfs.create(ADMIN_ACCESS, 'media-region', '/elsewhere/c.jpg/regions', 'face-0', { attrs: { personId: boId } });
    // Faces nobody has named are not counted as a person.
    await vfs.create(ADMIN_ACCESS, 'media-region', '/elsewhere/c.jpg/regions', 'face-1', { attrs: { personId: unknownId } });
    await vfs.ensure(ADMIN_ACCESS, 'directory', `${album}/b.jpg`, 'people', { props: { mode: 0o775 } });
    await mklink(`${album}/b.jpg/people`, 'anna', `${PEOPLE_ROOT}/anna`);
    await mklink(`${album}/b.jpg`, 'location', `${LOCATIONS_ROOT}/beach`);
    await mklink(`${album}/b.jpg`, 'photographer', `${PEOPLE_ROOT}/bo`);
    // Outside the album, so counted nowhere.
    await vfs.ensure(ADMIN_ACCESS, 'directory', '/elsewhere/d.jpg', 'people', { props: { mode: 0o775 } });
    await mklink('/elsewhere/d.jpg/people', 'bo', `${PEOPLE_ROOT}/bo`);

    await t.step('counts each subject over the members, linked ones included', async () => {
      const subjects = await client.execJson<ContainerSubjects>(`subjects-in ${album}`);
      assertEquals(subjects.total, 3);
      assertEquals(subjects.positioned, 3);
      assertEquals(subjects.people, [
        { path: `${PEOPLE_ROOT}/anna`, name: 'Anna Andersson', count: 2 },
        { path: `${PEOPLE_ROOT}/bo`, name: 'Bo', count: 1 },
      ]);
      assertEquals(subjects.locations, [{ path: `${LOCATIONS_ROOT}/beach`, name: 'The Beach', count: 1 }]);
      assertEquals(subjects.devices, [{ path: `${DEVICES_ROOT}/camera`, name: 'Example Camera', count: 3 }]);
      assertEquals(subjects.photographers, [{ path: `${PEOPLE_ROOT}/bo`, name: 'Bo', count: 1 }]);
      assertEquals(subjects.truncated, false);
    });

    await t.step('a path that is not a container is an error', async () => {
      await cmd.shouldFail(`subjects-in ${ALBUMS_ROOT}/missing`);
    });

    await t.step('find-within --under keeps the map to the album', async () => {
      const box = '--north=58 --south=57 --east=12 --west=11 --cell=1';
      assertEquals((await client.execJson<Clustered>(`find-within ${box}`)).total, 4);
      assertEquals((await client.execJson<Clustered>(`find-within ${box} --under ${album}`)).total, 3);
    });
  } finally {
    await client.close();
    await testCtx.teardown();
  }
});
