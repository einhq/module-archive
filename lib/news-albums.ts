/**
 * news-albums — the albums people made lately, as `news` entries: archive's part of the home
 * page's News. Each entry is drawn by archive's `/news/album` route, whose query carries the
 * album, who made it and when, how many members it has and a few of them to show.
 *
 * It asks when an album was **created**, `props.birthtime`, not when it was
 * last touched: an album is touched whenever anything inside it changes, so a
 * single retimed photo would put a fifteen-year-old album at the top.
 *
 * That has to be sorted here rather than by the store: `NodeQuery.orderBy`
 * takes an attr, and birthtime is a node *column*. One listing of the album
 * root and a sort stays server-side — only the handful of entries the page
 * shows cross the API.
 *
 * Each preview reads the album's members (`@archive/media/album-members`): a listing, and a
 * read per linked member. That is why `limit` is small and the albums are read together: a 1+N
 * pattern bounded to a fixed handful rather than to however many albums exist
 * (ein/core#42).
 */

import type { FeedActor, NewsEntry, Provided } from '@ein/api';
import { USERS_PATH } from '@ein/paths';
import { ALBUMS_ROOT } from '@archive/paths';
import { collectUnknownFlags, parseArgs, reportUnknownFlags } from '@ein/client';
import type { CmdReturn, Command } from '@ein/client';
import type { UserAttrs } from '@ein/client';
import { albumMembers, visibleMembers } from '@archive/media/album-members';
import { NODE_TYPE_ALBUM } from '@archive/media/types';

/** The route that draws one entry. */
const ENTRY_ROUTE = '/news/album';

type NewsOptions = {
  /** Where albums live. */
  root: string;
  /** How many entries to return. */
  limit: number;
  /** Pictures per entry. */
  preview: number;
};

/**
 * uid to account, from one listing of the users directory.
 *
 * A users directory this caller cannot read leaves the feed unattributed
 * rather than empty.
 */
const actors = async (cmd: Command): Promise<Map<number, FeedActor>> => {
  try {
    const users = await cmd.sys.vfs.children<UserAttrs>(cmd.access, cmd.env.USERS_PATH ?? USERS_PATH);
    return new Map(users.map((user) => [user.node.attrs.uid, { uid: user.node.attrs.uid, username: user.name, name: user.node.attrs.name }]));
  } catch {
    return new Map();
  }
};

/**
 * A few of an album's pictures, and how many it shows, by media's album rules: the members the
 * album page shows, stack fronts only, in listing order. An album that cannot be read has none.
 */
const previewOf = async (cmd: Command, albumPath: string, want: number): Promise<{ preview: string[]; count?: number }> => {
  try {
    const shown = visibleMembers((await albumMembers(cmd, albumPath)).members);
    return { preview: shown.slice(0, want).map((member) => member.path), count: shown.length };
  } catch {
    return { preview: [] };
  }
};

type AlbumRow = { entry: Awaited<ReturnType<Command['sys']['vfs']['children']>>[number]; at: number };

/** The albums under `root`, as rows carrying their creation time. */
const albumRows = async (cmd: Command, root: string): Promise<AlbumRow[]> => {
  let entries;
  try {
    entries = await cmd.sys.vfs.children(cmd.access, root);
  } catch {
    // No album root on this instance. An empty feed, not an error.
    return [];
  }

  return entries
    .filter((entry) => !entry.name.startsWith('.') && entry.node.type === NODE_TYPE_ALBUM)
    .map((entry) => ({ entry, at: Number(entry.node.props.birthtime?.timestamp ?? 0) }))
    .filter((row) => Number.isFinite(row.at) && row.at > 0);
};

/** Each row as an entry: its author, and a glimpse of what is inside it in the route's query. */
const describe = async (cmd: Command, root: string, albums: AlbumRow[], preview: number): Promise<Provided<NewsEntry>[]> => {
  if (albums.length === 0) return [];

  const [people, previews] = await Promise.all([
    actors(cmd),
    Promise.all(albums.map((row) => previewOf(cmd, `${root}/${row.entry.name}`, preview))),
  ]);

  return albums.map((row, index) => {
    const attrs = row.entry.node.attrs as Record<string, unknown>;
    const props = row.entry.node.props;
    const path = `${root}/${row.entry.name}`;
    const name = (typeof attrs.name === 'string' && attrs.name) || row.entry.name;
    // The creator, not the current owner: an album whose ownership later
    // changed was still added by whoever added it.
    const by = people.get(props.birthtime?.uid ?? props.uid);
    const who = by?.name ?? by?.username;
    const { count, preview: pictures } = previews[index];

    const query = new URLSearchParams({ path, name, at: String(row.at) });
    if (who) query.set('who', who);
    if (count !== undefined) query.set('count', String(count));
    for (const picture of pictures) query.append('preview', picture);

    return {
      at: row.at,
      title: `${who ?? 'Somebody'} added ${name}`,
      path,
      route: `${ENTRY_ROUTE}?${query}`,
      icon: 'photo',
      ...(by ? { by } : {}),
    };
  });
};

/** The most recently created albums, newest first. */
const recentNews = async (cmd: Command, opts: NewsOptions): Promise<Provided<NewsEntry>[]> => {
  if (opts.limit <= 0) return [];

  const albums = (await albumRows(cmd, opts.root))
    .sort((a, b) => b.at - a.at)
    .slice(0, opts.limit);

  return describe(cmd, opts.root, albums, opts.preview);
};

const DEFAULT_LIMIT = 8;
const DEFAULT_PREVIEW = 5;

const count = (raw: string | undefined, fallback: number): number | undefined => {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return raw.trim() !== '' && Number.isInteger(value) && value >= 0 ? value : undefined;
};

export const newsAlbums = async (cmd: Command): CmdReturn => {
  const unknown: string[] = [];
  const flags = parseArgs(cmd.args, {
    string: ['limit', 'preview', 'albums'],
    unknown: collectUnknownFlags(unknown),
  });

  if (await reportUnknownFlags(cmd, unknown)) return 1;

  const limit = count(flags.limit, DEFAULT_LIMIT);
  const preview = count(flags.preview, DEFAULT_PREVIEW);
  if (limit === undefined || preview === undefined) {
    await cmd.writeError(`news-albums: --${limit === undefined ? 'limit' : 'preview'} must be a non-negative whole number\n`);
    return 1;
  }

  const entries = await recentNews(cmd, { root: flags.albums ?? ALBUMS_ROOT, limit, preview });

  if (cmd.json) {
    await cmd.writeJSON(entries satisfies Provided<NewsEntry>[]);
    return 0;
  }

  for (const entry of entries) await cmd.writeLn(`${new Date(entry.at).toISOString().slice(0, 10)}  ${entry.title}`);
  return 0;
};

newsAlbums.spec = {
  name: 'news-albums',
  effect: 'read' as const,
  description: 'Recently created albums, newest first, with who made them, as news entries (core news gathers them)',
  args: [],
  flags: [
    { name: 'limit', type: 'number' as const, description: `albums returned (default ${DEFAULT_LIMIT})` },
    { name: 'preview', type: 'number' as const, description: `pictures kept per album (default ${DEFAULT_PREVIEW})` },
    { name: 'albums', type: 'path' as const, description: `album root to read (default ${ALBUMS_ROOT})` },
  ],
  examples: [
    'news-albums',
    'news-albums --limit 20 --preview 0',
  ],
  returns: 'the newest albums by creation time as news entries: when, who made it, a title, the album, and the route that draws it with the member count and a few pictures.',
};
