/**
 * staging-unzip: a zip uploaded into a staging category is expanded into the folder it lies in, by
 * a worker of the media pool, and removed once it is; over HTTP and over SFTP alike, and never
 * while its upload is still going on, whatever the upload changes on it meanwhile.
 *
 * The definition is the module's own, defined into a booted instance with a worker that takes
 * only its kind. `fixtures/trip.zip` holds two invented text files, one deflated, in folders two
 * deep: `Exempelresa/dag-1/anteckningar.txt` and `Exempelresa/dag-2/väder.txt`.
 */

import { POOLS_PATH } from '@ein/paths';
import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS, SystemTestHarness } from '@ein/testing';

const harness = new SystemTestHarness({ boot: true });

const DEFINITION = new URL('../../pipelines/staging-unzip.yaml', import.meta.url);
const ZIP = new URL('fixtures/trip.zip', import.meta.url);

async function waitFor(predicate: () => Promise<boolean>, what: string, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

Deno.test({
  name: 'staging-unzip expands a zip that lands in a category',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await harness.startPrimary();
  const client = await harness.createShellClient();

  const writeFile = async (path: string, body: Uint8Array) => {
    const handle = await vfs.open(ADMIN_ACCESS, path, { mode: 'w' });
    try {
      await handle.write(body);
    } finally {
      await handle.close();
    }
  };
  const run = async (line: string) => assertEquals((await client.exec(line)).success, true, line);

  const inbox = '/home/anna/staging/files/inbox';

  try {
    await run('mkdir -p /tmp/defs && mkdir -p /opt/unzip-worker && mkfile /opt/unzip-worker/start.sh && chmod 755 /opt/unzip-worker/start.sh');
    await writeFile('/opt/unzip-worker/start.sh', new TextEncoder().encode(`pipeline-worker --pool ${POOLS_PATH}/media --capacity cpu=1 --kind unzip --concurrency 1\n`));
    await run('service add unzip-worker /opt/unzip-worker && service enable unzip-worker && service start unzip-worker');

    await run('mkfile /tmp/defs/staging-unzip.yaml');
    await writeFile('/tmp/defs/staging-unzip.yaml', await Deno.readFile(DEFINITION));
    await run('pipeline define /tmp/defs/staging-unzip.yaml');
    await run(`mkdir -p ${inbox}`);

    await t.step('an uploaded zip is expanded beside it and removed', async () => {
      // As an upload stores it: the node first, then its bytes, then what they are.
      const zip = await vfs.create(ADMIN_ACCESS, 'file', inbox, 'trip.zip', { attrs: { name: 'trip.zip' } });
      await writeFile(`${inbox}/trip.zip`, await Deno.readFile(ZIP));
      await vfs.update(ADMIN_ACCESS, `${inbox}/trip.zip`, { attrs: { mimetype: 'application/zip' } });

      await waitFor(() => vfs.exists(ADMIN_ACCESS, `${inbox}/Exempelresa/dag-2/väder.txt`), 'the expanded files');
      await waitFor(async () => !(await vfs.exists(ADMIN_ACCESS, `${inbox}/trip.zip`)), 'the zip to be removed');

      assertEquals((await client.execString(`cat ${inbox}/Exempelresa/dag-1/anteckningar.txt`)).trim(), 'En segelbåt vid bryggan.');
      assertEquals((await vfs.get(ADMIN_ACCESS, `${inbox}/Exempelresa/dag-2/väder.txt`)).attrs.size, 16);

      // The run removed its own subject on purpose: it ends completed, not cancelled.
      const instance = `/var/pipelines/instances/staging-unzip/${zip.id}`;
      const status = async () => (await vfs.get<{ status?: string }>(ADMIN_ACCESS, instance).catch(() => undefined))?.attrs.status;
      await waitFor(async () => ['completed', 'failed', 'cancelled'].includes((await status()) ?? ''), 'the run to end');
      assertEquals(await status(), 'completed');
    });

    await t.step('a zip uploaded over HTTP is expanded once its upload has ended', async () => {
      const { cookie } = await harness.createHttpSession();
      await run(`mkdir -p ${inbox}/web`);
      const res = await fetch(`${harness.primary!.baseUrl}/file${inbox}/web/?name=web.zip`, { method: 'POST', headers: { cookie }, body: await Deno.readFile(ZIP) });
      assertEquals(res.status, 201);
      await waitFor(() => vfs.exists(ADMIN_ACCESS, `${inbox}/web/Exempelresa/dag-2/väder.txt`), 'the expanded files');
      await waitFor(async () => !(await vfs.exists(ADMIN_ACCESS, `${inbox}/web/web.zip`)), 'the zip to be removed');
    });

    await t.step('a zip still being uploaded over SFTP is left alone until its upload ends', async () => {
      const { sftp } = await harness.connectSFTP();
      const body = await Deno.readFile(ZIP);
      const half = Math.floor(body.length / 2);
      const path = `${inbox}/sftp/part.zip`;
      await run(`mkdir -p ${inbox}/sftp`);
      const handle = await sftp.open(path, 'w');
      await sftp.write(handle, body.subarray(0, half), 0, half, 0);
      // A mode set through the open handle changes the node while half its bytes are there; until
      // the close it is untyped bytes with no sha256.
      await sftp.fchmod(handle, 0o640);
      const zip = await vfs.get(ADMIN_ACCESS, path);
      assertEquals([zip.attrs.mimetype, zip.attrs.sha256], ['application/octet-stream', undefined]);
      const instance = `/var/pipelines/instances/staging-unzip/${zip.id}`;
      await new Promise((r) => setTimeout(r, 1500));
      assertEquals(await vfs.exists(ADMIN_ACCESS, instance), false);

      await sftp.write(handle, body.subarray(half), 0, body.length - half, half);
      await sftp.close(handle);
      await waitFor(() => vfs.exists(ADMIN_ACCESS, `${inbox}/sftp/Exempelresa/dag-2/väder.txt`), 'the expanded files');
      await waitFor(async () => !(await vfs.exists(ADMIN_ACCESS, path)), 'the zip to be removed');
      assertEquals((await client.execString(`cat ${inbox}/sftp/Exempelresa/dag-1/anteckningar.txt`)).trim(), 'En segelbåt vid bryggan.');
    });
  } finally {
    client.close();
    await harness.stop();
  }
});
