import { assert, assertEquals } from '@std/assert';
import {
  acceptChunks,
  discardChunks,
  fileChunks,
  type GroupRef,
  intoGroupChunks,
  laterChunks,
  newAlbumChunks,
  partsCount,
  planCommands,
  selectionParts,
  undoCommands,
} from '../selection-command.ts';

const root = '/home/anna/staging/albums/inbox';
const group = (index: number, memberCount = 10): GroupRef => ({
  name: `g${index}`,
  path: `${root}/g${index}`,
  title: `Day ${index}`,
  memberCount,
  staging: { memberKey: `k${index}` },
});
const groups = Array.from({ length: 214 }, (_, index) => group(index));
const rowOf = (name: string) => groups.find((each) => each.name === name);
type SectionSelection = Parameters<typeof selectionParts>[0];

Deno.test('a selection splits into groups whole, groups but for some pictures, and pictures one by one', () => {
  const selection: SectionSelection = {
    sections: new Set(['g1', 'g2', 'gone']),
    excluded: new Map([['/s/g2-a.jpg', 'g2'], ['/s/gone-a.jpg', 'gone']]),
    items: new Map([['/s/g5-a.jpg', 'g5'], ['/s/g5-b.jpg', 'g5']]),
  };
  const parts = selectionParts(selection, rowOf);
  assertEquals(parts.groups.map((each) => each.name), ['g1']);
  assertEquals(parts.partial.map(({ group, except }) => [group.name, except]), [['g2', ['/s/g2-a.jpg']]]);
  assertEquals(parts.files.map(({ group, paths }) => [group.name, paths]), [['g5', ['/s/g5-a.jpg', '/s/g5-b.jpg']]]);
  assertEquals(partsCount(parts), { groups: 2, files: 10 + 9 + 2, whole: 1 });
});

Deno.test('filing names at most 20 groups a call, each with its member key, then one call per group with exclusions, then 500 pictures a call', () => {
  const files = Array.from({ length: 1200 }, (_, index) => `/s/f${index}.jpg`);
  const chunks = fileChunks(
    { groups: groups.slice(0, 45), partial: [{ group: groups[50], except: ["/s/it's.jpg"] }], files: [{ group: groups[60], paths: files }] },
    '/archive/albums/Lake trip 2019',
  );
  assertEquals(chunks.map((chunk) => chunk.groups.length), [20, 20, 5, 0, 0, 0, 0]);
  assertEquals(chunks.map((chunk) => chunk.files), [200, 200, 50, 9, 500, 500, 200]);
  assertEquals(chunks.map((chunk) => chunk.decides), [20, 20, 5, 1, 0, 0, 0]);
  assert(chunks[0].command.startsWith(`staging promote '${root}/g0' '${root}/g1'`));
  assert(chunks[0].command.includes("--into '/archive/albums/Lake trip 2019' --expect 'k0' --expect 'k1'"));
  assertEquals(chunks[0].command.match(/--expect/g)?.length, 20);
  assertEquals(chunks[3].command, `staging promote '${root}/g50' --into '/archive/albums/Lake trip 2019' --except '/s/it'\\''s.jpg' --expect 'k50'`);
  assert(chunks[4].command.startsWith(`album add '/archive/albums/Lake trip 2019' '/s/f0.jpg'`));
  assertEquals(chunks[4].touched.map((each) => each.name), ['g60']);
});

Deno.test('a new album is made by the first call, and the rest are filed into it', () => {
  const start = newAlbumChunks({ groups: groups.slice(0, 25), partial: [], files: [{ group: groups[90], paths: ['/s/a.jpg'] }] }, 'Summer 2019', true);
  assert(start);
  assertEquals(start.first.command.match(/--expect/g)?.length, 20);
  assert(start.first.command.includes("--name 'Summer 2019' --share private"));
  assertEquals(fileChunks(start.rest, '/archive/albums/Summer 2019').map((chunk) => [chunk.groups.length, chunk.files]), [[5, 50], [0, 1]]);
  const fromPart = newAlbumChunks({ groups: [], partial: [{ group: groups[3], except: ['/s/x.jpg'] }], files: [] }, 'Box 3', false);
  assertEquals(fromPart?.first.command, `staging promote '${root}/g3' --name 'Box 3' --except '/s/x.jpg' --expect 'k3'`);
  assertEquals(newAlbumChunks({ groups: [], partial: [], files: [{ group: groups[1], paths: ['/s/a.jpg'] }] }, 'Box 3', false), null);
});

