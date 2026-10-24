import { ActionIcon, Box, Button, Group, Loader, Text, Tooltip } from '@mantine/core';
import { useHotkeys } from '@mantine/hooks';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import type { DayInHistory } from '@archive/media/api';
import { PageLoader, TablerIcon } from '@ein/ui/components';
import { useCommand, useShortcutHelp, useSurface } from '@ein/ui/hooks';
import { mediaItemFrom, posterUrl } from '@ein/ui/lib';
import { type MediaItem, openMediaAt } from '@ein/ui/signals';
import '../components/memories.css';
import { yearsAgo } from '../components/MemoryRings.tsx';
import { useWakeLock } from '../media/hooks/useWakeLock.ts';

export const handle = { fullBleed: true };

/** How long one picture stays. */
const SLIDE_SECONDS = 5;
/** Pictures a year can bring to the story. */
const PER_YEAR = 24;
/** How far back the story reaches. */
const YEARS = 30;
/** Longer than the cross-fade (twice `--mrx-dur-slow`), after which the old picture goes. */
const FADE_MS = 800;
/** A press held this long pauses rather than steps. */
const HOLD_MS = 250;

/** What a picture is drawn from: the same for the one on screen and the ones fetched ahead of it. */
const slideSource = (item: MediaItem): { src: string; srcSet?: string } => ({
  src: item.type === 'photo' ? item.fullUrl : posterUrl(item.path, item.type, item.hasDerivatives),
  srcSet: item.srcSet || undefined,
});

/** A picture on screen, and whether it has loaded (it fades in, and starts moving, once it has). */
type Layer = { key: string; src: string; srcSet?: string; variant: 'a' | 'b'; loaded: boolean };

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * One calendar day across the years, as a story: each year's pictures in turn, newest year first,
 * a bar per picture filling as it shows. A tap on the left third steps back, anywhere else on, a
 * held press pauses; the arrows and space do the same from a keyboard. Opened full screen from the
 * memory rings (`?year=` says which year to start at); Back or Escape closes it.
 */
