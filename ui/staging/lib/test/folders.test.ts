import { assertEquals } from '@std/assert';
import { cleanDir, crumbs, dirOf, folderPath, isFolderName, moveBlocked, parentDir } from '../folders.ts';

const category = '/home/anna/staging/files/scans';

Deno.test('a dir is cleaned of empty, . and .. segments, so it never leaves its category', () => {
  assertEquals(cleanDir('/box-3//prints/'), 'box-3/prints');
  assertEquals(cleanDir('../../albums'), 'albums');
  assertEquals(cleanDir(null), '');
  assertEquals(folderPath(category, ''), category);
  assertEquals(folderPath(category, '../inbox'), `${category}/inbox`);
  assertEquals(folderPath(category, 'box-3/prints'), `${category}/box-3/prints`);
});

Deno.test('a path is taken back to its dir below the category, and one outside it has none', () => {
  assertEquals(dirOf(category, category), '');
  assertEquals(dirOf(category, `${category}/box-3/prints`), 'box-3/prints');
  assertEquals(dirOf(category, '/home/anna/staging/files/scans-2/box-3'), undefined);
});

Deno.test('the crumbs lead down to a dir, and its parent is one up', () => {
  assertEquals(crumbs('box-3/prints'), [{ name: 'box-3', dir: 'box-3' }, { name: 'prints', dir: 'box-3/prints' }]);
  assertEquals(crumbs(''), []);
  assertEquals(parentDir('box-3/prints'), 'box-3');
  assertEquals(parentDir('box-3'), '');
  assertEquals(parentDir(''), '');
});

Deno.test('a move into a source or below it, or to where every source already is, is refused', () => {
  const box = `${category}/box-3`;
  assertEquals(moveBlocked(box, [box]), 'into-itself');
  assertEquals(moveBlocked(`${box}/prints`, [box]), 'into-itself');
  assertEquals(moveBlocked(category, [box]), 'already-there');
  assertEquals(moveBlocked(category, [box, `${category}/box-4/a.jpg`]), undefined);
  assertEquals(moveBlocked(`${category}/box-30`, [box]), undefined);
  assertEquals(moveBlocked('/home/anna/staging/files/inbox', [box]), undefined);
});

Deno.test('a new folder name is one segment', () => {
  assertEquals(isFolderName('Box 3'), true);
  assertEquals(isFolderName('a/b'), false);
  assertEquals(isFolderName('..'), false);
  assertEquals(isFolderName(''), false);
});
