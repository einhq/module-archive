/**
 * The files the archive's nodes were made from, and the links that say so.
 *
 * A source is filed in a folder: under the node that owns it when one does (a device's
 * `routes/` holds the GPX files of its track), else under `SOURCES_ROOT/<kind>` (a GEDCOM file
 * describes many people, none of whom owns it). Every node built from a source gets a softlink to
 * it in its own `sources/`, named after the file, which may carry attrs saying what in the file
 * the node came from. The VFS re-points a softlink when the file it names moves, so the links
 * follow a renamed device or a refiled source.
 *
 * Imports only `@ein/client`, its own answer types and std, so bins and other areas can import it.
 */
import { type Command, NodeNotFoundError } from '@ein/client';
import type { SourceFile } from '@archive/sources/api';
import { encodeHex } from '@std/encoding/hex';
import { basename, dirname } from '@std/path';
import { toArrayBuffer } from '@std/streams/to-array-buffer';

type Vfs = Command['sys']['vfs'];
type Access = Command['access'];

/** The child of a node that holds its links to the files it was made from. */
export const SOURCES_DIR = 'sources';

/** The SHA-256 of `bytes`, lower-case hex, as the VFS keeps a file's `sha256`. */
export const sha256Hex = async (bytes: Uint8Array): Promise<string> => encodeHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)));

/** `name` when it is not taken, else the first free `stem-2.ext`, `stem-3.ext`, … */
export const freeName = (name: string, taken: ReadonlySet<string>): string => {
  const dot = name.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  let free = name;
  for (let n = 2; taken.has(free); n++) free = `${stem}-${n}${ext}`;
  return free;
};

/** `path` and every directory above it that is missing. */
export const ensureFolder = async (vfs: Vfs, access: Access, path: string): Promise<void> => {
  if (path === '/' || await vfs.exists(access, path)) return;
  await ensureFolder(vfs, access, dirname(path));
  await vfs.ensure(access, 'directory', dirname(path), basename(path));
};

type FileSourceOptions = {
  /** The file's SHA-256 (`sha256Hex`), which says whether the folder holds it already. */
  sha256: string;
  /** Copy the file into the folder and leave it where it is, instead of moving it. */
  copy?: boolean;
  /** The name to file it under, instead of its own. */
  name?: string;
  /** Attrs set on the filed file, such as a `mimetype` its name alone does not give. */
  attrs?: Record<string, unknown>;
};

/** Where a source was filed, and whether the folder held the same bytes already. */
type Filed = { path: string; reused: boolean };

/**
 * A new file `name` in `folder` with the bytes of the file at `from`. What was made from the file
 * there, such as the text read out of it under its `metadata`, stays with it.
 */
async function copyBytes(vfs: Vfs, access: Access, from: string, folder: string, name: string): Promise<void> {
  const source = await vfs.open(access, from, { mode: 'r' });
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await toArrayBuffer(source.readable));
  } finally {
    await source.close();
  }
  await vfs.create(access, 'file', folder, name);
  const copy = await vfs.open(access, `${folder}/${name}`, { mode: 'w' });
  try {
    await copy.write(bytes);
  } finally {
    await copy.close();
  }
}

/**
 * File the file at `from` in `folder`, made if missing: moved there (its bytes copied, with
 * `copy`) under its own name or `name`, or the first free `name-2.ext`. A file in the folder with
 * the same bytes is the source instead, and the one at `from` is removed (left, with `copy`): a
 * file brought in twice is kept once.
 */
export async function fileSource(vfs: Vfs, access: Access, from: string, folder: string, opts: FileSourceOptions): Promise<Filed> {
  await ensureFolder(vfs, access, folder);
  const held = await vfs.children(access, folder, { follow: false });
  const same = held.find((entry) => entry.node.type === 'file' && (entry.node.attrs as { sha256?: unknown }).sha256 === opts.sha256);
  if (same) {
    const path = `${folder}/${same.name}`;
    if (path !== from && !opts.copy) await vfs.unlink(access, from, dirname(from), { recursive: true });
    return { path, reused: true };
  }

  const name = freeName(opts.name ?? basename(from), new Set(held.map((entry) => entry.name)));
  if (opts.copy) await copyBytes(vfs, access, from, folder, name);
  else await vfs.rename(access, dirname(from), basename(from), folder, name, { failIfExists: true });
  const path = `${folder}/${name}`;
  if (opts.attrs) await vfs.update(access, path, { attrs: opts.attrs });
  return { path, reused: false };
}

