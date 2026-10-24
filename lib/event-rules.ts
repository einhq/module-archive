/**
 * VFS mutation -> archive domain fact: the staging, media and location rule sets behind one queue.
 *
 * Each rule set sees only the routing keys it binds, as if it had a queue of its own. The rules
 * were written against their own narrow key lists — the media rules' `position` case, for one,
 * does not look at the event type, because `position.updated` is not one of its keys — so a
 * message is never handed to a rule set that would not have bound it.
 */

import type { DomainEvent } from '@ein/client';
import { deriveEvents, MEDIA_BRIDGE_ROUTING_KEYS, type RuleContext, type VfsEventInput } from '@archive/media/event-rules';
import { deriveLocationEvents, LOCATION_BRIDGE_ROUTING_KEYS, type LocationRuleContext } from '@archive/location/event-rules';
import { deriveStagingFacts, STAGING_BRIDGE_ROUTING_KEYS, stampLanes } from '@archive/staging/facts';

export type { VfsEventInput };

/** Everything either rule set needs from the VFS. */
export type ArchiveRuleContext = RuleContext & LocationRuleContext;

/** VFS routing keys the archive bridge binds: every rule set's keys, each once. */
export const ARCHIVE_BRIDGE_ROUTING_KEYS = [...new Set([...STAGING_BRIDGE_ROUTING_KEYS, ...MEDIA_BRIDGE_ROUTING_KEYS, ...LOCATION_BRIDGE_ROUTING_KEYS])];

const STAGING_KEYS = new Set(STAGING_BRIDGE_ROUTING_KEYS);
const MEDIA_KEYS = new Set(MEDIA_BRIDGE_ROUTING_KEYS);
const LOCATION_KEYS = new Set(LOCATION_BRIDGE_ROUTING_KEYS);

/**
 * The facts a VFS event announces, from every rule set that binds its routing key, each naming the
 * write it was derived from so the pipelines it starts can record that write as their cause, and
 * each about a file of a bulk category in the bulk lane (`stampLanes`).
 */
export async function deriveArchiveEvents(event: VfsEventInput, ctx: ArchiveRuleContext, now: number = Date.now()): Promise<Omit<DomainEvent, 'id'>[]> {
  const key = `system.vfs.${event.nodeType}.${event.type}`;
  const facts = await stampLanes(
    [
      ...STAGING_KEYS.has(key) ? await deriveStagingFacts(event, ctx, now) : [],
      ...MEDIA_KEYS.has(key) ? await deriveEvents(event, ctx, now) : [],
      ...LOCATION_KEYS.has(key) ? await deriveLocationEvents(event, ctx, now) : [],
    ],
    ctx,
    now,
  );
  if (!event.auditId || event.uid === undefined) return facts;
  const write = { auditId: event.auditId, uid: event.uid };
  return facts.map((fact) => ({ ...fact, write }));
}
