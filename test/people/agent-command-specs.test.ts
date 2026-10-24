/**
 * What a command promises when it is offered to a model.
 *
 * The archive's commands are the agent's tools, so the spec a command carries for tab
 * completion is also what a model reads before calling it. `AGENT_COMMANDS` is the set that is
 * actually offered, and joining it is a promise — typed flags, an example, and a sentence
 * saying what comes back. An untyped flag is worse than a missing one, because a tool schema
 * cannot tell a switch from a flag that takes a value and will declare one of them wrongly.
 *
 * The check runs `<command> --help` and reads what comes back, because that is what a model is
 * shown. A core command's spec is also on its VFS node, but a module's bin is a plain source
 * file until the loader materialises it, so --help is the one route that works for both.
 */

import { assert, assertEquals } from '@std/assert';
import { BIN_PATH, CORE_BIN_PATH, MOD_PATH } from '@ein/paths';
import { ADMIN_ACCESS } from '@ein/testing';
import type { CmdSpec } from '@ein/client';
import { createTestContext, testCommands } from '@ein/testing';

/** Every type a flag may carry. Anything else renders wrongly and generates a wrong schema. */
const FLAG_TYPES = new Set(['bool', 'string', 'number', 'path', 'user', 'group', 'command', 'subcommand']);

/** The commands offered to the assistant. Adding one here is the promise described above. */
export const AGENT_COMMANDS = [
  'search',
  'search-people',
  'person-info',
  'person-how-related',
  'person-children',
  'person-relatives',
  'person-set-parent',
  'person-add-event',
  'media-details',
  'dayinhistory',
  'events',
  'location-region',
  'person-set-partner',
  'file-set-description',
] as const;

const testCtx = createTestContext({ modules: ['archive'] });

Deno.test({
  name: 'agent-command-specs',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);
  try {
    const help = new Map<string, string>();
    for (const name of AGENT_COMMANDS) {
      // `--help` writes to the command's output, which the shell client hands back as `data`.
      // Text mode explicitly: the shell client the tests use runs in JSON mode, where --help
      // answers with the spec itself. Both shapes are checked, each in its own mode.
      const result = await cmd.shouldSucceed(`JSON_OUTPUT=0 ${name} --help`);
      const text = typeof result.data === 'string' ? result.data : JSON.stringify(result.data ?? '');
      assert(text.trim(), `${name}: --help said nothing — is it on PATH?`);
      help.set(name, text);
    }

    await t.step('every offered command says what it returns', () => {
      for (const [name, text] of help) {
        assert(text.includes('Returns:'), `${name}: --help does not say what comes back (CmdSpec.returns)`);
      }
    });

    await t.step('every offered command shows a call', () => {
      for (const [name, text] of help) {
        assert(text.includes('Examples:'), `${name}: --help carries no example (CmdSpec.examples)`);
        const example = text.split('Examples:')[1].trim().split('\n')[0].trim();
        assert(example.startsWith(name), `${name}: an example is the command line itself, not "${example}"`);
      }
    });

    await t.step('a flag that takes a value is not shown as a switch', () => {
      // The help renderer lists an untyped flag among the switches, where it reads as "on or
      // off". These three are the canaries: one filter, one value with a default, one real switch.
      const text = help.get('search') ?? '';
      assert(/--kind <\w+>/.test(text), 'search --kind takes a value and must say so');
      assert(/--from <\w+>/.test(text), 'search --from takes a value and must say so');
      assert(/--facets(?! <)/.test(text), 'search --facets is a switch and must stay one');
    });

    await t.step('no command on PATH has an untyped flag', async () => {
      // Not only the offered ones: an untyped flag renders as a switch, so `--kind photo` reads
      // as on/off to a person and to a model alike, and nothing can generate a schema from it.
      // A command's own parseArgs call says which flags take a value, so keeping this true is
      // mechanical rather than a matter of judgement.
      const listing = [...await vfs.children<CmdSpec>(ADMIN_ACCESS, BIN_PATH), ...await vfs.children<CmdSpec>(ADMIN_ACCESS, CORE_BIN_PATH)];
      for (const module of await vfs.children(ADMIN_ACCESS, MOD_PATH)) {
        try {
          listing.push(...await vfs.children<CmdSpec>(ADMIN_ACCESS, `${MOD_PATH}/${module.name}/bin`));
        } catch { /* a module without commands has no bin directory */ }
      }
      const untyped: string[] = [];
      const specs: CmdSpec[] = [];
      for (const entry of listing) {
        const attrs = entry.node.attrs as CmdSpec;
        if (attrs?.name && (attrs.flags || attrs.args || attrs.description)) {
          specs.push(attrs);
          continue;
        }
        // A module's bin is only its source on the VFS; the spec exists once the shell has
        // loaded it, so ask the command itself.
        const result = await cmd.shouldSucceed(`JSON_OUTPUT=1 ${entry.name} --help`).catch(() => undefined);
        const text = typeof result?.data === 'string' ? result.data : JSON.stringify(result?.data ?? '');
        try {
          const spec = JSON.parse(text) as CmdSpec;
          if (spec?.name) specs.push(spec);
        } catch { /* a command that does not describe itself has nothing to check */ }
      }
      for (const spec of specs) {
        for (const flag of spec.flags ?? []) {
          // `bool` is the switch; any type outside FLAG_TYPES, `boolean` included, renders as a
          // flag taking a value.
          if (!flag.type || !FLAG_TYPES.has(flag.type)) untyped.push(`${spec.name} --${flag.name}${flag.type ? ` (${flag.type})` : ''}`);
        }
        for (const arg of spec.args ?? []) if (!arg.type) untyped.push(`${spec.name} <${arg.name}>`);
      }
      assertEquals(untyped, [], `untyped: ${untyped.join(', ')}`);
    });

    await t.step('a text primitive still describes itself in JSON', async () => {
      // `grep` sets `json: false` so that its OWN output stays text and `seq | grep` keeps
      // working. That says nothing about how it should describe itself: a caller that asked for
      // JSON wants the spec, whatever the command does with its stdout.
      const result = await cmd.shouldSucceed('JSON_OUTPUT=1 grep --help');
      const text = typeof result.data === 'string' ? result.data : JSON.stringify(result.data ?? '');
      const spec = JSON.parse(text) as { name: string; json?: boolean };
      assertEquals(spec.name, 'grep');
      assertEquals(spec.json, false, 'and it is still a text primitive');
    });

    await t.step('--help in JSON mode is the spec itself', async () => {
      // What a tool-schema generator reads. A module's bin is
      // only its source on the VFS, so the spec has to come from the loaded command — and the
      // shape follows the shell's output mode rather than a second flag.
      for (const name of AGENT_COMMANDS) {
        const result = await cmd.shouldSucceed(`JSON_OUTPUT=1 ${name} --help`);
        const text = typeof result.data === 'string' ? result.data : JSON.stringify(result.data ?? '');
        const spec = JSON.parse(text) as { name: string; returns?: string; examples?: string[]; flags?: { name: string; type?: string }[] };
        assertEquals(spec.name, name);
        assert(spec.returns, `${name} --help (json): carries what it returns`);
        assert(spec.examples?.length, `${name} --help (json): carries an example`);
        for (const flag of spec.flags ?? []) assert(flag.type, `${name} --help (json): --${flag.name} needs a type`);
      }
    });
  } finally {
    await testCtx.teardown();
  }
});
