/**
 * person-voices: the evidence behind a person recognition found by voice.
 *
 * A face cluster can be reviewed by looking at crops. A voice cluster cannot, so what this
 * has to return instead is where to hear each voice — the recording and its longest turn — and
 * it has to put the voices worth listening to first: those heard longest.
 */

import { PEOPLE_ROOT } from '@archive/paths';
import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS, createTestContext } from '@ein/testing';

const testCtx = createTestContext({ modules: ['archive'] });

type VoiceView = {
  voicePath: string;
  filePath?: string;
  start: number;
  end: number;
  talkSeconds: number;
  turnCount: number;
  speaker?: string;
  mimetype?: string;
};
type Result = {
  person: { id: string; path: string; name: string; unnamed: boolean; voiceCount: number; recordingCount: number };
  total: number;
  offset: number;
  voices: VoiceView[];
};

Deno.test({
  name: 'person-voices',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();

  /** A voice of a recording: the person it is, and the turns it spoke. */
  const addSpeaker = async (file: string, name: string, personId: string, turns: [number, number][]) => {
    const path = `${file}/metadata/transcript/speakers/${name}`;
    await client.exec(`mknode -t embedding ${path} --as embeddingType=voice --an capacity=8`);
    const talkSeconds = turns.reduce((sum, [start, end]) => sum + end - start, 0);
    await vfs.update(ADMIN_ACCESS, path, {
      attrs: { turns, talkSeconds, turnCount: turns.length, speaker: `speaker_${name.slice(1)}`, personId, personSource: 'auto' },
    });
    return path;
  };

  try {
    await client.exec(`mkdir -p ${PEOPLE_ROOT}`);
    await client.exec('mkdir -p /rec');
    for (const file of ['/rec/a.mp4', '/rec/b.mp4']) {
      await client.exec(`echo x > ${file}`);
      await vfs.update(ADMIN_ACCESS, file, { attrs: { mimetype: 'video/mp4' } });
      await client.exec(`mkdir -p ${file}/metadata/transcript/speakers`);
    }

    await client.exec(`person-create ${PEOPLE_ROOT}/astrid --name Astrid`);
    const person = await vfs.get(ADMIN_ACCESS, `${PEOPLE_ROOT}/astrid`);

    await t.step('a person nothing has heard has no voices', async () => {
      const res = await client.execJson<Result>(`person-voices ${PEOPLE_ROOT}/astrid`);
      assertEquals(res.total, 0);
      assertEquals(res.person.recordingCount, 0);
    });

    await t.step('returns every recording voice, with its longest turn to hear it at', async () => {
      await addSpeaker('/rec/a.mp4', 's0', person.id, [[5, 9], [30, 31]]);
      await addSpeaker('/rec/b.mp4', 's1', person.id, [[2, 14]]);

      const res = await client.execJson<Result>(`person-voices ${PEOPLE_ROOT}/astrid`);
      assertEquals(res.total, 2);
      assertEquals(res.person.voiceCount, 2);
      assertEquals(res.person.recordingCount, 2);
      // Heard longest first: twelve seconds in b against five in a.
      assertEquals(res.voices.map((voice) => [voice.filePath, voice.talkSeconds, voice.turnCount]), [['/rec/b.mp4', 12, 1], ['/rec/a.mp4', 5, 2]]);
      // The sample is the voice's longest turn.
      assertEquals([res.voices[1].start, res.voices[1].end], [5, 9]);
      // And the recording's kind, so a player can pick its rendition.
      assertEquals(res.voices.map((voice) => voice.mimetype), ['video/mp4', 'video/mp4']);
    });

    await t.step('orders by recording when asked', async () => {
      const res = await client.execJson<Result>(`person-voices --sort file ${PEOPLE_ROOT}/astrid`);
      assertEquals(res.voices.map((voice) => voice.filePath), ['/rec/a.mp4', '/rec/b.mp4']);
    });

    await t.step('pages', async () => {
      const res = await client.execJson<Result>(`person-voices --limit 1 --offset 1 ${PEOPLE_ROOT}/astrid`);
      assertEquals(res.total, 2);
      assertEquals(res.voices.length, 1);
      assertEquals(res.offset, 1);
    });

    await t.step('refuses a path that is not a person', async () => {
      const res = await client.exec(`person-voices /rec/a.mp4`);
      assertEquals(res.success, false);
    });
  } finally {
    await client.close();
    await testCtx.teardown();
  }
});
