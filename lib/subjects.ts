/**
 * The media a person, a location or a device has: what `subject-person`, `subject-location` and
 * `subject-device` answer `search --subject` with (`SubjectListing`), and what `find-within`
 * narrows the map to.
 *
 * Person and location are reverse lookups. A media file points *out* at its subjects — a `location`
 * softlink, `people/<slug>` softlinks for boxless tags, `regions/<name>` boxes carrying a
 * personId, the voices of a recording (`metadata/transcript/speakers/`) carrying one — and
 * nothing points back, so the set is assembled per query from the backlink index
 * (`vfs.findLinks`) and the personId attr index. That is the trade against denormalizing subject
 * ids onto every file: a few batched round trips, no write path to keep in sync, and nothing to
 * reindex when a person is renamed or merged (ids are what is matched, not slugs).
 *
 * A device needs no lookup: `device-link` writes its path onto each file as `devicePath`, so its
 * media is an attr equality the store answers and pages by itself, however many there are.
 *
 * The other way round, `subject-<kind> --of <file>` answers which subjects each of a set of media
 * has (`SubjectsOf`), for `search --group-by <kind>`: read from the files outwards, by id in
 * batches (`readSignals`), so it costs what the set costs, not what the archive holds.
 */

import { basename, dirname } from '@std/path';
import { toText } from '@std/streams/to-text';
import { type Command, type NodeId, parseArgs, type SubjectEntry, type SubjectListing, type SubjectsOf } from '@ein/client';
import { DEVICES_ROOT, LOCATIONS_ROOT, PEOPLE_ROOT } from '@archive/paths';
import { REGION_TYPE } from '@archive/media/regions';
import { VOICE_EMBEDDING_TYPE } from '@archive/media/speakers';
import { readSignals } from '@archive/staging/signals';

/** The `<file>/location` softlink: the manual location association. */
const LOCATION_LINK_NAME = 'location';
/** `<file>/people/<slug>` softlinks: a person in the picture, without a box. */
const PEOPLE_DIR_NAME = 'people';
/** `<file>/regions/<name>`: a box on the picture — a face or a tag — assigned via personId. */
const REGIONS_DIR_NAME = 'regions';

/**
 * Ceiling on how much of a person's or location's set is examined. It holds into the low tens of
 * thousands of media per subject; beyond that the set wants a real index.
 */
const SUBJECT_SCAN_LIMIT = 20000;

type SubjectKind = 'person' | 'location' | 'device';

const ROOTS: Record<SubjectKind, string> = { person: PEOPLE_ROOT, location: LOCATIONS_ROOT, device: DEVICES_ROOT };

/** What to try instead, when a ref names nothing: "no such location" alone sends a caller retrying spellings. */
const ADVICE: Record<SubjectKind, (ref: string) => string> = {
  person: (ref) => `find people by name with \`search --subject-name 'person:${ref}'\``,
  location: (ref) => `for a town, region or country use --bbox from \`location-region '${ref}'\``,
  device: () => 'list the devices with `device-list`',
};

/** A slug or name (`anna`) under the kind's root, or a full path (`/archive/people/anna`). */
const subjectPath = (kind: SubjectKind, ref: string): string => ref.startsWith('/') ? ref : `${ROOTS[kind]}/${ref}`;

/** The node a ref names, when it is one of `kind`. */
export const resolveSubject = async (cmd: Command, kind: SubjectKind, ref: string): Promise<{ path: string; id: NodeId }> => {
  const path = subjectPath(kind, ref);
  const node = await cmd.sys.vfs.get(cmd.access, path);
  if (node.type !== kind) throw new Error(`${path} is a ${node.type}, not a ${kind}`);
  return { path, id: node.id };
};

/**
 * The ids of the media files a person is in or a location is linked to. `truncated` when a source
 * reached `SUBJECT_SCAN_LIMIT`, so the set is only a prefix.
 */
