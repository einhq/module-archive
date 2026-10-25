/**
 * The commands that have EMS make something of a file refuse a caller who may not write it before
 * EMS is asked: a user who may only read the album, and the guest, are told "permission denied"
 * and the media service hears nothing from them (ein/core#535).
 */

import { ALBUMS_ROOT } from '@archive/paths';
import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS, createTestContext, type ShellClient, testCommands } from '@ein/testing';
import { startStubEms } from '@ems/testing';

const testCtx = createTestContext({ boot: true, modules: ['archive'] });
const JINA = 'jina-embeddings-v5-text-small';

Deno.test({
  name: 'processing commands refuse a reader before asking EMS',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  const admin = await testCtx.server.createShellClient();
  const cmd = testCommands(admin);
  // No op answers, but every request is recorded: a command that got past its check is seen.
  const stub = startStubEms({ capabilities: { models: { text_embed: JINA } } });
  const readers: ShellClient[] = [];

  const write = async (path: string, body: string) => {
    const handle = await vfs.open(ADMIN_ACCESS, path, { mode: 'w' });
    try {
      await handle.write(new TextEncoder().encode(body));
    } finally {
      await handle.close();
    }
  };
  /** Readable and searchable by anyone, writable by the administrator alone. */
  const readOnly = (...paths: string[]) => Promise.all(paths.map((path) => vfs.update(ADMIN_ACCESS, path, { props: { mode: 0o755 } })));

  const album = `${ALBUMS_ROOT}/hamnen`;
  const photo = `${album}/files/bat.jpg`;
  const clip = `${album}/files/hamn.mp4`;
  const letter = `${album}/files/brev.pdf`;

  try {
    await cmd.shouldSucceed(`mknode -t album ${album} --as name=hamnen --an mediaCount=3`);
    await cmd.shouldSucceed(`mkdir -p ${album}/files`);
    await cmd.shouldSucceed(`mknode -t file ${photo} --as name=bat.jpg --as mimetype=image/jpeg --an width=8000 --an height=6000`);
    await cmd.shouldSucceed(`mknode -t file ${clip} --as name=hamn.mp4 --as mimetype=video/mp4`);
    await cmd.shouldSucceed(`mknode -t file ${letter} --as name=brev.pdf --as mimetype=application/pdf`);

    // Text in the picture to re-embed, a transcript to listen to, and a face crop larger than the
    // bound: each would be work for EMS.
    await cmd.shouldSucceed(`mkdir -p ${photo}/metadata ${clip}/metadata ${photo}/regions`);
    await cmd.shouldSucceed(`mknode -t file ${photo}/metadata/content --as mimetype=text/plain --tier db`);
    await write(`${photo}/metadata/content`, 'HAMNEN');
    await cmd.shouldSucceed(`mknode -t file ${clip}/metadata/transcript --as mimetype=text/vtt --tier db`);
    await write(`${clip}/metadata/transcript`, 'WEBVTT\n\n00:00.000 --> 00:02.000\nThe boat is in.\n');
    const photoId = (await vfs.get(ADMIN_ACCESS, photo)).id;
    await cmd.shouldSucceed(`mknode -t media-region ${photo}/regions/face-0 --as fileId=${photoId}`);
    await vfs.update(ADMIN_ACCESS, `${photo}/regions/face-0`, { attrs: { faceBox: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 } } });
    await cmd.shouldSucceed(`mknode -t file ${photo}/regions/face-0/image.avif --as mimetype=image/avif --as sourceId=${photoId}`);

    await readOnly(
      album,
      `${album}/files`,
      photo,
      clip,
      letter,
      `${photo}/metadata`,
      `${photo}/metadata/content`,
      `${clip}/metadata`,
      `${clip}/metadata/transcript`,
      `${photo}/regions`,
      `${photo}/regions/face-0`,
      `${photo}/regions/face-0/image.avif`,
    );

    await cmd.shouldSucceed('user-create anna --uid 3000');
    await cmd.shouldSucceed('user-passwd anna --new-password secret');
    const anna = await testCtx.server.createShellClient({ username: 'anna', password: 'secret' });
    readers.push(anna);
    const guest = await testCtx.server.createShellClient({ login: false });
    readers.push(guest);

    const lines = [
      `detect-faces ${photo}`,
      `embed-picture ${photo}`,
      `exif-extract ${photo}`,
      `generate-derivatives ${photo}`,
      `compute-fingerprint ${photo}`,
      `transcribe-file ${clip}`,
      `voiceprint-file ${clip}`,
      `see-speakers ${clip}`,
      `index-document ${letter}`,
      `media-reembed ${photo}`,
      'regenerate-face-crops',
    ];

    for (const [who, client] of [['a user who may only read', anna], ['the guest', guest]] as const) {
      await t.step(`${who} is refused, and EMS is not asked`, async () => {
        // The guest of an archive that asks visitors to sign in is refused before the command runs.
        const refusal = client === guest ? 'sign in first' : 'permission denied';
        for (const line of lines) await testCommands(client).shouldFailWith(`CFG_EMS_URL=${stub.url} ${line}`, refusal);
        // A walk over the archive passes over what the caller may not write.
        const walk = await client.exec(`CFG_EMS_URL=${stub.url} media-reembed`);
        assertEquals(walk.success, false);
        assertEquals(stub.requests.map((request) => request.op), []);
      });
    }

    await t.step('the administrator gets as far as EMS', async () => {
      await admin.exec(`CFG_EMS_URL=${stub.url} detect-faces ${photo}`);
      assertEquals(stub.requests.map((request) => request.op), ['faces.detect']);
    });
  } finally {
    for (const reader of readers) reader.close();
    admin.close();
    await stub.close();
    await testCtx.teardown();
  }
});
