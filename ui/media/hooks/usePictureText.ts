import { fileUrl } from '@ein/ui/lib';
import { useEffect, useState } from 'react';

/**
 * The whole text in a picture. `media-details` carries the start of a long one only
 * (`contentTruncated`); then the whole is read from the picture's `metadata/content`, and until it
 * arrives the start is given, marked with an ellipsis, and `whole` is false.
 */
export function usePictureText(path: string, text: string, truncated: boolean): { text: string; whole: boolean } {
  const [full, setFull] = useState<string | null>(null);

  useEffect(() => {
    setFull(null);
    if (!truncated) return;
    const abort = new AbortController();
    fetch(`${fileUrl(path)}/metadata/content`, { signal: abort.signal, cache: 'no-store' })
      .then((response) => response.ok ? response.text() : null)
      .then(setFull)
      .catch(() => {});
    return () => abort.abort();
  }, [path, text, truncated]);

  if (!truncated) return { text, whole: true };
  return full === null ? { text: `${text}…`, whole: false } : { text: full, whole: true };
}
