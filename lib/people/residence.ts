/**
 * Residence: somebody lived at a location, between two dates.
 *
 * The tie is an ordinary relation pair — `<person>/homes/<location>` ↔
 * `<location>/residents/<person>`, both halves carrying `attrs.relation` — with one
 * addition. The person-side half *also* carries the span as two flat attrs,
 * `movedIn` and `movedOut`.
 *
 * That denormalisation is what puts a move on the corpus-wide timeline. Nested
 * refs can query and index `relation.from`, but both halves carry identical
 * relation attrs, so a query over the pair would emit every move twice. The
 * flat attrs mark the one timeline-bearing half and are the indexed projections
 * the feed already uses (ein/core#104).
 *
 * `relation.{from,to}` stays the record of truth and the flat pair is its
 * projection; everything that writes a residence goes through here so the two
 * cannot drift, and `person-check` reports it as `home-date-drift` if they ever do.
 */

import { basename } from '@std/path';
import {
  type Access,
  comparableDate,
  createRelationPair,
  readRelationDir,
  type RelationAttrs,
  type RelationEntry,
  removeRelationPair,
  validDate,
  type Vfs,
} from './genealogy.ts';

export const HOMES_DIR = 'homes';
export const RESIDENTS_DIR = 'residents';

/** The indexed projection of `relation.from` / `relation.to`. Person-side half only. */
export const MOVED_IN_ATTR = 'movedIn';
export const MOVED_OUT_ATTR = 'movedOut';

/** When they moved in and when they moved out; either end may be unknown. */
type ResidenceSpan = { from?: string; to?: string };

export const homeLink = (person: string, location: string): string => `${person}/${HOMES_DIR}/${basename(location)}`;
const residentLink = (location: string, person: string): string => `${location}/${RESIDENTS_DIR}/${basename(person)}`;

/** Throws with a message meant to be shown to whoever typed the date. */
const assertSpan = (span: ResidenceSpan): void => {
  for (const [name, value] of [['from', span.from], ['to', span.to]] as const) {
    if (value !== undefined && !validDate(value)) throw new Error(`--${name} '${value}' is not a date (YYYY[-MM[-DD]])`);
  }
  if (span.from && span.to && comparableDate(span.to) < comparableDate(span.from)) {
    throw new Error(`moved out ${span.to} before moving in ${span.from}`);
  }
};

/** The flat pair as an *update*: an absent end is `null`, which deletes the attr. */
const spanPatch = (span: ResidenceSpan): Record<string, string | null> => ({
  [MOVED_IN_ATTR]: span.from ?? null,
  [MOVED_OUT_ATTR]: span.to ?? null,
});

const defined = <T extends Record<string, unknown>>(obj: T): Record<string, unknown> =>
  Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null));

/** Both halves, with the span on the relation and its projection on the person's. */
export const createResidence = async (vfs: Vfs, access: Access, person: string, location: string, span: ResidenceSpan): Promise<void> => {
  assertSpan(span);
  await createRelationPair(vfs, access, {
    aLink: homeLink(person, location),
    aTarget: location,
    bLink: residentLink(location, person),
    bTarget: person,
    from: span.from,
    to: span.to,
    aAttrs: defined(spanPatch(span)),
  });
};

/**
 * Rewrite the span of a residence that already exists.
 *
 * The span given *is* the new one: an omitted end clears whatever was there,
 * which is the only way to reopen a residence somebody closed by mistake. The
 * peer is found through the recorded `peerLink` rather than rebuilt from the
 * paths, so a link that was moved is still updated on both sides; a peer that
 * has gone missing is not an error here — `person-check` reports it.
 */
export const updateResidence = async (vfs: Vfs, access: Access, person: string, location: string, span: ResidenceSpan): Promise<void> => {
  assertSpan(span);
  const linkPath = homeLink(person, location);
  const node = await vfs.get<RelationAttrs>(access, linkPath, { follow: false });
  const peerLink = node.attrs.relation?.peerLink ?? residentLink(location, person);

  // `relation` is one attr, so writing it replaces the object wholesale — which
  // is what makes a cleared date actually clear. Anything else it carries (a
  // `kind`, one day) survives because it is spread back in.
  const { from: _from, to: _to, ...rest } = node.attrs.relation ?? { peerLink };
  const relation = { ...rest, peerLink, ...defined(span) };

  await vfs.update(access, linkPath, { follow: false, attrs: { relation, ...spanPatch(span) } });

  if (await vfs.exists(access, peerLink, { follow: false })) {
    await vfs.update(access, peerLink, { follow: false, attrs: { relation: { ...relation, peerLink: linkPath } } });
  }
};

/**
 * Both halves of a residence, gone.
 *
 * Through `removeRelationPair` rather than two unlinks of its own, because the
 * peer can disappear between the check and the removal: `relations-guard` sees
 * the first half go and removes the second, and an explicit removal of the
 * missing peer must not fail a command that has done its job.
 */
export const removeResidence = (vfs: Vfs, access: Access, person: string, location: string): Promise<void> => removeRelationPair(vfs, access, homeLink(person, location));

/** Where somebody has lived. */
export const readResidences = (vfs: Vfs, access: Access, person: string): Promise<RelationEntry[]> => readRelationDir(vfs, access, person, HOMES_DIR);
