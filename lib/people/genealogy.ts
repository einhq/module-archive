/**
 * Genealogy graph + kinship engine of the archive's people area.
 *
 * Relationships are softlink pairs under a person's parents/ children/ partners/
 * directories, each link carrying attrs.relation = { peerLink, kind?, from?, to? }.
 * The core relations-guard service removes the peer on delete (it keys off
 * peerLink). Role (mother/father) is derived from the parent's `gender` attr at
 * compute time, which lets Swedish distinguish farmor vs mormor.
 *
 * Imported by the #!ts bins via the @archive/people/genealogy alias (a bin
 * copied to /tmp cannot use relative imports,
 * but the import map resolves the alias to this file, whose own relative imports
 * resolve normally).
 */

import type { Command } from '@ein/client';
import { basename, dirname } from '@std/path';
import type { PersonAttrs, PersonGender } from '@archive/people/types';

// Derive the concrete vfs/access types from the Command surface so the module
// does not import core internals directly.
export type Vfs = Command['sys']['vfs'];
export type Access = Command['access'];

export const PARENTS_DIR = 'parents';
export const CHILDREN_DIR = 'children';
export const PARTNERS_DIR = 'partners';

const NODE_TYPE_DIRECTORY = 'directory';
const NODE_TYPE_SOFTLINK = 'softlink';
const MAX_DEPTH = 30;

export type RelationAttrs = {
  relation?: {
    peerLink: string;
    /** non-blood parent tie (adoptive|step|foster) or partner kind (married); unset ⇒ blood/partner */
    kind?: string;
    /** partnership start (ISO) */
    from?: string;
    /** partnership end (ISO) */
    to?: string;
  };
};

// ---------- dates ----------

/**
 * Accept YYYY, YYYY-MM or YYYY-MM-DD, with or without a time of day after it: a stored
 * `born` may carry the birth time (`2018-04-18T10:34`).
 */
export const validDate = (d: string): boolean => /^\d{4}(-\d{2}(-\d{2})?)?(T.*)?$/.test(d);

/** The calendar part of a date, without any time of day. */
export const datePart = (d: string): string => d.split('T')[0];

/** Normalise a partial date to a comparable YYYY-MM-DD string. */
export const comparableDate = (d: string): string => {
  const [y, m = '01', day = '01'] = datePart(d).split('-');
  return `${y}-${m}-${day}`;
};

/**
 * Completed years between a (possibly partial) birth date and a moment.
 * `approx` marks a birth date without a day, where the result can be off by
 * one. Returns null for an invalid birth date, an unparseable moment or a
 * moment before the birth.
 */
export const ageAt = (born: string, at: string | Date | number): { years: number; approx: boolean } | null => {
  if (!born || !validDate(born)) return null;

  const when = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(when.getTime())) return null;

  const [y, m, d] = comparableDate(born).split('-').map(Number);
  let years = when.getFullYear() - y;
  const month = when.getMonth() + 1;
  if (month < m || (month === m && when.getDate() < d)) years--;

  if (years < 0) return null;
  return { years, approx: datePart(born).length < 10 };
};

/** Completed months, used where completed years would flatten an infant to zero. */
export const ageMonthsAt = (born: string, at: string | Date | number): { months: number; approx: boolean } | null => {
  if (!born || !validDate(born)) return null;

  const when = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(when.getTime())) return null;

  const [year, month, day] = comparableDate(born).split('-').map(Number);
  let months = (when.getFullYear() - year) * 12 + (when.getMonth() + 1 - month);
  if (when.getDate() < day) months--;

  if (months < 0) return null;
  return { months, approx: datePart(born).length < 10 };
};

// ---------- relation pairs ----------

type RelationPairSpec = {
  aLink: string;
  aTarget: string;
  bLink: string;
  bTarget: string;
  kind?: string;
  from?: string;
  to?: string;
  /**
   * Extra attrs for the a-side link only. Residence uses it to carry the
   * indexable projection of the span on one half of the pair.
   */
  aAttrs?: Record<string, unknown>;
};