export default function MemoriesPage() {
  const { day = '' } = useParams();
  const [searchParams] = useSearchParams();
  const surface = useSurface();
  const { data, loading } = useCommand<DayInHistory>(`dayinhistory ${day} --years ${YEARS} --per-year ${PER_YEAR}`);

  const years = useMemo(() => (data?.years ?? []).filter((year) => year.items.length > 0), [data]);
  const startYear = Number(searchParams.get('year'));
  const [yearIndex, setYearIndex] = useState<number | null>(null);
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const pressRef = useRef<{ at: number; held: boolean; timer: number } | null>(null);

  // Start at the year the ring was for, once the answer is in.
  useEffect(() => {
    if (yearIndex !== null || years.length === 0) return;
    setYearIndex(Math.max(0, years.findIndex((year) => year.year === startYear)));
  }, [years, startYear, yearIndex]);

  useWakeLock(!paused);

  const current = yearIndex === null ? undefined : years[yearIndex];
  const items = useMemo(() => (current?.items ?? []).map((item) => mediaItemFrom(item)), [current]);
  const item = items[index];

  // The picture showing, and under it the one before, kept until the new one has loaded: then the
  // two cross-fade, so a slide never cuts to black while its picture is on the way, and the old
  // one's edges never show round a new one of another shape.
  const [layers, setLayers] = useState<Layer[]>([]);
  const slide = useMemo(
    () => (item && current ? { key: `${current.year}/${index}`, ...slideSource(item), variant: index % 2 ? 'b' as const : 'a' as const } : undefined),
    [item, current, index],
  );
  useEffect(() => {
    if (!slide) return;
    setLayers((previous) => {
      if (previous.at(-1)?.key === slide.key) return previous;
      const shown = previous.filter((layer) => layer.loaded).at(-1);
      return [...(shown ? [shown] : []), { ...slide, loaded: false }];
    });
  }, [slide]);
  // Two frames on, so a picture fetched ahead, which loads the moment it mounts, is still drawn
  // hidden once and fades in rather than cutting.
  const markLoaded = (key: string) =>
    requestAnimationFrame(() => requestAnimationFrame(() => setLayers((previous) => previous.map((layer) => (layer.key === key ? { ...layer, loaded: true } : layer)))));
  // Once the two have cross-faded, the old one goes.
  const settled = layers.length > 1 && layers.at(-1)?.loaded ? layers.at(-1)?.key : undefined;
  useEffect(() => {
    if (!settled) return;
    const timer = globalThis.setTimeout(() => setLayers((previous) => previous.slice(-1)), FADE_MS);
    return () => globalThis.clearTimeout(timer);
  }, [settled]);
  // Until the picture is in, its bar waits too, so a slow one still gets its full time.
  const waiting = layers.at(-1)?.loaded !== true;

  const step = (direction: 1 | -1) => {
    if (yearIndex === null) return;
    if (direction === 1 && index < items.length - 1) return setIndex(index + 1);
    if (direction === -1 && index > 0) return setIndex(index - 1);
    const nextYear = yearIndex + direction;
    if (nextYear < 0) return setIndex(0);
    if (nextYear >= years.length) return surface.close();
    setYearIndex(nextYear);
    setIndex(direction === 1 ? 0 : years[nextYear].items.length - 1);
  };

  useShortcutHelp('Memories', [
    { keys: '→', label: 'Next picture' },
    { keys: '←', label: 'Previous picture' },
    { keys: 'space', label: 'Pause or play' },
    { keys: 'Esc', label: 'Close' },
  ]);
  useHotkeys([
    ['ArrowRight', () => step(1)],
    ['ArrowLeft', () => step(-1)],
    ['space', () => setPaused((value) => !value)],
  ]);

  const press = () => {
    const timer = globalThis.setTimeout(() => {
      if (pressRef.current) pressRef.current.held = true;
      setPaused(true);
    }, HOLD_MS);
    pressRef.current = { at: Date.now(), held: false, timer };
  };
  const release = (direction: 1 | -1) => {
    const pressed = pressRef.current;
    pressRef.current = null;
    if (!pressed) return;
    globalThis.clearTimeout(pressed.timer);
    if (pressed.held) setPaused(false);
    else step(direction);
  };

  // The next two pictures are fetched and decoded while this one shows, from the same `src` and
  // `srcset` the story draws them with, so the browser picks the same file for both.
  const nextYearFirst = years[(yearIndex ?? 0) + 1]?.items[0];
  const ahead = [items[index + 1], items[index + 2] ?? (nextYearFirst && mediaItemFrom(nextYearFirst))].filter((entry): entry is MediaItem => Boolean(entry));
  const aheadKey = ahead.map((entry) => entry.path).join('\n');
  const fetched = useRef<HTMLImageElement[]>([]);
  useEffect(() => {
    fetched.current = ahead.map((entry) => {
      const { src, srcSet } = slideSource(entry);
      const image = new Image();
      if (srcSet) image.srcset = srcSet;
      image.src = src;
      image.decode().catch(() => {});
      return image;
    });
    // `ahead` is a fresh array each render; its paths say when it changed.
  }, [aheadKey]);
  const [month, dayOfMonth] = day.split('-').map(Number);

  const openAll = () => {
    const all = years.flatMap((year) => year.items).map((entry) => mediaItemFrom(entry));
    openMediaAt(Math.max(0, all.findIndex((entry) => entry.path === item?.path)), all);
  };

  if (loading || (years.length > 0 && !item)) {
    return (
      <Box className='mrx-story' data-loading>
        <PageLoader label='Loading memories…' />
      </Box>
    );
  }

  if (!item || !current) {
    return (
      <Box className='mrx-story'>
        <Text c='gray.4'>Nothing was taken on this day in earlier years.</Text>
        <Button variant='default' onClick={surface.close} mt='md'>Close</Button>
      </Box>
    );
  }

  return (
    <Box className='mrx-story' data-paused={paused || undefined} data-waiting={waiting || undefined}>
      {layers.map((layer, i) => (
        <img
          key={layer.key}
          className={`mrx-story-image mrx-lightbox-ken-burns mrx-lightbox-ken-burns-${layer.variant}`}
          data-loaded={layer.loaded || undefined}
          data-leaving={(i < layers.length - 1 && layers.at(-1)?.loaded) || undefined}
          style={{ animationDuration: `${SLIDE_SECONDS + 1}s` }}
          src={layer.src}
          srcSet={layer.srcSet}
          alt=''
          draggable={false}
          onLoad={() => markLoaded(layer.key)}
          onError={() => markLoaded(layer.key)}
        />
      ))}
      {layers.every((layer) => !layer.loaded) && <Loader className='mrx-story-loader' />}

      <Box className='mrx-story-tap mrx-story-tap-back' onPointerDown={press} onPointerUp={() => release(-1)} onPointerCancel={() => release(-1)} />
      <Box className='mrx-story-tap mrx-story-tap-on' onPointerDown={press} onPointerUp={() => release(1)} onPointerCancel={() => release(1)} />

      <Box className='mrx-story-top'>
        <Box className='mrx-story-progress'>
          {items.map((entry, i) => (
            <span key={entry.path}>
              <i
                data-state={i < index ? 'done' : i === index ? 'now' : 'next'}
                style={i === index ? { animationDuration: `${SLIDE_SECONDS}s` } : undefined}
                onAnimationEnd={i === index ? () => step(1) : undefined}
              />
            </span>
          ))}
        </Box>
        <Group justify='space-between' wrap='nowrap' mt='sm'>
          <Box>
            <Text fw={700} c='white'>{yearsAgo(new Date().getFullYear() - current.year)}</Text>
            <Text size='sm' c='gray.3'>{dayOfMonth} {MONTHS[month - 1]} {current.year}</Text>
          </Box>
          <Group gap='xs' wrap='nowrap'>
            <Tooltip label={paused ? 'Play (space)' : 'Pause (space)'} withArrow>
              <ActionIcon variant='subtle' color='gray.0' size='lg' onClick={() => setPaused((value) => !value)} aria-label={paused ? 'Play' : 'Pause'}>
                <TablerIcon name={paused ? 'player-play' : 'player-pause'} size={20} />
              </ActionIcon>
            </Tooltip>
            <Tooltip label='Open in the lightbox' withArrow>
              <ActionIcon variant='subtle' color='gray.0' size='lg' onClick={openAll} aria-label='Open in the lightbox'>
                <TablerIcon name='photo-scan' size={20} />
              </ActionIcon>
            </Tooltip>
            <Tooltip label='Close (Esc)' withArrow>
              <ActionIcon variant='subtle' color='gray.0' size='lg' onClick={surface.close} aria-label='Close'>
                <TablerIcon name='x' size={20} />
              </ActionIcon>
            </Tooltip>
          </Group>
        </Group>
      </Box>
    </Box>
  );
}
