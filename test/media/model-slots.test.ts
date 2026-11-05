/**
 * Every kind of work the archive's pipelines put in the media pool is one its drop-ins name for the
 * media module's workers, or its jobs would wait forever with nothing to claim them: the CPU kinds
 * in `etc/media-worker.d/kinds`, the model-bound ones in `etc/media-models.d/kinds`.
 */

import { assertEquals } from '@std/assert';
import { parse as parseYaml } from '@std/yaml';

type PipelineFile = {
  steps: Record<string, { kind: string; requires?: Record<string, number> }>;
};

const moduleRoot = new URL('../../', import.meta.url);

/** The kinds a drop-in names, as the media module reads it: a kind a line, `#` a comment. */
const dropInKinds = async (worker: string): Promise<string[]> =>
  (await Deno.readTextFile(new URL(`etc/${worker}.d/kinds`, moduleRoot)))
    .split('\n')
    .map((line) => line.replace(/#.*/, '').trim().split(/\s+/)[0])
    .filter(Boolean);

/** Every pipeline whose step calls a model in EMS, and the kind it queues under. */
const MODEL_STEPS = [
  { file: 'media-faces.yaml', step: 'detect-faces', kind: 'faces' },
  { file: 'media-video-faces.yaml', step: 'detect-faces', kind: 'faces' },
  { file: 'media-faces-stale.yaml', step: 'detect-faces', kind: 'faces' },
  { file: 'media-embed-picture.yaml', step: 'embed-picture', kind: 'embed-picture' },
  { file: 'media-embed-text.yaml', step: 'embed-text', kind: 'embed-text' },
  { file: 'media-transcribe.yaml', step: 'transcribe-file', kind: 'transcribe' },
  { file: 'media-voiceprint.yaml', step: 'voiceprint-file', kind: 'diarize' },
  { file: 'media-speaker-faces.yaml', step: 'see', kind: 'diarize' },
  { file: 'media-transcode.yaml', step: 'chapters', kind: 'shots' },
];

Deno.test('model-bound steps take one slot each, and every kind they name is one the models worker is offered', async () => {
  const offered = await dropInKinds('media-models');

  for (const { file, step, kind } of MODEL_STEPS) {
    const definition = parseYaml(await Deno.readTextFile(new URL(`pipelines/${file}`, moduleRoot))) as PipelineFile;
    assertEquals(definition.steps[step].kind, kind, file);
    // A slot is a request in flight against EMS; nothing here is a card, so nothing states a
    // VRAM figure. The device is EMS's decision.
    assertEquals(definition.steps[step].requires, { models: 1 }, file);
    assertEquals(offered.includes(kind), true, `${file}: ${step} queues under ${kind}, which the drop-in does not name`);
  }
});

Deno.test('every kind a CPU-bound step queues under is one the media worker is offered', async () => {
  const offered = await dropInKinds('media-worker');
  const named: string[] = [];
  for await (const entry of Deno.readDir(new URL('pipelines/', moduleRoot))) {
    if (!entry.name.endsWith('.yaml')) continue;
    const definition = parseYaml(await Deno.readTextFile(new URL(`pipelines/${entry.name}`, moduleRoot))) as PipelineFile;
    for (const [name, step] of Object.entries(definition.steps)) {
      if (step.requires?.cpu === undefined) continue;
      named.push(step.kind);
      assertEquals(offered.includes(step.kind), true, `${entry.name}: ${name} queues under ${step.kind}, which the drop-in does not name`);
    }
  }
  assertEquals(named.includes('stills') && named.includes('transcode'), true);
});
