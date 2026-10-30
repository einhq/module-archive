import { SetCoverAction } from '../../media/components/SetCoverAction.tsx';
import { MediaGrid, MediaSelectionBar, MoreLoader, TablerIcon } from '@ein/ui/components';
import { Alert, Box, Group, SegmentedControl, Text } from '@mantine/core';
import { type ReactNode, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { type PersonFace, usePersonFaces } from '../hooks/usePersonFaces.ts';
import { forgetCover, useLoadMoreSentinel, useMediaSelection } from '@ein/ui/hooks';
import type { PersonEntry } from '../hooks/usePeople.ts';
import { forgetSubjectFacets } from '../../hooks/useSubjectFacets.ts';
import { FACE_CROP_NAME } from '../lib/face-crop.ts';
import { mediaItemFrom, shq } from '@ein/ui/lib';
import { execCommand, MediaItem } from '@ein/ui/signals';
import { NotThisPersonAction } from './NotThisPersonAction.tsx';
import type { FaceDoubtView } from '@archive/people/api';
import { ConfirmFacesAction } from './ConfirmFacesAction.tsx';

/** Faces are small pictures; at the photo grid's row height a crop is upscaled past its pixels. */
const FACE_ROW_HEIGHT = 140;

type Props = {
  person: { path: string; name: string };
  /** Named people, for moving a face to the person it really is. */
  named: PersonEntry[];
};

/** `IMG_4021-face-0.avif`: a crop saved to disk should still say which photo it came from. */
const cropName = (face: PersonFace): string => {
  const [photo, , faceName] = face.facePath.split('/').slice(-3);
  return `${photo.replace(/\.[^.]+$/, '')}-${faceName}.avif`;
};

/** Under a doubtful face: who asked, or who it looks like. */
const doubtBadge = (doubt: FaceDoubtView): ReactNode => (
  <Text className='mrx-tile-badge' component='span' size='xs' fw={600} px={7} py={2} truncate>
    {'markedBy' in doubt ? `asked by ${doubt.markedBy}` : `like ${doubt.likeName}`}
  </Text>
);

/**
 * Every face assigned to a person, as a grid of their crops.
 *
 * The tiles are the crops — the one picture known to show this person and nobody else — so a
 * selection downloads crops and "Set as cover" links one. Opening a tile shows the photo the
 * face was cut from instead, since that is what a click on a face is asking for; the lightbox
 * steps through the photos in the same order as the grid. "Not <name>" takes wrong faces off.
 *
 * The faces arrive a page at a time as the grid scrolls. Selection, select-all and the
 * lightbox cover the loaded ones, so the count above the grid says when that is not all.
 *
 * When faces of this person are in question — somebody marked them doubtful, or an audit found
 * them looking more like somebody else — a switch (`?faces=doubtful`) lists only those, the ones
 * somebody asked about first, each labelled with who asked or who it looks like. The reviewer
 * takes the wrong ones off with "Not <name>", which offers the look-alike, and keeps the rest
 * with "Is <name>".
 */
export function PersonFacesTab({ person, named }: Props) {
  const [searchParams, setSearchParams] = useSearchParams();
  const onlyDoubtful = searchParams.get('faces') === 'doubtful';
  const showDoubtful = (on: boolean) =>
    setSearchParams((params) => {
      if (on) params.set('faces', 'doubtful');
      else params.delete('faces');
      return params;
    }, { replace: true });
  const { faces, total, doubtful, loading, loadingMore, hasMore, loadMore, error, refetch, removeFaces } = usePersonFaces(person.path, { doubtful: onlyDoubtful });
  const sentinelRef = useLoadMoreSentinel(hasMore && !error, loading || loadingMore, loadMore);

  /**
   * Faces left this person. If one of them was the cover, the cover now shows somebody else,
   * so `person-cover` is asked straight away rather than at the next sweep.
   */
  const afterDetach = (facePaths: string[]) => {
    if (facePaths.length > 0) removeFaces(facePaths);
    else refetch();
    // A face that left may have taken its photo out of this person's media.
    forgetSubjectFacets();
    execCommand(`person-cover ${shq(person.path)}`).then(() => forgetCover(person.path)).catch(() => {});
  };

  const crops = useMemo<MediaItem[]>(
    () =>
      faces.map((face) =>
        mediaItemFrom({
          path: `${face.facePath}/${FACE_CROP_NAME}`,
          name: cropName(face),
          mimetype: 'image/avif',
          hasDerivatives: false,
          // A crop has no rotation of its own: it is cut from the display frame.
          width: face.cropWidth,
          height: face.cropHeight,
          takenAt: face.takenAt,
        })
      ),
    [faces],
  );

  const photos = useMemo<MediaItem[]>(
    () =>
      faces.map((face, index) =>
        face.filePath
          ? mediaItemFrom({
            path: face.filePath,
            mimetype: face.mimetype,
            width: face.width,
            height: face.height,
            angle: face.angle,
            takenAt: face.takenAt,
          })
          : crops[index]
      ),
    [faces, crops],
  );

  const selection = useMediaSelection(crops);
  const tags = useMemo(() => new Set(faces.filter((face) => !face.hasFace).map((face) => face.facePath)), [faces]);
  const doubtOf = useMemo(() => new Map(faces.filter((face) => face.doubt).map((face) => [`${face.facePath}/${FACE_CROP_NAME}`, face.doubt!])), [faces]);
  // The person the whole selection looks like, if it is one person.
  const suggested = useMemo(() => {
    const likes = new Set([...selection.selected].map((path) => {
      const doubt = doubtOf.get(path);
      return doubt && 'likePath' in doubt ? doubt.likePath : undefined;
    }));
    const [only] = likes;
    return likes.size === 1 ? only : undefined;
  }, [selection.selected, doubtOf]);

  if (error) {
    return <Alert color='red' icon={<TablerIcon name='alert-circle' size={16} />} variant='light'>{error.message}</Alert>;
  }
  const listSwitch = (doubtful > 0 || onlyDoubtful) && (
    <SegmentedControl
      size='xs'
      value={onlyDoubtful ? 'doubtful' : 'all'}
      onChange={(value) => showDoubtful(value === 'doubtful')}
      data={[{ value: 'all', label: 'All faces' }, { value: 'doubtful', label: `Doubtful (${doubtful.toLocaleString()})` }]}
    />
  );
  if (!loading && faces.length === 0) {
    return (
      <>
        {listSwitch && <Group mb='xs'>{listSwitch}</Group>}
        <Text c='dimmed'>
          {onlyDoubtful ? `No doubtful faces of ${person.name} left.` : `No faces of ${person.name} yet. They appear here once a detected face is assigned to them.`}
        </Text>
      </>
    );
  }

  return (
    <>
      {(listSwitch || hasMore) && (
        <Group mb='xs' gap='sm'>
          {listSwitch}
          {onlyDoubtful && (
            <Text size='sm' c='dimmed'>
              Faces somebody is not sure of, or that look more like somebody else. Select the ones that are {person.name}, or take the rest off.
            </Text>
          )}
          {hasMore && (
            <Text size='sm' c='dimmed'>
              {faces.length.toLocaleString()} of {total.toLocaleString()} loaded
            </Text>
          )}
        </Group>
      )}
      <MediaGrid
        items={crops}
        lightboxItems={photos}
        selection={selection}
        targetRowHeight={FACE_ROW_HEIGHT}
        loading={loading}
        renderOverlay={doubtOf.size > 0 ? (item) => doubtOf.has(item.path) ? doubtBadge(doubtOf.get(item.path)!) : null : undefined}
        bleed
      />
      {hasMore && !loading && !loadingMore && <Box ref={sentinelRef} h={1} />}
      {loadingMore && <MoreLoader />}
      <MediaSelectionBar
        selection={selection}
        items={crops}
        onRemoved={() => {}}
        removable={false}
        archiveName={`${person.name} faces`}
        actions={
          <>
            <SetCoverAction selection={selection} items={crops} owner={person.path} />
            {onlyDoubtful && <ConfirmFacesAction selection={selection} items={crops} person={person} onApplied={() => refetch()} />}
            <NotThisPersonAction selection={selection} items={crops} tags={tags} person={person} named={named} suggested={suggested} onApplied={afterDetach} />
          </>
        }
      />
    </>
  );
}
