/**
 * The voices start from the transcript (the media module's `media.transcript.generated`) and from
 * the speakers gap, are found again when other voice models found them, and no pipeline describes
 * media.
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

Deno.test('media-voiceprint-stale diarizes again, forced, below a new recording', async () => {
  const def = await read('media-voiceprint-stale.yaml');
  assertEquals(def.triggers.map((trigger) => [trigger.on, trigger.skipIfAttr]), [['media.speakers.stale', 'undecodable']]);
  const step = def.steps['voiceprint-file'];
  assertEquals([step.command, step.kind], ['voiceprint-file -f $NODE_PATH', 'diarize']);
  const fresh = (await read('media-voiceprint.yaml')).steps['voiceprint-file'] as { priority?: number };
  assertEquals((step as { priority?: number }).priority, undefined);
  assertEquals(def.triggers[0].priority! < fresh.priority!, true);
});

Deno.test('no pipeline describes media', () => {
  const files = [...Deno.readDirSync(pipelinesDir)].map((entry) => entry.name);
  assertEquals(files.filter((name) => name.includes('describe')), []);
});
