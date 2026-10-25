import { assertEquals, assertStringIncludes } from '@std/assert';
import { parse as parseYaml } from '@std/yaml';

type PipelineFile = {
  steps: Record<string, { kind: string; requires?: Record<string, number> }>;
};

const moduleRoot = new URL('../../', import.meta.url);

/** Every pipeline whose step calls a model in EMS, and the kind it queues under. */
const MODEL_STEPS = [
  { file: 'media-faces.yaml', step: 'detect-faces', kind: 'faces' },
  { file: 'media-video-faces.yaml', step: 'detect-faces', kind: 'faces' },
  { file: 'media-embed-picture.yaml', step: 'embed-picture', kind: 'embed-picture' },
  { file: 'media-embed-text.yaml', step: 'embed-text', kind: 'embed-text' },
  { file: 'media-transcribe.yaml', step: 'transcribe-file', kind: 'transcribe' },
  { file: 'media-voiceprint.yaml', step: 'voiceprint-file', kind: 'diarize' },
  { file: 'media-speaker-faces.yaml', step: 'see', kind: 'diarize' },
  { file: 'media-transcode.yaml', step: 'chapters', kind: 'shots' },
];

Deno.test('model-bound steps take one slot each, and every kind they name is one the worker offers', async () => {
  const worker = await Deno.readTextFile(new URL('services/models/start.sh', moduleRoot));

  for (const { file, step, kind } of MODEL_STEPS) {
    const definition = parseYaml(await Deno.readTextFile(new URL(`pipelines/${file}`, moduleRoot))) as PipelineFile;
    assertEquals(definition.steps[step].kind, kind, file);
    // A slot is a request in flight against EMS; nothing here is a card, so nothing states a
    // VRAM figure. The device is EMS's decision.
    assertEquals(definition.steps[step].requires, { models: 1 }, file);
    // Every kind the definitions name has to be one the worker offers, or its jobs sit ready
    // forever with nothing to claim them — a pool stores no worker state, so nothing would say so.
    assertStringIncludes(worker, `--kind ${kind}`);
  }
  assertStringIncludes(worker, '--capacity models="${CFG_MODEL_SLOTS:-2}"');
  // The invocation itself names no card.
  const invocation = worker.slice(worker.indexOf('pipeline-worker'));
  assertEquals(invocation.includes('vramMb'), false);
  assertEquals(invocation.includes('gpu'), false);
});

Deno.test('every kind a CPU-bound step queues under is one the CPU worker offers', async () => {
  const worker = await Deno.readTextFile(new URL('services/cpu/start.sh', moduleRoot));
  const named: string[] = [];
  for await (const entry of Deno.readDir(new URL('pipelines/', moduleRoot))) {
    if (!entry.name.endsWith('.yaml')) continue;
    const definition = parseYaml(await Deno.readTextFile(new URL(`pipelines/${entry.name}`, moduleRoot))) as PipelineFile;
    for (const [name, step] of Object.entries(definition.steps)) {
      if (step.requires?.cpu === undefined) continue;
      named.push(step.kind);
      // Whole names: `face` is not offered by `--kind face-assign`.
      assertEquals(new RegExp(`--kind ${step.kind}\\s`).test(worker), true, `${entry.name}: ${name} queues under ${step.kind}, which no CPU worker offers`);
    }
  }
  assertEquals(named.includes('stills') && named.includes('transcode'), true);
});
