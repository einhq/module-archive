import { Anchor, Box, Group, SimpleGrid, Skeleton, Text, UnstyledButton } from '@mantine/core';
import { useEffect, useState } from 'react';
import type { SearchHit, SearchResponse } from '@ein/api';
import { searchResultToMediaItem } from '@ein/ui/hooks';
import { gridUrl, paramsFromFilters, shq } from '@ein/ui/lib';
import { execCommand, openMediaAt } from '@ein/ui/signals';

/** How many pictures the strip shows. */
const SHOWN = 12;
/**
 * How many of the nearest the search looks at for them: a few more than are shown, for what the
 * search drops on the way (a rendition, a file the reader may not open). Without it the search
 * ranks its full text-sized page to show a dozen.
 */
const SCANNED = 48;

/**
 * Pictures that look like `path`, nearest first, by `search --like`: without the picture itself
 * or the rest of its stack, a video by its best keyframe. Undefined while they load; empty when
 * the picture cannot be compared, nothing is near it, or there is no `path` to ask about.
 */
export function useSimilarMedia(path: string | undefined): SearchHit[] | undefined {
  const [hits, setHits] = useState<SearchHit[] | undefined>(undefined);

  useEffect(() => {
    let current = true;
    if (!path) {
      setHits([]);
      return;
    }
    setHits(undefined);
    execCommand<SearchResponse>(`search --like ${shq(path)} --kind photo,video -l ${SHOWN} --max-scan ${SCANNED}`)
      .then((answer) => current && setHits(answer.results))
      .catch(() => current && setHits([]));
    return () => {
      current = false;
    };
  }, [path]);

  return hits;
}

/**
 * The lightbox's Similar strip: a small grid of the nearest pictures by what they show
 * (`useSimilarMedia` of `path`), skeletons while they load. A click opens one, and the lightbox
 * then walks these pictures; Show all opens the same search on the Media page, where the other
 * filters can narrow it. The caller leaves it out when there are none.
 */
export function SimilarMedia({ path, similar, onNavigate }: { path: string; similar: SearchHit[] | undefined; onNavigate: (route: string) => void }) {
  const open = (index: number) => openMediaAt(index, (similar ?? []).map(searchResultToMediaItem));

  return (
    <Box>
      <Group justify='space-between' mb={6}>
        <Text size='sm' fw={500}>Similar</Text>
        <Anchor size='xs' onClick={() => onNavigate(`/media?${paramsFromFilters({ like: path })}`)}>Show all</Anchor>
      </Group>
      <SimpleGrid cols={4} spacing={4}>
        {similar === undefined && Array.from({ length: 8 }, (_, i) => <Skeleton key={i} style={{ aspectRatio: '1' }} radius='sm' />)}
        {similar?.map((hit, index) => (
          <UnstyledButton
            key={hit.path}
            onClick={() => open(index)}
            aria-label={`Open ${hit.name}`}
            style={{ aspectRatio: '1', overflow: 'hidden', borderRadius: 4 }}
          >
            <img src={gridUrl(hit.path, true)} alt='' loading='lazy' draggable={false} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
          </UnstyledButton>
        ))}
      </SimpleGrid>
    </Box>
  );
}
