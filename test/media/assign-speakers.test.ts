/**
 * assign-speakers: each voice of a recording either joins the person a similar voice already
 * belongs to, or — when it spoke long enough — becomes a new unnamed person.
 *
 * The cases that matter are where voices differ from faces: the unit is a whole voice of a
 * recording, founding a person is gated on how long it spoke, and two voices of one recording
 * are never the same person automatically (the diarizer already said they differ).
 */

import { PEOPLE_ROOT } from '@archive/paths';
import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS, createTestContext } from '@ein/testing';

const testCtx = createTestContext({ modules: ['archive'] });

type Result = { speakerPath: string; personId: string | null; created: boolean; reason: string };
type Summary = { file: string; speakers: number; attached: number; created: number; skipped: number; dryRun: boolean; results: Result[] };

const DIM = 64;
const BLOCK = 16;
/** Orthogonal directions (cosine 0) so distinct voices never vote on each other. */
const dir = (group: number) => Array.from({ length: DIM }, (_, i) => (Math.floor(i / BLOCK) === group ? 1 : 0));
const near = (base: number[], seed: number) => base.map((v, i) => (v === 1 && i % BLOCK === seed % BLOCK ? v + 0.02 : v));

const ANNA = dir(0);
const EDVIN = dir(1);

Deno.test({
  name: 'assign-speakers',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();

  const attrsOf = (path: string) =>
    vfs.get<{ personId?: string; personSource?: string; assignLocked?: boolean; asdAssisted?: boolean }>(ADMIN_ACCESS, path).then((n) => n.attrs);

  const unknownPeople = async () => {
    try {
      return (await vfs.children(ADMIN_ACCESS, `${PEOPLE_ROOT}/unknown`)).filter((c) => c.node.type === 'person');
    } catch {
      return [];
    }
  };

  const makeRecording = async (file: string) => {
    await client.exec('mkdir -p /rec');
    await client.exec(`echo x > ${file}`);
    await vfs.update(ADMIN_ACCESS, file, { attrs: { mimetype: 'video/mp4' } });
    await client.exec(`mkdir -p ${file}/metadata/transcript/speakers`);
  };

  /** A voice of a recording: its voiceprint, and how long it spoke — what the seed gate reads. */
  const addSpeaker = async (file: string, name: string, vector: number[] | null, opts: { talkSeconds?: number } = {}) => {
    const fileId = (await vfs.get(ADMIN_ACCESS, file)).id;
    const path = `${file}/metadata/transcript/speakers/${name}`;
    await client.exec(
      `mknode -t embedding ${path} --as embeddingType=voice --an capacity=${DIM} --as fileId=${fileId} ` +
        `--as detectedBy=diar_sortformer_4spk-v1 --as speaker=speaker_${name.slice(1)}`,
    );
    const talkSeconds = opts.talkSeconds ?? 30;
    await vfs.update(ADMIN_ACCESS, path, { attrs: { talkSeconds, turns: [[0, talkSeconds]], turnCount: 1 } });
    if (vector) {
      const h = await vfs.open(ADMIN_ACCESS, path, { mode: 'w' });
      try {
        await h.write(new TextEncoder().encode(JSON.stringify(vector)));
      } finally {
        await h.close();
      }
    }
    return path;
  };

  try {
    await client.exec(`mkdir -p ${PEOPLE_ROOT}`);

    let annaId = '';
    let edvinId = '';

    await t.step('a voice matching nobody becomes a new unnamed person', async () => {
      await makeRecording('/rec/1.mp4');
      const path = await addSpeaker('/rec/1.mp4', 's0', near(ANNA, 0));

      const res = await client.execJson<Summary>('assign-speakers /rec/1.mp4');
      assertEquals(res.created, 1);
      assertEquals(res.attached, 0);

      const people = await unknownPeople();
      assertEquals(people.length, 1);
      annaId = people[0].node.id;
      const personAttrs = people[0].node.attrs as { unnamed?: boolean; origin?: string; representativeFaceId?: string };
      assertEquals(personAttrs.unnamed, true);
      // Found by voice, and with no crop to stand in for them.
      assertEquals(personAttrs.origin, 'voice');
      assertEquals(personAttrs.representativeFaceId, undefined);
      assertEquals((await attrsOf(path)).personId, annaId);
      assertEquals((await attrsOf(path)).personSource, 'auto');
    });

    await t.step('the same voice in a later recording joins, no second person', async () => {
      // The whole point: recognition compounds as recordings arrive.
      await makeRecording('/rec/2.mp4');
      const path = await addSpeaker('/rec/2.mp4', 's0', near(ANNA, 3));

      const res = await client.execJson<Summary>('assign-speakers /rec/2.mp4');
      assertEquals(res.attached, 1);
      assertEquals(res.created, 0);
      assertEquals((await unknownPeople()).length, 1);
      assertEquals((await attrsOf(path)).personId, annaId);
    });

    await t.step('a different voice in the same recording is a different person', async () => {
      await makeRecording('/rec/3.mp4');
      const anna = await addSpeaker('/rec/3.mp4', 's0', near(ANNA, 1));
      const edvin = await addSpeaker('/rec/3.mp4', 's1', near(EDVIN, 0));

      const res = await client.execJson<Summary>('assign-speakers /rec/3.mp4');
      assertEquals(res.attached, 1);
      assertEquals(res.created, 1);
      assertEquals((await attrsOf(anna)).personId, annaId);
      edvinId = (await attrsOf(edvin)).personId ?? '';
      assertEquals(edvinId !== '' && edvinId !== annaId, true);
    });

    await t.step('two voices of one recording never become the same person', async () => {
      // The diarizer said they differ. If it split one person in two, a merge fixes that; two
      // people fused into one would have to be found first.
      await makeRecording('/rec/12.mp4');
      const louder = await addSpeaker('/rec/12.mp4', 's0', near(ANNA, 6), { talkSeconds: 60 });
      const quieter = await addSpeaker('/rec/12.mp4', 's1', near(ANNA, 7), { talkSeconds: 20 });

      const res = await client.execJson<Summary>('assign-speakers /rec/12.mp4');
      // The one who spoke more is decided first and claims the person.
      assertEquals((await attrsOf(louder)).personId, annaId);
      assertEquals((await attrsOf(quieter)).personId, undefined);
      assertEquals(res.results.find((r) => r.speakerPath === quieter)?.reason, 'skipped-taken');
    });

    await t.step('a voice like the last one heard, but unlike the person as a whole, is left undecided', async () => {
      // Three voices 40° apart in their own plane: each is a close neighbour of the one before
      // (cosine 0.77), the third is far from the first (0.17) and from the person's mean (0.5).
      const at = (degrees: number) => {
        const v = Array.from({ length: DIM }, () => 0);
        v[2 * BLOCK] = Math.cos((degrees * Math.PI) / 180);
        v[2 * BLOCK + 1] = Math.sin((degrees * Math.PI) / 180);
        return v;
      };
      await makeRecording('/rec/20.mp4');
      const first = await addSpeaker('/rec/20.mp4', 's0', at(0));
      await client.execJson<Summary>('assign-speakers /rec/20.mp4');
      const personId = (await attrsOf(first)).personId;
      assertEquals(typeof personId, 'string');

      await makeRecording('/rec/21.mp4');
      const second = await addSpeaker('/rec/21.mp4', 's0', at(40));
      await client.execJson<Summary>('assign-speakers /rec/21.mp4');
      assertEquals((await attrsOf(second)).personId, personId);

      await makeRecording('/rec/22.mp4');
      const third = await addSpeaker('/rec/22.mp4', 's0', at(80));
      const before = (await unknownPeople()).length;
      const res = await client.execJson<Summary>('assign-speakers /rec/22.mp4');
      assertEquals(res.results[0].reason, 'skipped-unlike');
      assertEquals((await attrsOf(third)).personId, undefined);
      // Evidence pointed at someone, so it is not somebody new either.
      assertEquals((await unknownPeople()).length, before);
    });

    await t.step('a voice that spoke too little never founds a person', async () => {
      // It may still attach to someone later; what it must not do is invent an identity.
      await makeRecording('/rec/4.mp4');
      await addSpeaker('/rec/4.mp4', 's0', near(dir(2), 0), { talkSeconds: 4 });

      const before = (await unknownPeople()).length;
      const res = await client.execJson<Summary>('assign-speakers /rec/4.mp4');
      assertEquals(res.created, 0);
      assertEquals(res.results[0].reason, 'skipped-gate');
      assertEquals((await unknownPeople()).length, before);
    });

    await t.step('a voice with no vector is skipped rather than guessed at', async () => {
      await makeRecording('/rec/5.mp4');
      await addSpeaker('/rec/5.mp4', 's0', null);

      const res = await client.execJson<Summary>('assign-speakers /rec/5.mp4');
      assertEquals(res.results[0].reason, 'skipped-no-vector');
    });

    await t.step('a locked voice is left alone', async () => {
      await makeRecording('/rec/6.mp4');
      const path = await addSpeaker('/rec/6.mp4', 's0', near(ANNA, 4));
      await vfs.update(ADMIN_ACCESS, path, { attrs: { assignLocked: true } });

      const res = await client.execJson<Summary>('assign-speakers /rec/6.mp4');
      assertEquals(res.results[0].reason, 'skipped-locked');
      assertEquals((await attrsOf(path)).personId, undefined);
    });

    await t.step('a recognised face saying the words attaches the voice on its own', async () => {
      // The cold-start case the video is there for: this person's voice has never been heard, so
      // no voiceprint neighbour can speak for it, and the lip-sync match is the only evidence.
      await client.exec(`mknode -t person ${PEOPLE_ROOT}/cecilia`);
      const ceciliaId = (await vfs.get(ADMIN_ACCESS, `${PEOPLE_ROOT}/cecilia`)).id;
      await makeRecording('/rec/8.mp4');
      const path = await addSpeaker('/rec/8.mp4', 's0', near(dir(3), 0));
      await vfs.update(ADMIN_ACCESS, path, { attrs: { asdPersonId: ceciliaId, asdScore: 0.92 } });

      const res = await client.execJson<Summary>('assign-speakers /rec/8.mp4');
      assertEquals(res.attached, 1);
      assertEquals(res.created, 0);
      const attrs = await attrsOf(path);
      assertEquals(attrs.personId, ceciliaId);
      // Still an ordinary automatic assignment; the vote decided it, not a separate path.
      assertEquals(attrs.personSource, 'auto');
      assertEquals(attrs.asdAssisted, true);
    });

    await t.step('a weak lip-sync match is ignored', async () => {
      await makeRecording('/rec/9.mp4');
      const path = await addSpeaker('/rec/9.mp4', 's0', near(dir(2), 5), { talkSeconds: 4 });
      await vfs.update(ADMIN_ACCESS, path, { attrs: { asdPersonId: annaId, asdScore: 0.2 } });

      const res = await client.execJson<Summary>('assign-speakers /rec/9.mp4');
      assertEquals(res.attached, 0);
      assertEquals((await attrsOf(path)).personId, undefined);
    });

    await t.step('voices only a machine decided do not outvote a face seen saying the words', async () => {
      // Closer to Edvin's voice, assigned automatically (/rec/3), than to Anna's, yet like Anna's
      // enough to be hers (cosine 0.55). An earlier run's guess, repeated over enough recordings,
      // would outweigh any face; seeing who speaks is the better evidence.
      await makeRecording('/rec/10.mp4');
      const path = await addSpeaker('/rec/10.mp4', 's0', ANNA.map((v, i) => v + 1.5 * EDVIN[i]));
      await vfs.update(ADMIN_ACCESS, path, { attrs: { asdPersonId: annaId, asdScore: 0.95 } });

      await client.execJson<Summary>('assign-speakers /rec/10.mp4');
      const attrs = await attrsOf(path);
      assertEquals(attrs.personId, annaId);
      assertEquals(attrs.asdAssisted, true);
    });

    await t.step('a face in frame while another voice talks is left undecided', async () => {
      // The camera operator speaks while Anna is filmed: the face is confident, but the voice is
      // nothing like any Anna was heard with.
      await makeRecording('/rec/17.mp4');
      const path = await addSpeaker('/rec/17.mp4', 's0', near(EDVIN, 9));
      await vfs.update(ADMIN_ACCESS, path, { attrs: { asdPersonId: annaId, asdScore: 0.95 } });

      const before = (await unknownPeople()).length;
      const res = await client.execJson<Summary>('assign-speakers /rec/17.mp4');
      assertEquals(res.results[0].reason, 'skipped-unlike');
      assertEquals((await attrsOf(path)).personId, undefined);
      assertEquals((await unknownPeople()).length, before);
    });

    await t.step('one face against one voice a person named is left undecided', async () => {
      // Someone on screen mouthing along while a known voice talks: the evidence is split, and
      // the margin rule refuses rather than guessing — and does not mint a third person either.
      await makeRecording('/rec/15.mp4');
      const named = await addSpeaker('/rec/15.mp4', 's0', near(EDVIN, 15));
      await vfs.update(ADMIN_ACCESS, named, { attrs: { personId: edvinId, personSource: 'manual' } });

      await makeRecording('/rec/16.mp4');
      const path = await addSpeaker('/rec/16.mp4', 's0', near(EDVIN, 8));
      await vfs.update(ADMIN_ACCESS, path, { attrs: { asdPersonId: annaId, asdScore: 0.95 } });

      const before = (await unknownPeople()).length;
      const res = await client.execJson<Summary>('assign-speakers /rec/16.mp4');
      assertEquals((await attrsOf(path)).personId, undefined);
      assertEquals(res.created, 0);
      assertEquals(res.results[0].reason, 'skipped-no-match');
      assertEquals((await unknownPeople()).length, before);
    });

    await t.step('enough voices a person named do outvote a mistaken lip-sync match', async () => {
      for (const n of [13, 14]) {
        await makeRecording(`/rec/${n}.mp4`);
        const path = await addSpeaker(`/rec/${n}.mp4`, 's0', near(EDVIN, n));
        await vfs.update(ADMIN_ACCESS, path, { attrs: { personId: edvinId, personSource: 'manual' } });
      }

      await makeRecording('/rec/11.mp4');
      const path = await addSpeaker('/rec/11.mp4', 's0', near(EDVIN, 7));
      await vfs.update(ADMIN_ACCESS, path, { attrs: { asdPersonId: annaId, asdScore: 0.95 } });

      await client.execJson<Summary>('assign-speakers /rec/11.mp4');
      assertEquals((await attrsOf(path)).personId, edvinId, 'the voiceprints won');
    });

    await t.step('a dry run decides without writing', async () => {
      await makeRecording('/rec/7.mp4');
      const path = await addSpeaker('/rec/7.mp4', 's0', near(ANNA, 5));

      const before = (await unknownPeople()).length;
      const res = await client.execJson<Summary>('assign-speakers -n /rec/7.mp4');
      assertEquals(res.dryRun, true);
      assertEquals(res.attached, 1);
      assertEquals((await unknownPeople()).length, before);
      assertEquals((await attrsOf(path)).personId, undefined);
    });
  } finally {
    await client.close();
    await testCtx.teardown();
  }
});
