/**
 * document-index reads no staged file: a write under `/home/<user>/staging` starts no instance
 * and runs no filter, whatever the file is, a staged file put in the trash neither, and a file
 * is indexed once it is moved out. A text file in a node's `metadata/`, such as an album's
 * description, is never read.
 *
 * The definition is the module's own, defined into a booted instance with `index-document`
 * stubbed and one line opening its filter that records each evaluation. Probe pipelines that
 * watch staging, the trash and metadata without `unless` show each event reached the definitions, so
 * document-index's silence is a verdict, not a delay.
 *
 * A file no event reached is `media-scan`'s gap, `media.text.missing`, decided in TypeScript by
 * `isTextIndexedMimetype`; the last steps hold that to the filter and to media-ocr's triggers for
 * pictures, and the fact's trigger to the same paths as the events'.
 */

import { ALBUMS_ROOT } from '@archive/paths';
import { isTextIndexedMimetype } from '@archive/media/event-rules';
import { EVENTS_NODE_PATH, PIPELINE_INSTANCES_PATH } from '@ein/paths';
import { ulid } from '@std/ulid/ulid';
import { assertEquals } from '@std/assert';
import { parse as parseYaml } from '@std/yaml';
import { ADMIN_ACCESS, SystemTestHarness } from '@ein/testing';

const harness = new SystemTestHarness({ ssh: false, boot: true });

const DEFINITION = new URL('../../pipelines/document-index.yaml', import.meta.url);
const OCR_DEFINITION = new URL('../../pipelines/media-ocr.yaml', import.meta.url);
const FILTER_EVALS = '/tmp/filter-evals';