export const subjectMediaIds = async (
  cmd: Command,
  kind: 'person' | 'location',
  subject: { path: string; id: NodeId },
): Promise<{ ids: Set<NodeId>; truncated: boolean }> => {
  const vfs = cmd.sys.vfs;
  // `SEARCH_TRACE=1` prints where a subject set's time goes, on stderr; the phases below are
  // each one registry round trip over the whole set, and which one costs is not guessable.
  const trace = cmd.env.SEARCH_TRACE ? (label: string, since: number) => cmd.writeError(`subject ${subject.path}: ${label} ${Date.now() - since}ms\n`) : undefined;
  let phase = Date.now();

  const fileIds = new Set<NodeId>();
  /** `<file>/people` and `<file>/regions` directories, one level below the file. */
  const holderDirs = new Set<NodeId>();

  // Read one beyond the ceiling so a complete index never silently claims that
  // an exactly-full source is the whole answer.
  const links = await vfs.findLinks(cmd.access, subject.path, SUBJECT_SCAN_LIMIT + 1);
  let truncated = links.length > SUBJECT_SCAN_LIMIT;
  await trace?.(`findLinks ${links.length}`, phase);
  phase = Date.now();

  for (const link of links.slice(0, SUBJECT_SCAN_LIMIT)) {
    if (kind === 'location') {
      // `<file>/location` — the link's parent is the file itself. Anything else
      // pointing at this location (a resident relation, a label) is not media.
      if (basename(link.absPath) === LOCATION_LINK_NAME) fileIds.add(link.parentId);
      continue;
    }

    // `<file>/people/<slug>` — one level deeper, so the file is the parent of
    // the parent. Deliberately not `<file>/photographer`: that is who held the
    // camera, not who is in the picture.
    if (basename(dirname(link.absPath)) === PEOPLE_DIR_NAME) holderDirs.add(link.parentId);
  }

  if (kind === 'person') {
    const faces = await vfs.query(cmd.access, {
      types: [REGION_TYPE],
      where: [{ ref: 'personId', op: 'eq', value: subject.id }],
      limit: SUBJECT_SCAN_LIMIT + 1,
    });
    truncated ||= faces.length > SUBJECT_SCAN_LIMIT;
    await trace?.(`faces query ${faces.length}`, phase);
    phase = Date.now();

    // A query row carries the region's own id, not its parent's, so regions need
    // one extra round to reach their `regions/` directory. Parent links, not
    // paths: this only asks *which* directory, and building a path per region
    // costs far more than the parent lookup.
    if (faces.length > 0) {
      const parents = await vfs.getParentLinksByIds(cmd.access, faces.slice(0, SUBJECT_SCAN_LIMIT).map((face) => face.id));
      for (const parentLinks of parents.values()) {
        for (const link of parentLinks) holderDirs.add(link.parentId);
      }
      await trace?.(`face parents ${faces.length}`, phase);
      phase = Date.now();
    }

    // Recordings the person is heard in. A voice names its recording (`fileId`), so this costs
    // the one query.
    const voices = await vfs.query(cmd.access, {
      types: ['embedding'],
      where: [{ ref: 'embeddingType', op: 'eq', value: VOICE_EMBEDDING_TYPE }, { ref: 'personId', op: 'eq', value: subject.id }],
      limit: SUBJECT_SCAN_LIMIT + 1,
    });
    truncated ||= voices.length > SUBJECT_SCAN_LIMIT;
    for (const voice of voices.slice(0, SUBJECT_SCAN_LIMIT)) {
      const fileId = (voice.node.attrs as { fileId?: unknown }).fileId;
      if (typeof fileId === 'string' && fileId) fileIds.add(fileId);
    }
    await trace?.(`voices query ${voices.length}`, phase);
    phase = Date.now();
  }

  // Which file holds each directory, and under what name — `people/` and
  // `regions/` count, anything else (a region hung somewhere odd) does not.
  if (holderDirs.size > 0) {
    const dirLinks = await vfs.getParentLinksByIds(cmd.access, [...holderDirs]);
    for (const parentLinks of dirLinks.values()) {
      for (const link of parentLinks) {
        if (link.name === PEOPLE_DIR_NAME || link.name === REGIONS_DIR_NAME) fileIds.add(link.parentId);
      }
    }
  }
  await trace?.(`holders ${holderDirs.size} → ${fileIds.size} files`, phase);
  return { ids: fileIds, truncated };
};

