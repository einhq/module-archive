/**
 * The category lock: whoever changes which files a category's suggested groups hold — the
 * organizer, the grouping verbs, and the decisions that take files out of the groups — does so
 * holding the lock of that category's directory of groups, so no two of them interleave their
 * reads and writes.
 *
 * The lock lives in this process. A lib file is loaded once per process and shared by every
 * command that imports it, so `staging` and `album` run in one process share it.
 */

/** The tail of each directory's queue: settles once everything queued on it so far has run. */
const tails = new Map<string, Promise<void>>();

/**
 * Run `fn` once every earlier holder of `albumsPath`'s lock is done, holding it until `fn`
 * settles. Not reentrant: code that holds the lock calls the unlocked forms of what it needs.
 */
export const withCategoryLock = async <T>(albumsPath: string, fn: () => Promise<T>): Promise<T> => {
  const before = tails.get(albumsPath) ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>((resolve) => release = resolve);
  const tail = before.then(() => held);
  tails.set(albumsPath, tail);
  await before;
  try {
    return await fn();
  } finally {
    release();
    if (tails.get(albumsPath) === tail) tails.delete(albumsPath);
  }
};
