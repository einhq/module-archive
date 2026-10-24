import { ActionIcon, Tooltip } from '@mantine/core';
import { TablerIcon } from '@ein/ui/components';
import { formatClock } from '@ein/ui/lib';
import type { MediaFace } from '@archive/media/api';

/** The spans shown in a tooltip before the rest are counted. */
const SPANS_LISTED = 3;

/** `0:00–0:39, 0:42–1:28`, and how many more after the first few. */
const onScreen = (appearances: [number, number][]): string => {
  const listed = appearances.slice(0, SPANS_LISTED).map(([start, end]) => `${formatClock(start)}–${formatClock(end)}`).join(', ');
  const more = appearances.length - SPANS_LISTED;
  return more > 0 ? `${listed} and ${more} more` : listed;
};

/**
 * A button beside a person or a face in a video's sidebar: the video paused on the frame the
 * face was seen most clearly in, with the face boxed. Nothing for a face no video moment holds.
 */
export function ShowFace({ face, name, onShow }: { face?: MediaFace; name: string; onShow?: (facePath: string) => void }) {
  if (!onShow || face?.atSeconds === undefined) return null;
  const seen = face.appearances && face.appearances.length > 0 ? ` · on screen ${onScreen(face.appearances)}` : '';
  return (
    <Tooltip label={`Show ${name} at ${formatClock(face.atSeconds)}${seen}`} withinPortal multiline maw={320}>
      <ActionIcon size='sm' variant='subtle' color='gray' aria-label={`Show ${name} in the video`} onClick={() => onShow(face.facePath)}>
        <TablerIcon name='user-square-rounded' size={16} />
      </ActionIcon>
    </Tooltip>
  );
}
