/**
 * Whether a photo is from before someone was born, so they cannot be in it (ein/core#1587).
 *
 * Recognition gives such a person no vote on the photo's faces, and a human moving faces onto
 * them is told and asked again. The test is deliberately one-sided: only a photo *surely* older
 * than the birth counts, so every doubt in either date — a year-only `takenAt`, an `about`, a
 * `born` only known to be before some year — widens it towards "could be".
 */
import type { Access, NodeVFS } from '@ein/client';
import { imageOfRegion } from '@archive/media/regions';

/** The years an `about` stretches a date either way, as `ageSpan` reads a person's. */
const ABOUT_YEARS = 2;

const DATE = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?/;

/** The attrs of a file that say when it was taken. */
export type TakenAttrs = { takenAt?: unknown; takenAtQualifier?: unknown };

/** The attrs of a person that say when they were born. */
export type BornAttrs = { born?: unknown; bornQualifier?: unknown };

/** The last day a capture time can name, `YYYY-MM-DD`; a month's end is written `31`, which sorts after its real last day. */
const lastDay = ({ takenAt, takenAtQualifier }: TakenAttrs): string | undefined => {
  const match = typeof takenAt === 'string' ? DATE.exec(takenAt) : null;
  if (!match) return undefined;
  if (takenAtQualifier === 'about') return `${Number(match[1]) + ABOUT_YEARS}-12-31`;
  return `${match[1]}-${match[2] ?? '12'}-${match[3] ?? '31'}`;
};

/** The first day a birth date can name, `YYYY-MM-DD`; undefined when it has no lower bound. */
const firstDay = ({ born, bornQualifier }: BornAttrs): string | undefined => {
  const match = typeof born === 'string' ? DATE.exec(born) : null;
  if (!match || bornQualifier === 'before') return undefined;
  if (bornQualifier === 'about') return `${Number(match[1]) - ABOUT_YEARS}-01-01`;
  return `${match[1]}-${match[2] ?? '01'}-${match[3] ?? '01'}`;
};

/** Whether a file was surely taken before the person was born. A photo from the day of the birth may show them. */
export const takenBeforeBirth = (taken: TakenAttrs, person: BornAttrs): boolean => {
  const last = lastDay(taken);
  const first = firstDay(person);
  return last !== undefined && first !== undefined && last < first;
};

/** A face or tag as the commands that move them hold one: its path, and the file it is on when known. */
type PlacedFace = { path: string; attrs: { fileId?: unknown } };

/**
 * Which of the faces are on files taken before the person was born, in their order. Each file is
 * read once, by id when the region names it and by the path above the region otherwise.
 */
export const facesBeforeBirth = async <F extends PlacedFace>(vfs: NodeVFS, access: Access, person: BornAttrs, faces: F[]): Promise<F[]> => {
  if (faces.length === 0 || firstDay(person) === undefined) return [];
  const ids = [...new Set(faces.map((face) => face.attrs.fileId).filter((id): id is string => typeof id === 'string' && id.length > 0))];
  const byId = ids.length > 0 ? await vfs.getNodesByIds<TakenAttrs>(access, ids) : new Map();
  const byPath = new Map<string, TakenAttrs | undefined>();
  const takenOf = async (face: F): Promise<TakenAttrs | undefined> => {
    const id = face.attrs.fileId;
    if (typeof id === 'string' && byId.has(id)) return byId.get(id)!.attrs;
    const image = imageOfRegion(face.path);
    if (!image) return undefined;
    if (!byPath.has(image)) byPath.set(image, await vfs.get<TakenAttrs>(access, image).then((node) => node.attrs, () => undefined));
    return byPath.get(image);
  };
  const out: F[] = [];
  for (const face of faces) {
    const taken = await takenOf(face);
    if (taken && takenBeforeBirth(taken, person)) out.push(face);
  }
  return out;
};

/** Which of the people were born after a file was taken: those its faces cannot be. */
export const unbornAt = async (vfs: NodeVFS, access: Access, taken: TakenAttrs, personIds: string[]): Promise<Set<string>> => {
  if (personIds.length === 0 || lastDay(taken) === undefined) return new Set();
  const people = await vfs.getNodesByIds<BornAttrs>(access, personIds);
  return new Set([...people].filter(([, node]) => takenBeforeBirth(taken, node.attrs)).map(([id]) => id));
};