Deno.test('discard takes 20 groups a call, Later 100, accept 20 and its plan 50', () => {
  assertEquals(discardChunks({ groups: groups.slice(0, 41), partial: [], files: [] }).map((chunk) => chunk.groups.length), [20, 20, 1]);
  assertEquals(
    discardChunks({ groups: [], partial: [], files: [{ group: groups[0], paths: ['/s/a.jpg', '/s/b c.jpg'] }] })[0].command,
    `staging discard '/s/a.jpg' '/s/b c.jpg'`,
  );
  const later = laterChunks(groups.slice(0, 200), false);
  assertEquals(later.map((chunk) => chunk.groups.length), [100, 100]);
  assert(!later[0].command.includes('--off'));
  assert(laterChunks(groups.slice(0, 3), true)[0].command.endsWith(' --off'));
  assertEquals(acceptChunks(groups, 'medium').length, 11);
  assert(acceptChunks(groups.slice(0, 2), 'high')[0].command.includes("--confidence high --expect 'k0' --expect 'k1'"));
  const plans = planCommands(groups);
  assertEquals(plans.length, 5);
  assert(plans[0].includes('--dry-run --confidence low'));
});

Deno.test('Undo all takes the newest entries first, 20 a call', () => {
  const journal = Array.from({ length: 45 }, (_, index) => `01J${String(index).padStart(3, '0')}`);
  const calls = undoCommands(journal);
  assertEquals(calls.length, 3);
  assert(calls[0].startsWith(`staging undo '01J044' '01J043'`));
  assertEquals(calls[0].match(/'01J/g)?.length, 20);
  assert(calls[2].endsWith(`'01J000'`));
});

Deno.test('a drop on a header merges groups into it, or moves pictures into it, in one call', () => {
  const into = groups[7];
  const merge = intoGroupChunks({ groups: [groups[1], into, groups[2]], partial: [], files: [] }, into, () => undefined);
  assert('chunk' in merge);
  assertEquals(merge.chunk.command, `staging merge '${root}/g7' '${root}/g1' '${root}/g2' --expect 'k7' --expect 'k1' --expect 'k2'`);
  assertEquals(merge.chunk.groups.map((each) => each.name), ['g1', 'g2']);

  const open = ['/s/1.jpg', '/s/2.jpg', '/s/3.jpg'];
  const move = intoGroupChunks({ groups: [], partial: [{ group: groups[4], except: ['/s/2.jpg'] }], files: [] }, into, (each) => each.name === 'g4' ? open : undefined);
  assert('chunk' in move);
  assertEquals(move.chunk.command, `staging regroup '${root}/g7' '/s/1.jpg' '/s/3.jpg' --expect 'k7'`);
  assertEquals(move.chunk.touched.map((each) => each.name), ['g7', 'g4']);

  assert('refused' in intoGroupChunks({ groups: [], partial: [{ group: groups[4], except: ['/s/2.jpg'] }], files: [] }, into, () => undefined));
  assert('refused' in intoGroupChunks({ groups: [groups[1]], partial: [], files: [{ group: groups[3], paths: ['/s/a.jpg'] }] }, into, () => undefined));
  assert('refused' in intoGroupChunks({ groups: [into], partial: [], files: [] }, into, () => undefined));
  assert('refused' in intoGroupChunks({ groups: groups.slice(20, 42), partial: [], files: [] }, into, () => undefined));
});
