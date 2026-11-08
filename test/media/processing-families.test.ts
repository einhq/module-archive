/**
 * Every pipeline that acts on a file wherever it lies names the family of work it does, on every
 * trigger, so a folder that wants only some families gets only those (`processing`, core's
 * `wants`). A pipeline that names none is one every family needs, or one that acts only on the
 * archive's own trees; a new pipeline has to be put in one table or the other.
 */

import { assertEquals } from '@std/assert';
import { parse as parseYaml } from '@std/yaml';

type Trigger = { wants?: string | string[] };
type PipelineFile = { trigger?: Trigger; triggers?: Trigger[] };

const moduleRoot = new URL('../../', import.meta.url);

/** The family each pipeline's triggers name. */
const FAMILIES: Record<string, string[]> = {
  'media-faces': ['archive'],
  'media-video-faces': ['archive'],
  'media-faces-stale': ['archive'],
  'media-face-assign': ['archive'],
  'media-speaker-faces': ['archive'],
  'media-speaker-assign': ['archive'],
  'media-voiceprint': ['archive'],
  'media-camera': ['archive'],
  'media-camera-cover': ['archive'],
  'media-interpret': ['archive'],
  'media-geocode': ['archive'],
  'media-weather': ['archive'],
  'media-duplicates': ['archive'],
};

/** The pipelines that name no family, and why. */
const UNGATED: Record<string, string> = {
  'media-heal': "a pass over the albums, the archive's own tree",
  'media-album': "an album's members, in the archive's own tree",
  'staging-organize': 'a staging category',
  'staging-retime': 'a staging category',
  'staging-sidecars': 'a staging category',
  'staging-unzip': 'a zip in a staging category',
  'gedcom-stage': 'a GEDCOM file in staging',
  'track-stage': 'a GPX file in staging',
  'track-trips': "a camera's track",
  'location-upkeep': 'a location',
  'location-link-point': 'a photo point near a location',
};

Deno.test('every pipeline names the family of work it does, or is one that names none', async () => {
  const seen: string[] = [];
  for await (const entry of Deno.readDir(new URL('pipelines/', moduleRoot))) {
    if (!entry.name.endsWith('.yaml')) continue;
    const name = entry.name.slice(0, -'.yaml'.length);
    seen.push(name);
    const definition = parseYaml(await Deno.readTextFile(new URL(`pipelines/${entry.name}`, moduleRoot))) as PipelineFile;
    const triggers = definition.triggers ?? (definition.trigger ? [definition.trigger] : []);
    const named = triggers.map((trigger) => trigger.wants === undefined ? undefined : [trigger.wants].flat());

    if (name in UNGATED) {
      assertEquals(named.filter((wants) => wants !== undefined), [], `${name} names no family: ${UNGATED[name]}`);
      continue;
    }
    if (!(name in FAMILIES)) throw new Error(`${name}: put it in FAMILIES with the family it does, or in UNGATED with why it needs none`);
    assertEquals(named, triggers.map(() => FAMILIES[name]), `${name}: every trigger names ${FAMILIES[name].join(', ')}`);
  }
  assertEquals([...Object.keys(FAMILIES), ...Object.keys(UNGATED)].filter((name) => !seen.includes(name)), [], 'a pipeline in a table is gone');
});
