import { useCallback, useEffect, useState } from 'react';
import { type NodeAccessProps, type NodeChildEntry, shq } from '@ein/ui/lib';
import type { StatNode } from '@ein/ui/hooks';
import { execCommand } from '@ein/ui/signals';

export type AlbumEvent = {
  path: string;
  /** The date that puts this text beneath an album timeline divider. */
  date: string;
  text: string;
  /** The event file's owner and mode, for whether the reader may change it. */
  ownership: NodeAccessProps;
  /** The uid that made the event file: who wrote the text, when no writer is named. */
  creator: number;
  /** The person named as the text's writer: the event file's `writer` link, and the name of who it points at. */
  writer?: { path: string; name: string };
};

/** Where an event's `writer` link points and that person's name, or nothing when it has none or it leads nowhere. */
async function readWriter(eventPath: string): Promise<AlbumEvent['writer']> {
  const link = shq(`${eventPath}/writer`);
  const [own, person] = await Promise.all([
    execCommand<StatNode>(`stat -L ${link}`).catch(() => undefined),
    execCommand<StatNode>(`stat ${link}`).catch(() => undefined),
  ]);
  const path = own?.props.softlink;
  const name = person?.type === 'person' ? person.attrs.name : undefined;
  return path && typeof name === 'string' && name ? { path, name } : undefined;
}

/**
 * The prose attached to an album's dated `events/` files, and a way to read
 * them again after one has changed.
 *
 * Album media is indexed by `search --under`; event bodies deliberately are
 * not. Read the small sibling directory separately so travel journals and
 * similar imports remain part of the album timeline without making every media
 * result carry arbitrary document text.
 */
export function useAlbumEvents(album?: string): { events: AlbumEvent[]; reload: () => void } {
  const [events, setEvents] = useState<AlbumEvent[]>([]);
  const [generation, setGeneration] = useState(0);
  const reload = useCallback(() => setGeneration((value) => value + 1), []);

  // Cleared only when the album changes: a reload keeps the old text up until the new is in.
  useEffect(() => setEvents([]), [album]);

  useEffect(() => {
    let cancelled = false;
    if (!album) return;

    const eventsPath = `${album}/events`;
    void (async () => {
      try {
        const entries = await execCommand<NodeChildEntry[]>(`ls -l ${shq(eventsPath)}`);
        const datedFiles = entries.flatMap((entry) => {
          const date = (entry.node.attrs as Record<string, unknown>).date;
          const { uid, gid, mode, acl, birthtime } = entry.node.props;
          return entry.node.type === 'file' && typeof date === 'string' && date
            ? [{ path: `${eventsPath}/${entry.name}`, date, ownership: { uid, gid, mode, acl }, creator: birthtime.uid, children: entry.childCount }]
            : [];
        });
        const loaded = await Promise.all(datedFiles.map(async ({ children, ...event }): Promise<AlbumEvent | undefined> => {
          const [text, writer] = await Promise.all([
            execCommand<unknown>(`cat ${shq(event.path)}`).catch(() => undefined),
            children > 0 ? readWriter(event.path) : undefined,
          ]);
          return typeof text === 'string' && text.trim() ? { ...event, text: text.trim(), writer } : undefined;
        }));
        if (!cancelled) setEvents(loaded.filter((event): event is AlbumEvent => Boolean(event)));
      } catch {
        // Most albums do not have an events directory. That is an empty state,
        // not an error beside an otherwise healthy media grid.
        if (!cancelled) setEvents([]);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [album, generation]);

  return { events, reload };
}
