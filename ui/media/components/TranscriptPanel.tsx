import { Badge, Box, Loader, ScrollArea, Text, UnstyledButton } from '@mantine/core';
import { useEffect, useMemo, useRef } from 'react';
import { useSignals } from '@preact/signals-react/runtime';
import { activeCueIndex, attachSpeakers, speakerColor, speakerLabel } from '../lib/vtt.ts';
import type { MediaSpeaker } from '@archive/media/api';
import { TranscriptSpeakers } from './TranscriptSpeakers.tsx';
import { bust, fileUrl, formatClock, versionOf } from '@ein/ui/lib';
import { useTranscriptCues } from '../hooks/useTranscriptCues.ts';
import { playbackPosition, playbackSeek } from '../signals/playback.ts';

/** Above this, the panel scrolls rather than pushing the rest of the sidebar off screen. */
const PANEL_MAX_HEIGHT = 260;

type TranscriptPanelProps = {
  /** VFS path of the media file, not of the transcript node. */
  path: string;
  /** The recording's voices, from media-details. Empty for one never voiceprinted. */
  speakers?: MediaSpeaker[];
  /** Saying who a voice is — see TranscriptSpeakers. Without these the voices are only listed. */
  canEdit?: boolean;
  onReviewPerson?: (personId: string) => void;
  onOpenPerson?: (personId: string) => void;
  onSpeakersChanged?: () => Promise<void> | void;
};

/**
 * What was said, as a list that follows the playhead.
 *
 * The cue under the playhead is highlighted and kept in view, and clicking any cue seeks
 * there. For an audio file this is the whole content of the file made readable and
 * skimmable; for a video it is the half the poster frame cannot show.
 *
 * Fetched rather than passed down, so an hour of speech never has to travel inside a details
 * response; the video player's subtitles share the request.
 */
export function TranscriptPanel({ path, speakers, canEdit = false, onReviewPerson, onOpenPerson, onSpeakersChanged }: TranscriptPanelProps) {
  useSignals();

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const activeRef = useRef<HTMLButtonElement | null>(null);

  // The URL the video player's subtitles ask for, version and all, so the two share one request.
  const url = bust(`${fileUrl(path)}/metadata/transcript`, versionOf(path));
  const { cues, failed } = useTranscriptCues(url);

  // Joined here rather than on the server: the words are already on the client, and the
  // voices are a handful per file.
  const spoken = useMemo(() => (cues ? attachSpeakers(cues, speakers ?? []) : null), [cues, speakers]);

  const position = playbackPosition.value;
  const active = cues ? activeCueIndex(cues, position) : -1;

  // Follow the playhead, but only within the panel — `scrollIntoView` on its own scrolls
  // every ancestor, which drags the whole sidebar around while a video plays.
  useEffect(() => {
    const node = activeRef.current;
    const viewport = viewportRef.current;
    if (!node || !viewport) return;

    const nodeTop = node.offsetTop;
    const nodeBottom = nodeTop + node.offsetHeight;
    if (nodeTop < viewport.scrollTop || nodeBottom > viewport.scrollTop + viewport.clientHeight) {
      viewport.scrollTo({ top: nodeTop - viewport.clientHeight / 3, behavior: 'smooth' });
    }
  }, [active]);

  if (failed) return <Text size='sm' c='dimmed'>Transcript unavailable.</Text>;
  if (!spoken) return <Loader size='xs' />;
  if (spoken.length === 0) return <Text size='sm' c='dimmed'>No speech was detected.</Text>;

  const seek = playbackSeek.value;

  return (
    <>
      {speakers && speakers.length > 0 && (
        <TranscriptSpeakers
          speakers={speakers}
          canEdit={canEdit && Boolean(onReviewPerson)}
          onReviewPerson={onReviewPerson ?? (() => {})}
          onOpenPerson={onOpenPerson ?? (() => {})}
          onChanged={onSpeakersChanged ?? (() => {})}
        />
      )}
      <ScrollArea.Autosize mah={PANEL_MAX_HEIGHT} viewportRef={viewportRef} type='auto'>
        <Box>
          {spoken.map((cue, index) => {
            const isActive = index === active;
            // Only when the speaker changes: a label on every line of a monologue is noise,
            // and what the reader is looking for is where the voice hands over.
            const changed = index === 0 || spoken[index - 1].speaker?.speaker !== cue.speaker?.speaker;
            return (
              <UnstyledButton
                key={`${cue.start}-${index}`}
                ref={isActive ? activeRef : undefined}
                // Without a player mounted there is nothing to seek, so the cue stays readable
                // but stops pretending to be a control.
                onClick={seek ? () => seek(cue.start) : undefined}
                style={{
                  display: 'block',
                  width: '100%',
                  padding: '2px 0',
                  cursor: seek ? 'pointer' : 'default',
                  textAlign: 'left',
                }}
              >
                <Text
                  component='span'
                  size='xs'
                  c='dimmed'
                  mr={6}
                  style={{ fontVariantNumeric: 'tabular-nums' }}
                >
                  {formatClock(cue.start)}
                </Text>
                {cue.speaker && changed && (
                  <Badge
                    component='span'
                    size='xs'
                    variant='light'
                    color={speakerColor(cue.speaker.speaker)}
                    mr={6}
                    style={{ verticalAlign: 'middle' }}
                  >
                    {speakerLabel(cue.speaker)}
                  </Badge>
                )}
                <Text component='span' size='sm' c={isActive ? undefined : 'dimmed'} fw={isActive ? 600 : undefined}>
                  {cue.text}
                </Text>
              </UnstyledButton>
            );
          })}
        </Box>
      </ScrollArea.Autosize>
    </>
  );
}
