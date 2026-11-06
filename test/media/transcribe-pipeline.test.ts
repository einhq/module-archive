/**
 * The voices start from the transcript (the media module's `media.transcript.generated`) and from
 * the speakers gap, and no pipeline describes media.
 */

import { assertEquals } from '@std/assert';
import { parse as parseYaml } from '@std/yaml';

const pipelinesDir = new URL('../../pipelines/', import.meta.url);

type Trigger = {
  on?: string;
  match?: { mimetype?: string };
  skipIfExists?: string;
  skipIfAttr?: string;
  vars?: Record<string, string>;
  priority?: number;
};

type PipelineFile = {
  triggers: Trigger[];
  steps: Record<string, { command: string; kind?: string; requires?: { models: number } }>;
  options: { priority: number };
};

const read = async (name: string): Promise<PipelineFile> => parseYaml(await Deno.readTextFile(new URL(name, pipelinesDir))) as PipelineFile;

Deno.test('media-voiceprint starts from a transcript and from the speakers gap', async () => {
  const def = await read('media-voiceprint.yaml');
  assertEquals(def.triggers.map((trigger) => trigger.on).sort(), ['media.speakers.missing', 'media.transcript.generated']);
  for (const trigger of def.triggers) assertEquals(trigger.skipIfAttr, 'speakersAt');
});

Deno.test('no pipeline describes media', () => {
  const files = [...Deno.readDirSync(pipelinesDir)].map((entry) => entry.name);
  assertEquals(files.filter((name) => name.includes('describe')), []);
});
