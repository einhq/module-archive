import { useEffect, useState } from 'react';
import { execCommand } from '@ein/ui/signals';
import { albumDates, type DatedAlbumAttrs, type NodeAccessProps, shq } from '@ein/ui/lib';

type AlbumInfo = {
  /** `attrs.name` — the album's own title. Falls back to the directory name. */
  title: string;
  description?: string;
  timeStart?: string;
  timeEnd?: string;
  /**
   * `album` or `directory` — the page shows both, but only an album has a stack manifest.
   * Absent until the node is read, so nothing album-only is offered on a guess.
   */
  type?: string;
  /** Who may change it, for the page to offer only what the reader may do. Absent until read. */
  ownership?: NodeAccessProps;
};

type AlbumNode = { type: string; props: NodeAccessProps; attrs: { name?: string; description?: string } & DatedAlbumAttrs };

const basename = (path: string): string => path.split('/').filter(Boolean).pop() ?? path;

/**
 * An album's own title and description, and who may change it.
 *
 * The directory name is a slug of the title ("Sommar_i_Exempelstad"), so a page that
 * shows a heading or a breadcrumb has to read the node — one `stat` call,
 * separate from the media listing so the heading is not blocked by it.
 */
export function useAlbumInfo(path: string): { info: AlbumInfo; loading: boolean; refetch: () => void } {
  const [title, setTitle] = useState(() => basename(path));
  const [description, setDescription] = useState<string | undefined>(undefined);
  const [dates, setDates] = useState<{ timeStart?: string; timeEnd?: string }>({});
  const [type, setType] = useState<string | undefined>(undefined);
  const [ownership, setOwnership] = useState<NodeAccessProps | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    // The fallback has to be re-applied on every path change: the heading would
    // otherwise keep the previous album's title until the new attrs land.
    setTitle(basename(path));
    setDescription(undefined);
    setDates({});
    setType(undefined);
    setOwnership(undefined);
    setLoading(true);

    if (!path) return;

    execCommand<AlbumNode>(`stat ${shq(path)}`)
      .then((node) => {
        if (cancelled) return;
        if (node?.attrs?.name) setTitle(node.attrs.name);
        setDescription(node?.attrs?.description);
        setDates(albumDates(node?.attrs));
        setType(node?.type);
        if (node?.props) setOwnership({ mode: node.props.mode, uid: node.props.uid, gid: node.props.gid, acl: node.props.acl ?? undefined });
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [path, version]);

  return { info: { title, description, ...dates, type, ownership }, loading, refetch: () => setVersion((value) => value + 1) };
}
