/** The roots archive's code names are the roots its manifest declares. */

import { assertEquals } from '@std/assert';
import { ALBUMS_ROOT, DEVICES_ROOT, LOCATIONS_ROOT, PEOPLE_ROOT } from '@archive/paths';

Deno.test("archive's paths are the roots in its mod.json", async () => {
  const manifest = JSON.parse(await Deno.readTextFile(new URL('../mod.json', import.meta.url)));
  assertEquals([...manifest.roots].sort(), [ALBUMS_ROOT, DEVICES_ROOT, LOCATIONS_ROOT, PEOPLE_ROOT].sort());
});