const relationAttrs = (peerLink: string, extra: Pick<RelationPairSpec, 'kind' | 'from' | 'to'>): RelationAttrs => {
  const relation: NonNullable<RelationAttrs['relation']> = { peerLink };
  if (extra.kind !== undefined) relation.kind = extra.kind;
  if (extra.from !== undefined) relation.from = extra.from;
  if (extra.to !== undefined) relation.to = extra.to;
  return { relation };
};

const ensureDir = async (vfs: Vfs, access: Access, dir: string): Promise<void> => {
  await vfs.ensure(access, NODE_TYPE_DIRECTORY, dirname(dir), basename(dir));
};

/** Create both halves of a relation. The peer is auto-removed on delete by relations-guard. */
export const createRelationPair = async (vfs: Vfs, access: Access, spec: RelationPairSpec): Promise<void> => {
  const aDir = dirname(spec.aLink);
  const bDir = dirname(spec.bLink);
  await ensureDir(vfs, access, aDir);
  await ensureDir(vfs, access, bDir);
  await vfs.create(access, NODE_TYPE_SOFTLINK, aDir, basename(spec.aLink), {
    props: { uid: access.uid, gid: access.gid, mode: 0o777, softlink: spec.aTarget },
    attrs: { ...relationAttrs(spec.bLink, spec), ...spec.aAttrs },
  });
  await vfs.create(access, NODE_TYPE_SOFTLINK, bDir, basename(spec.bLink), {
    props: { uid: access.uid, gid: access.gid, mode: 0o777, softlink: spec.bTarget },
    attrs: relationAttrs(spec.aLink, spec),
  });
};

/**
 * Rewrite the span of a relation pair that already exists, on both halves.
 *
 * The span given *is* the new one: an omitted end clears whatever was there.
 * `relation` is one attr, so writing it replaces the object wholesale — which is
 * what makes a cleared date actually clear — and anything else it carries (a
 * `kind`) is spread back in. A missing peer is left for the checks to report.
 */
export const updateRelationSpan = async (vfs: Vfs, access: Access, linkPath: string, span: { from?: string; to?: string }): Promise<void> => {
  const node = await vfs.get<RelationAttrs>(access, linkPath, { follow: false });
  const peerLink = node.attrs.relation?.peerLink;
  if (!peerLink) throw new Error(`${linkPath}: not a relation link`);

  const { from: _from, to: _to, ...rest } = node.attrs.relation!;
  const relation = { ...rest, ...(span.from ? { from: span.from } : {}), ...(span.to ? { to: span.to } : {}) };
  await vfs.update(access, linkPath, { follow: false, attrs: { relation } });

  if (await vfs.exists(access, peerLink, { follow: false })) {
    await vfs.update(access, peerLink, { follow: false, attrs: { relation: { ...relation, peerLink: linkPath } } });
  }
};

/** Remove a relation link and its peer (idempotent on the peer). */
export const removeRelationPair = async (vfs: Vfs, access: Access, linkPath: string): Promise<void> => {
  const node = await vfs.get<RelationAttrs>(access, linkPath, { follow: false });
  const peerLink = node.attrs.relation?.peerLink;
  if (!peerLink) throw new Error(`${linkPath}: not a relation link`);
  await vfs.unlink(access, linkPath, dirname(linkPath), { readlink: true });
  try {
    await vfs.unlink(access, peerLink, dirname(peerLink), { readlink: true });
  } catch {
    // peer already gone (guard may have raced us)
  }
};

export type RelationEntry = {
  name: string;
  linkPath: string;
  target: string;
  kind?: string;
  from?: string;
  to?: string;
};

/** Read one relation dir (parents/children/partners); [] if absent. */
export const readRelationDir = async (vfs: Vfs, access: Access, person: string, dir: string): Promise<RelationEntry[]> => {
  const dirPath = `${person}/${dir}`;
  try {
    const children = await vfs.children<RelationAttrs>(access, dirPath, { follow: false });
    return children.map((c) => ({
      name: c.name,
      linkPath: `${dirPath}/${c.name}`,
      target: c.node.props.softlink ?? '',
      kind: c.node.attrs.relation?.kind,
      from: c.node.attrs.relation?.from,
      to: c.node.attrs.relation?.to,
    }));
  } catch {
    return [];
  }
};

