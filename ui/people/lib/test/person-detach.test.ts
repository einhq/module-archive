import { ALBUMS_ROOT, PEOPLE_ROOT } from '@archive/paths';
import { assertEquals, assertRejects } from '@std/assert';
import { DETACH_CHUNK, detachFromPerson } from '../person-detach.ts';

/** Records what was run and answers as `person-detach --to-new-person` does. */
const fakeExec = (person: string | null = `${PEOPLE_ROOT}/unknown/new1`) => {
  const commands: string[] = [];
  const exec = <T>(command: string): Promise<T> => {
    commands.push(command);
    return Promise.resolve({ person: person ? { id: 'new1', path: person, name: 'Unknown new1' } : null } as T);
  };
  return { commands, exec };
};

const paths = (count: number) => Array.from({ length: count }, (_, i) => `${ALBUMS_ROOT}/p${i}.jpg/faces/face-0`);

Deno.test('detach faces: unassigning passes the paths and nothing else', async () => {
  const { commands, exec } = fakeExec();
  assertEquals(await detachFromPerson(exec, paths(2), { kind: 'unassign' }), null);
  assertEquals(commands, [
    `person-detach '${ALBUMS_ROOT}/p0.jpg/faces/face-0' '${ALBUMS_ROOT}/p1.jpg/faces/face-0'`,
  ]);
});

Deno.test('detach faces: an existing person is the target from the first chunk', async () => {
  const { commands, exec } = fakeExec();
  assertEquals(await detachFromPerson(exec, paths(1), { kind: 'person', path: `${PEOPLE_ROOT}/anna` }), { path: `${PEOPLE_ROOT}/anna` });
  assertEquals(commands, [`person-detach --to '${PEOPLE_ROOT}/anna' '${ALBUMS_ROOT}/p0.jpg/faces/face-0'`]);
});

Deno.test('detach faces: a batch spanning chunks mints exactly one person', async () => {
  // Only the first chunk mints; every later chunk goes to the person it made.
  const { commands, exec } = fakeExec(`${PEOPLE_ROOT}/unknown/minted`);
  const landed = await detachFromPerson(exec, paths(DETACH_CHUNK * 2 + 1), { kind: 'new-person' });

  assertEquals(landed, { id: 'new1', path: `${PEOPLE_ROOT}/unknown/minted`, name: 'Unknown new1' });
  assertEquals(commands.length, 3);
  assertEquals(commands.filter((c) => c.includes('--to-new-person')).length, 1);
  assertEquals(commands.slice(1).every((c) => c.includes(`--to '${PEOPLE_ROOT}/unknown/minted'`)), true);
});

Deno.test('detach faces: a mint that reports no person stops the batch', async () => {
  const { commands, exec } = fakeExec(null);
  await assertRejects(() => detachFromPerson(exec, paths(DETACH_CHUNK + 1), { kind: 'new-person' }));
  // The second chunk never ran, rather than minting a second person for it.
  assertEquals(commands.length, 1);
});

Deno.test('detach faces: a path with a quote in it survives the shell', () => {
  const { commands, exec } = fakeExec();
  return detachFromPerson(exec, [`${ALBUMS_ROOT}/o'brien.jpg/faces/face-0`], { kind: 'unassign' }).then(() => {
    assertEquals(commands[0], `person-detach '${ALBUMS_ROOT}/o'\\''brien.jpg/faces/face-0'`);
  });
});

Deno.test('detach faces: nothing to move runs nothing', async () => {
  const { commands, exec } = fakeExec();
  assertEquals(await detachFromPerson(exec, [], { kind: 'new-person' }), null);
  assertEquals(commands, []);
});
