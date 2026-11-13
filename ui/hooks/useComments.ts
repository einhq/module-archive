import { useCallback, useEffect, useRef, useState } from 'react';
import { execCommand } from '@ein/ui/signals';
import { shq } from '@ein/ui/lib';
import type { CommentEntry } from '@ein/api';

/**
 * The comments on a node (`comment list`), and adding one or removing one; `comments` is null while
 * they are asked, or when they could not be.
 */
export function useComments(path: string): {
  comments: CommentEntry[] | null;
  add: (text: string) => Promise<void>;
  remove: (slug: string) => Promise<void>;
} {
  const [comments, setComments] = useState<CommentEntry[] | null>(null);
  // An answer about a node the page has since left is dropped.
  const current = useRef(path);
  current.current = path;

  const read = useCallback(async () => {
    const answer = await execCommand<CommentEntry[]>(`comment list ${shq(path)}`).catch(() => null);
    if (current.current === path) setComments(answer);
  }, [path]);

  useEffect(() => {
    setComments(null);
    void read();
  }, [read]);

  const add = useCallback(async (text: string) => {
    // A comment is multi-line text: it goes in on stdin, which the command takes as `-`.
    await execCommand(`comment add ${shq(path)} --body -`, { stdin: text });
    await read();
  }, [path, read]);

  const remove = useCallback(async (slug: string) => {
    await execCommand(`comment remove ${shq(path)} ${shq(slug)}`);
    await read();
  }, [path, read]);

  return { comments, add, remove };
}
