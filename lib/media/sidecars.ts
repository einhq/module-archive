/**
 * Paired sidecars: a Takeout JSON or an XMP file moved under the file it describes, as
 * `<file>/sidecar`, which the file's time and place are then read from (`@archive/media/sidecars`).
 *
 * A paired sidecar is a file node carrying `sourceId` (the file's id) and `sidecar`
 * (`MediaSidecar`), or a softlink to one: an edited copy and a Live Photo's video share their
 * original's. `sourceId` makes it a derived file, which no pipeline indexes and no subtree query
 * of originals lists. A Takeout album folder's `metadata.json` stays where it is, its `sourceId`
 * the folder's id, and gives the folder its `title` and `description`.
 *
 * `pairSidecars` finds the unpaired sidecars within a folder, pairs each by its rules
 * (`@archive/media/takeout`, `@archive/media/xmp`) with a file beside it, and carries over what
 * a person said: a caption becomes the file's description where it has none, and a Google Photos
 * favourite a star for the owner of the inbox it is staged in. A file already indexed is dated
 * again and given the sidecar's place where it has none.
 */

import type { Command, Node, NodeChild } from '@ein/client';
import { shq } from '@ein/client';
import { homePath } from '@ein/paths';
import { encodeBase64 } from '@std/encoding/base64';
import type { MediaSidecar, MediaSidecarsAnswer, TakeoutAlbumSidecar, TakeoutSidecar, XmpSidecar } from '@archive/media/api';
import { SIDECAR_CHILD, SIDECAR_MIMETYPES, sidecarPoint, writePosition } from '@archive/media/paired-sidecar';
import { matchTakeout, parseTakeoutJson } from '@archive/media/takeout';
import { matchXmp, parseXmp } from '@archive/media/xmp';
import { applyFileTime } from '@archive/media/resolve-time';
import { POSITION_CHILD } from '@archive/location/location-link';
import { parseStagedPath } from '@archive/staging/paths';

type Vfs = Command['sys']['vfs'];
type Access = Command['access'];

/** A body larger than this is no sidecar, and is not read. */
const MAX_SIDECAR_BYTES = 64 * 1024;

/** Rows per page of the query and the folder listings. */
const PAGE = 1000;

/** Unmatched sidecars named in an answer at most. */
const UNMATCHED_SHOWN = 50;

/** Where a user's stars are: softlinks, one per starred node. */
const STARS_DIR = 'stars';

const MEDIA = /^(image|video|audio)\//;

/** The body of a small file as text. */
const readBody = async (vfs: Vfs, access: Access, path: string): Promise<string> => {
  const handle = await vfs.open(access, path, { mode: 'r' });
  try {
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (total <= MAX_SIDECAR_BYTES) {
      const chunk = await handle.read(MAX_SIDECAR_BYTES + 1 - total);
      if (chunk.length === 0) break;
      chunks.push(chunk);
      total += chunk.length;
    }
    const body = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.length;
    }
    return new TextDecoder().decode(body);
  } finally {
    await handle.close();
  }
};

/** An unpaired sidecar as found: where it is, and what it says once read. */
type Found = { id: string; path: string; name: string; folder: string; sha256?: string; read?: TakeoutSidecar | TakeoutAlbumSidecar | XmpSidecar };

/** A file of a folder that a sidecar may pair with. */
type Medium = { id: string; name: string; path: string; attrs: Record<string, unknown>; props: Node['props']; children: NodeChild[] };

/** Every unpaired sidecar within `root`, a page at a time. */
const findUnpaired = async (vfs: Vfs, access: Access, root: string): Promise<Found[]> => {
  const found: Found[] = [];
  let after: { value: string | null; id: string } | undefined;
  while (true) {
    const page = await vfs.query(access, {
      within: root,
      types: ['file'],
      where: [{ ref: 'mimetype', op: 'in', value: SIDECAR_MIMETYPES }, { ref: 'sourceId', op: 'missing' }, { ref: 'sidecar', op: 'missing' }],
      ...(after ? { after } : {}),
      limit: PAGE,
    });
    for (const row of page) {
      const slash = row.absPath.lastIndexOf('/');
      const attrs = row.node.attrs as Record<string, unknown>;
      found.push({
        id: row.id,
        path: row.absPath,
        name: row.absPath.slice(slash + 1),
        folder: row.absPath.slice(0, slash),
        ...(typeof attrs.sha256 === 'string' ? { sha256: attrs.sha256 } : {}),
      });
    }
    if (page.length < PAGE) return found;
    after = { value: null, id: page[page.length - 1].id };
  }
};

