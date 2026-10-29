import { TablerIcon } from '@ein/ui/components';
import { ActionIcon, Box, Group, Stack, Text, Tooltip } from '@mantine/core';
import { useHotkeys } from '@mantine/hooks';
import { type MouseEvent as ReactMouseEvent, useRef, useState } from 'react';
import { MediaItem } from '@ein/ui/signals';
import { useShortcutHelp } from '@ein/ui/hooks';
import { fileUrl, formatClock, gridSrcSet, gridUrl, WAVEFORM_ASPECT } from '@ein/ui/lib';
import { useAudioPictureInPicture } from '../hooks/useAudioPictureInPicture.ts';
import { useMediaTransport } from '../hooks/useMediaTransport.ts';
import { usePlayPauseKey } from '../hooks/usePlayPauseKey.ts';
import { type PlayerTranscript, transcriptLabel, useSubtitles } from '../hooks/useSubtitles.ts';
import { useVolume } from '../hooks/useVolume.ts';
import { volumeIcon } from '../lib/player-settings.ts';
import { speakerColor, speakerLabel } from '../lib/vtt.ts';
import { Scrubber } from './Scrubber.tsx';
import { VolumeSlider } from './VolumeSlider.tsx';

/** What the skip buttons move by, in seconds. */
const SKIP_SECONDS = 10;

/** How wide the scrubber actually renders, so `srcset` picks the rendition it needs and no more. */
const PLAYER_MAX_WIDTH = 1100;
const WAVEFORM_SIZES = `(max-width: ${PLAYER_MAX_WIDTH}px) 100vw, ${PLAYER_MAX_WIDTH}px`;

const AUDIO_SHORTCUTS = [
  { keys: 'Space', label: 'Play or pause' },
  { keys: 'j', label: `Back ${SKIP_SECONDS} seconds` },
  { keys: 'l', label: `Forward ${SKIP_SECONDS} seconds` },
  { keys: 'c', label: 'Subtitles on or off' },
  { keys: 'm', label: 'Mute or unmute' },
  { keys: 'p', label: 'Picture-in-picture on or off, where the browser has it' },
];

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
  /** The transcript's language and voices, when the recording has one. */
  transcript?: PlayerTranscript;
  /** A phone's layout: larger targets, no mute. */
  compact?: boolean;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
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
 *
 * Under it are the video player's controls, in its order and with its keys: play, skip, volume and
 * the time, then subtitles (a line under the waveform), picture-in-picture and fullscreen. While it
 * is paused, a play button sits on the waveform, as one does on a paused video.
 */
