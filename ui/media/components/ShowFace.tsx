import { ActionIcon, Tooltip } from '@mantine/core';
import { TablerIcon } from '@ein/ui/components';
import { formatClock } from '@ein/ui/lib';
import type { MediaFace } from '@archive/media/api';

/** The spans shown in a tooltip before the rest are counted. */
const SPANS_LISTED = 3;

/** `0:00–0:39, 0:42–1:28`, and how many more after the first few. */
export const onScreen = (appearances: [number, number][]): string => {
  const listed = appearances.slice(0, SPANS_LISTED).map(([start, end]) => `${formatClock(start)}–${formatClock(end)}`).join(', ');
  const more = appearances.length - SPANS_LISTED;
  return more > 0 ? `${listed} and ${more} more` : listed;
};

/**
 * A button in a person's or a face's row in a video's sidebar (`FaceRow`): the video paused on the
 * frame the face was seen most clearly in, with the face boxed, and the box following it from
 * there. Pressed again, it stops following. Nothing for a face no video moment holds.
 */
export function ShowFace({ face, name, onShow, followed }: {
  face?: MediaFace;
  name: string;
  onShow?: (facePath: string) => void;
  /** The face being followed. */
  followed?: string | null;
}) {
  if (!onShow || face?.atSeconds === undefined) return null;
  const following = followed === face.facePath;
  const seen = face.appearances && face.appearances.length > 0 ? ` · on screen ${onScreen(face.appearances)}` : '';
  const label = following ? `Stop following ${name}` : `Show ${name} at ${formatClock(face.atSeconds)}${seen}`;
  return (
    <Tooltip label={label} withinPortal multiline maw={320}>
      <ActionIcon
        size='sm'
        variant={following ? 'light' : 'subtle'}
        color={following ? 'marine' : 'gray'}
        aria-pressed={following}
        aria-label={`Show ${name} in the video`}
        onClick={() => onShow(face.facePath)}
      >
        <TablerIcon name='user-square-rounded' size={16} />
      </ActionIcon>
    </Tooltip>
  );
}
