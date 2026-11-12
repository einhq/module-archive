import { Box, Skeleton, Text } from '@mantine/core';
import { useSignals } from '@preact/signals-react/runtime';
import type { ContainerListing } from '@ein/api';
import { useCommand, useLocalDay } from '@ein/ui/hooks';
import { displayUrl, gridUrl, lightboxRoute, shq } from '@ein/ui/lib';
import { isAuthenticated, openFullscreen } from '@ein/ui/signals';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { DatedMedia, DayInHistory } from '../../lib/media/api.ts';

/** What a picture may be: the files a picture card can draw, by extension. */
const PICTURE = /\.(jpe?g|png|webp|gif|heic|heif|avif|tiff?|dng|cr2|cr3|nef|arw|orf|raf|rw2)$/i;

/** A whole number from text, the same for the same text: what picks the day's picture. */
const seedOf = (text: string): number => {
  let hash = 2166136261;
  for (const char of text) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return hash >>> 0;
};

/** The hour it is, as a number that changes every hour: for a picture that changes hourly. */
const hourNow = (): number => Math.floor(Date.now() / 3_600_000);

type Candidate = { path: string; takenAt?: string; year?: number };

/**
 * The pictures to pick from: from this calendar day in earlier years (`dayinhistory`), from an
 * album (`members`), or the newest (`latest`).
 */
function useCandidates(from: string, album: string, day: string): { candidates: Candidate[] | null; error: Error | null } {
  const command = from === 'album' ? (album ? `members ${shq(album)}` : 'true') : from === 'recent' ? 'latest 200' : `dayinhistory ${day.slice(5)} --years 40 --per-year 12`;
  const answer = useCommand<DayInHistory | ContainerListing | DatedMedia[]>(command);
  if (!answer.data) return { candidates: null, error: answer.error };
  if (from === 'album') {
    const listing = answer.data as ContainerListing;
    return { candidates: (listing.members ?? []).filter((member) => !member.front && PICTURE.test(member.path)).map((member) => ({ path: member.path })), error: null };
  }
  if (from === 'recent') return { candidates: (answer.data as DatedMedia[]).filter((media) => media.mimetype?.startsWith('image/') ?? PICTURE.test(media.path)), error: null };
  const history = answer.data as DayInHistory;
  return {
    candidates: history.years.flatMap(({ year, items }) => items.filter((item) => item.mimetype?.startsWith('image/') ?? true).map((item) => ({ ...item, year }))),
    error: null,
  };
}

/**
 * `/cards/archive/picture`: a picture of the day, the whole tile, slowly drifting closer — from
 * this calendar day in earlier years (`from=onthisday`), an album (`from=album`, `album`), or the
 * newest pictures (`from=recent`) — the same one all day, or changing each hour (`every=hour`),
 * with when it was taken under it. Someone signed in opens it in the lightbox.
 */
export default function PictureCard() {
  useSignals();
  const [params] = useSearchParams();
  const from = params.get('from') ?? 'onthisday';
  const album = params.get('album') ?? '';
  const hourly = params.get('every') === 'hour';
  const day = useLocalDay();
  const [hour, setHour] = useState(hourNow);
  useEffect(() => {
    if (!hourly) return;
    const timer = setInterval(() => setHour(hourNow()), 60_000);
    return () => clearInterval(timer);
  }, [hourly]);
  const { candidates, error } = useCandidates(from, album, day);
  const [failed, setFailed] = useState(false);

  if (!candidates) return error ? <Text size='sm' c='dimmed' ta='center' mt='lg'>{error.message}</Text> : <Skeleton h='100%' radius={0} />;
  if (candidates.length === 0) {
    return (
      <Text size='sm' c='dimmed' ta='center' style={{ display: 'grid', placeItems: 'center', height: '100%', padding: 16 }}>
        {from === 'onthisday' ? 'No pictures from this day in earlier years' : 'No pictures to show'}
      </Text>
    );
  }
  const picked = candidates[seedOf(`${day}|${hourly ? hour : ''}|${from}|${album}`) % candidates.length];
  const yearsAgo = picked.year !== undefined ? Number(day.slice(0, 4)) - picked.year : undefined;
  const when = picked.takenAt ? new Date(picked.takenAt).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }) : undefined;
  const open = isAuthenticated.value ? () => openFullscreen(lightboxRoute(picked.path)) : undefined;

  return (
    <Box
      h='100%'
      pos='relative'
      onClick={open}
      style={{ overflow: 'hidden', cursor: open ? 'zoom-in' : undefined, background: 'var(--mrx-media-bg)' }}
    >
      <img
        key={picked.path}
        src={failed ? gridUrl(picked.path, true) : displayUrl(picked.path, 'photo', true)}
        onError={() => setFailed(true)}
        alt=''
        style={{ width: '100%', height: '100%', objectFit: 'cover', animation: 'archive-card-drift 40s ease-in-out infinite alternate' }}
      />
      {(when || yearsAgo !== undefined) && (
        <Box
          pos='absolute'
          bottom={0}
          left={0}
          right={0}
          style={{ padding: '2.5em 1em 0.8em', background: 'linear-gradient(transparent, rgba(0, 0, 0, 0.72))', color: 'white', fontSize: 'clamp(0.8rem, 4cqmin, 1.4rem)' }}
        >
          {yearsAgo !== undefined && <Text inherit fw={650}>{yearsAgo === 0 ? 'Today' : yearsAgo === 1 ? 'A year ago' : `${yearsAgo} years ago`}</Text>}
          {when && <Text inherit size='0.85em' c='rgba(255, 255, 255, 0.8)'>{when}</Text>}
        </Box>
      )}
      <style>
        {'@keyframes archive-card-drift { from { transform: scale(1.02) } to { transform: scale(1.1) translate(-1.5%, -1%) } } @media (prefers-reduced-motion: reduce) { img { animation: none !important } }'}
      </style>
    </Box>
  );
}