export function AudioPlayer(
  { media, bust, onEnded, onStalled, onPlay, keysEnabled = true, transcript, compact = false, fullscreen, onToggleFullscreen }: AudioPlayerProps,
) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioHomeRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  // `media.duration` is the *source* length from exif and is there immediately; the element's
  // own arrives with the metadata.
  const transport = useMediaTransport(audioRef, { fallbackDuration: media.duration, startAt: media.atSeconds, autoPlay: true, onEnded, onPlay, onRefused: onStalled });
  const { playing, position, duration, toggle, skip } = transport;
  usePlayPauseKey(toggle, keysEnabled);

  const subtitles = useSubtitles(transcript, bust(`${fileUrl(media.path)}/metadata/transcript`), position);
  useShortcutHelp('Audio', AUDIO_SHORTCUTS);
  const { volume, muted, canSetVolume, toggleMute, changeVolume } = useVolume(audioRef);

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

  const pip = useAudioPictureInPicture(audioRef, audioHomeRef, { name: media.name, waveform });
  useHotkeys(
    keysEnabled
      ? [
        ['j', () => skip(-SKIP_SECONDS)],
        ['l', () => skip(SKIP_SECONDS)],
        ['m', toggleMute],
        ['c', () => transcript && subtitles.toggle()],
        ['p', () => pip.supported && pip.toggle()],
      ]
      : [],
  );

  const iconSize = compact ? 24 : 20;
  const buttonSize = compact ? 'xl' : 'lg';
  const playLabel = playing ? 'Pause' : 'Play';
  // A click on a control leaves the focus where it was, so the lightbox's keys stay its own.
  const keepFocus = (event: ReactMouseEvent) => event.preventDefault();

  return (
    <Stack gap='md' style={{ width: '100%', maxWidth: PLAYER_MAX_WIDTH, alignItems: 'stretch' }}>
      <Box style={{ position: 'relative' }}>
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

        {/* Beside the waveform rather than in it, so a press on it plays rather than seeks. */}
        {!playing && !failed && (
          <ActionIcon
            variant='filled'
            color='dark'
            size={72}
            radius='xl'
            onMouseDown={keepFocus}
            onClick={toggle}
            aria-label='Play'
            style={{ position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -50%)', opacity: 0.85 }}
          >
            <TablerIcon name='player-play-filled' size={34} color='white' />
          </ActionIcon>
        )}
      </Box>

      {
        /* Room for two lines while subtitles are on, so the controls do not jump between cues. */
      }
      {subtitles.on && (
        <Text
          aria-hidden
          ta='center'
          size='lg'
          c='gray.2'
          style={{ minHeight: '2.8em', lineHeight: 1.4 }}
        >
          {subtitles.namedVoices && subtitles.cue?.speaker && (
            <b style={{ color: `var(--mantine-color-${speakerColor(subtitles.cue.speaker.speaker)}-4)`, marginRight: '0.4em' }}>
              {speakerLabel(subtitles.cue.speaker)}
            </b>
          )}
          {subtitles.cue?.text}
        </Text>
      )}

      {failed && (
        <Text ta='center' c='red.4' size='sm'>
          This rendition could not be played. It may still be transcoding.
        </Text>
      )}

      <Group gap={compact ? 4 : 2} wrap='nowrap' onMouseDown={keepFocus}>
        <Tooltip label={`${playLabel} (Space)`} withArrow>
          <ActionIcon variant='subtle' color='gray' size={buttonSize} onClick={toggle} aria-label={playLabel}>
            <TablerIcon name={playing ? 'player-pause-filled' : 'player-play-filled'} size={iconSize} color='white' />
          </ActionIcon>
        </Tooltip>
        <Tooltip label={`Back ${SKIP_SECONDS} s (j)`} withArrow>
          <ActionIcon variant='subtle' color='gray' size={buttonSize} onClick={() => skip(-SKIP_SECONDS)} aria-label={`Back ${SKIP_SECONDS} seconds`}>
            <TablerIcon name='rewind-backward-10' size={iconSize} color='white' />
          </ActionIcon>
        </Tooltip>
        <Tooltip label={`Forward ${SKIP_SECONDS} s (l)`} withArrow>
          <ActionIcon variant='subtle' color='gray' size={buttonSize} onClick={() => skip(SKIP_SECONDS)} aria-label={`Forward ${SKIP_SECONDS} seconds`}>
            <TablerIcon name='rewind-forward-10' size={iconSize} color='white' />
          </ActionIcon>
        </Tooltip>
        {!compact && (
          <>
            <Tooltip label={muted ? 'Unmute (m)' : 'Mute (m)'} withArrow>
              <ActionIcon variant='subtle' color='gray' size={buttonSize} onClick={toggleMute} aria-label={muted ? 'Unmute' : 'Mute'} aria-pressed={muted}>
                <TablerIcon name={volumeIcon(volume, muted)} size={iconSize} color='white' />
              </ActionIcon>
            </Tooltip>
            {canSetVolume && <VolumeSlider volume={volume} muted={muted} onChange={changeVolume} />}
          </>
        )}
        {
          /* Monospace and tabular figures, so the digits do not jitter as it counts. */
        }
        <Text size='sm' c='gray.3' ff='monospace' px={compact ? 4 : 6} style={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
          {formatClock(position) || '0:00'} / {formatClock(duration) || '—'}
        </Text>
        <Box style={{ flex: 1 }} />
        {transcript && (
          <Tooltip label={`Subtitles: ${transcriptLabel(transcript.language)} (c)`} withArrow>
            <ActionIcon
              variant='subtle'
              color='gray'
              size={buttonSize}
              onClick={subtitles.toggle}
              aria-label={`Subtitles: ${transcriptLabel(transcript.language)}`}
              aria-pressed={subtitles.on}
            >
              <TablerIcon name={subtitles.on ? 'badge-cc-filled' : 'badge-cc'} size={iconSize} color='white' />
            </ActionIcon>
          </Tooltip>
        )}
        {pip.supported && (
          <Tooltip label={pip.active ? 'Leave picture-in-picture (p)' : 'Picture-in-picture (p)'} withArrow>
            <ActionIcon variant='subtle' color='gray' size={buttonSize} onClick={pip.toggle} aria-label='Picture-in-picture' aria-pressed={pip.active}>
              <TablerIcon name={pip.active ? 'picture-in-picture-off' : 'picture-in-picture'} size={iconSize} color='white' />
            </ActionIcon>
          </Tooltip>
        )}
        <Tooltip label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'} withArrow>
          <ActionIcon variant='subtle' color='gray' size={buttonSize} onClick={onToggleFullscreen} aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}>
            <TablerIcon name={fullscreen ? 'minimize' : 'maximize'} size={iconSize} color='white' />
          </ActionIcon>
        </Tooltip>
      </Group>

      {
        /*
        `preload="metadata"` rather than `auto`: these renditions run to tens of megabytes
        and the range server can stream them, so there is no reason to pull the whole file
        before the first frame of sound. Its box holds nothing else: picture-in-picture moves
        the element out into its window and back.
      */
      }
      <div ref={audioHomeRef}>
        <audio
          ref={audioRef}
          src={src}
          preload='metadata'
          onError={() => {
            setFailed(true);
            onStalled?.();
          }}
        />
      </div>
    </Stack>
  );
}