/** The media files directly in `folder`, each with its own child edges. */
const readMedia = async (vfs: Vfs, access: Access, folder: string): Promise<Medium[]> => {
  const media: Medium[] = [];
  let after: string | undefined;
  while (true) {
    const page = await vfs.children(access, folder, { types: ['file'], childLinks: true, page: { limit: PAGE, ...(after !== undefined ? { after } : {}) } });
    for (const entry of page) {
      const attrs = entry.node.attrs as Record<string, unknown>;
      if (attrs.sourceId || !MEDIA.test(String(attrs.mimetype ?? ''))) continue;
      media.push({ id: entry.node.id, name: entry.name, path: `${folder}/${entry.name}`, attrs, props: entry.node.props, children: entry.children ?? [] });
    }
    if (page.length < PAGE) return media;
    after = page[page.length - 1].name;
  }
};

/** Star `paths` for `user`, as `star` does for its caller: a softlink each in their `stars/`, owned by them. */
const starFor = async (vfs: Vfs, access: Access, user: string, paths: string[], dryRun: boolean): Promise<number> => {
  const home = homePath(user);
  const dir = `${home}/${STARS_DIR}`;
  const existing = await vfs.children(access, dir, { follow: false }).catch(() => []);
  const starred = new Set(existing.flatMap((entry) => entry.node.props.softlink ? [entry.node.props.softlink] : []));
  const fresh = [...new Set(paths)].filter((path) => !starred.has(path));
  if (fresh.length === 0 || dryRun) return fresh.length;
  const owner = (await vfs.get(access, home)).props;
  await vfs.ensure(access, 'directory', home, STARS_DIR, { props: { uid: owner.uid, gid: owner.gid, mode: 0o755 } });
  const used = new Set(existing.map((entry) => entry.name));
  const names = fresh.map((path) => {
    const base = path.slice(path.lastIndexOf('/') + 1);
    let name = base;
    for (let n = 2; used.has(name); n++) name = `${base}-${n}`;
    used.add(name);
    return name;
  });
  await vfs.createTree(access, dir, fresh.map((path, i) => ({ type: 'softlink', name: names[i], props: { uid: owner.uid, gid: owner.gid, mode: 0o777, softlink: path } })));
  return fresh.length;
};

const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');

/**
 * Pair the unpaired sidecars within `root` with the files beside them, or with `dryRun` count
 * what that would do. Idempotent: a paired sidecar carries `sourceId` and is not found again.
 */