/** One link of a node's `sources/`: its name, the file it names and what it says of it. */
type SourceLink = { name: string; linkPath: string; target: string; attrs: Record<string, unknown> };

/** The links in `node`'s `sources/`, in name order; none when it has no `sources/`. */
export async function readSources(vfs: Vfs, access: Access, node: string): Promise<SourceLink[]> {
  const dir = `${node}/${SOURCES_DIR}`;
  const entries = await vfs.children(access, dir, { follow: false }).catch(() => []);
  return entries
    .filter((entry) => entry.node.props.softlink)
    .map((entry) => ({ name: entry.name, linkPath: `${dir}/${entry.name}`, target: entry.node.props.softlink!, attrs: entry.node.attrs as Record<string, unknown> }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

const str = (value: unknown): string | undefined => typeof value === 'string' && value !== '' ? value : undefined;

/**
 * The files `node` was read from, as `source-list` and `person-info` answer them. A file that is
 * gone is listed as missing; one the caller may not read is left out.
 */
export async function sourceFiles(vfs: Vfs, access: Access, node: string): Promise<SourceFile[]> {
  const links = await readSources(vfs, access, node);
  const files = await Promise.all(links.map((link) => vfs.get(access, link.target).catch((error) => error instanceof NodeNotFoundError ? null : undefined)));
  return links.flatMap((link, i): SourceFile[] => {
    const xref = str((link.attrs.gedcom as { xref?: unknown } | undefined)?.xref);
    const file = files[i];
    if (file === undefined) return [];
    if (file === null) return [{ name: link.name, path: link.target, missing: true, ...(xref ? { xref } : {}) }];
    const attrs = file.attrs as Record<string, unknown>;
    return [{
      name: link.name,
      path: link.target,
      ...(typeof attrs.size === 'number' ? { size: attrs.size } : {}),
      ...(str(attrs.mimetype) ? { mimetype: str(attrs.mimetype) } : {}),
      ...(str(attrs.writtenAt) ? { writtenAt: str(attrs.writtenAt) } : {}),
      ...(xref ? { xref } : {}),
    }];
  });
}

/**
 * Link `source` from `node`'s `sources/`, made if missing, under the file's name or the first
 * free one. A link to it already there is kept, its attrs replaced by `attrs` when given.
 * Returns the link's path.
 */
export async function linkSource(vfs: Vfs, access: Access, node: string, source: string, attrs?: Record<string, unknown>): Promise<string> {
  const links = await readSources(vfs, access, node);
  const linked = links.find((link) => link.target === source);
  if (linked) {
    if (attrs) await vfs.update(access, linked.linkPath, { attrs, follow: false });
    return linked.linkPath;
  }
  const dir = `${node}/${SOURCES_DIR}`;
  await vfs.ensure(access, 'directory', node, SOURCES_DIR);
  const taken = new Set((await vfs.children(access, dir, { follow: false })).map((entry) => entry.name));
  const name = freeName(basename(source), taken);
  await vfs.create(access, 'softlink', dir, name, {
    props: { uid: access.uid, gid: access.gid, mode: 0o777, softlink: source },
    ...(attrs ? { attrs } : {}),
  });
  return `${dir}/${name}`;
}

/**
 * Move `from`'s source links to `to`, a link to a file `to` links already being dropped. Returns
 * how many moved.
 */
export async function moveSources(vfs: Vfs, access: Access, from: string, to: string): Promise<number> {
  const moving = await readSources(vfs, access, from);
  if (moving.length === 0) return 0;
  const held = await readSources(vfs, access, to);
  const linked = new Set(held.map((link) => link.target));
  const taken = new Set(held.map((link) => link.name));
  let moved = 0;
  for (const link of moving) {
    if (linked.has(link.target)) continue;
    await vfs.ensure(access, 'directory', to, SOURCES_DIR);
    const name = freeName(link.name, taken);
    taken.add(name);
    linked.add(link.target);
    await vfs.rename(access, `${from}/${SOURCES_DIR}`, link.name, `${to}/${SOURCES_DIR}`, name, { failIfExists: true });
    moved++;
  }
  return moved;
}