// ---------- graph ----------

export type Ctx = { vfs: Vfs; access: Access; genderCache: Map<string, PersonGender> };
export const makeCtx = (vfs: Vfs, access: Access): Ctx => ({ vfs, access, genderCache: new Map() });

const targets = async (ctx: Ctx, person: string, dir: string): Promise<{ path: string; kind?: string }[]> => {
  const entries = await readRelationDir(ctx.vfs, ctx.access, person, dir);
  return entries.filter((e) => e.target).map((e) => ({ path: e.target, kind: e.kind }));
};
export const getParents = (ctx: Ctx, p: string) => targets(ctx, p, PARENTS_DIR);
export const getChildren = (ctx: Ctx, p: string) => targets(ctx, p, CHILDREN_DIR);
export const getPartners = (ctx: Ctx, p: string) => targets(ctx, p, PARTNERS_DIR);

export const getGender = async (ctx: Ctx, path: string): Promise<PersonGender> => {
  const cached = ctx.genderCache.get(path);
  if (cached) return cached;
  let gender: PersonGender = 'unknown';
  try {
    const node = await ctx.vfs.get<PersonAttrs>(ctx.access, path);
    gender = node.attrs.gender ?? 'unknown';
  } catch {
    // missing/unreadable person -> unknown
  }
  ctx.genderCache.set(path, gender);
  return gender;
};

const ancestorMap = async (ctx: Ctx, start: string): Promise<Map<string, number>> => {
  const map = new Map<string, number>([[start, 0]]);
  let frontier = [start];
  for (let depth = 1; depth <= MAX_DEPTH && frontier.length; depth++) {
    const next: string[] = [];
    for (const p of frontier) {
      for (const { path } of await getParents(ctx, p)) {
        if (!map.has(path)) {
          map.set(path, depth);
          next.push(path);
        }
      }
    }
    frontier = next;
  }
  return map;
};

const pathUp = async (ctx: Ctx, from: string, target: string): Promise<string[] | null> => {
  if (from === target) return [from];
  const prev = new Map<string, string>();
  const seen = new Set([from]);
  let frontier = [from];
  for (let depth = 0; depth < MAX_DEPTH && frontier.length; depth++) {
    const next: string[] = [];
    for (const p of frontier) {
      for (const { path } of await getParents(ctx, p)) {
        if (seen.has(path)) continue;
        seen.add(path);
        prev.set(path, p);
        if (path === target) {
          const chain = [path];
          let cur = path;
          while (cur !== from) {
            cur = prev.get(cur)!;
            chain.push(cur);
          }
          return chain.reverse();
        }
        next.push(path);
      }
    }
    frontier = next;
  }
  return null;
};

const gendersAlong = async (ctx: Ctx, paths: string[]): Promise<PersonGender[]> => {
  const out: PersonGender[] = [];
  for (const p of paths) out.push(await getGender(ctx, p));
  return out;
};

const firstEdgeNonBlood = async (ctx: Ctx, child: string, parent: string): Promise<NonBlood | undefined> => {
  const kind = (await getParents(ctx, child)).find((e) => e.path === parent)?.kind;
  return kind && kind !== 'blood' ? (kind as NonBlood) : undefined;
};

export const wouldCreateCycle = async (ctx: Ctx, child: string, parent: string): Promise<boolean> => {
  if (child === parent) return true;
  return (await ancestorMap(ctx, parent)).has(child);
};

// ---------- kinship ----------

type NonBlood = 'adoptive' | 'step' | 'foster';

