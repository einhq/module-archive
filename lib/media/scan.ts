/**
 * What `media-scan` keeps on the root it scans, and what decides whether a scan would announce
 * anything: shared by `media-scan`, which walks, and `media-heal`, which says when a pass is due.
 */

import { POOLS_PATH } from '@ein/paths';
import type { PipelineSummary } from '@ein/api';
import type { Command } from '@ein/client';
import { join } from '@std/path';

/**
 * An unfinished pass, kept on the node that was scanned.
 *
 * On the root rather than in a state directory of its own so it is per-subtree without any
 * encoding of the path into a name, and so it disappears with the root it describes — a staging
 * area that is deleted leaves nothing behind to go stale.
 */
export const PASS_ATTR = 'mediaScanPass';

/** The last pass that walked to the end of the root, kept beside `PASS_ATTR`. */
export const LAST_PASS_ATTR = 'mediaScanLast';

/** The fact `media-heal` announces on the albums root when a pass over it is due. */
export const HEAL_DUE = 'media.heal.due';

/** What `PASS_ATTR` holds. */
export type Pass = {
  /** The last file examined; the next run resumes past it. */
  cursor: string;
  /** Files the pass's runs have examined so far. */
  scanned: number;
  /** Facts announced by the pass's runs so far. */
  emitted: number;
  /** Fact types the pass's runs held back so far. */
  held: string[];
  /**
   * Under `--if-idle`, the fact types whose work waited when the pass began. Its later runs hold
   * back these rather than what waits by then, which is mostly what the pass's own earlier runs
   * announced: asked afresh, a pass would hold back every kind of gap it had found in its first run.
   */
  busy?: string[];
};

/** What `LAST_PASS_ATTR` holds. */
export type LastPass = {
  /** When the pass reached the end, epoch ms. */
  at: number;
  /** Files it examined. */
  scanned: number;
  /** Facts it announced. */
  emitted: number;
  /** Fact types it held back because their work waited. */
  held: string[];
};

const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string');

const count = (value: unknown): number => typeof value === 'number' ? value : 0;

/** The root's attrs, or undefined when it cannot be read. */
const rootAttrs = async (cmd: Command, root: string): Promise<Record<string, unknown> | undefined> => {
  try {
    return (await cmd.sys.vfs.get(cmd.access, root)).attrs as Record<string, unknown>;
  } catch {
    return undefined;
  }
};

/** The unfinished pass stored on `root`, or undefined when there is none. */
export const readPass = async (cmd: Command, root: string): Promise<Pass | undefined> => {
  const pass = (await rootAttrs(cmd, root))?.[PASS_ATTR] as Partial<Pass> | undefined;

  if (!pass || typeof pass.cursor !== 'string' || !pass.cursor) return undefined;

  return {
    cursor: pass.cursor,
    scanned: count(pass.scanned),
    emitted: count(pass.emitted),
    held: isStrings(pass.held) ? pass.held : [],
    ...(isStrings(pass.busy) ? { busy: pass.busy } : {}),
  };
};

/** The last finished pass recorded on `root`, or undefined when none is. */
export const readLastPass = async (cmd: Command, root: string): Promise<LastPass | undefined> => {
  const last = (await rootAttrs(cmd, root))?.[LAST_PASS_ATTR] as Partial<LastPass> | undefined;

  if (!last || typeof last.at !== 'number') return undefined;

  return { at: last.at, scanned: count(last.scanned), emitted: count(last.emitted), held: isStrings(last.held) ? last.held : [] };
};

/** The kinds with a ready job in the pool at `path`; none when there is no pool yet (a fresh boot). */
const readyKinds = async (cmd: Command, path: string): Promise<Set<string>> => {
  if (!await cmd.sys.vfs.exists(cmd.access, path)) return new Set();
  const stat = await cmd.sys.vfs.stat(cmd.access, path) as { byKind?: Record<string, { ready?: number }> };
  return new Set(Object.entries(stat.byKind ?? {}).filter(([, counts]) => (counts.ready ?? 0) > 0).map(([kind]) => kind));
};

/**
 * The fact types whose work waits, each mapped to whether it does: a type waits when a pipeline it
 * starts has a ready trigger, or a ready job in the media pool of a kind one of its steps runs. A
 * scan then would announce again what is already on its way, so `--if-idle` holds those facts
 * back. Counted per pipeline, not per pool: a backlog of one kind of work does not hold off gaps
 * that feed another, and a live tracker's debounced `track-trips` job, ready for as long as it
 * sends, holds off nothing here. Types no pipeline starts are left out.
 *
 * Undefined when the definitions cannot be read, which the caller takes as everything waiting.
 */
export const factsWaiting = async (cmd: Command, name: string): Promise<Map<string, boolean> | undefined> => {
  const listed = await cmd.execute('JSON_OUTPUT=1 pipeline list');
  let pipelines: PipelineSummary[];
  try {
    pipelines = JSON.parse(listed.stdout);
  } catch {
    await cmd.writeError(`${name}: could not read the pipeline definitions: ${listed.stderr.trim() || listed.stdout.trim()}\n`);
    return undefined;
  }

  const pools = cmd.env.POOLS_PATH || POOLS_PATH;
  const triggers = await readyKinds(cmd, join(pools, 'triggers'));
  const media = await readyKinds(cmd, join(pools, 'media'));
  const waiting = new Map<string, boolean>();
  for (const pipeline of pipelines) {
    const busy = triggers.has(pipeline.name) || Object.values(pipeline.stepKinds ?? {}).some((kind) => media.has(kind));
    for (const type of pipeline.triggers.flatMap((trigger) => trigger.on ?? [])) {
      waiting.set(type, (waiting.get(type) ?? false) || busy);
    }
  }

  return waiting;
};

/** Whether every one of `types` waits by `waiting`, which a scan of only those types would hold back whole. */
export const allWait = (waiting: Map<string, boolean> | undefined, types: string[]): boolean => !waiting || types.every((type) => waiting.get(type) !== false);
