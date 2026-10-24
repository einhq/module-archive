import type { AlbumInfoAnswer, AlbumListItem, AlbumListResult } from '@archive/media/api';
import type { StagingRowInfo } from '@archive/staging/api';
import { useNodeEvents } from '@ein/ui/hooks';
import { forgetMediaSet, shq } from '@ein/ui/lib';
import { execCommand } from '@ein/ui/signals';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/** A suggested album as the stream holds it: its `album list` row, which carries `staging`. */
export type GroupRow = AlbumListItem & { staging: StagingRowInfo };

type GroupIndex = {
  /** Every suggested album loaded so far, in no particular order. */
  rows: GroupRow[];
  /** Every page is in: the counts are exact. */
  complete: boolean;
  error: Error | null;
  /** Take rows out: decided here, or gone. */
  remove: (names: string[]) => void;
  /** Read these albums again (`album info`) and put what comes back in their place. */
  reread: (paths: string[]) => void;
  /** Change a row in place, for what a command just did, ahead of the event that says so. */
  patch: (name: string, change: (row: GroupRow) => GroupRow) => void;
};

/** Rows per `album list` page. */
const PAGE = 1000;
/** Paths per `album info`. */
const INFO_BATCH = 50;
/** Events for the same albums within this window are read once. */
const COALESCE_MS = 1000;

const isGroup = (item: AlbumListItem): item is GroupRow => item.staging !== undefined;

/**
 * Every suggested album in `albumsPath`, the complete index the Sort stream is drawn from.
 *
 * Loaded with `album list` a page at a time, in the background, each page shown as it lands. Then
 * kept current by one non-recursive subscription on the directory: an album created or changed is
 * read again with `album info`, a burst of them in one call, and one deleted leaves. An album whose
 * members changed has its pictures forgotten (`forgetMediaSet`), so a section showing it asks
 * again. Events for the names `ignore` holds — a decision on them is being carried out — are let
 * pass, so what the page has done to them stands until the command says otherwise.
 */
export function useGroupIndex(albumsPath: string, ignore: (name: string) => boolean): GroupIndex {
  const [rows, setRows] = useState<ReadonlyMap<string, GroupRow>>(() => new Map());
  const [complete, setComplete] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const ignoreRef = useRef(ignore);
  ignoreRef.current = ignore;

  const merge = useCallback((items: AlbumListItem[], gone: string[] = []) => {
    setRows((previous) => {
      const next = new Map(previous);
      for (const name of gone) next.delete(name);
      for (const item of items) {
        const before = next.get(item.name);
        if (!isGroup(item)) {
          next.delete(item.name);
          continue;
        }
        if (before && before.staging.memberKey !== item.staging.memberKey) forgetMediaSet(item.path);
        next.set(item.name, item);
      }
      return next;
    });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setRows(new Map());
    setComplete(false);
    setError(null);
    (async () => {
      let cursor: string | null = null;
      do {
        const page: AlbumListResult = await execCommand<AlbumListResult>(
          `album list ${shq(albumsPath)} --limit ${PAGE}${cursor === null ? '' : ` --cursor=${shq(cursor)}`}`,
          { signal: controller.signal },
        );
        merge(page.items);
        cursor = page.nextCursor;
      } while (cursor !== null && !controller.signal.aborted);
      if (!controller.signal.aborted) setComplete(true);
    })().catch((value) => {
      if (!controller.signal.aborted) setError(value instanceof Error ? value : new Error(String(value)));
    });
    return () => controller.abort();
  }, [albumsPath, merge]);

  const queued = useRef(new Set<string>());
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => globalThis.clearTimeout(timer.current), []);

  const flush = useCallback(async () => {
    timer.current = undefined;
    const paths = [...queued.current];
    queued.current.clear();
    for (let start = 0; start < paths.length; start += INFO_BATCH) {
      const batch = paths.slice(start, start + INFO_BATCH);
      try {
        const answer = await execCommand<AlbumInfoAnswer>(`album info ${batch.map(shq).join(' ')}`);
        const name = (path: string) => path.slice(albumsPath.length + 1);
        merge(answer.albums.filter((album) => !ignoreRef.current(album.name)), answer.missing.map(name).filter((each) => !ignoreRef.current(each)));
      } catch {
        // The next event, or the next visit, reads them again.
      }
    }
  }, [albumsPath, merge]);

  const reread = useCallback((paths: string[]) => {
    for (const path of paths) queued.current.add(path);
    if (timer.current === undefined) timer.current = globalThis.setTimeout(() => void flush(), COALESCE_MS);
  }, [flush]);

  useNodeEvents({ pathPrefix: albumsPath, recursive: false }, (event) => {
    if (event.path === albumsPath || !event.path.startsWith(`${albumsPath}/`)) return;
    const name = event.path.slice(albumsPath.length + 1);
    if (name.startsWith('.') || ignoreRef.current(name)) return;
    if (event.type === 'deleted') merge([], [name]);
    else if (event.type === 'created' || event.type === 'updated') reread([event.path]);
  });

  const remove = useCallback((names: string[]) => merge([], names), [merge]);
  const patch = useCallback((name: string, change: (row: GroupRow) => GroupRow) => {
    setRows((previous) => {
      const row = previous.get(name);
      if (!row) return previous;
      return new Map(previous).set(name, change(row));
    });
  }, []);

  const list = useMemo(() => [...rows.values()], [rows]);
  return { rows: list, complete, error, remove, reread, patch };
}