type Kinship =
  | { kind: 'self' }
  | { kind: 'not-related' }
  | { kind: 'partner' }
  | { kind: 'ancestor'; genders: PersonGender[]; nonBlood?: NonBlood }
  | { kind: 'descendant'; genders: PersonGender[]; nonBlood?: NonBlood }
  | { kind: 'sibling'; gender: PersonGender; half: boolean }
  /** `via`: the gender of the parent (of a) or sibling (of a) the tie runs through — moster or faster, systerson or brorson. */
  | { kind: 'pibling'; gender: PersonGender; greats: number; via: PersonGender }
  | { kind: 'nibling'; gender: PersonGender; greats: number; via: PersonGender }
  | { kind: 'cousin'; degree: number; removed: number }
  | { kind: 'inlaw'; via: 'spouse-relative' | 'relative-spouse'; base: Kinship; gender: PersonGender }
  | { kind: 'path'; length: number };

const bloodKinship = async (ctx: Ctx, a: string, b: string): Promise<Kinship> => {
  if (a === b) return { kind: 'self' };
  const ancA = await ancestorMap(ctx, a);
  const ancB = await ancestorMap(ctx, b);

  if (ancA.has(b)) {
    const chain = (await pathUp(ctx, a, b)) ?? [a, b];
    const genders = await gendersAlong(ctx, chain.slice(1));
    const nonBlood = chain.length === 2 ? await firstEdgeNonBlood(ctx, a, b) : undefined;
    return { kind: 'ancestor', genders, nonBlood };
  }
  if (ancB.has(a)) {
    const chain = (await pathUp(ctx, b, a)) ?? [b, a];
    const down = chain.slice(0, -1).reverse();
    const genders = await gendersAlong(ctx, down);
    const nonBlood = chain.length === 2 ? await firstEdgeNonBlood(ctx, b, a) : undefined;
    return { kind: 'descendant', genders, nonBlood };
  }

  let ca: string | undefined;
  let best = Infinity;
  for (const [path, dA] of ancA) {
    const dB = ancB.get(path);
    if (dB === undefined) continue;
    if (dA + dB < best) {
      best = dA + dB;
      ca = path;
    }
  }
  if (ca === undefined) return { kind: 'not-related' };

  const dA = ancA.get(ca)!;
  const dB = ancB.get(ca)!;
  const genderB = await getGender(ctx, b);

  if (dA === 1 && dB === 1) {
    const pa = new Set((await getParents(ctx, a)).map((e) => e.path));
    const pb = (await getParents(ctx, b)).map((e) => e.path);
    const shared = pb.filter((p) => pa.has(p)).length;
    return { kind: 'sibling', gender: genderB, half: shared < 2 };
  }
  // The side is the first step up from the lower of the two: a's parent for an aunt, b's
  // parent — a's sibling — for a niece.
  if (dB === 1) return { kind: 'pibling', gender: genderB, greats: dA - 2, via: await getGender(ctx, (await pathUp(ctx, a, ca))?.[1] ?? '') };
  if (dA === 1) return { kind: 'nibling', gender: genderB, greats: dB - 2, via: await getGender(ctx, (await pathUp(ctx, b, ca))?.[1] ?? '') };
  return { kind: 'cousin', degree: Math.min(dA, dB) - 1, removed: Math.abs(dA - dB) };
};

const isBlood = (k: Kinship): boolean => k.kind !== 'not-related' && k.kind !== 'partner' && k.kind !== 'path' && k.kind !== 'inlaw';

/** Breadth-first fallback when neither blood nor in-law rules name the tie. */
const shortestRelationshipPath = async (ctx: Ctx, a: string, b: string): Promise<string[] | null> => {
  if (a === b) return [a];
  const seen = new Set([a]);
  const previous = new Map<string, string>();
  let frontier = [a];
  for (let depth = 1; depth <= MAX_DEPTH && frontier.length; depth++) {
    const next: string[] = [];
    for (const p of frontier) {
      const neighbours = [...await getParents(ctx, p), ...await getChildren(ctx, p), ...await getPartners(ctx, p)];
      for (const { path } of neighbours) {
        if (seen.has(path)) continue;
        seen.add(path);
        previous.set(path, p);
        if (path === b) {
          const chain = [b];
          let current = b;
          while (current !== a) {
            current = previous.get(current)!;
            chain.push(current);
          }
          return chain.reverse();
        }
        next.push(path);
      }
    }
    frontier = next;
  }
  return null;
};

