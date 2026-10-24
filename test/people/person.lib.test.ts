/**
 * Unit tests for the person lifecycle lib: slugs, unnamed people, naming.
 * Fast tier — an in-memory VFS, no harness, no models.
 */

import { assertEquals, assertRejects } from '@std/assert';
import { ADMIN_ACCESS } from '@ein/testing';
import { createTestVfs } from '@ein/testing';
import type { NodeVFS } from '@ein/testing';
import {
  createUnnamedPerson,
  faceCropSize,
  isUnnamed,
  namePerson,
  PEOPLE_ROOT,
  type PersonNodeAttrs,
  slugifyName,
  uniqueSlug,
  UNKNOWN_ROOT,
} from '../../lib/people/person.ts';

const setupPeople = async (vfs: NodeVFS) => {
  const props = { uid: 1000, gid: 1000, mode: 0o775 };
  let parent = '/';
  for (const segment of PEOPLE_ROOT.split('/').filter(Boolean)) {
    await vfs.create(ADMIN_ACCESS, 'directory', parent, segment, { props });
    parent = parent === '/' ? `/${segment}` : `${parent}/${segment}`;
  }
};

Deno.test('slugifyName transliterates rather than stripping', () => {
  // Stripping non-ASCII would give `sa-berg`, losing the first letter of both names.
  assertEquals(slugifyName('Åsa Öberg'), 'asa-oberg');
  assertEquals(slugifyName('Anna Andersson'), 'anna-andersson');
  assertEquals(slugifyName('Renée Ekström'), 'renee-ekstrom');
  assertEquals(slugifyName('Jean-Luc  Picard'), 'jean-luc-picard');
  assertEquals(slugifyName("O'Brien, Miles"), 'o-brien-miles');
  assertEquals(slugifyName('  spaced  '), 'spaced');
});

Deno.test('slugifyName yields an empty slug for a nameless name', () => {
  // Callers must not turn this into a path segment; namePerson rejects it.
  assertEquals(slugifyName('???'), '');
});

Deno.test('uniqueSlug suffixes around collisions', async () => {
  const { vfs, dispose } = await createTestVfs();
  try {
    await setupPeople(vfs);
    assertEquals(await uniqueSlug(vfs, ADMIN_ACCESS, PEOPLE_ROOT, 'anna'), 'anna');

    await vfs.create(ADMIN_ACCESS, 'person', PEOPLE_ROOT, 'anna', {
      props: { uid: 1000, gid: 1000, mode: 0o775 },
      attrs: { name: 'Anna' },
    });
    assertEquals(await uniqueSlug(vfs, ADMIN_ACCESS, PEOPLE_ROOT, 'anna'), 'anna-2');
  } finally {
    await dispose();
  }
});

Deno.test(`createUnnamedPerson makes a real person under ${PEOPLE_ROOT}/unknown`, async () => {
  const { vfs, dispose } = await createTestVfs();
  try {
    await setupPeople(vfs);
    const created = await createUnnamedPerson(vfs, ADMIN_ACCESS, {
      createdBy: 'assign-faces',
      representativeFaceId: 'FACE1',
    });

    assertEquals(created.path.startsWith(`${UNKNOWN_ROOT}/`), true);

    const node = await vfs.get<PersonNodeAttrs>(ADMIN_ACCESS, created.path);
    assertEquals(node.type, 'person');
    assertEquals(isUnnamed(node.attrs), true);
    assertEquals(node.attrs.origin, 'face');
    assertEquals(node.attrs.createdBy, 'assign-faces');
    assertEquals(node.attrs.representativeFaceId, 'FACE1');
    // A blank name would render as an empty row.
    assertEquals(node.attrs.name.length > 0, true);
    assertEquals(node.attrs.name, created.name);

    // Shape-identical to a person-create person.
    assertEquals((await vfs.get(ADMIN_ACCESS, `${created.path}/events`)).type, 'directory');
  } finally {
    await dispose();
  }
});

Deno.test(`unnamed people are invisible to a listing of ${PEOPLE_ROOT}`, async () => {
  const { vfs, dispose } = await createTestVfs();
  try {
    await setupPeople(vfs);
    await vfs.create(ADMIN_ACCESS, 'person', PEOPLE_ROOT, 'anna', {
      props: { uid: 1000, gid: 1000, mode: 0o775 },
      attrs: { name: 'Anna' },
    });
    await createUnnamedPerson(vfs, ADMIN_ACCESS, { createdBy: 'assign-faces' });
    await createUnnamedPerson(vfs, ADMIN_ACCESS, { createdBy: 'assign-faces' });

    // Listing people reads the direct children of type person.
    const listed = (await vfs.children(ADMIN_ACCESS, PEOPLE_ROOT))
      .filter((c) => c.node.type === 'person')
      .map((c) => c.name);
    assertEquals(listed, ['anna']);
  } finally {
    await dispose();
  }
});

Deno.test('two unnamed people created in the same tick get distinct paths', async () => {
  const { vfs, dispose } = await createTestVfs();
  try {
    await setupPeople(vfs);
    const made = await Promise.all(
      Array.from({ length: 5 }, () => createUnnamedPerson(vfs, ADMIN_ACCESS, { createdBy: 'assign-faces' })),
    );
    assertEquals(new Set(made.map((m) => m.path)).size, 5);
    assertEquals(new Set(made.map((m) => m.id)).size, 5);
  } finally {
    await dispose();
  }
});

