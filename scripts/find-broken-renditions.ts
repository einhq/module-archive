/**
 * Find derivative nodes whose bytes were never finished being written, and
 * optionally clear them so the pipeline regenerates them.
 *
 *   POSTGRES_URL=... VOLATILE_FILE_ROOT_PATH=... \
 *   deno run -A modules/archive/scripts/find-broken-renditions.ts [--repair]
 *
 * TWO SHAPES, and they need opposite repairs.
 *
 * **Unsynced.** A converter used to point ffmpeg/convert straight at the final path, so any
 * interruption — container restart, OOM kill, a stopped worker — left that
 * path holding a partial file. `file-sync` never ran, so the node has no `size` attr while
 * real bytes sit on disk underneath it. Converters write to a temp and swap now, so this
 * finds what was stranded before that change. Repair = remove the bytes.
 *
 * **Empty encode.** The converter ran and produced nothing, and `file-sync` recorded that
 * faithfully: `size: 0`, `mimetype: application/octet-stream`, the sha256 of the empty
 * string. The node is self-consistent, so no other check sees it; a transcode whose encode died
 * is the usual case. There are no bytes to remove;
 * repair = clear the `size` attr so the node reads as absent.
 *
 * Both repairs converge on the same state: a node with no size, which
 * `generate-derivatives` already treats as absent ("exists but is empty, regenerating"), so
 * the next crawl or a `regenerate` refills it. Neither removes the NODE, so nothing that
 * links to it by id breaks.
 *
 * The detector is a node attr query, not an ffprobe sweep: both shapes are exactly the set
 * that failed, the predicate is indexed (`..._attr_source_idx`), and it costs no I/O over
 * 800k renditions.
 *
 * **A third shape, reported and never repaired: the SOURCE is unreadable.** A file whose own
 * container ffprobe refused carries `undecodable` (see `@archive/media/media-probe`), and no rendition
 * can ever be made from it — regenerating is not the answer, and there is nothing here to
 * clear. Listed at the end because this is the tool somebody reaches for when renditions are
 * missing, and "the original is truncated" is the one answer that does not belong in the
 * counts above. ein/core#145.
 *
 * A CONVERTER THAT IS RUNNING RIGHT NOW looks exactly like an unsynced one: no size attr,
 * bytes on disk, because `file-sync` only runs when it finishes. So a repair skips anything
 * modified within --older-than minutes (default 30). Nothing bounds how long a step runs, so a
 * long encode can outlast that: repair while no transcode step is running, or raise it. A repair
 * once deleted a rendition out from under a live ffmpeg. Self-healing, but pure waste, and on a
 * slower box it would race something much larger. The empty-encode class
 * needs no such guard — a live converter has not written its `size` attr yet, so it is never
 * in that set.
 */
import { join } from '@std/path';
import { Pool } from 'pg';

const POSTGRES_URL = Deno.env.get('POSTGRES_URL') || 'postgres://ein:ein@127.0.0.1:5432/ein';
const MOUNT = Deno.env.get('MIGRATE_MOUNT_NAME') || 'root';
const VOLATILE_ROOT = Deno.env.get('VOLATILE_FILE_ROOT_PATH');
const REPAIR = Deno.args.includes('--repair');

const olderThanArg = Deno.args.find((a) => a.startsWith('--older-than='));
const OLDER_THAN_MIN = olderThanArg ? Number(olderThanArg.split('=')[1]) : 30;

if (!Number.isFinite(OLDER_THAN_MIN) || OLDER_THAN_MIN < 0) {
  console.error('error: --older-than= must be a non-negative number of minutes');
  Deno.exit(1);
}

if (!VOLATILE_ROOT) {
  console.error('error: VOLATILE_FILE_ROOT_PATH env is required');
  Deno.exit(1);
}

// Deno.exit above does not narrow the union for the closures below.
const volatileRoot: string = VOLATILE_ROOT;

const prefix = `${MOUNT}_nodes`;
const NODES = prefix;
const ATTRS = `${prefix}_attr`;
// A node's name lives on the parent edge, not in its attrs — `attributes->>'name'` is null for
// a rendition and silently matches nothing.
const LNK = `${prefix}_lnk`;

const bucketPath = (root: string, id: string) => join(root, id.slice(-2), id);

const humanize = (n: number) => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
};