/** The parent/child route through the same closest common ancestor as `bloodKinship`. */
const bloodRelationshipPath = async (ctx: Ctx, a: string, b: string): Promise<string[] | null> => {
  if (a === b) return [a];
  const ancA = await ancestorMap(ctx, a);
  const ancB = await ancestorMap(ctx, b);
  if (ancA.has(b)) return await pathUp(ctx, a, b);
  if (ancB.has(a)) return (await pathUp(ctx, b, a))?.reverse() ?? null;

  let common: string | undefined;
  let best = Infinity;
  for (const [path, dA] of ancA) {
    const dB = ancB.get(path);
    if (dB !== undefined && dA + dB < best) {
      common = path;
      best = dA + dB;
    }
  }
  if (!common) return null;
  const aToCommon = await pathUp(ctx, a, common);
  const bToCommon = await pathUp(ctx, b, common);
  return aToCommon && bToCommon ? [...aToCommon, ...bToCommon.reverse().slice(1)] : null;
};

/**
 * The chain used by the kinship rules: blood before in-law, then any remaining
 * graph route. This order matters when two people happen to have several ties.
 */
export const relationshipPath = async (ctx: Ctx, a: string, b: string): Promise<string[] | null> => {
  if (a === b) return [a];
  if ((await getPartners(ctx, a)).some((entry) => entry.path === b)) return [a, b];

  const blood = await bloodRelationshipPath(ctx, a, b);
  if (blood) return blood;

  for (const { path: partner } of await getPartners(ctx, a)) {
    const via = await bloodRelationshipPath(ctx, partner, b);
    if (via) return [a, ...via];
  }
  for (const { path: partner } of await getPartners(ctx, b)) {
    const via = await bloodRelationshipPath(ctx, a, partner);
    if (via) return [...via, b];
  }
  return await shortestRelationshipPath(ctx, a, b);
};

export const kinship = async (ctx: Ctx, a: string, b: string): Promise<Kinship> => {
  if (a === b) return { kind: 'self' };
  if ((await getPartners(ctx, a)).some((e) => e.path === b)) return { kind: 'partner' };

  const blood = await bloodKinship(ctx, a, b);
  if (isBlood(blood)) return blood;

  for (const { path: pa } of await getPartners(ctx, a)) {
    const base = await bloodKinship(ctx, pa, b);
    if (isBlood(base)) return { kind: 'inlaw', via: 'spouse-relative', base, gender: await getGender(ctx, b) };
  }
  for (const { path: pb } of await getPartners(ctx, b)) {
    const base = await bloodKinship(ctx, a, pb);
    if (isBlood(base)) return { kind: 'inlaw', via: 'relative-spouse', base, gender: await getGender(ctx, b) };
  }

  const path = await shortestRelationshipPath(ctx, a, b);
  return path === null ? { kind: 'not-related' } : { kind: 'path', length: path.length - 1 };
};

// ---------- rendering ----------

export type Lang = 'en' | 'sv';

