import { TablerIcon } from '@ein/ui/components';
import { ActionIcon, Box, Group, Stack, Text, Tooltip } from '@mantine/core';
import { useRef, useState } from 'react';
import { MediaItem } from '@ein/ui/signals';
import { formatClock, gridSrcSet, gridUrl, WAVEFORM_ASPECT } from '@ein/ui/lib';
import { useMediaTransport } from '../hooks/useMediaTransport.ts';
import { usePlayPauseKey } from '../hooks/usePlayPauseKey.ts';
import { Scrubber } from './Scrubber.tsx';

/** What the skip buttons move by, in seconds. */
const SKIP_SECONDS = 10;

/** How wide the scrubber actually renders, so `srcset` picks the rendition it needs and no more. */
const PLAYER_MAX_WIDTH = 1100;
const WAVEFORM_SIZES = `(max-width: ${PLAYER_MAX_WIDTH}px) 100vw, ${PLAYER_MAX_WIDTH}px`;

type AudioPlayerProps = {
  media: MediaItem;
  /** Cache-buster from the lightbox, so a re-transcode is not served from cache. */
  bust: (url: string) => string;
  onEnded?: () => void;
  /** It cannot play on its own: the browser wants a gesture first, or the rendition failed. */
  onStalled?: () => void;
  /** It started, or started again. */
  onPlay?: () => void;
  /** Off while a dialog over the lightbox has the keys. */
  keysEnabled?: boolean;
};

/**
 * The lightbox's audio arm.
 *
 * A custom transport rather than `<audio controls>` for one reason: the waveform is the
 * scrubber. Native controls would put a generic browser bar under a picture of the sound
 * and leave the picture inert, when the picture is the thing that says where in the
 * recording you are.
 *
 * The waveform is the same rendition the grid tile draws, so the lightbox needs no
 * derivative of its own — `srcset` just lets a wide viewport pull the 1600 rendition
 * instead of the 512.
 */
export function AudioPlayer({ media, bust, onEnded, onStalled, onPlay, keysEnabled = true }: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [failed, setFailed] = useState(false);
  // `media.duration` is the *source* length from exif and is there immediately; the element's
  // own arrives with the metadata.
  const transport = useMediaTransport(audioRef, { fallbackDuration: media.duration, startAt: media.atSeconds, autoPlay: true, onEnded, onPlay, onRefused: onStalled });
  const { playing, position, duration, toggle, skip } = transport;
  usePlayPauseKey(toggle, keysEnabled);

  const src = bust(media.fullUrl);
  const waveform = bust(gridUrl(media.path, media.hasDerivatives));
  // Bust every entry, not just `src`: a matching `srcset` candidate is what the browser
  // actually fetches, so an unbusted one silently serves the stale image the busted `src`
  // was there to avoid.
  const waveformSrcSet = gridSrcSet(media.path, media.hasDerivatives, WAVEFORM_ASPECT)
    .split(', ')
    .filter(Boolean)
    .map((entry) => {
      const [url, descriptor] = entry.split(' ');
      return `${bust(url)} ${descriptor}`;
    })
    .join(', ');

  return (
    <Stack gap='lg' style={{ width: '100%', maxWidth: PLAYER_MAX_WIDTH, alignItems: 'stretch' }}>
      <Scrubber
        transport={transport}
        style={{
          position: 'relative',
          width: '100%',
          aspectRatio: `${WAVEFORM_ASPECT}`,
          background: 'var(--mrx-media-bg)',
          overflow: 'hidden',
        }}
      >
        {/* Unplayed: the waveform as rendered, dimmed back so the played part leads. */}
        <img
          src={waveform}
          {...(waveformSrcSet ? { srcSet: waveformSrcSet, sizes: WAVEFORM_SIZES } : {})}
          alt=''
          draggable={false}
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'fill', opacity: 0.45 }}
        />

        {
          /*
          Played: the same image at full strength, revealed left-to-right. One picture drawn
          twice rather than two renditions — the browser decodes it once and the clip is a
          compositor-only property, so scrubbing costs no layout.
        */
        }
        <Box
          style={{
            position: 'absolute',
            inset: 0,
            clipPath: 'inset(0 calc((1 - var(--progress, 0)) * 100%) 0 0)',
            pointerEvents: 'none',
          }}
        >
          <img
            src={waveform}
            {...(waveformSrcSet ? { srcSet: waveformSrcSet, sizes: WAVEFORM_SIZES } : {})}
            alt=''
            draggable={false}
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'fill' }}
          />
        </Box>

        <Box
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: 'calc(var(--progress, 0) * 100%)',
            width: 2,
            background: 'var(--mrx-accent)',
            pointerEvents: 'none',
          }}
        />
      </Scrubber>

      {failed && (
        <Text ta='center' c='red.4' size='sm'>
          This rendition could not be played. It may still be transcoding.
        </Text>
      )}

      <Group justify='center' gap='xl'>
        <Tooltip label={`Back ${SKIP_SECONDS}s`} withArrow>
          <ActionIcon variant='subtle' color='gray' size='lg' onClick={() => skip(-SKIP_SECONDS)} aria-label={`Back ${SKIP_SECONDS} seconds`}>
            <TablerIcon name='rewind-backward-10' size={22} color='white' />
          </ActionIcon>
        </Tooltip>

        <Tooltip label={playing ? 'Pause (space)' : 'Play (space)'} withArrow>
          <ActionIcon variant='filled' color='blue' size={56} radius='xl' onClick={toggle} aria-label={playing ? 'Pause' : 'Play'}>
            {playing ? <TablerIcon name='player-pause-filled' size={26} color='white' /> : <TablerIcon name='player-play-filled' size={26} color='white' />}
          </ActionIcon>
        </Tooltip>

        <Tooltip label={`Forward ${SKIP_SECONDS}s`} withArrow>
          <ActionIcon variant='subtle' color='gray' size='lg' onClick={() => skip(SKIP_SECONDS)} aria-label={`Forward ${SKIP_SECONDS} seconds`}>
            <TablerIcon name='rewind-forward-10' size={22} color='white' />
          </ActionIcon>
        </Tooltip>

        {
          /*
            Elapsed/total and the filename share one line to the right of the transport:
            the sidebar names the file too, but it can be closed, so the name is here, just
            not shouting. Monospace and tabular figures on the clock so the digits do not
            jitter as it counts.
          */
        }
        <Box style={{ minWidth: 0 }}>
          <Text c='dimmed' size='sm' ff='monospace' style={{ fontVariantNumeric: 'tabular-nums' }}>
            {formatClock(position) || '0:00'} / {formatClock(duration) || '—'}
          </Text>
          <Text
            c='dimmed'
            size='xs'
            title={media.name}
            style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 320 }}
          >
            {media.name}
          </Text>
        </Box>
      </Group>

      {
        /*
        `preload="metadata"` rather than `auto`: these renditions run to tens of megabytes
        and the range server can stream them, so there is no reason to pull the whole file
        before the first frame of sound.
      */
      }
      <audio
        ref={audioRef}
        src={src}
        preload='metadata'
        onError={() => {
          setFailed(true);
          onStalled?.();
        }}
      />
    </Stack>
  );
}
