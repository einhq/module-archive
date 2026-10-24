/**
 * Flags may come before the path.
 *
 * `transcribe-file -f <path>` must not take `-f` for the filename, as reading `cmd.args[0]`
 * as the path would; `--help` advertises the leading form.
 *
 * Each case runs the leading-flag form against a *directory*, so the command stops at
 * its own node-type check with no external tool or model in the picture. The assertion
 * is that the error names the directory: if the flag were still being read as the path,
 * the message would name the flag instead.
 */

import { ALBUMS_ROOT, LOCATIONS_ROOT, PEOPLE_ROOT } from '@archive/paths';
import { assertEquals } from '@std/assert';
import { createTestContext, testCommands } from '@ein/testing';

const testCtx = createTestContext({ modules: ['archive'] });

const DIR = `${ALBUMS_ROOT}/flagorder`;

Deno.test({
  name: 'bin flag order',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  try {
    await client.exec(`mkdir -p ${DIR}`);

    const leadingFlag: [string, string][] = [
      ['transcribe-file', `transcribe-file -f ${DIR}`],
      ['detect-chapters', `detect-chapters -f ${DIR}`],
      ['compute-fingerprint', `compute-fingerprint -f ${DIR}`],
      ['detect-faces', `detect-faces -f ${DIR}`],
      ['index-document', `index-document -f ${DIR}`],
      ['generate-derivatives', `generate-derivatives -f ${DIR}`],
      ['exif-extract', `exif-extract -f ${DIR}`],
      ['geocode-position', `geocode-position -f ${DIR}`],
    ];

    for (const [name, command] of leadingFlag) {
      await t.step(`${name} takes the path after its flags`, async () => {
        await cmd.shouldFailWith(command, DIR);
      });
    }

    // A value-taking flag must swallow its own value, or the value becomes the path.
    await t.step('a flag value is not mistaken for the path', async () => {
      await cmd.shouldFailWith(`generate-derivatives --size grid ${DIR}`, DIR);
      await cmd.shouldFailWith(`detect-faces --confidence 0.9 ${DIR}`, DIR);
    });

    // The trailing form is what the pipeline steps use; it must keep working.
    await t.step('the trailing form still works', async () => {
      await cmd.shouldFailWith(`transcribe-file ${DIR} -f`, DIR);
      await cmd.shouldFailWith(`compute-fingerprint ${DIR} --force`, DIR);
    });

    // Missing path is still missing — a lone flag must not become one.
    await t.step('a lone flag is not a path', async () => {
      await cmd.shouldFailWith('transcribe-file -f', 'missing file path');
      await cmd.shouldFailWith('index-document -v', 'missing file path');
    });

    // An undeclared flag eats the argument after it, so without this the command reports a
    // missing path while the path is sitting right there in the command line.
    await t.step('an undeclared flag is named, not silently swallowed', async () => {
      await cmd.shouldFailWith(`transcribe-file --bogus ${DIR}`, 'unknown flag --bogus');
      await cmd.shouldFailWith(`device-link -f ${DIR}`, 'unknown flag -f');
      await cmd.shouldFailWith(`generate-derivatives -z ${DIR}`, 'unknown flag -z');
    });

    // A short cluster is reported as the one argument the caller actually typed.
    await t.step('a short cluster is reported whole', async () => {
      await cmd.shouldFailWith(`exif-extract -qx ${DIR}`, 'unknown flag -qx');
    });

    // Operands after `--` are never offered to the unknown hook, so a path that looks like a
    // flag still reaches the command.
    await t.step('-- ends the flags', async () => {
      await cmd.shouldFailWith(`transcribe-file -f -- ${DIR}`, DIR);
    });

    // The trap in the guard. `--no-mirror` reaches the unknown hook even though `mirror` is a
    // declared boolean and parseArgs sets it correctly to false, so a guard that reported
    // everything the hook saw would reject every --no-x flag in the tree.
    await t.step('a negated boolean is not an unknown flag', async () => {
      // file-set-orientation declares `mirror`; --no-mirror must reach the command, which then
      // fails on the missing file rather than on the flag.
      const negated = await client.exec(`file-set-orientation --no-mirror ${DIR}`);
      assertEquals(
        String(negated.error ?? '').includes('unknown flag'),
        false,
        `--no-mirror was rejected as unknown: ${negated.error}`,
      );
      // ...while a negation of something undeclared still is one.
      await cmd.shouldFailWith(`file-set-orientation --no-bogus ${DIR}`, 'unknown flag --no-bogus');
    });

    // One converted bin per area, to catch an area whose conversion was skipped. Other modules
    // check their own (archive-parse, auto-album-cluster).
    await t.step('the guard reaches every area', async () => {
      for (
        const command of [
          `album --bogus ${ALBUMS_ROOT}`,
          `person-name --bogus ${PEOPLE_ROOT}/x`,
          `location-locate --bogus ${LOCATIONS_ROOT}/x`,
          'device-match --bogus',
          `index-document --bogus ${ALBUMS_ROOT}`,
        ]
      ) {
        await cmd.shouldFailWith(command, 'unknown flag --bogus');
      }
    });
  } finally {
    await client.close();
    await testCtx.teardown();
  }
});
