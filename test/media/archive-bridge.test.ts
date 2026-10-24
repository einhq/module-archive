/**
 * The chain the split depends on, end to end without media tools:
 * VFS mutation -> archive-bridge -> /dev/events -> pipeline trigger.
 *
 * Uses stub step commands so the fast tier can assert the wiring — that a real
 * file landing in the VFS starts the right per-capability pipelines, and that
 * media-scan re-derives the same facts for a file the bridge never saw.
 */

import { PIPELINE_DEFINITIONS_PATH, PIPELINE_INSTANCES_PATH, QUEUES_PATH } from '@ein/paths';
import { ALBUMS_ROOT } from '@archive/paths';
import { MEDIA_EVENTS } from '@archive/media/event-rules';
import { assertEquals, assertStringIncludes } from '@std/assert';
import { ADMIN_ACCESS } from '@ein/testing';
import { EVENTS_ROUTING_KEY } from '@ein/client';
import { createTestContext } from '@ein/testing';

// boot: true — this test is about the boot-wired chain (engine service, bridge
// service, /dev/events), not about calling the bins directly.
const testCtx = createTestContext({ modules: ['archive'], boot: true });

async function waitFor(predicate: () => Promise<boolean>, what: string, timeoutMs = 20000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

Deno.test({
  name: 'archive bridge, media facts',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();

  const nodeIdOf = async (path: string): Promise<string> => (await vfs.get(ADMIN_ACCESS, path)).id;

  const hasInstance = async (pipeline: string, nodeId: string): Promise<boolean> => await vfs.exists(ADMIN_ACCESS, `${PIPELINE_INSTANCES_PATH}/${pipeline}/${nodeId}`);

  /** A media file node with bytes, as file-sync would leave it. */
  const makeMedia = async (path: string, mimetype = 'image/jpeg') => {
    await client.exec(`echo content > ${path}`);
    await vfs.update(ADMIN_ACCESS, path, { attrs: { mimetype, sha256: 'sha-1' } });
  };

  try {
    // Replace every media step with a marker-writing stub: this test is about the
    // event wiring, not about exiftool.
    await client.exec(`mkdir -p /opt/stub && mkdir -p /tmp/markers && mkdir -p ${ALBUMS_ROOT}/t`);
    for (
      const name of [
        'exif-extract',
        'generate-derivatives',
        'compute-fingerprint',
        'detect-faces',
        'tag-transfer',
        'transcribe-file',
        'device-link',
        'geocode-position',
        'assign-faces',
        'album-stack',
      ]
    ) {
      await client.exec(`mkfile /opt/stub/${name} && chmod 755 /opt/stub/${name}`);
      const handle = await vfs.open(ADMIN_ACCESS, `/opt/stub/${name}`, { mode: 'w' });
      try {
        await handle.write(new TextEncoder().encode(`echo "${name} $1" >> /tmp/markers/log\n`));
      } finally {
        await handle.close();
      }
    }
    // Prepended, so the stubs win over the module bins on PATH
    await client.exec(`echo 'export PATH="/opt/stub:$PATH"' >> /etc/bashrc`);

    await t.step('the bridge and engine services are registered by mod setup', async () => {
      const services = await client.execJson<string[]>('ls /etc/services/enabled');
      assertEquals(services.includes('archive-bridge'), true, `services: ${services}`);
      assertEquals(services.includes('models'), true, `services: ${services}`);
      // media-scan must NOT be a service. Its facts are predicates, so running it
      // on a timer would re-publish them for everything still unindexed. It is a
      // manual backfill command.
      assertEquals(services.includes('media-scan'), false, `services: ${services}`);
    });

    await t.step('every media pipeline is defined', async () => {
      const defs = await client.execJson<string[]>(`ls ${PIPELINE_DEFINITIONS_PATH}`);
      for (
        const name of [
          'media-ingest',
          'media-reindex',
          'media-device',
          'media-geocode',
          'media-stills',
          'media-transcode',
          'media-fingerprint',
          'media-faces',
          'media-face-transfer',
          'media-face-assign',
          'media-transcribe',
          'media-album',
        ]
      ) {
        assertEquals(defs.includes(name), true, `${name} missing from ${defs}`);
      }
    });

    await t.step('a new media file starts media-ingest and nothing else', async () => {
      await makeMedia(`${ALBUMS_ROOT}/t/a.jpg`);
      const nodeId = await nodeIdOf(`${ALBUMS_ROOT}/t/a.jpg`);

      await waitFor(() => hasInstance('media-ingest', nodeId), 'media-ingest instance');

      // Everything else waits on a fact media-ingest has not produced yet
      assertEquals(await hasInstance('media-stills', nodeId), false);
      assertEquals(await hasInstance('media-faces', nodeId), false);
    });

    await t.step('a derivative never starts anything', async () => {
      await client.exec(`mkdir -p ${ALBUMS_ROOT}/t/a.jpg/thumbnails`);

      // Exactly the order the converters use: the node is
      // created *with* sourceId, before any bytes exist. Together with the rule's
      // size > 0 requirement that leaves no window in which a rendition looks
      // like an unindexed original — write the bytes first and it would be
      // discovered before it is marked, and index its own output.
      const thumb = `${ALBUMS_ROOT}/t/a.jpg/thumbnails/320x320.avif`;
      await client.exec(`mknode -p -t file ${thumb} --as sourceId=${await nodeIdOf(`${ALBUMS_ROOT}/t/a.jpg`)}`);
      await client.exec(`echo thumb > ${thumb}`);
      await vfs.update(ADMIN_ACCESS, thumb, { attrs: { mimetype: 'image/avif', sha256: 'sha-thumb' } });

      const thumbId = await nodeIdOf(thumb);

      await new Promise((r) => setTimeout(r, 700));
      assertEquals(await hasInstance('media-ingest', thumbId), false, 'derivative must not be indexed');
    });

    await t.step('a populated exif node fans out to the capability pipelines', async () => {
      const nodeId = await nodeIdOf(`${ALBUMS_ROOT}/t/a.jpg`);

      // What exif-extract would write
      await client.exec(`mkdir -p ${ALBUMS_ROOT}/t/a.jpg/metadata`);
      await vfs.ensure(ADMIN_ACCESS, 'exif', `${ALBUMS_ROOT}/t/a.jpg/metadata`, 'exif');
      await vfs.update(ADMIN_ACCESS, `${ALBUMS_ROOT}/t/a.jpg/metadata/exif`, {
        attrs: { indexedAt: '2020-01-01T00:00:00Z', sourceSha256: 'sha-1', deviceSerialNumber: 'SER1' },
      });

      await waitFor(() => hasInstance('media-stills', nodeId), 'media-stills instance');
      await waitFor(() => hasInstance('media-fingerprint', nodeId), 'media-fingerprint instance');
      await waitFor(() => hasInstance('media-faces', nodeId), 'media-faces instance');
      await waitFor(() => hasInstance('media-device', nodeId), 'media-device instance');
      assertEquals(await hasInstance('media-face-transfer', nodeId), false, 'face transfer must wait for face completion');
    });

    await t.step('face completion starts its downstream jobs only after facesAt lands', async () => {
      const path = `${ALBUMS_ROOT}/t/a.jpg`;
      const nodeId = await nodeIdOf(path);

      await vfs.update(ADMIN_ACCESS, path, {
        attrs: { facesAt: '2026-09-07T07:00:00Z', faceCount: 0 },
      });

      await waitFor(() => hasInstance('media-face-transfer', nodeId), 'media-face-transfer after faces completion');
    });

    await t.step('mimetype filters keep video-only work off an image', async () => {
      const nodeId = await nodeIdOf(`${ALBUMS_ROOT}/t/a.jpg`);

      // media-transcode filters on video/* and audio/*
      assertEquals(await hasInstance('media-transcode', nodeId), false);
    });

    await t.step('a non-administrator turning an indexed video starts a forced media-transcode', async () => {
      const path = `${ALBUMS_ROOT}/t/turned.mp4`;
      await makeMedia(path, 'video/mp4');
      const nodeId = await nodeIdOf(path);
      // Indexed, without the metadata that would start the ordinary transcode first.
      await client.exec(`mkdir -p ${path}/metadata`);
      await vfs.ensure(ADMIN_ACCESS, 'exif', `${path}/metadata`, 'exif');

      // `pipeline start` is the administrator's, so the re-encode has to come from the write.
      // `--no-regenerate` leaves the previews out of it: the transcode does not depend on them.
      await client.exec(`user-create anna && user-passwd anna --new-password secret && chown -R anna ${path}`);
      const anna = await testCtx.server.createShellClient({ username: 'anna', password: 'secret' });
      try {
        const turned = await anna.exec(`file-set-orientation ${path} --rotate cw --no-regenerate`);
        assertEquals(turned.success, true, turned.error);
      } finally {
        anna.close();
      }

      await waitFor(() => hasInstance('media-transcode', nodeId), 'media-transcode after a turn');
      const instance = await vfs.get<{ vars?: Record<string, string> }>(ADMIN_ACCESS, `${PIPELINE_INSTANCES_PATH}/media-transcode/${nodeId}`);
      assertEquals(instance.attrs.vars?.FORCE, '-f');
    });

    await t.step('a face embedding starts assignment keyed on its region', async () => {
      await client.exec(`mkdir -p ${ALBUMS_ROOT}/t/a.jpg/regions`);
      await vfs.create(ADMIN_ACCESS, 'media-region', `${ALBUMS_ROOT}/t/a.jpg/regions`, 'face-0', {
        attrs: { fileId: await nodeIdOf(`${ALBUMS_ROOT}/t/a.jpg`), confidence: 0.9 },
      });
      await vfs.create(ADMIN_ACCESS, 'embedding', `${ALBUMS_ROOT}/t/a.jpg/regions/face-0`, 'embedding', {
        attrs: { embeddingType: 'face', capacity: 512 },
      });

      const faceId = await nodeIdOf(`${ALBUMS_ROOT}/t/a.jpg/regions/face-0`);

      await waitFor(() => hasInstance('media-face-assign', faceId), 'media-face-assign instance');
    });

    await t.step('removing a media file publishes media.file.removed with what the file was', async () => {
      const path = `${ALBUMS_ROOT}/t/gone.jpg`;
      await makeMedia(path);
      const nodeId = await nodeIdOf(path);
      await waitFor(() => hasInstance('media-ingest', nodeId), 'media-ingest instance for gone.jpg');

      await vfs.create(ADMIN_ACCESS, 'router', '/tmp', 'events-tail', { attrs: { routingKey: EVENTS_ROUTING_KEY } });
      const handle = await vfs.open(ADMIN_ACCESS, '/tmp/events-tail', { mode: 'r' });

      try {
        const signal = AbortSignal.timeout(10000);
        const removed = (async () => {
          for (;;) {
            const data = await handle.read(1, signal);
            if (data.length === 0) return undefined;
            const fact = JSON.parse(new TextDecoder().decode(data).trim());
            if (fact.type === MEDIA_EVENTS.fileRemoved) return fact;
          }
        })();

        await client.exec(`rm ${path}`);
        const fact = await removed;

        assertEquals([fact?.subject, fact?.nodeId, fact?.data?.mimetype, fact?.data?.sha256], [path, nodeId, 'image/jpeg', 'sha-1']);
      } finally {
        await handle.close();
      }
    });

    await t.step('a member landing in an album starts media-album on the album, after the debounce', async () => {
      await client.exec(`mknode -t album ${ALBUMS_ROOT}/coalesced --as name=coalesced`);
      const albumId = await nodeIdOf(`${ALBUMS_ROOT}/coalesced`);

      await makeMedia(`${ALBUMS_ROOT}/coalesced/b.jpg`);
      await makeMedia(`${ALBUMS_ROOT}/coalesced/c.jpg`);

      // The subject is the album, not the members: the fact rides on the album's
      // own `child-attached`, held by `debounceMs` so a burst is one instance.
      await waitFor(() => hasInstance('media-album', albumId), 'media-album instance', 30000);
      assertEquals(await hasInstance('media-album', await nodeIdOf(`${ALBUMS_ROOT}/coalesced/b.jpg`)), false);
      await waitFor(
        async () => {
          const attrs = (await vfs.get(ADMIN_ACCESS, `${PIPELINE_INSTANCES_PATH}/media-album/${albumId}`)).attrs;
          return attrs.status === 'completed';
        },
        'media-album completion',
        30000,
      );
      // `album-stack` is stubbed (the marker is `<name> $1`); `album-span` and `album-cover` ran for real.
      assertStringIncludes(String((await client.exec('cat /tmp/markers/log')).data), 'album-stack refresh');
      assertEquals((await vfs.get(ADMIN_ACCESS, `${ALBUMS_ROOT}/coalesced`)).attrs.mediaCount, 2);
      const cover = await vfs.get(ADMIN_ACCESS, `${ALBUMS_ROOT}/coalesced/coverPhoto`, { readlink: true });
      assertEquals([`${ALBUMS_ROOT}/coalesced/b.jpg`, `${ALBUMS_ROOT}/coalesced/c.jpg`].includes(cover.props.softlink ?? ''), true);
    });

    await t.step('the bridge consumes with competing consumers, and the count is configurable', async () => {
      // A queue handle allows one unacked entry, so the only way the bridge gets
      // past one message at a time is N handles competing on the one subscription.
      // The startup line is what says how many it actually opened.
      const stdout = '/var/logs/services/archive-bridge/stdout.log';
      const startupLine = async (): Promise<string> => String((await client.exec(`tail -n 100 ${stdout}`)).data ?? '');

      assertStringIncludes(await startupLine(), '4 consumers');

      // One command: API-shell commands run in spawned contexts, so the export has
      // to reach `service restart` in the same invocation to be passed through.
      await client.exec('export ARCHIVE_BRIDGE_CONCURRENCY=2 && service restart archive-bridge');
      // The log is truncated on each start, so this can only be the new run.
      await waitFor(async () => (await startupLine()).includes('2 consumers'), 'the restarted bridge to report its consumer count');

      // And it still derives the same facts. A burst rather than one file: out-of-
      // order consumption is the thing concurrency introduces, and each of these
      // must still reach media-ingest exactly once.
      const paths = [`${ALBUMS_ROOT}/t/burst-0.jpg`, `${ALBUMS_ROOT}/t/burst-1.jpg`, `${ALBUMS_ROOT}/t/burst-2.jpg`, `${ALBUMS_ROOT}/t/burst-3.jpg`];
      await Promise.all(paths.map((path) => makeMedia(path)));

      for (const path of paths) {
        const nodeId = await nodeIdOf(path);
        await waitFor(() => hasInstance('media-ingest', nodeId), `media-ingest instance for ${path}`);
      }
    });

    await t.step('media-scan walks module container types, not just directories', async () => {
      // Every album on a real install is an `album` node, not a `directory`.
      // A walk that only descends into 'directory' reports 0 files under a full
      // library.
      await client.exec(`album create ${ALBUMS_ROOT}/holiday`);
      await client.exec(`mkdir -p ${ALBUMS_ROOT}/holiday/files`);
      await makeMedia(`${ALBUMS_ROOT}/holiday/files/deep.jpg`);

      const nodeId = await nodeIdOf(`${ALBUMS_ROOT}/holiday/files/deep.jpg`);
      await waitFor(() => hasInstance('media-ingest', nodeId), 'bridge instance for the album file');
      // Remove it so the scan below has to rediscover the file
      await client.exec(`rm -r ${PIPELINE_INSTANCES_PATH}/media-ingest/${nodeId}`);

      const result = await client.execJson<{ scanned: number; paths: string[] }>(`media-scan ${ALBUMS_ROOT}`);

      assertEquals(result.scanned > 0, true, `scan found no files: ${JSON.stringify(result)}`);
      assertEquals(
        result.paths.includes(`${ALBUMS_ROOT}/holiday/files/deep.jpg`),
        true,
        `expected the album file, got ${JSON.stringify(result.paths)}`,
      );
    });

    await t.step('media-scan --only emits only the fact types it names', async () => {
      const deep = `${ALBUMS_ROOT}/holiday/files/deep.jpg`;
      const all = await client.execJson<{ paths: string[] }>(`media-scan -n --restart ${ALBUMS_ROOT}/holiday`);
      assertEquals(all.paths.includes(deep), true, `nothing to filter: ${JSON.stringify(all)}`);
      const none = await client.execJson<{ emitted: number }>(`media-scan -n --restart --only media.nothing.such ${ALBUMS_ROOT}/holiday`);
      assertEquals(none.emitted, 0);
      const one = await client.execJson<{ paths: string[] }>(
        `media-scan -n --restart --only media.nothing.such,media.file.discovered ${ALBUMS_ROOT}/holiday`,
      );
      assertEquals(one.paths.includes(deep), true, JSON.stringify(one));
    });

    await t.step('media-scan announces a document or picture never text-indexed, once', async () => {
      const pdf = `${ALBUMS_ROOT}/holiday/files/menu.pdf`;
      await client.exec(`echo text > ${pdf}`);
      await vfs.update(ADMIN_ACCESS, pdf, { attrs: { mimetype: 'application/pdf' } });
      const scan = () => client.execJson<{ paths: string[] }>(`media-scan -n --restart --only media.text.missing ${ALBUMS_ROOT}/holiday`);

      assertEquals((await scan()).paths.includes(pdf), true);
      await vfs.update(ADMIN_ACCESS, pdf, { attrs: { textIndexedAt: '2026-10-17T08:00:00Z' } });
      assertEquals((await scan()).paths.includes(pdf), false);
    });

    await t.step('a folder moved out of staging whole has its unread files text-indexed', async () => {
      const staged = '/home/anna/staging/files/trip';
      await client.exec(`mkdir -p ${staged}/day-2`);
      const write = async (path: string, mimetype: string, attrs: Record<string, unknown> = {}) => {
        await client.exec(`echo text > ${path}`);
        await vfs.update(ADMIN_ACCESS, path, { attrs: { mimetype, ...attrs } });
        return await nodeIdOf(path);
      };
      const pdf = await write(`${staged}/menu.pdf`, 'application/pdf');
      const note = await write(`${staged}/day-2/note.txt`, 'text/plain');
      const read = await write(`${staged}/read.txt`, 'text/plain', { textIndexedAt: '2026-10-17T08:00:00Z' });
      await new Promise((r) => setTimeout(r, 500));
      assertEquals(await hasInstance('document-index', pdf), false, 'a staged file waits to be filed');

      assertEquals((await client.exec(`mv ${staged} ${ALBUMS_ROOT}/holiday/files/`)).success, true);

      await waitFor(() => hasInstance('document-index', pdf), 'document-index for a file in the moved folder');
      await waitFor(() => hasInstance('document-index', note), 'document-index for a file in a folder within it');
      assertEquals(await hasInstance('document-index', read), false, 'a file read before is not read again');
    });

    await t.step('a folder moved and removed before the bridge reads the move is acked, not dead-lettered', async () => {
      const folder = '/home/anna/staging/files/gone';
      await client.exec(`mkdir -p ${folder} /home/anna/.trash/t`);
      await client.exec(`echo text > ${folder}/note.txt`);
      await client.exec('service stop archive-bridge');
      assertEquals((await client.exec(`mv ${folder} /home/anna/.trash/t/ && rm -r /home/anna/.trash/t/gone`)).success, true);
      await client.exec('service start archive-bridge');

      const queue = `${QUEUES_PATH}/archive-bridge`;
      await waitFor(async () => (await client.execJson<{ items: unknown[] }>(`queue-peek ${queue}`)).items.length === 0, 'the bridge to drain its queue');
      assertEquals((await client.execJson<{ items: unknown[] }>(`queue-dead ${queue}`)).items, []);
    });

    await t.step('media-scan does not follow softlinks out of the hierarchy', async () => {
      // Files carry relation softlinks to *other files* and albums carry a
      // cover link. Following those turns the tree into a cyclic
      // graph, and a scan that wanders the whole library never reaches its budget.
      await makeMedia(`${ALBUMS_ROOT}/holiday/files/linked.jpg`);
      await client.exec(`mkdir -p ${ALBUMS_ROOT}/holiday/files/deep.jpg/relations`);
      await client.exec(`ln -s ${ALBUMS_ROOT}/holiday/files/linked.jpg ${ALBUMS_ROOT}/holiday/files/deep.jpg/relations/related-1`);
      await client.exec(`ln -s ${ALBUMS_ROOT}/holiday/files ${ALBUMS_ROOT}/holiday/cover`);

      const result = await client.execJson<{ scanned: number; paths: string[] }>(`media-scan ${ALBUMS_ROOT} --limit 50`);

      // Each file counted once — a followed link would revisit them
      const seen = result.paths.filter((p) => p === `${ALBUMS_ROOT}/holiday/files/linked.jpg`);
      assertEquals(seen.length <= 1, true, `linked.jpg emitted ${seen.length} times: ${JSON.stringify(result.paths)}`);
    });

    await t.step('service stop archive-bridge stops the live feeder', async () => {
      // The remote disk guard relies on this being a real, stoppable service.
      // Stop the bridge, then create a file it will never see.
      await client.exec('service stop archive-bridge');
      await makeMedia(`${ALBUMS_ROOT}/t/missed.jpg`);

      const nodeId = await nodeIdOf(`${ALBUMS_ROOT}/t/missed.jpg`);
      await new Promise((r) => setTimeout(r, 500));
      assertEquals(await hasInstance('media-ingest', nodeId), false, 'bridge is down, nothing should trigger');

      const result = await client.execJson<{ scanned: number; emitted: number }>(`media-scan ${ALBUMS_ROOT}`);
      assertEquals(result.emitted >= 1, true, `expected an emitted event, got ${JSON.stringify(result)}`);

      await waitFor(() => hasInstance('media-ingest', nodeId), 'media-ingest from media-scan');
    });

    await t.step('media-scan is silent for an already-indexed file', async () => {
      // The last stages a.jpg is still missing, by what they leave: its fingerprint, and the
      // `textIndexedAt` and `facesAt` markers — `facesAt` rather than the `regions/` directory
      // created above, since the legacy importer writes that directory at import time, so a file
      // can hold face nodes and still never have met the detector.
      await client.exec(`mknode -p -t embedding ${ALBUMS_ROOT}/t/a.jpg/metadata/sscd-image --as embeddingType=sscd-image`);
      await vfs.update(ADMIN_ACCESS, `${ALBUMS_ROOT}/t/a.jpg`, {
        attrs: { facesAt: '2026-08-23T00:00:00Z', fingerprintedAt: '2026-08-23T00:00:00Z', textIndexedAt: '2026-08-23T00:00:00Z' },
      });

      const result = await client.execJson<{ emitted: number; paths: string[] }>(`media-scan ${ALBUMS_ROOT}`);

      // a.jpg has exif with a matching sourceSha256; missed.jpg now does not, but
      // it has no exif either — re-emitting discovery for it is correct and
      // absorbed by one-instance-per-node.
      assertEquals(result.paths.includes(`${ALBUMS_ROOT}/t/a.jpg`), false, 'indexed file must stay silent');
    });

    await t.step('media-scan re-announces a file whose face detection never ran', async () => {
      // The gap `skipIfAttr: facesAt` cannot close on its own: with no `facesAt` the pipeline
      // would run, but nothing re-emits the fact that would trigger it.
      await vfs.update(ADMIN_ACCESS, `${ALBUMS_ROOT}/t/a.jpg`, { attrs: { facesAt: undefined } });

      const result = await client.execJson<{ emitted: number; paths: string[] }>(`media-scan ${ALBUMS_ROOT}`);

      assertEquals(result.paths.includes(`${ALBUMS_ROOT}/t/a.jpg`), true, `expected a gap re-announce, got ${JSON.stringify(result.paths)}`);

      await vfs.update(ADMIN_ACCESS, `${ALBUMS_ROOT}/t/a.jpg`, { attrs: { facesAt: '2026-08-23T00:00:00Z' } });
    });

    await t.step('a scan resumes where the last one stopped', async () => {
      // What converges is the pass, not the run. A run that spends a budget stores where it got
      // to, so the next one carries on rather than re-reading — and re-announcing — the same
      // first slice.
      type Pass = { scanned: number; complete: boolean; cursor: string | null };

      const first = await client.execJson<Pass>(`media-scan ${ALBUMS_ROOT} --restart --scan-limit 1`);

      assertEquals(first.scanned, 1, `expected one file examined, got ${JSON.stringify(first)}`);
      assertEquals(first.complete, false, 'a run cut short by a budget has not finished its pass');
      assertEquals(typeof first.cursor, 'string', `expected a stored resume point, got ${first.cursor}`);

      const second = await client.execJson<Pass>(`media-scan ${ALBUMS_ROOT} --scan-limit 1`);

      assertEquals(second.scanned, 1, `expected one file examined, got ${JSON.stringify(second)}`);
      assertEquals(second.cursor !== first.cursor, true, `the second run examined ${second.cursor} again`);

      // Reaching the end of the subtree ends the pass and clears the cursor, so the run after it
      // starts from the top again.
      const third = await client.execJson<Pass>(`media-scan ${ALBUMS_ROOT}`);

      assertEquals(third.complete, true, `expected a completed pass, got ${JSON.stringify(third)}`);
      assertEquals(third.cursor, null);

      const attrs = (await vfs.get(ADMIN_ACCESS, ALBUMS_ROOT)).attrs as Record<string, unknown>;
      assertEquals(attrs.mediaScanCursor, undefined, 'a finished pass must leave no resume point behind');
    });

    // A reconciler with no brake floods the trigger queue: with no active slots left, the
    // budget is spent before the first file.
    await t.step('the backlog gate actually stops the walk', async () => {
      const result = await client.execJson<{ scanned: number; emitted: number; budget: number }>(
        `media-scan ${ALBUMS_ROOT} --max-active 0`,
      );

      assertEquals(result.budget, 0);
      assertEquals(result.emitted, 0);
      assertEquals(result.scanned, 0);
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
