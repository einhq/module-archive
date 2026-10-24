/**
 * person-unknown for a person found by voice: the card has no face to show, so it carries the
 * recordings to hear them in instead — the ones they speak longest in, each with its longest turn
 * and the recording's kind, so the card can play it without asking again.
 */

import { PEOPLE_ROOT } from '@archive/paths';
import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS, createTestContext } from '@ein/testing';
import type { UnknownListResult } from '@archive/people/api';

const testCtx = createTestContext({ modules: ['archive'] });

Deno.test({
  name: 'person-unknown voices',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();

  const addSpeaker = async (file: string, name: string, personId: string, turns: [number, number][]) => {
    const path = `${file}/metadata/transcript/speakers/${name}`;
    await client.exec(`mknode -t embedding ${path} --as embeddingType=voice --an capacity=8`);
    const talkSeconds = turns.reduce((sum, [start, end]) => sum + end - start, 0);
    await vfs.update(ADMIN_ACCESS, path, { attrs: { turns, talkSeconds, turnCount: turns.length, personId, personSource: 'auto' } });
    return path;
  };

  try {
    await client.exec(`mkdir -p ${PEOPLE_ROOT}/unknown /rec`);
    const person = await vfs.create(ADMIN_ACCESS, 'person', `${PEOPLE_ROOT}/unknown`, 'v1', {
      props: { uid: 1000, gid: 1000, mode: 0o775 },
      attrs: { name: 'Unknown V1', unnamed: true, origin: 'voice', createdAt: '2026-07-01T00:00:00Z' },
    });
    for (const [file, mimetype] of [['/rec/a.m4a', 'audio/mp4'], ['/rec/b.mp4', 'video/mp4']]) {
      await client.exec(`echo x > ${file}`);
      await vfs.update(ADMIN_ACCESS, file, { attrs: { mimetype } });
      await client.exec(`mkdir -p ${file}/metadata/transcript/speakers`);
    }
    const short = await addSpeaker('/rec/a.m4a', 's0', person.id, [[5, 9]]);
    const long = await addSpeaker('/rec/b.mp4', 's1', person.id, [[2, 14], [20, 22]]);

    await t.step('a card carries the voices, longest first, with their sample and kind', async () => {
      const res = await client.execJson<UnknownListResult>('person-unknown');
      const card = res.people.find((p) => p.id === person.id)!;
      assertEquals(card.faceCount, 0);
      assertEquals(card.voiceCount, 2);
      assertEquals(card.voices.map((voice) => [voice.voicePath, voice.filePath, voice.start, voice.end, voice.mimetype]), [
        [long, '/rec/b.mp4', 2, 14, 'video/mp4'],
        [short, '/rec/a.m4a', 5, 9, 'audio/mp4'],
      ]);
    });

    await t.step('--faces caps the voices as it caps the crops', async () => {
      const res = await client.execJson<UnknownListResult>('person-unknown --faces 1');
      assertEquals(res.people.find((p) => p.id === person.id)!.voices.map((voice) => voice.voicePath), [long]);
    });

    await t.step('--person carries them too', async () => {
      const res = await client.execJson<UnknownListResult>(`person-unknown --person ${person.id}`);
      assertEquals(res.people[0].voices.map((voice) => voice.voicePath), [long, short]);
    });
  } finally {
    await client.close();
    await testCtx.teardown();
  }
});
