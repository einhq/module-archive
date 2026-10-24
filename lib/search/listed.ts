/**
 * What a text provider ranks when `search` hands it the unlisted trees (`--not-within`): the
 * library only, so hits in a staging area do not use up the hits it may answer.
 *
 * A store query of files takes the trees as `notWithin`. A vector or a text's words lie under
 * their file, where no `notWithin` reaches, so those lookups are read by path instead: what lies in
 * a tree is dropped and more is asked for, until the library fills what was wanted or the lookup
 * runs out.
 */
import type { Command } from '@ein/client';
import { isUnlistedPath } from '@ein/client';

/** The most rows one lookup grows to while it refills. */
const REFILL_CAP = 50000;

/** How much a lookup grows each time what it found was mostly unlisted. */
const REFILL_GROWTH = 4;

/**
 * Rows found by `lookup(asked)`, nearest or best first, without those every path of which lies in
 * one of `roots`: at most `wanted`, asking for more while too few are left. `paths` are each kept
 * row's paths outside the trees. `full`: there may be more than `wanted`.
 */
export const listedRows = async <T extends { id: string }>(
  cmd: Pick<Command, 'sys' | 'access'>,
  roots: readonly string[],
  wanted: number,
  lookup: (asked: number) => Promise<T[]>,
): Promise<{ rows: T[]; paths: Map<string, string[]>; full: boolean }> => {
  let asked = wanted;
  for (;;) {
    const rows = await lookup(asked);
    const resolved = rows.length === 0 ? new Map<string, string[]>() : await cmd.sys.vfs.resolveIdPaths(cmd.access, rows.map((row) => row.id));
    const paths = new Map<string, string[]>();
    const kept: T[] = [];
    for (const row of rows) {
      const listed = (resolved.get(row.id) ?? []).filter((path) => !isUnlistedPath(roots, path));
      if (listed.length === 0 && roots.length > 0) continue;
      paths.set(row.id, roots.length > 0 ? listed : resolved.get(row.id) ?? []);
      kept.push(row);
    }
    const exhausted = rows.length < asked;
    if (exhausted || kept.length >= wanted || asked >= REFILL_CAP) {
      return { rows: kept.slice(0, wanted), paths, full: kept.length >= wanted || !exhausted };
    }
    asked = Math.min(asked * REFILL_GROWTH, REFILL_CAP);
  }
};
