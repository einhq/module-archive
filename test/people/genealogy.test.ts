/**
 * Pure-unit tests for the kinship engine: builds a small graph directly in an
 * in-memory VFS and asserts English + Swedish rendered terms (composition,
 * männing math, removal, in-law/step).
 */

import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS } from '@ein/testing';
import { createTestVfs } from '@ein/testing';
import type { NodeVFS } from '@ein/testing';
import type { PersonGender } from '@archive/people/types';
import { createRelationPair, kinship, type Lang, makeCtx, relationshipPath, render } from '../../lib/people/genealogy.ts';

const person = (vfs: NodeVFS, name: string, gender: PersonGender) =>
  vfs.create(ADMIN_ACCESS, 'person', '/', name, { props: { uid: 1000, gid: 1000, mode: 0o755 }, attrs: { gender } });

const addParent = (vfs: NodeVFS, child: string, parent: string) =>
  createRelationPair(vfs, ADMIN_ACCESS, {
    aLink: `/${child}/parents/${parent}`,
    aTarget: `/${parent}`,
    bLink: `/${parent}/children/${child}`,
    bTarget: `/${child}`,
  });

const addPartner = (vfs: NodeVFS, a: string, b: string) =>
  createRelationPair(vfs, ADMIN_ACCESS, {
    aLink: `/${a}/partners/${b}`,
    aTarget: `/${b}`,
    bLink: `/${b}/partners/${a}`,
    bTarget: `/${a}`,
  });

Deno.test('genealogy kinship rendering', async () => {
  const { vfs, dispose } = await createTestVfs();
  try {
    for (
      const [n, g] of [
        ['ggm', 'female'],
        ['gm', 'female'],
        ['gf', 'male'],
        ['gm2', 'female'],
        ['m', 'female'],
        ['m2', 'female'],
        ['sib', 'female'],
        ['ch', 'female'],
        ['ch2', 'female'],
        ['stepdad', 'male'],
        ['outsider', 'other'],
      ] as [string, PersonGender][]
    ) {
      await person(vfs, n, g);
    }
    await addParent(vfs, 'gm', 'ggm');
    await addParent(vfs, 'gm2', 'ggm');
    await addParent(vfs, 'm', 'gm');
    await addParent(vfs, 'm', 'gf');
    await addParent(vfs, 'sib', 'gm');
    await addParent(vfs, 'sib', 'gf'); // m & sib share both parents -> full siblings
    await addParent(vfs, 'm2', 'gm2');
    await addParent(vfs, 'ch', 'm');
    await addParent(vfs, 'ch2', 'm2');
    await addPartner(vfs, 'm', 'stepdad');

    const ctx = makeCtx(vfs, ADMIN_ACCESS);
    const term = async (a: string, b: string, lang: Lang) => render(await kinship(ctx, `/${a}`, `/${b}`), lang);

    // lineal composition
    assertEquals(await term('ch', 'gm', 'en'), 'grandmother');
    assertEquals(await term('ch', 'gm', 'sv'), 'mormor');
    assertEquals(await term('ch', 'ggm', 'en'), 'great-grandmother');
    assertEquals(await term('ch', 'ggm', 'sv'), 'mormorsmor');

    // descendant
    assertEquals(await term('gm', 'ch', 'en'), 'granddaughter');
    assertEquals(await term('gm', 'ch', 'sv'), 'dotterdotter');

    // sibling (full)
    assertEquals(await term('m', 'sib', 'en'), 'sister');
    assertEquals(await term('m', 'sib', 'sv'), 'syster');

    // cousins + männing + removal
    assertEquals(await term('m', 'm2', 'en'), 'first cousin');
    assertEquals(await term('m', 'm2', 'sv'), 'kusin');
    assertEquals(await term('ch', 'ch2', 'en'), 'second cousin');
    assertEquals(await term('ch', 'ch2', 'sv'), 'syssling');
    assertEquals(await term('ch', 'm2', 'en'), 'first cousin once removed');
    assertEquals(await term('ch', 'm2', 'sv'), 'kusin (1 generation förskjutet)');

    // aunts and nieces know which side: sib is the mother's sister
    assertEquals(await term('ch', 'sib', 'en'), 'aunt');
    assertEquals(await term('ch', 'sib', 'sv'), 'moster');
    assertEquals(await term('sib', 'ch', 'en'), 'niece');
    assertEquals(await term('sib', 'ch', 'sv'), 'systerdotter');

    // partner + step (gender follows the described person)
    assertEquals(await term('m', 'stepdad', 'en'), 'partner');
    assertEquals(await term('ch', 'stepdad', 'en'), 'stepfather');
    assertEquals(await term('ch', 'stepdad', 'sv'), 'styvfar');

    // in-law reaches blood relatives of a partner, and genuine unrelated
    assertEquals(await term('stepdad', 'gm2', 'en'), 'aunt-in-law');
    assertEquals(await term('ch', 'outsider', 'en'), 'not related');

    // The drawing companion gets the actual relationship chain, not just its
    // rendered name. A cousin route passes through the shared ancestor.
    assertEquals(await relationshipPath(ctx, '/ch', '/ch2'), ['/ch', '/m', '/gm', '/ggm', '/gm2', '/m2', '/ch2']);
    assertEquals(await relationshipPath(ctx, '/ch', '/stepdad'), ['/ch', '/m', '/stepdad']);
    assertEquals(await relationshipPath(ctx, '/ch', '/outsider'), null);
  } finally {
    await dispose();
  }
});