async function main() {
  const pool = new Pool({ connectionString: POSTGRES_URL });
  const conn = await pool.connect();

  try {
    // A rendition is a file node carrying sourceId, and it is broken in one of two ways.
    //
    // No size attr means file-sync never ran on it, so its bytes were left half-written.
    //
    // A size of exactly 0 is the opposite failure and needs a different repair: the
    // converter produced nothing and file-sync recorded that faithfully, so the node is
    // self-consistent, there are no stranded bytes to remove, and the mtime heuristic below
    // does not apply.
    const { rows } = await conn.query<{ id: string; name: string | null; empty_attr: boolean }>(
      `SELECT n.id, l.name AS name, (a.attributes->>'size') = '0' AS empty_attr
         FROM ${NODES} n
         JOIN ${ATTRS} a ON a.node_id = n.id
         LEFT JOIN ${LNK} l ON l.child_id = n.id
        WHERE n.type = 'file'
          AND a.attributes->>'sourceId' IS NOT NULL
          AND (a.attributes->>'size' IS NULL OR (a.attributes->>'size') = '0')
        ORDER BY n.id`,
    );

    // A converter that died between mknode and the swap leaves its `.tmpvideo-*` /
    // `.tmpimage-*` / `.tmpaudio-*` sibling behind. Removing its bytes is this script's job;
    // removing the NODE is `regenerate --prune`'s, which already deletes anything under
    // thumbnails/ that is not in the target set and is the tested path for it. Counted below
    // so a build-up is visible rather than waiting to be discovered — and counted only among
    // the STRANDED, since a converter running right now legitimately has one.
    let leakedTemps = 0;

    let stranded = 0;
    let strandedBytes = 0;
    let live = 0;
    let empty = 0;
    let absent = 0;
    let emptyAttr = 0;

    const cutoff = Date.now() - OLDER_THAN_MIN * 60_000;
    const id2name = new Map(rows.map((r) => [r.id, r.name ?? '']));

    for (const { id, empty_attr } of rows) {
      // A node that already says `size: 0` has nothing to strand and nothing to delete —
      // the repair is to make it look absent, which for this class means clearing the attr
      // so generate-derivatives' `existingSize > 0` check regenerates it. Reported and
      // repaired here rather than in a second pass so one sweep covers both shapes.
      if (empty_attr) {
        emptyAttr++;
        console.log(`${REPAIR ? 'clearing ' : 'empty    '}  ${'0 B'.padStart(10)}  ${id}  ${id2name.get(id) ?? ''}`);
        if (REPAIR) {
          await conn.query(
            `UPDATE ${ATTRS} SET attributes = attributes - 'size' WHERE node_id = $1`,
            [id],
          );
        }
        continue;
      }

      const path = bucketPath(volatileRoot, id);
      let stat: Deno.FileInfo;
      try {
        stat = await Deno.stat(path);
      } catch {
        absent++;
        continue;
      }

      if (stat.size === 0) {
        empty++;
        continue;
      }

      // Still being written: leave it entirely alone.
      const mtime = stat.mtime?.getTime() ?? 0;
      if (mtime > cutoff) {
        live++;
        console.log(`in flight   ${humanize(stat.size).padStart(10)}  ${id}  (modified ${Math.round((Date.now() - mtime) / 1000)}s ago — skipped)`);
        continue;
      }

      stranded++;
      strandedBytes += stat.size;
      if ((id2name.get(id) ?? '').startsWith('.tmp')) leakedTemps++;
      console.log(`${REPAIR ? 'repairing' : 'stranded '}  ${humanize(stat.size).padStart(10)}  ${id}`);

      if (REPAIR) {
        // Drop the bytes only. The node stays, with no size attr, which is the
        // "absent" state generate-derivatives already regenerates from.
        await Deno.remove(path).catch(() => {});
      }
    }

    console.log('');
    console.log(`broken rendition nodes: ${rows.length}`);
    console.log(`  stranded (> ${OLDER_THAN_MIN}m old):  ${stranded}  (${humanize(strandedBytes)})${REPAIR ? ' — removed' : ''}`);
    console.log(`  in flight:              ${live}  (skipped — a converter is writing them)`);
    console.log(`  empty encode:           ${emptyAttr}  (size attr is 0)${REPAIR ? ' — size cleared' : ''}`);
    console.log(`  0-byte:                 ${empty}  (already treated as absent)`);
    console.log(`  no file at all:         ${absent}  (already treated as absent)`);
    if (leakedTemps > 0) {
      console.log('');
      console.log(`  ${leakedTemps} of these are leaked converter temps (.tmp*).`);
      console.log('  Their bytes are handled above; clear the nodes with `regenerate <path> --prune`.');
    }

    // Sources nothing can decode. A separate query because it is a different population — a
    // source node, not a rendition — and because no --repair applies to it.
    const { rows: undecodable } = await conn.query<{ id: string; name: string | null; reason: string }>(
      `SELECT n.id, l.name AS name, a.attributes->>'undecodable' AS reason
         FROM ${NODES} n
         JOIN ${ATTRS} a ON a.node_id = n.id
         LEFT JOIN ${LNK} l ON l.child_id = n.id
        WHERE n.type = 'file'
          AND a.attributes->>'sourceId' IS NULL
          AND COALESCE(a.attributes->>'undecodable', '') <> ''
        ORDER BY n.id`,
    );

    if (undecodable.length > 0) {
      console.log('');
      console.log(`undecodable sources: ${undecodable.length}  (the original itself is unreadable — no repair applies)`);
      for (const row of undecodable) {
        console.log(`  ${row.name ?? row.id}  ${row.reason}`);
      }
    }

    if ((stranded > 0 || emptyAttr > 0) && !REPAIR) {
      console.log('');
      console.log('re-run with --repair to remove the stranded bytes and clear the empty sizes.');
      console.log('a repair only makes them look absent — `regenerate` or the next crawl refills them.');
    }
  } finally {
    conn.release();
    await pool.end();
  }
}

await main();
