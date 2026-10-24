/**
 * A first transcript and a stale one's redo are two trigger modes of one pipeline, for audio and
 * video alike, and the voices start from the transcript.
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

Deno.test('media-transcribe carries ordinary triggers per media type and one forced trigger', async () => {
  const def = await read('media-transcribe.yaml');
  const ordinary = def.triggers.filter((trigger) => trigger.on === 'media.metadata.extracted');
  const stale = def.triggers.filter((trigger) => trigger.on === 'media.transcript.stale');

  assertEquals(ordinary.map((trigger) => trigger.match?.mimetype).sort(), ['audio/*', 'video/*']);
  for (const trigger of ordinary) {
    assertEquals(trigger.skipIfExists, '$NODE_PATH/metadata/transcript');
    assertEquals(trigger.vars, undefined);
  }
  assertEquals(stale.length, 1);
  assertEquals(stale[0].skipIfExists, undefined);
  assertEquals(stale[0].vars, { FORCE: '-f' });
  assertEquals(stale[0].priority, 10);
  assertEquals(def.options.priority, 50);
  assertEquals(def.steps['transcribe-file'].command, 'transcribe-file $FORCE $NODE_PATH');
  assertEquals(def.steps['transcribe-file'].kind, 'transcribe');
  assertEquals(def.steps['transcribe-file'].requires, { models: 1 });
});

Deno.test('media-voiceprint starts from a transcript and from the speakers gap', async () => {
  const def = await read('media-voiceprint.yaml');
  assertEquals(def.triggers.map((trigger) => trigger.on).sort(), ['media.speakers.missing', 'media.transcript.generated']);
  for (const trigger of def.triggers) assertEquals(trigger.skipIfAttr, 'speakersAt');
});

Deno.test('no pipeline describes media', () => {
  const files = [...Deno.readDirSync(pipelinesDir)].map((entry) => entry.name);
  assertEquals(files.filter((name) => name.includes('describe')), []);
});
