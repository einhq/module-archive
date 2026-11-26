/**
 * What `media-scan` keeps on the root it scans: shared by `media-scan`, which walks, and
 * `media-heal`, which says when a pass is due. Also which facts a failed run already has, which a
 * scan leaves to `pipeline heal`. Whether work waits for a fact is `@media/waiting`.
 */

import { PIPELINE_INSTANCES_PATH } from '@ein/paths';
import type { AttrCondition, Command, DomainEvent, NodeQueryCursor } from '@ein/client';

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

/** The fact `media-heal` announces on a root, the albums or a staging area's files, when a pass over it is due. */
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

/** Failed instances one query page returns. */
const FAILED_PAGE = 500;

/** `data` as a string that is the same for the same keys and values, whatever their order. */
const canonical = (data: Record<string, unknown> | undefined): string =>
  JSON.stringify(Object.keys(data ?? {}).filter((key) => data![key] !== undefined).sort().map((key) => [key, data![key]]));

/** A fact as `failedAlike` compares it. */
type FactKey = { type: string; nodeId?: string; data?: Record<string, unknown> };

/**
 * Whether a fact is the one a failed pipeline instance was started by: the same type, the same
 * node and the same data, so the same bytes or the same model as the run that failed. Such a fact
 * is `pipeline heal`'s to run again, after a wait that grows with each try; announced again, it
 * would replace the failed instance with a fresh one every pass and reset that count.
 *
 * Read once, from every failed instance, so a pass asks no more of each file. A fact that differs
 * in anything — the file's bytes changed, EMS runs another model — is announced as before.
 */
export const failedAlike = async (cmd: Command): Promise<(fact: FactKey) => boolean> => {
  const failed = new Set<string>();
  const where: AttrCondition[] = [{ ref: 'pipelineName', op: 'exists' }, { ref: 'status', op: 'eq', value: 'failed' }];
  let after: NodeQueryCursor | undefined;
  try {
    do {
      const page = await cmd.sys.vfs.query(cmd.access, { where, within: PIPELINE_INSTANCES_PATH, after, limit: FAILED_PAGE });
      for (const row of page) {
        const event = (row.node.attrs as { triggerEvent?: DomainEvent }).triggerEvent;
        if (event?.type && event.nodeId) failed.add(`${event.nodeId} ${event.type} ${canonical(event.data)}`);
      }
      after = page.length === FAILED_PAGE ? { value: page[page.length - 1].sortValue, id: page[page.length - 1].id } : undefined;
    } while (after);
  } catch (error) {
    // Unreadable: every fact is announced, as it would be with no failure on record.
    await cmd.writeError(`media-scan: could not read the failed pipeline instances: ${error instanceof Error ? error.message : String(error)}\n`);
  }

  return (fact) => fact.nodeId !== undefined && failed.has(`${fact.nodeId} ${fact.type} ${canonical(fact.data)}`);
};

/** The last finished pass recorded on `root`, or undefined when none is. */
export const readLastPass = async (cmd: Command, root: string): Promise<LastPass | undefined> => {
  const last = (await rootAttrs(cmd, root))?.[LAST_PASS_ATTR] as Partial<LastPass> | undefined;

  if (!last || typeof last.at !== 'number') return undefined;

  return { at: last.at, scanned: count(last.scanned), emitted: count(last.emitted), held: isStrings(last.held) ? last.held : [] };
};