const ordinalEn = (n: number): string => {
  const names = ['zeroth', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth'];
  return names[n] ?? `${n}th`;
};
const timesEn = (n: number): string => (n === 1 ? 'once' : n === 2 ? 'twice' : n === 3 ? 'thrice' : `${n} times`);
const greatsEn = (n: number, base: string): string => 'great-'.repeat(Math.max(0, n)) + base;

const parentTermEn = (g: PersonGender): string => (g === 'male' ? 'father' : g === 'female' ? 'mother' : 'parent');
const childTermEn = (g: PersonGender): string => (g === 'male' ? 'son' : g === 'female' ? 'daughter' : 'child');
const piblingEn = (g: PersonGender): string => (g === 'male' ? 'uncle' : g === 'female' ? 'aunt' : 'aunt/uncle');
const niblingEn = (g: PersonGender): string => (g === 'male' ? 'nephew' : g === 'female' ? 'niece' : 'niece/nephew');
const siblingEn = (g: PersonGender): string => (g === 'male' ? 'brother' : g === 'female' ? 'sister' : 'sibling');
const grandparentEn = (g: PersonGender): string => (g === 'male' ? 'grandfather' : g === 'female' ? 'grandmother' : 'grandparent');
const grandchildEn = (g: PersonGender): string => (g === 'male' ? 'grandson' : g === 'female' ? 'granddaughter' : 'grandchild');
const lastGender = (genders: PersonGender[]): PersonGender => genders[genders.length - 1] ?? 'unknown';

const renderEn = (k: Kinship): string => {
  switch (k.kind) {
    case 'self':
      return 'self';
    case 'not-related':
      return 'not related';
    case 'partner':
      return 'partner';
    case 'ancestor': {
      const g = lastGender(k.genders);
      const n = k.genders.length;
      if (n === 1) return k.nonBlood === 'step' ? `step${parentTermEn(g)}` : k.nonBlood ? `${k.nonBlood} ${parentTermEn(g)}` : parentTermEn(g);
      if (n === 2) return grandparentEn(g);
      return greatsEn(n - 2, grandparentEn(g));
    }
    case 'descendant': {
      const g = lastGender(k.genders);
      const n = k.genders.length;
      if (n === 1) return k.nonBlood === 'step' ? `step${childTermEn(g)}` : k.nonBlood ? `${k.nonBlood} ${childTermEn(g)}` : childTermEn(g);
      if (n === 2) return grandchildEn(g);
      return greatsEn(n - 2, grandchildEn(g));
    }
    case 'sibling':
      return `${k.half ? 'half-' : ''}${siblingEn(k.gender)}`;
    case 'pibling':
      return greatsEn(k.greats, k.greats > 0 ? `grand${piblingEn(k.gender)}` : piblingEn(k.gender));
    case 'nibling':
      return greatsEn(k.greats, k.greats > 0 ? `grand${niblingEn(k.gender)}` : niblingEn(k.gender));
    case 'cousin': {
      const removed = k.removed > 0 ? ` ${timesEn(k.removed)} removed` : '';
      return `${ordinalEn(k.degree)} cousin${removed}`;
    }
    case 'path':
      return `distant relative (${k.length} steps)`;
    case 'inlaw':
      return renderEnInlaw(k);
  }
};

const renderEnInlaw = (k: Extract<Kinship, { kind: 'inlaw' }>): string => {
  const base = k.base;
  const g = k.gender;
  if (k.via === 'spouse-relative') {
    if (base.kind === 'ancestor' && base.genders.length === 1) return `${parentTermEn(g)}-in-law`;
    if (base.kind === 'sibling') return `${siblingEn(g)}-in-law`;
    if (base.kind === 'descendant' && base.genders.length === 1) return `step${childTermEn(g)}`;
    return `${renderEn(base)}-in-law`;
  }
  if (base.kind === 'ancestor' && base.genders.length === 1) return `step${parentTermEn(g)}`;
  if (base.kind === 'descendant' && base.genders.length === 1) return `${childTermEn(g)}-in-law`;
  if (base.kind === 'sibling') return `${siblingEn(g)}-in-law`;
  return `${renderEn(base)}-in-law`;
};

const svUp = (g: PersonGender): string => (g === 'male' ? 'far' : g === 'female' ? 'mor' : 'förälder');
const svDown = (g: PersonGender): string => (g === 'male' ? 'son' : g === 'female' ? 'dotter' : 'barn');

const svLineal = (parts: string[]): string => {
  if (parts.length === 1) return parts[0];
  let out = parts[0] + parts[1];
  for (let i = 2; i < parts.length; i++) out += `s${parts[i]}`;
  return out;
};

/**
 * Cousins by degree: kusin, syssling, brylling, pyssling, then the counted form. A kusin is a
 * tvåmänning (two generations to the shared ancestor), so the count is the degree plus one.
 */
const svCousin = (degree: number): string => {
  const named = ['', 'kusin', 'syssling', 'brylling', 'pyssling'];
  if (named[degree]) return named[degree];
  const n = degree + 1;
  const words = ['', '', 'två', 'tre', 'fyr', 'fem', 'sex', 'sju', 'åtta', 'nio'];
  return `${words[n] ?? n}männing`;
};

const svPibling = (g: PersonGender, via: PersonGender): string => {
  if (via === 'male') return g === 'male' ? 'farbror' : g === 'female' ? 'faster' : 'faster/farbror';
  if (via === 'female') return g === 'male' ? 'morbror' : g === 'female' ? 'moster' : 'moster/morbror';
  return g === 'male' ? 'morbror/farbror' : g === 'female' ? 'moster/faster' : 'moster/faster/morbror/farbror';
};
const svNibling = (g: PersonGender, via: PersonGender): string => {
  if (via === 'male') return g === 'male' ? 'brorson' : g === 'female' ? 'brorsdotter' : 'brorsbarn';
  if (via === 'female') return g === 'male' ? 'systerson' : g === 'female' ? 'systerdotter' : 'systerbarn';
  return g === 'male' ? 'systerson/brorson' : g === 'female' ? 'systerdotter/brorsdotter' : 'syskonbarn';
};
const svSibling = (g: PersonGender): string => (g === 'male' ? 'bror' : g === 'female' ? 'syster' : 'syskon');

const renderSv = (k: Kinship): string => {
  switch (k.kind) {
    case 'self':
      return 'sig själv';
    case 'not-related':
      return 'inte släkt';
    case 'partner':
      return 'partner';
    case 'ancestor': {
      const term = svLineal(k.genders.map(svUp));
      const prefix = k.nonBlood === 'step' ? 'styv' : k.nonBlood === 'adoptive' ? 'adoptiv' : k.nonBlood === 'foster' ? 'foster' : '';
      return k.genders.length === 1 ? `${prefix}${term}` : term;
    }
    case 'descendant': {
      const term = svLineal(k.genders.map(svDown));
      const prefix = k.nonBlood === 'step' ? 'styv' : k.nonBlood === 'adoptive' ? 'adoptiv' : k.nonBlood === 'foster' ? 'foster' : '';
      return k.genders.length === 1 ? `${prefix}${term}` : term;
    }
    case 'sibling':
      return `${k.half ? 'halv' : ''}${svSibling(k.gender)}`;
    case 'pibling':
      return k.greats > 0 ? `${'gammel'.repeat(k.greats)}${svPibling(k.gender, k.via)}` : svPibling(k.gender, k.via);
    case 'nibling':
      return k.greats > 0 ? `${'gammel'.repeat(k.greats)}${svNibling(k.gender, k.via)}` : svNibling(k.gender, k.via);
    case 'cousin': {
      const term = svCousin(k.degree);
      return k.removed > 0 ? `${term} (${k.removed} generation${k.removed > 1 ? 'er' : ''} förskjutet)` : term;
    }
    case 'path':
      return `avlägsen släkting (${k.length} steg)`;
    case 'inlaw':
      return renderSvInlaw(k);
  }
};

const renderSvInlaw = (k: Extract<Kinship, { kind: 'inlaw' }>): string => {
  const base = k.base;
  const g = k.gender;
  const svärParent = g === 'male' ? 'svärfar' : g === 'female' ? 'svärmor' : 'svärförälder';
  const svärChild = g === 'male' ? 'svärson' : g === 'female' ? 'svärdotter' : 'svärbarn';
  const svåger = g === 'male' ? 'svåger' : g === 'female' ? 'svägerska' : 'svåger/svägerska';
  if (k.via === 'spouse-relative') {
    if (base.kind === 'ancestor' && base.genders.length === 1) return svärParent;
    if (base.kind === 'sibling') return svåger;
    if (base.kind === 'descendant' && base.genders.length === 1) return `styv${svDown(g)}`;
    return `ingift (${renderSv(base)})`;
  }
  if (base.kind === 'ancestor' && base.genders.length === 1) return `styv${svUp(g)}`;
  if (base.kind === 'descendant' && base.genders.length === 1) return svärChild;
  if (base.kind === 'sibling') return svåger;
  return `ingift (${renderSv(base)})`;
};

export const render = (k: Kinship, lang: Lang): string => (lang === 'sv' ? renderSv(k) : renderEn(k));