Deno.test('namePerson moves the person and keeps the node id', async () => {
  const { vfs, dispose } = await createTestVfs();
  try {
    await setupPeople(vfs);
    const created = await createUnnamedPerson(vfs, ADMIN_ACCESS, {
      createdBy: 'cluster-faces',
      representativeFaceId: 'FACE1',
    });

    const named = await namePerson(vfs, ADMIN_ACCESS, created.path, { name: 'Åsa Öberg', gender: 'female' });

    assertEquals(named.path, `${PEOPLE_ROOT}/asa-oberg`);
    // The id is the whole point: every recognized face refers to its person by id.
    assertEquals(named.id, created.id);
    assertEquals((await vfs.resolveId(ADMIN_ACCESS, created.id))[0].vfsAbsPath, named.path);
    assertEquals(await vfs.exists(ADMIN_ACCESS, created.path), false);

    const node = await vfs.get<PersonNodeAttrs>(ADMIN_ACCESS, named.path);
    assertEquals(node.attrs.name, 'Åsa Öberg');
    assertEquals(node.attrs.gender, 'female');
    // Every trace of auto-creation is gone, not merely falsified.
    for (const key of ['unnamed', 'origin', 'createdBy', 'representativeFaceId', 'createdAt']) {
      assertEquals(Object.hasOwn(node.attrs, key), false, `${key} should be removed`);
    }
    assertEquals(isUnnamed(node.attrs), false);
    // The events dir came along with the move.
    assertEquals((await vfs.get(ADMIN_ACCESS, `${named.path}/events`)).type, 'directory');
  } finally {
    await dispose();
  }
});

Deno.test('namePerson suffixes onto an existing slug instead of colliding', async () => {
  const { vfs, dispose } = await createTestVfs();
  try {
    await setupPeople(vfs);
    await vfs.create(ADMIN_ACCESS, 'person', PEOPLE_ROOT, 'anna-andersson', {
      props: { uid: 1000, gid: 1000, mode: 0o775 },
      attrs: { name: 'Anna Andersson' },
    });
    const created = await createUnnamedPerson(vfs, ADMIN_ACCESS, { createdBy: 'assign-faces' });

    const named = await namePerson(vfs, ADMIN_ACCESS, created.path, { name: 'Anna Andersson' });
    assertEquals(named.path, `${PEOPLE_ROOT}/anna-andersson-2`);
  } finally {
    await dispose();
  }
});

Deno.test('namePerson honours an explicit slug', async () => {
  const { vfs, dispose } = await createTestVfs();
  try {
    await setupPeople(vfs);
    const created = await createUnnamedPerson(vfs, ADMIN_ACCESS, { createdBy: 'assign-faces' });
    const named = await namePerson(vfs, ADMIN_ACCESS, created.path, { name: 'Anna' }, 'the-boss');
    assertEquals(named.path, `${PEOPLE_ROOT}/the-boss`);
  } finally {
    await dispose();
  }
});

Deno.test('namePerson refuses an already-named person', async () => {
  const { vfs, dispose } = await createTestVfs();
  try {
    await setupPeople(vfs);
    await vfs.create(ADMIN_ACCESS, 'person', PEOPLE_ROOT, 'anna', {
      props: { uid: 1000, gid: 1000, mode: 0o775 },
      attrs: { name: 'Anna' },
    });

    // Moving a named person would strand the softlinks that record their path.
    await assertRejects(
      () => namePerson(vfs, ADMIN_ACCESS, `${PEOPLE_ROOT}/anna`, { name: 'Anna Andersson' }),
      Error,
      'only unnamed people',
    );
    assertEquals(await vfs.exists(ADMIN_ACCESS, `${PEOPLE_ROOT}/anna`), true);
  } finally {
    await dispose();
  }
});

Deno.test('namePerson rejects a name that yields no slug', async () => {
  const { vfs, dispose } = await createTestVfs();
  try {
    await setupPeople(vfs);
    const created = await createUnnamedPerson(vfs, ADMIN_ACCESS, { createdBy: 'assign-faces' });
    await assertRejects(() => namePerson(vfs, ADMIN_ACCESS, created.path, { name: '???' }), Error, 'slug');
    // Left untouched, still unnamed and still where it was.
    assertEquals(isUnnamed((await vfs.get<PersonNodeAttrs>(ADMIN_ACCESS, created.path)).attrs), true);
  } finally {
    await dispose();
  }
});

Deno.test('faceCropSize: the padded box in the display frame, fitted inside the crop bound', () => {
  // 100 px face, padded 30% each side -> 160 px, under the bound, kept as is.
  assertEquals(faceCropSize({ x: 0.4, y: 0.4, width: 0.1, height: 0.1 }, { width: 1000, height: 1000 }), { width: 160, height: 160 });
  // 400x600 face -> 640x960 padded -> fitted to 384 on the long side.
  assertEquals(faceCropSize({ x: 0.3, y: 0.2, width: 0.2, height: 0.3 }, { width: 2000, height: 2000 }), { width: 256, height: 384 });
  // A quarter turn swaps the frame the box is a fraction of.
  assertEquals(faceCropSize({ x: 0.4, y: 0.4, width: 0.1, height: 0.1 }, { width: 2000, height: 1000, angle: 90 }), { width: 160, height: 320 });
  // Padding stops at the edge of the frame.
  assertEquals(faceCropSize({ x: 0.9, y: 0.9, width: 0.1, height: 0.1 }, { width: 1000, height: 1000 }), { width: 130, height: 130 });
  assertEquals(faceCropSize({ x: 0, y: 0, width: 0.1, height: 0.1 }, {}), undefined);
});