async function waitFor(predicate: () => Promise<boolean>, what: string, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

Deno.test({
  name: 'document-index leaves staging alone until a file leaves it',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await harness.startPrimary();
  const client = await harness.createShellClient();

  const writeFile = async (path: string, body: string) => {
    const handle = await vfs.open(ADMIN_ACCESS, path, { mode: 'w' });
    try {
      await handle.write(new TextEncoder().encode(body));
    } finally {
      await handle.close();
    }
  };

  // Definitions live under /tmp, which document-index never reads, so defining the probe after
  // it starts nothing.
  const define = async (name: string, yaml: string) => {
    await client.exec(`mkfile /tmp/defs/${name}.yaml`);
    await writeFile(`/tmp/defs/${name}.yaml`, yaml);
    assertEquals((await client.exec(`pipeline define /tmp/defs/${name}.yaml`)).success, true, `define ${name}`);
  };

  const filterEvals = async (): Promise<string[]> => {
    const result = await client.exec(`cat ${FILTER_EVALS}`);
    return result.success ? String(result.data).split('\n').filter(Boolean) : [];
  };

  const nodeIdOf = async (path: string): Promise<string> => (await vfs.get(ADMIN_ACCESS, path)).id;
  const hasInstance = (pipeline: string, nodeId: string): Promise<boolean> => vfs.exists(ADMIN_ACCESS, `${PIPELINE_INSTANCES_PATH}/${pipeline}/${nodeId}`);

  const staged = '/home/anna/staging/files';
  const album = `${ALBUMS_ROOT}/garden-party/files`;

  try {
    // A stub, so an instance completes without the media service
    await client.exec('mkdir -p /opt/stub && mkdir -p /tmp/defs && mkfile /opt/stub/index-document && chmod 755 /opt/stub/index-document');
    await writeFile('/opt/stub/index-document', 'echo "$1" >> /tmp/indexed\n');
    await client.exec(`echo 'export PATH="/opt/stub:$PATH"' >> /etc/bashrc`);
    await client.exec(`mkdir -p ${staged} && mkdir -p ${album}`);

    const definition = await Deno.readTextFile(DEFINITION);
    const filter = '    filter: |\n';
    assertEquals(definition.split(filter).length, 2, 'one filter, shared by both triggers');
    await define('document-index', definition.replace(filter, `${filter}      echo "$NODE_PATH" >> ${FILTER_EVALS}\n`));
    await define(
      'test-staging-probe',
      [
        'name: test-staging-probe',
        'trigger:',
        '  event: updated',
        '  nodeType: file',
        '  match:',
        "    nodePath: '/home/*/staging/**'",
        'steps:',
        '  noop:',
        '    command: echo ran',
      ].join('\n'),
    );
    await define(
      'test-trash-probe',
      [
        'name: test-trash-probe',
        'trigger:',
        '  event: moved',
        '  nodeType: file',
        '  match:',
        "    nodePath: '**/.trash/**'",
        'steps:',
        '  noop:',
        '    command: echo ran',
      ].join('\n'),
    );
    await define(
      'test-metadata-probe',
      [
        'name: test-metadata-probe',
        'trigger:',
        '  event: updated',
        '  nodeType: file',
        '  match:',
        "    nodePath: '**/metadata/**'",
        'steps:',
        '  noop:',
        '    command: echo ran',
      ].join('\n'),
    );

    await t.step('a staged text, picture or sidecar write starts no instance', async () => {
      const files = {
        'notes.txt': 'Garden party at the lake house. Bring a sailboat.\n',
        'IMG_0001.jpg.supplemental-metadata.json': '{"title": "IMG_0001.jpg", "description": "A sailboat"}\n',
        'IMG_0002.xmp': '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>\n<x:xmpmeta xmlns:x="adobe:ns:meta/"></x:xmpmeta>\n',
      };
      for (const [name, body] of Object.entries(files)) {
        await client.exec(`mkfile ${staged}/${name}`);
        await writeFile(`${staged}/${name}`, body);
      }
      // A picture as an upload leaves it: bytes, then its mimetype
      await client.exec(`echo pixels > ${staged}/IMG_0001.jpg`);
      await vfs.update(ADMIN_ACCESS, `${staged}/IMG_0001.jpg`, { attrs: { mimetype: 'image/jpeg' } });

      const ids = await Promise.all([...Object.keys(files), 'IMG_0001.jpg'].map((name) => nodeIdOf(`${staged}/${name}`)));
      for (const id of ids) await waitFor(() => hasInstance('test-staging-probe', id), `probe instance for ${id}`);
      await new Promise((r) => setTimeout(r, 500));

      for (const id of ids) assertEquals(await hasInstance('document-index', id), false, `no instance for ${id}`);
      assertEquals((await filterEvals()).filter((path) => path.includes('/staging/')), [], 'no filter run for a staged write');
      assertEquals((await vfs.get<{ mimetype?: string }>(ADMIN_ACCESS, `${staged}/IMG_0001.jpg.supplemental-metadata.json`)).attrs.mimetype, 'application/json');
      assertEquals((await vfs.get<{ mimetype?: string }>(ADMIN_ACCESS, `${staged}/IMG_0002.xmp`)).attrs.mimetype, 'application/rdf+xml');
    });

    await t.step('a staged file put in the trash starts no instance and runs no filter', async () => {
      const id = await nodeIdOf(`${staged}/IMG_0001.jpg`);
      assertEquals((await client.exec(`trash put ${staged}/IMG_0001.jpg`)).success, true);
      await waitFor(() => hasInstance('test-trash-probe', id), 'probe instance for the trashed file');
      await new Promise((r) => setTimeout(r, 500));

      assertEquals(await hasInstance('document-index', id), false);
      assertEquals((await filterEvals()).filter((path) => path.includes('/.trash/')), [], 'no filter run for a trashed file');
    });

    await t.step("a text file in a node's metadata starts no instance and runs no filter", async () => {
      const description = `${ALBUMS_ROOT}/garden-party/metadata/description`;
      await client.exec(`mkdir -p ${ALBUMS_ROOT}/garden-party/metadata && mkfile ${description}`);
      await writeFile(description, 'Garden party. A sailboat on the lake, 12 items.\n');
      await vfs.update(ADMIN_ACCESS, description, { attrs: { mimetype: 'text/plain' } });
      const id = await nodeIdOf(description);
      await waitFor(() => hasInstance('test-metadata-probe', id), 'probe instance for the description');
      await new Promise((r) => setTimeout(r, 500));

      assertEquals(await hasInstance('document-index', id), false);
      assertEquals((await filterEvals()).filter((path) => path.includes('/metadata/')), [], 'no filter run for a metadata write');
    });

    await t.step('a file written outside staging is indexed', async () => {
      await client.exec(`mkfile ${album}/letter.txt`);
      await writeFile(`${album}/letter.txt`, 'Dear Anna Andersson, thank you for the sailboat.\n');
      const id = await nodeIdOf(`${album}/letter.txt`);
      await waitFor(() => hasInstance('document-index', id), 'instance for the library file');
      assertEquals(await filterEvals(), [`${album}/letter.txt`], 'the filter decides a library write');
    });

    await t.step('a file in a folder named staging deeper in a home is indexed', async () => {
      const path = '/home/anna/notes/staging/draft.txt';
      await client.exec('mkdir -p /home/anna/notes/staging');
      await client.exec(`mkfile ${path}`);
      await writeFile(path, 'A list for the sailboat trip.\n');
      const id = await nodeIdOf(path);
      await waitFor(() => hasInstance('document-index', id), 'instance for the file outside the inbox');
    });

    await t.step('a staged file moved out of staging is indexed', async () => {
      const id = await nodeIdOf(`${staged}/notes.txt`);
      assertEquals((await client.exec(`mv ${staged}/notes.txt ${album}/notes.txt`)).success, true);
      assertEquals(await nodeIdOf(`${album}/notes.txt`), id);
      await waitFor(() => hasInstance('document-index', id), 'instance for the moved file');
    });

    await t.step('the filter takes the documents media-scan announces a text gap for, and no picture', async () => {
      const { triggers } = parseYaml(await Deno.readTextFile(DEFINITION)) as { triggers: { filter?: string }[] };
      const filter = triggers[0].filter ?? '';
      const mimetypes = [
        'application/pdf',
        'text/plain',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.oasis.opendocument.text',
        'image/jpeg',
        'image/png',
        'image/heic',
        'image/x-canon-cr2',
        'text/markdown',
        'application/json',
        'application/rdf+xml',
        'video/mp4',
        'audio/wav',
      ];
      for (const mimetype of mimetypes) {
        const result = await client.exec(`(MIMETYPE='${mimetype}'; NODE_PATH=/probe\n${filter})`);
        assertEquals(result.success, isTextIndexedMimetype(mimetype) && !mimetype.startsWith('image/'), mimetype);
      }
    });

    await t.step('media-ocr reads every picture media-scan announces a text gap for, outside the same paths', async () => {
      type Trigger = { on?: string | string[]; match?: { mimetype?: string }; unless?: { nodePath?: string[] } };
      const documents = (parseYaml(await Deno.readTextFile(DEFINITION)) as { triggers: Trigger[] }).triggers;
      const pictures = (parseYaml(await Deno.readTextFile(OCR_DEFINITION)) as { triggers: Trigger[] }).triggers;
      const gap = pictures.find((trigger) => trigger.on === 'media.text.missing');
      assertEquals(gap?.match?.mimetype, 'image/*');
      for (const mimetype of ['image/jpeg', 'image/heic', 'image/x-canon-cr2']) assertEquals(isTextIndexedMimetype(mimetype), true, mimetype);
      // document-index also leaves out a node's metadata, where its own output is and no picture.
      const unread = (documents[0].unless?.nodePath ?? []).filter((path) => path !== '**/metadata/**');
      for (const trigger of pictures) assertEquals(trigger.unless?.nodePath, unread, String(trigger.on ?? 'moved'));
    });

    await t.step('a text gap starts an instance for a library file, and none for a staged one', async () => {
      const announce = async (path: string, mimetype: string) => {
        const fact = { id: ulid(), type: 'media.text.missing', subject: path, time: Date.now(), source: 'test', data: { mimetype } };
        const handle = await vfs.open(ADMIN_ACCESS, EVENTS_NODE_PATH, { mode: 'a' });
        try {
          await handle.write(new TextEncoder().encode(JSON.stringify(fact) + '\n'));
        } finally {
          await handle.close();
        }
      };

      const id = await nodeIdOf(`${album}/letter.txt`);
      // The stub writes no textIndexedAt, so the file reads as never indexed once its instance is gone.
      assertEquals((await client.exec(`rm -r ${PIPELINE_INSTANCES_PATH}/document-index/${id}`)).success, true);
      await announce(`${album}/letter.txt`, 'text/plain');
      await waitFor(() => hasInstance('document-index', id), 'instance for the announced gap');

      await client.exec(`mkfile ${staged}/scan.pdf`);
      await writeFile(`${staged}/scan.pdf`, '%PDF-1.4 a sailboat\n');
      const pdfId = await nodeIdOf(`${staged}/scan.pdf`);
      await announce(`${staged}/scan.pdf`, 'application/pdf');
      await new Promise((r) => setTimeout(r, 1000));
      assertEquals(await hasInstance('document-index', pdfId), false, 'a staged file waits to be filed');
    });
  } finally {
    await harness.stop();
  }
});