/** One ref, answered the way `search` asks a subject command (`SubjectEntry`). */
const subjectEntry = async (cmd: Command, kind: SubjectKind, ref: string): Promise<SubjectEntry> => {
  let subject;
  try {
    subject = await resolveSubject(cmd, kind, ref);
  } catch {
    return { ref, error: `no such ${kind}: ${ref}; ${ADVICE[kind](ref)}` };
  }
  if (kind === 'device') return { ref, path: subject.path, match: { attr: 'devicePath', value: subject.path } };

  const { ids, truncated } = await subjectMediaIds(cmd, kind, subject);
  return { ref, path: subject.path, ids: [...ids], ...(truncated ? { truncated } : {}) };
};

/** Ids per batched lookup in `subjectsOfMedia`. */
const IDS_PER_CALL = 1000;

const chunks = <T>(items: T[]): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += IDS_PER_CALL) out.push(items.slice(i, i + IDS_PER_CALL));
  return out;
};

/** What a subject node is called: its name, else its display name, else its slug. */
const nameOf = (path: string, attrs: Record<string, unknown> | undefined): string => {
  for (const key of ['name', 'displayName']) {
    const value = attrs?.[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return basename(path).replaceAll('_', ' ');
};

/** The person ids each of `ids` is heard in: the voices of a recording name their person and their file. */
const voicesOf = async (cmd: Command, ids: NodeId[]): Promise<Map<NodeId, NodeId[]>> => {
  const heard = new Map<NodeId, NodeId[]>();
  for (const page of chunks(ids)) {
    const voices = await cmd.sys.vfs.query(cmd.access, {
      types: ['embedding'],
      where: [{ ref: 'embeddingType', op: 'eq', value: VOICE_EMBEDDING_TYPE }, { ref: 'fileId', op: 'in', value: page }],
      limit: SUBJECT_SCAN_LIMIT,
    });
    for (const voice of voices) {
      const { fileId, personId } = voice.node.attrs as { fileId?: unknown; personId?: unknown };
      if (typeof fileId === 'string' && typeof personId === 'string' && personId) heard.set(fileId, [...heard.get(fileId) ?? [], personId]);
    }
  }
  return heard;
};

/**
 * The subjects of `kind` each of `ids` (media files) has: the people its faces, tags and voices
 * name, the location it is linked to, the device that took it. A person is named only directly
 * under the people root; one further down is a group of faces nobody has named yet, and comes
 * without a name. Subjects the reader cannot read are left out.
 */
const subjectsOfMedia = async (cmd: Command, kind: SubjectKind, ids: NodeId[]): Promise<SubjectsOf> => {
  const vfs = cmd.sys.vfs;
  /** Media id -> the paths of its subjects. */
  const has = new Map<NodeId, Set<string>>();
  const add = (media: NodeId, path: string) => has.set(media, (has.get(media) ?? new Set()).add(path));
  /** Subject path -> its name, or undefined for one nobody has named. */
  const names = new Map<string, string | undefined>();

  if (kind === 'device') {
    for (const page of chunks(ids)) {
      for (const node of (await vfs.getNodesByIds(cmd.access, page)).values()) {
        if (typeof node.attrs.devicePath === 'string') add(node.id, node.attrs.devicePath);
      }
    }
  } else if (kind === 'location') {
    for (const [media, signal] of await readSignals(vfs, cmd.access, ids)) if (signal.location) add(media, signal.location);
  } else {
    const [signals, voices] = await Promise.all([readSignals(vfs, cmd.access, ids), voicesOf(cmd, ids)]);
    const personsOf = new Map<NodeId, NodeId[]>();
    for (const [media, signal] of signals) personsOf.set(media, [...signal.persons, ...voices.get(media) ?? []]);
    const personIds = [...new Set([...personsOf.values()].flat())];
    const pathOf = new Map<NodeId, string>();
    for (const page of chunks(personIds)) {
      const [paths, nodes] = await Promise.all([vfs.resolveIdPaths(cmd.access, page), vfs.getNodesByIds(cmd.access, page)]);
      for (const [id, found] of paths) {
        const named = found.find((path) => dirname(path) === PEOPLE_ROOT);
        const path = named ?? found[0];
        if (!path) continue;
        pathOf.set(id, path);
        names.set(path, named ? nameOf(named, nodes.get(id)?.attrs) : undefined);
      }
    }
    for (const [media, persons] of personsOf) {
      for (const person of persons) {
        const path = pathOf.get(person);
        if (path) add(media, path);
      }
    }
  }

  // A location or a device is named by its node, read once each.
  const unread = [...new Set([...has.values()].flatMap((paths) => [...paths]))].filter((path) => !names.has(path));
  const read = await Promise.all(unread.map((path) => vfs.get(cmd.access, path).then((node) => node.attrs as Record<string, unknown>, () => null)));
  const unreadable = new Set<string>();
  unread.forEach((path, index) => read[index] ? names.set(path, nameOf(path, read[index]!)) : unreadable.add(path));

  const subjects: SubjectsOf['subjects'] = [];
  const indexOf = new Map<string, number>();
  const media: SubjectsOf['media'] = {};
  for (const [id, paths] of has) {
    const indexes: number[] = [];
    for (const path of paths) {
      if (unreadable.has(path)) continue;
      let index = indexOf.get(path);
      if (index === undefined) {
        const name = names.get(path);
        index = subjects.push(name ? { path, name } : { path }) - 1;
        indexOf.set(path, index);
      }
      indexes.push(index);
    }
    if (indexes.length > 0) media[id] = indexes;
  }
  return { subjects, media };
};

/** The media ids in the file `--of` names: a JSON array, as `search` writes it. */
const readIds = async (cmd: Command, path: string): Promise<NodeId[]> => {
  const handle = await cmd.sys.vfs.open(cmd.access, path, { mode: 'r' });
  try {
    const ids = JSON.parse(await toText(handle.readable));
    if (!Array.isArray(ids)) throw new Error('not a JSON array');
    return ids.filter((id): id is string => typeof id === 'string');
  } finally {
    await handle.close();
  }
};

/**
 * `subject-<kind> <ref>...`: one `SubjectEntry` per ref under `JSON_OUTPUT=1`, a line per ref
 * otherwise. Exits 0 when a ref resolves to nothing — its entry says why — so one stale ref among
 * the matches of a name does not sink the others. `subject-<kind> --of <file>` answers the
 * subjects of the media ids in the file instead (`SubjectsOf`).
 */
export const runSubjectCommand = async (cmd: Command, kind: SubjectKind): Promise<number> => {
  const flags = parseArgs(cmd.args, { string: ['of'] });
  if (flags.of !== undefined) {
    let answer: SubjectsOf;
    try {
      answer = await subjectsOfMedia(cmd, kind, await readIds(cmd, flags.of));
    } catch (error) {
      await cmd.writeError(`subject-${kind}: cannot read --of ${flags.of}: ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
    if (cmd.json) {
      await cmd.writeJSON(answer satisfies SubjectsOf);
      return 0;
    }
    const counts = new Map<number, number>();
    for (const indexes of Object.values(answer.media)) for (const index of indexes) counts.set(index, (counts.get(index) ?? 0) + 1);
    for (const [index, subject] of answer.subjects.entries()) {
      await cmd.writeLn(`${String(counts.get(index) ?? 0).padStart(6)}  ${subject.path}${subject.name ? `  ${subject.name}` : ''}`);
    }
    return 0;
  }

  const refs = flags._.map(String).filter((arg) => arg !== '');
  if (refs.length === 0) {
    await cmd.writeError(`subject-${kind}: expected a ${kind} slug or path\n`);
    return 1;
  }
  const subjects: SubjectEntry[] = [];
  for (const ref of refs) subjects.push(await subjectEntry(cmd, kind, ref));
  if (cmd.json) {
    await cmd.writeJSON({ subjects } satisfies SubjectListing);
    return 0;
  }
  for (const entry of subjects) {
    if (entry.error) await cmd.writeError(`subject-${kind}: ${entry.error}\n`);
    else if (entry.match) await cmd.writeLn(`${entry.path}  ${entry.match.attr}=${entry.match.value}`);
    else await cmd.writeLn(`${entry.path}  ${entry.ids?.length ?? 0} media${entry.truncated ? ' (truncated)' : ''}`);
  }
  return 0;
};
