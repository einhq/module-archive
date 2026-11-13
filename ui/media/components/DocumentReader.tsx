import { TablerIcon } from '@ein/ui/components';
import { Box, Button, Loader, Text } from '@mantine/core';
import { useEffect, useState } from 'react';
import type { MediaItem } from '@ein/ui/signals';
import { bust, documentViewUrl, fileUrl, formatBytes } from '@ein/ui/lib';

/** How much of a text file the reader shows; Download has the rest. */
const TEXT_HEAD = 256 * 1024;

type Reading =
  | { kind: 'loading' }
  | { kind: 'pdf'; url: string }
  | { kind: 'text'; text: string; total?: number }
  | { kind: 'none' };

/** Bytes of text as UTF-8, else as Windows-1252; a character cut at the end is left out. */
const decodeText = (bytes: ArrayBuffer): string => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: true });
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
};

/** The whole file's size, from a `Content-Range: bytes 0-262143/1048576` answer. */
const totalOf = (response: Response): number | undefined => {
  const total = Number(response.headers.get('content-range')?.split('/')[1]);
  return Number.isFinite(total) && total > 0 ? total : undefined;
};

/** What the reader shows of `media`: its PDF, its text, or nothing it can show. */
async function read(media: MediaItem, signal: AbortSignal): Promise<Reading> {
  if (media.mimetype.startsWith('text/')) {
    const response = await fetch(fileUrl(media.path), { headers: { Range: `bytes=0-${TEXT_HEAD - 1}` }, signal });
    if (!response.ok) return { kind: 'none' };
    return { kind: 'text', text: decodeText(await response.arrayBuffer()), total: totalOf(response) };
  }
  const url = documentViewUrl(media.path, media.mimetype, media.hasDerivatives);
  if (!url) return { kind: 'none' };
  // A converted PDF exists only once the media pipeline has made it.
  if (url !== fileUrl(media.path) && !(await fetch(url, { method: 'HEAD', signal })).ok) return { kind: 'none' };
  return { kind: 'pdf', url };
}

/**
 * A document in the lightbox: a PDF in the browser's own reader — the file itself, or the PDF a
 * Word, OpenDocument or RTF file was converted to — and text as text, never as a page of its own,
 * so an HTML file's scripts do not run. On a phone (`compact`), whose browser may not show a PDF
 * inside a page, a PDF is its first page and a button that opens it on its own. A document it cannot
 * show is its first page, or an icon, with a word on downloading it. Marked `data-document-reader`, so
 * the lightbox's swipes leave it to scroll.
 */
export function DocumentReader({ media, reloadToken, compact }: { media: MediaItem; reloadToken: number; compact?: boolean }) {
  const [reading, setReading] = useState<Reading>({ kind: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    setReading({ kind: 'loading' });
    read(media, controller.signal).then(setReading, () => !controller.signal.aborted && setReading({ kind: 'none' }));
    return () => controller.abort();
  }, [media.path, media.mimetype, media.hasDerivatives, reloadToken]);

  if (reading.kind === 'loading') return <Loader color='gray' />;

  if (reading.kind === 'pdf' && compact) {
    return (
      <Box style={{ textAlign: 'center', maxWidth: '100%' }}>
        {media.hasDerivatives && <img src={bust(media.fullUrl, reloadToken)} alt={media.name} style={{ maxWidth: '100%', maxHeight: '60vh', background: 'white' }} />}
        <Box mt='md'>
          <Button component='a' href={bust(reading.url, reloadToken)} target='_blank' rel='noopener' variant='light' leftSection={<TablerIcon name='file-text' size={16} />}>
            Open the document
          </Button>
        </Box>
      </Box>
    );
  }

  if (reading.kind === 'pdf') {
    return (
      <Box
        component='iframe'
        data-document-reader
        src={bust(reading.url, reloadToken)}
        title={media.name}
        style={{ width: '100%', height: '100%', border: 0, background: 'white' }}
      />
    );
  }

  if (reading.kind === 'text') {
    return (
      <Box
        data-document-reader
        style={{ width: '100%', maxWidth: 960, height: '100%', overflow: 'auto', background: 'var(--mantine-color-body)', touchAction: 'pan-y' }}
      >
        <Box
          component='pre'
          style={{
            margin: 0,
            padding: 'var(--mantine-spacing-lg)',
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere',
            fontFamily: 'var(--mantine-font-family-monospace)',
            fontSize: 'var(--mantine-font-size-sm)',
            color: 'var(--mantine-color-text)',
          }}
        >
          {reading.text}
        </Box>
        {reading.total !== undefined && reading.total > TEXT_HEAD && (
          <Text size='xs' c='dimmed' px='lg' pb='lg'>
            The first {formatBytes(TEXT_HEAD)} of {formatBytes(reading.total)}; Download has the rest.
          </Text>
        )}
      </Box>
    );
  }

  return (
    <Box style={{ textAlign: 'center', color: 'var(--mantine-color-gray-4)', maxWidth: 460 }}>
      {media.hasDerivatives
        ? <img src={bust(media.fullUrl, reloadToken)} alt={media.name} style={{ maxWidth: '100%', maxHeight: '60vh', background: 'white' }} />
        : <TablerIcon name='file-text' size={48} stroke={1.2} />}
      <Text size='sm' mt='sm'>EiN cannot show this document here. Use Download to open it on your device.</Text>
    </Box>
  );
}
