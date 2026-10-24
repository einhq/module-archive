import { assertEquals } from '@std/assert';
import {
  addFiles,
  discardFiles,
  discardGroup,
  later,
  merge,
  notAGroup,
  promoteInto,
  promoteNew,
  regroupInto,
  regroupNew,
  reject,
  split,
  undoEntries,
} from '../decision-commands.ts';

const group = { path: "/home/anna/staging/albums/inbox/anna's day", staging: { memberKey: '0f3a9c2b4d5e6f70' } };
const quotedGroup = `'/home/anna/staging/albums/inbox/anna'\\''s day'`;

Deno.test('each decision is one command naming the group with its member key', () => {
  assertEquals(promoteInto(group, '/archive/albums/Lake trip'), `staging promote ${quotedGroup} --into '/archive/albums/Lake trip' --expect '0f3a9c2b4d5e6f70'`);
  assertEquals(promoteNew(group, 'Lake weekend'), `staging promote ${quotedGroup} --name 'Lake weekend' --expect '0f3a9c2b4d5e6f70'`);
  assertEquals(
    promoteNew(group, 'Lake weekend', { private: true, except: ['/s/a.jpg', '/s/b.jpg'] }),
    `staging promote ${quotedGroup} --name 'Lake weekend' --share private --except '/s/a.jpg' --except '/s/b.jpg' --expect '0f3a9c2b4d5e6f70'`,
  );
  assertEquals(discardGroup(group), `staging discard ${quotedGroup} --expect '0f3a9c2b4d5e6f70'`);
  assertEquals(later(group, true), `staging later ${quotedGroup} --off`);
});

Deno.test('files and journal entries are named one by one', () => {
  assertEquals(discardFiles(['/s/a.jpg', '/s/b c.jpg']), `staging discard '/s/a.jpg' '/s/b c.jpg'`);
  assertEquals(addFiles('/archive/albums/summer', ['/s/a.jpg']), `album add '/archive/albums/summer' '/s/a.jpg'`);
  assertEquals(undoEntries(['01JA', '01JB']), `staging undo '01JA' '01JB'`);
});

Deno.test('each edit of the groups is one command, every group in it named with its member key', () => {
  const other = { path: '/home/anna/staging/albums/inbox/2019-06-15', staging: { memberKey: '1a2b3c4d5e6f7081' } };
  assertEquals(split(group, '/s/IMG_0412.jpg'), `staging split ${quotedGroup} --at '/s/IMG_0412.jpg' --expect '0f3a9c2b4d5e6f70'`);
  assertEquals(regroupInto(other, ['/s/a.jpg', '/s/b.jpg']), `staging regroup '${other.path}' '/s/a.jpg' '/s/b.jpg' --expect '1a2b3c4d5e6f7081'`);
  assertEquals(regroupNew(['/s/a.jpg']), `staging regroup --new '/s/a.jpg'`);
  assertEquals(merge(other, group), `staging merge '${other.path}' ${quotedGroup} --expect '1a2b3c4d5e6f7081' --expect '0f3a9c2b4d5e6f70'`);
  assertEquals(notAGroup(group), `staging delete ${quotedGroup} --expect '0f3a9c2b4d5e6f70'`);
});

Deno.test('"not this album" names the group and the album', () => {
  assertEquals(reject(group, '/archive/albums/Summer 2019'), `staging reject ${quotedGroup} '/archive/albums/Summer 2019'`);
});