export const pairSidecars = async (cmd: Command, root: string, dryRun: boolean): Promise<MediaSidecarsAnswer> => {
  const vfs = cmd.sys.vfs;
  const access = cmd.access;
  const answer: MediaSidecarsAnswer = {
    ok: true,
    path: root,
    dryRun,
    found: 0,
    paired: 0,
    shared: 0,
    albums: 0,
    duplicates: 0,
    unmatched: 0,
    unmatchedPaths: [],
    other: 0,
    described: 0,
    starred: 0,
    retimed: 0,
    positioned: 0,
    failed: [],
  };
  const unpaired = await findUnpaired(vfs, access, root);
  answer.found = unpaired.length;
  const byFolder = new Map<string, Found[]>();
  for (const sidecar of unpaired) byFolder.set(sidecar.folder, [...byFolder.get(sidecar.folder) ?? [], sidecar]);

  const unmatched: string[] = [];
  /** Favourites to star, by the inbox owner they are staged for. */
  const stars = new Map<string, string[]>();
  /** Files whose sidecar was paired or shared, with it. */
  const touched: { medium: Medium; sidecar: TakeoutSidecar | XmpSidecar; shared?: true }[] = [];

  for (const [folder, sidecars] of [...byFolder].sort(([a], [b]) => a < b ? -1 : 1)) {
    for (const sidecar of sidecars) {
      const size = Number((await vfs.get(access, sidecar.path).catch(() => undefined))?.attrs.size ?? 0);
      if (size > MAX_SIDECAR_BYTES || size === 0) continue;
      const body = await readBody(vfs, access, sidecar.path).catch(() => '');
      sidecar.read = /\.xmp$/i.test(sidecar.name) ? parseXmp(body) : parseTakeoutJson(body);
    }
    const media = await readMedia(vfs, access, folder);
    const mediumOf = new Map(media.map((medium) => [medium.name, medium]));
    const takeouts = sidecars.filter((sidecar) => sidecar.read?.kind === 'takeout');
    const xmps = sidecars.filter((sidecar) => sidecar.read?.kind === 'xmp');
    const albums = sidecars.filter((sidecar) => sidecar.read?.kind === 'takeout-album');
    answer.other += sidecars.filter((sidecar) => !sidecar.read).length;

    const takeoutMatch = matchTakeout(takeouts.map((sidecar) => ({ name: sidecar.name, title: (sidecar.read as TakeoutSidecar).title })), media.map((medium) => medium.name));
    // A file takes one sidecar: what a Takeout JSON claimed is not an XMP packet's to claim.
    const xmpMatch = matchXmp(
      xmps.map((sidecar) => sidecar.name),
      media.filter((medium) => ![...takeoutMatch.paired.values()].includes(medium.name)).map((medium) => ({
        name: medium.name,
        mimetype: String(medium.attrs.mimetype ?? ''),
      })),
    );
    const pairs = [...takeoutMatch.paired, ...xmpMatch].map(([name, target]) => ({ sidecar: sidecars.find((each) => each.name === name)!, medium: mediumOf.get(target)! }));

    // A file that has a sidecar already keeps it: a second copy of the same bytes goes, another stays unmatched.
    const heldIds = pairs.flatMap(({ medium }) => medium.children.filter((child) => child.name === SIDECAR_CHILD).map((child) => child.id));
    const held = heldIds.length > 0 ? await vfs.getNodesByIds(access, heldIds) : new Map<string, Node>();
    const moves: typeof pairs = [];
    const duplicates: string[] = [];
    for (const pair of pairs) {
      const existing = pair.medium.children.find((child) => child.name === SIDECAR_CHILD);
      if (!existing) moves.push(pair);
      else if (pair.sidecar.sha256 !== undefined && held.get(existing.id)?.attrs.sha256 === pair.sidecar.sha256) duplicates.push(pair.sidecar.path);
      else unmatched.push(pair.sidecar.path);
    }
    const pairedNames = new Set([...takeoutMatch.paired.keys(), ...xmpMatch.keys()]);
    for (const sidecar of [...takeouts, ...xmps]) if (!pairedNames.has(sidecar.name)) unmatched.push(sidecar.path);
    answer.duplicates += duplicates.length;

    const moved = new Set<string>();
    if (dryRun) {
      for (const pair of moves) moved.add(pair.sidecar.path);
    } else if (moves.length > 0) {
      // Marked before they move, so nothing ever sees an unmarked sidecar under a file.
      const pairedAt = nowIso();
      await vfs.updateEach(
        access,
        moves.map(({ sidecar, medium }) => ({ ref: sidecar.path, attrs: { sidecar: { ...sidecar.read!, pairedAt } satisfies MediaSidecar, sourceId: medium.id } })),
      );
      const outcomes = await vfs.renameMany(access, moves.map(({ sidecar, medium }) => ({ from: sidecar.path, to: `${medium.path}/${SIDECAR_CHILD}` })), {
        failIfExists: true,
        relink: false,
      });
      const refused = moves.filter((_, i) => outcomes[i].status === 'rejected');
      outcomes.forEach((outcome, i) => {
        if (outcome.status === 'fulfilled') moved.add(moves[i].sidecar.path);
        else answer.failed.push({ path: moves[i].sidecar.path, error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason) });
      });
      if (refused.length > 0) await vfs.updateEach(access, refused.map(({ sidecar }) => ({ ref: sidecar.path, attrs: { sidecar: null, sourceId: null } })));
    }
    if (!dryRun && duplicates.length > 0) await vfs.unlinkMany(access, duplicates);
    answer.paired += moved.size;

    const pairedMedia = moves.filter(({ sidecar }) => moved.has(sidecar.path));
    for (const { sidecar, medium } of pairedMedia) touched.push({ medium, sidecar: sidecar.read as TakeoutSidecar | XmpSidecar });

    // An edited copy and a Live Photo's video share their original's sidecar, by a softlink to it.
    const original = new Map(pairedMedia.map(({ sidecar, medium }) => [sidecar.name, medium]));
    const sharing = [...takeoutMatch.shared].flatMap(([name, sidecarName]) => {
      const medium = mediumOf.get(name)!;
      const from = original.get(sidecarName);
      return from && !medium.children.some((child) => child.name === SIDECAR_CHILD) ? [{ medium, from, sidecar: takeouts.find((each) => each.name === sidecarName)! }] : [];
    });
    for (const { medium, from, sidecar } of sharing) {
      if (!dryRun) {
        await vfs.create(access, 'softlink', medium.path, SIDECAR_CHILD, {
          props: { uid: medium.props.uid, gid: medium.props.gid, mode: 0o777, softlink: `${from.path}/${SIDECAR_CHILD}` },
        });
      }
      touched.push({ medium, sidecar: sidecar.read as TakeoutSidecar, shared: true });
    }
    answer.shared += sharing.length;

    // An album's metadata names its folder; the first of several is believed.
    const album = albums.toSorted((a, b) => a.name < b.name ? -1 : 1)[0];
    if (album) {
      const read = album.read as TakeoutAlbumSidecar;
      if (!dryRun) {
        const node = await vfs.get(access, folder);
        const attrs = node.attrs as Record<string, unknown>;
        if (attrs.title !== read.title || (attrs.description ?? undefined) !== read.description) {
          await vfs.update(access, folder, { attrs: { title: read.title, description: read.description ?? null } });
        }
        const pairedAt = nowIso();
        await vfs.updateEach(access, albums.map((each) => ({ ref: each.path, attrs: { sidecar: { ...each.read!, pairedAt } satisfies MediaSidecar, sourceId: node.id } })));
      }
      answer.albums += 1;
    }
  }

  answer.unmatched = unmatched.length;
  answer.unmatchedPaths = unmatched.sort().slice(0, UNMATCHED_SHOWN);

  for (const { medium, sidecar, shared } of touched) {
    // A caption becomes the description where the file has none: a person wrote both.
    const caption = sidecar.description;
    if (caption && !medium.attrs.description) {
      answer.described++;
      if (!dryRun) {
        const result = await cmd.execute(`file-set-description ${shq(medium.path)} --text-base64 ${encodeBase64(new TextEncoder().encode(caption))}`);
        if (result.code !== 0) answer.failed.push({ path: medium.path, error: result.stderr.trim() || 'file-set-description failed' });
      }
    }
    const owner = parseStagedPath(medium.path);
    // The favourite was the file the JSON was written for, not the copies sharing it.
    if (sidecar.kind === 'takeout' && sidecar.favorited && !shared && owner?.area === 'files') stars.set(owner.user, [...stars.get(owner.user) ?? [], medium.path]);
  }
  for (const [user, paths] of stars) answer.starred += await starFor(vfs, access, user, paths, dryRun);

  // What is indexed already is dated again, and placed where it has no place of its own.
  for (const { medium, sidecar } of touched) {
    if (typeof medium.attrs.indexedAt !== 'string') continue;
    answer.retimed++;
    const point = sidecarPoint({ ...sidecar, pairedAt: '' }, medium.attrs.digitized === true);
    const placed = medium.children.some((child) => child.name === POSITION_CHILD) || medium.attrs.positionManual !== undefined;
    if (point && !placed) answer.positioned++;
    if (dryRun) continue;
    try {
      await applyFileTime(cmd, medium.path);
      if (point && !placed) await writePosition(vfs, access, medium.path, point);
    } catch (error) {
      answer.failed.push({ path: medium.path, error: error instanceof Error ? error.message : String(error) });
    }
  }

  answer.ok = answer.failed.length === 0;
  return answer;
};
