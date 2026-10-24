import { ActionIcon, Badge, Group, Loader, Tooltip } from '@mantine/core';
import { useState } from 'react';
import { useSignals } from '@preact/signals-react/runtime';
import { TablerIcon } from '@ein/ui/components';
import { formatClock, shq } from '@ein/ui/lib';
import { execCommand } from '@ein/ui/signals';
import type { MediaSpeaker } from '@archive/media/api';
import { speakerColor, speakerLabel } from '../lib/vtt.ts';
import { playbackSeek } from '../signals/playback.ts';

type TranscriptSpeakersProps = {
  speakers: MediaSpeaker[];
  /** Whether the viewer may decide who a voice is. */
  canEdit: boolean;
  /** Review an unnamed person — name them, or merge them into someone who exists. */
  onReviewPerson: (personId: string) => void;
  /** Open a named person's page. */
  onOpenPerson: (personId: string) => void;
  /** The voices changed (one was given a person): read the details again. */
  onChanged: () => Promise<void> | void;
};

/** A voice's longest turn: where a listener hears the most of it at once. */
const longestTurn = (turns: [number, number][]): [number, number] | undefined =>
  turns.reduce<[number, number] | undefined>((best, turn) => (!best || turn[1] - turn[0] > best[1] - best[0] ? turn : best), undefined);

/**
 * The voices of a recording, one chip each: who it is (or "Speaker 2"), how long it speaks, a
 * button to hear its longest turn, and a click to say who it is.
 *
 * Saying who a voice is goes through the same review a face does: an unnamed person opens the
 * dialog where they are named or merged into someone known, and a voice no one has been decided
 * for first becomes a person of its own (`person-detach --to-new-person`), then opens it. A named
 * voice opens its person.
 */
export function TranscriptSpeakers({ speakers, canEdit, onReviewPerson, onOpenPerson, onChanged }: TranscriptSpeakersProps) {
  useSignals();
  const [busy, setBusy] = useState<string | null>(null);
  const seek = playbackSeek.value;

  const open = async (speaker: MediaSpeaker) => {
    if (speaker.personId && !speaker.unnamed) return onOpenPerson(speaker.personId);
    if (speaker.personId) return onReviewPerson(speaker.personId);
    if (!canEdit) return;
    setBusy(speaker.speakerPath);
    try {
      const result = await execCommand<{ person: { id?: string } | null }>(`person-detach --to-new-person ${shq(speaker.speakerPath)}`);
      await onChanged();
      if (result.person?.id) onReviewPerson(result.person.id);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Group gap={6} mb={6} wrap='wrap'>
      {speakers.map((speaker) => {
        const sample = longestTurn(speaker.turns);
        const named = Boolean(speaker.personId && !speaker.unnamed);
        const actionable = named || Boolean(speaker.personId) || canEdit;
        return (
          <Tooltip key={speaker.speakerPath} label={named ? 'Open this person' : 'Who is this?'} disabled={!actionable} withinPortal>
            <Badge
              variant='light'
              color={speakerColor(speaker.speaker)}
              tt='none'
              fw={500}
              style={{ cursor: actionable ? 'pointer' : 'default' }}
              onClick={actionable ? () => open(speaker) : undefined}
              leftSection={seek && sample
                ? (
                  <ActionIcon
                    size={14}
                    variant='transparent'
                    color={speakerColor(speaker.speaker)}
                    aria-label={`Hear ${speakerLabel(speaker)}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      seek(sample[0]);
                    }}
                  >
                    <TablerIcon name='player-play' size={10} />
                  </ActionIcon>
                )
                : undefined}
              rightSection={busy === speaker.speakerPath ? <Loader size={10} /> : undefined}
            >
              {speakerLabel(speaker)} · {formatClock(speaker.talkSeconds)}
            </Badge>
          </Tooltip>
        );
      })}
    </Group>
  );
}
