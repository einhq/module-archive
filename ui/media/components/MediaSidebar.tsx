/**
 * Lightbox info sidebar.
 *
 * The order is the order somebody looks for things in: what the file is, when it
 * was taken, what a person wrote about it, what took it and who owned that, the
 * albums holding it, who is in it, where it was, its other versions, what was said
 * about it — and only then, folded by default, "Details" with the machine-written
 * text and the hashes, and the EXIF dump.
 *
 * Every section is an icon beside a content column (`SidebarSection`), which keeps
 * it readable at a glance; the icon folds the section, and the fold is remembered.
 *
 * The `media-details` answer arrives as `result`: the face overlay draws from the
 * same response, and a read of its own would mean two round trips per photo.
 *
 * The panel stays mounted from one picture to the next, so a step updates only the rows that
 * change (ein/core#915). What belongs to the picture shown starts over when `media` changes: the
 * comment draft, the open menu and dialogs (the comment delete's confirmation too), the doubt question and the scroll; children that keep
 * state of their own for a picture are keyed by its path.
 */

import { CoverAvatar, HatField, MapMarkers, MapShape, MapView, type PositionShape, ScrollBox, SharingChip, TablerIcon, useMapEnlarged } from '@ein/ui/components';
import { Anchor, Badge, Box, Button, Group, Loader, Select, Stack, Text } from '@mantine/core';
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useAccessIds } from '@ein/ui/hooks';
import { canWrite, fileUrl, formatBytes, formatClock, formatDateTime, isGuest, thumbnailUrl } from '@ein/ui/lib';
import { SimilarMedia, useSimilarMedia } from './SimilarMedia.tsx';
import type { MediaDetails, MediaExif, MediaVersion, StackMemberRef, UseMediaDetailsResult } from '../hooks/useMediaDetails.ts';
import { MediaItem, notify, openTerminalTab, sharingChanged } from '@ein/ui/signals';
import { useSignals } from '@preact/signals-react/runtime';
import { mediaTerminalCommand } from '../lib/lightbox-presentation.ts';
import { faceKeyForPerson } from './FaceOverlay.tsx';
import { FaceRow } from './FaceRow.tsx';
import { PersonGlance, UnknownGlance } from './FaceGlance.tsx';
import { TranscriptPanel } from './TranscriptPanel.tsx';
import { albumRoute } from '../lib/album-path.ts';
import { timeSourceLabel } from '../lib/capture-time.ts';
import { qualifiedDate } from '@archive/people/date-qualifier';
import { FaceCrop } from '../../people/components/FaceCrop.tsx';
import { NodeLabels } from '../../components/NodeLabels.tsx';
import { StagedDuplicates } from '../../staging/components/StagedDuplicates.tsx';
import { restoredSteps } from './RestoredCompare.tsx';
import { setShownCopy } from '../lib/shown-copy.ts';
import { readingLine, readingSources } from '../../location/lib/weather.ts';
import { useRestoredCompare } from './FileActions.tsx';
import { UserText } from '../../components/UserText.tsx';
import { Comments } from '../../components/Comments.tsx';
import { SidebarSection, useSectionOpen } from './SidebarSection.tsx';
import './lightbox-side.css';

/** Wide enough for the iconed rows. */
export const SIDEBAR_WIDTH = 400;

/** In the reader's date and time format, as the lightbox's other times are. */
const TIMESTAMP: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' };

function formatTimestamp(ts?: number): string {
  return ts ? formatDateTime(ts, TIMESTAMP) : '';
}

/** Shutter speed reads as a fraction below a second, which is how every camera writes it. */
function formatExposure(seconds?: number): string {
  if (!seconds || seconds <= 0) return '';
  if (seconds >= 1) return `${Number(seconds.toFixed(2))} s`;
  return `1/${Math.round(1 / seconds)} s`;
}

/** An ownership span, open-ended at either end. */
function formatSpan(from?: string, to?: string): string {
  if (!from && !to) return '';
  return `${from ?? '…'}–${to ?? ''}`;
}

/**
 * The small facts, on one line under the filename: how big the picture is, how
 * many megapixels that comes to, and what the camera was set to. A document's
 * size is its first page's, in millimetres.
 *
 * One line rather than a stack of labelled rows because none of it is worth a
 * row of its own — it is the caption a photographer glances at, not data.
 */
function summaryLine(exif: MediaExif | null, media: MediaItem): string {
  const parts: string[] = [];

  const width = exif?.displayWidth ?? media.width;
  const height = exif?.displayHeight ?? media.height;
  if (width && height && media.type === 'document') {
    // Stored in points, 72 to the inch.
    parts.push(`${Math.round(width * 25.4 / 72)} × ${Math.round(height * 25.4 / 72)} mm`);
  } else if (width && height) {
    parts.push(`${width} × ${height}`);
    parts.push(`${((width * height) / 1e6).toFixed(1)} MP`);
  }
  if (exif?.iso !== undefined) parts.push(`ISO ${exif.iso}`);
  const exposure = formatExposure(exif?.exposure);
  if (exposure) parts.push(exposure);
  // Length belongs to anything with a running time, audio included; for audio it is often
  // the only fact on the line. Frame rate stays video's alone.
  if (media.type === 'video' || media.type === 'audio') {
    const duration = formatClock(exif?.duration ?? media.duration);
    if (duration) parts.push(duration);
  }
  if (media.type === 'video' && exif?.fps !== undefined) {
    parts.push(`${Number(exif.fps.toFixed(2))} fps`);
  }
  // The audio equivalents of ISO and exposure: what the recording actually is, rather than
  // what it is about. Only for audio — a video's soundtrack is not what this line describes.
  if (media.type === 'audio') {
    if (exif?.bitrate !== undefined) parts.push(`${Math.round(exif.bitrate / 1000)} kbps`);
    if (exif?.sampleRate !== undefined) parts.push(`${(exif.sampleRate / 1000).toFixed(1).replace(/\.0$/, '')} kHz`);
    const channels = formatChannels(exif?.channels);
    if (channels) parts.push(channels);
  }

  return parts.join(' · ');
}

/** Channel count as a word where there is one — "mono" reads better than "1 ch". */
function formatChannels(channels?: number): string {
  if (channels === undefined || !Number.isFinite(channels) || channels < 1) return '';
  if (channels === 1) return 'mono';
  if (channels === 2) return 'stereo';
  return `${channels} ch`;
}

/**
 * The languages offered for a picture's text: those with a handwriting transcriber (Swedish and
 * Finnish, English) and the neighbours an archive like this is likely to hold.
 */
const TEXT_LANGUAGES = ['sv', 'fi', 'en', 'da', 'no', 'de', 'fr'];

const languageName = (code: string): string => {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
};

/**
 * The language a picture's text is read in, and a choice of it: `auto` leaves it to EMS, which
 * tells it from the reading. A change reads the picture again on the media pool, so the text and
 * the language shown here follow a while later.
 */
function TextLanguage({ details, canEdit, onSet }: { details: MediaDetails; canEdit: boolean; onSet: (language: string) => Promise<void> }) {
  const [saving, setSaving] = useState(false);
  const read = details.contentLanguage;
  const readLabel = read ? `${languageName(read.code)}${read.confidence !== undefined ? ` (${Math.round(read.confidence * 100)}%)` : ''}` : null;
  const manual = details.contentLanguageManual;
  if (!canEdit) return <InfoRow label='Text language' value={readLabel ?? ''} />;
  const codes = manual && !TEXT_LANGUAGES.includes(manual) ? [...TEXT_LANGUAGES, manual] : TEXT_LANGUAGES;
  const choose = async (value: string | null) => {
    if (!value || value === (manual ?? 'auto')) return;
    setSaving(true);
    try {
      await onSet(value);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Box>
      <Text size='xs' c='dimmed'>Text language</Text>
      <Select
        size='xs'
        allowDeselect={false}
        disabled={saving}
        value={manual ?? 'auto'}
        onChange={(value) => void choose(value)}
        data={[
          { value: 'auto', label: readLabel && !manual ? `Automatic: ${readLabel}` : 'Automatic' },
          ...codes.map((code) => ({ value: code, label: languageName(code) })),
        ]}
        rightSection={saving ? <Loader size={12} /> : undefined}
      />
    </Box>
  );
}

/** What `find-damage` found, as the Damage row says it. */
const DAMAGE_WORDS: Record<string, string> = { faded: 'faded colours', dust: 'dust', scratches: 'scratches', blurred: 'out of focus', shaken: 'camera shake' };
const damageLabel = (kinds: string[]): string => {
  const words = kinds.map((kind) => DAMAGE_WORDS[kind] ?? kind).join(', ');
  return words ? words[0].toUpperCase() + words.slice(1) : 'None found';
};

function InfoRow({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <Box>
      <Text size='xs' c='dimmed'>{label}</Text>
      <Text size='sm' style={{ wordBreak: 'break-word' }}>{value}</Text>
    </Box>
  );
}

function StackSection({ details, selectedPath, canMutate, busy, onPreview, onAction }: {
  details: NonNullable<MediaDetails['albumStack']>;
  selectedPath: string;
  canMutate: boolean;
  busy: boolean;
  onPreview: (member: StackMemberRef) => void;
  onAction: (action: 'front' | 'separate' | 'allow', member: StackMemberRef) => Promise<void>;
}) {
  const selected = details.members.find((member) => member.path === selectedPath) ?? details.members[0];
  if (!selected) return null;
  return (
    <SidebarSection id='stack' label='Stack' icon='stack-2' count={details.members.length}>
      <Group justify='space-between' gap='xs'>
        <Text size='sm' fw={600}>{details.excluded ? 'Kept separate' : `${details.members.length} stacked photos`}</Text>
        {canMutate && (
          <Group gap={6}>
            {details.excluded ? <Button size='compact-xs' variant='light' loading={busy} onClick={() => onAction('allow', selected)}>Allow stacking</Button> : (
              <>
                {details.frontId !== selected.id && <Button size='compact-xs' variant='light' loading={busy} onClick={() => onAction('front', selected)}>Make front</Button>}
                <Button size='compact-xs' variant='subtle' color='gray' loading={busy} onClick={() => onAction('separate', selected)}>Keep separate</Button>
              </>
            )}
          </Group>
        )}
      </Group>
      {details.members.length > 1 && (
        <Box style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 4, scrollSnapType: 'x proximity' }}>
          {details.members.map((member) => {
            const isSelected = member.path === selectedPath;
            const isFront = member.id === details.frontId;
            return (
              <button
                type='button'
                key={member.id}
                onClick={() => onPreview(member)}
                aria-label={`Preview ${member.name}${isFront ? ', stack front' : ''}`}
                aria-pressed={isSelected}
                style={{
                  position: 'relative',
                  flex: '0 0 72px',
                  width: 72,
                  height: 72,
                  padding: 0,
                  border: `2px solid ${isSelected ? 'var(--mrx-accent)' : isFront ? 'var(--mantine-color-gray-5)' : 'transparent'}`,
                  borderRadius: 6,
                  overflow: 'hidden',
                  background: 'var(--mrx-media-bg)',
                  cursor: 'pointer',
                  scrollSnapAlign: 'start',
                }}
              >
                <img src={thumbnailUrl(member.path, true)} alt='' loading='lazy' style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                {isFront && <Badge size='xs' variant='filled' color='dark' style={{ position: 'absolute', left: 3, bottom: 3 }}>Front</Badge>}
              </button>
            );
          })}
        </Box>
      )}
    </SidebarSection>
  );
}

/** The description a person wrote, changed in the file's edit dialog. */
function DescriptionSection({ description }: { description: string }) {
  return (
    <SidebarSection id='description' label='Description' icon='file-description'>
      <UserText text={description} size='sm' />
    </SidebarSection>
  );
}

/**
 * What took the picture, and whose it was.
 *
 * The camera over `Owned by …`, with the photographer folded in — who pressed
 * the button belongs with what they pressed it on, not among
 * the people who happen to be *in* the frame.
 */
function CameraSection({ details, exif, onOpen }: {
  details: MediaDetails;
  exif: MediaExif | null;
  onOpen: (path: string) => void;
}) {
  const camera = details.camera;
  const exifCamera = [exif?.make, exif?.model].filter(Boolean).join(' ');
  if (!camera && !exifCamera && !details.photographer) return null;

  return (
    <SidebarSection id='camera' label='Camera' icon='camera'>
      {camera ? <Anchor size='sm' onClick={() => onOpen(camera.path)}>{camera.name}</Anchor> : exifCamera ? <Text size='sm'>{exifCamera}</Text> : null}

      {camera && camera.owners.length > 0 && (
        <Text size='xs' c='dimmed'>
          Owned by {camera.owners.map((owner, index) => (
            <span key={owner.path}>
              {index > 0 && ', '}
              <Anchor size='xs' inherit onClick={() => onOpen(`/people/${owner.id}`)}>{owner.name}</Anchor>
              {formatSpan(owner.from, owner.to) && ` (${formatSpan(owner.from, owner.to)})`}
            </span>
          ))}
        </Text>
      )}

      {details.photographer && (
        <Text size='xs' c='dimmed'>
          Shot by{' '}
          <Anchor size='xs' inherit onClick={() => onOpen(`/people/${details.photographer!.id}`)}>
            {details.photographer.name}
          </Anchor>
        </Text>
      )}
    </SidebarSection>
  );
}

/**
 * The file's other versions, such as the camera RAW of a JPEG or a restored copy: each a download,
 * with its type and size, and a restored copy what was done to it, a way to compare it and, for
 * whoever may change the file, to show it in the file's place or the file again.
 */
function VersionsSection({ versions, onCompare, onShow }: {
  versions: MediaVersion[];
  onCompare: (version: MediaVersion) => void;
  /** Show this copy in the file's place, or the file with null; absent for who may not. */
  onShow?: (name: string | null) => void;
}) {
  return (
    <SidebarSection id='versions' label='Versions' icon='versions' count={versions.length}>
      {versions.map((version) => (
        <Box key={version.path}>
          <Group gap={6} wrap='nowrap'>
            <TablerIcon name='download' size={14} style={{ flexShrink: 0, color: 'var(--mantine-color-dimmed)' }} />
            <Anchor href={fileUrl(version.path)} download={version.name} size='sm' style={{ wordBreak: 'break-word' }}>
              {version.name}
            </Anchor>
          </Group>
          <Text size='xs' c='dimmed'>
            {[version.mimetype, version.size !== undefined ? formatBytes(version.size) : ''].filter(Boolean).join(' · ')}
          </Text>
          {version.restored && (
            <Group gap={6} wrap='nowrap'>
              <Text size='xs' c='dimmed'>Restored: {restoredSteps(version.restored.steps)}</Text>
              <Anchor component='button' size='xs' onClick={() => onCompare(version)}>Compare</Anchor>
            </Group>
          )}
          {version.shown && (
            <Group gap={6} wrap='nowrap'>
              <Text size='xs' c='dimmed'>Shown in the archive</Text>
              {onShow && <Anchor component='button' size='xs' onClick={() => onShow(null)}>Show the original</Anchor>}
            </Group>
          )}
          {!version.shown && version.restored && version.thumbnails && onShow && (
            <Anchor component='button' size='xs' onClick={() => onShow(version.name)}>Show this copy</Anchor>
          )}
        </Box>
      ))}
    </SidebarSection>
  );
}

/** Where the picture was taken, as its shape; enlarged, the picture itself stands on the spot too. */
function PlaceSpot({ shape, media }: { shape: PositionShape; media: MediaItem }) {
  const enlarged = useMapEnlarged();
  return (
    <>
      <MapShape shape={shape} />
      {enlarged && <MapMarkers markers={[{ id: `spot-${media.id}`, lat: shape.lat, lng: shape.lng, label: media.name, thumbnailUrl: media.thumbnailUrl }]} />}
    </>
  );
}

export function MediaSidebar(
  {
    media,
    mobile = false,
    result,
    hoveredFace,
    onHoverFace,
    onNavigate,
    onReviewUnknown,
    onShowFace,
    followedFace,
    canEdit,
    stackBusy = false,
    onStackPreview,
    onStackAction,
    onLayer,
    headerActions,
    foot,
  }: {
    media: MediaItem;
    mobile?: boolean;
    result: UseMediaDetailsResult;
    hoveredFace?: string | null;
    onHoverFace?: (key: string | null) => void;
    /** Route navigation is owned by the lightbox so it can replace its history entry. */
    onNavigate: (path: string) => void;
    /** Keep unidentified-person review in the lightbox instead of changing route. */
    onReviewUnknown: (personId: string) => void;
    /** On a video: follow a face, from the frame it was seen most clearly in; the same face again stops. */
    onShowFace?: (facePath: string) => void;
    /** The face being followed, whose button shows it. */
    followedFace?: string | null;
    canEdit: boolean;
    stackBusy?: boolean;
    onStackPreview: (member: StackMemberRef) => void;
    onStackAction: (action: 'front' | 'separate' | 'allow', member: StackMemberRef) => Promise<void>;
    /** A dialog of the sidebar's opened or closed over the lightbox, which leaves it the keys while open. */
    onLayer: (open: boolean) => void;
    /** Buttons at the right of the file's name, the panel's top right corner. */
    headerActions?: ReactNode;
    /** A row under what scrolls, at the panel's foot; the panel's pattern runs down behind it. */
    foot?: ReactNode;
  },
) {
  useSignals();
  const access = useAccessIds();
  // Asked here rather than in the strip, so a picture with nothing like it has no row at all.
  const similar = useSimilarMedia(media.type === 'audio' ? undefined : media.path);
  const { details, addComment, removeComment, setTextLanguage, rawExif, loadRawExif, rawExifLoading } = result;
  const restoredCompare = useRestoredCompare({ media, result, canEdit });
  /** The person row whose doubt question is open. */
  const [asking, setAsking] = useState<string | null>(null);
  /** A comment's delete waits to be confirmed. */
  const [confirmingComment, setConfirmingComment] = useState(false);
  /** The place's map is enlarged over the lightbox, which leaves it Escape. */
  const [mapEnlarged, setMapEnlarged] = useState(false);
  const [shownPath, setShownPath] = useState(media.path);
  if (shownPath !== media.path) {
    setShownPath(media.path);
    setAsking(null);
    setConfirmingComment(false);
  }
  const scrollRef = useRef<HTMLDivElement>(null);
  // A block, not an expression: newer browsers' scrollTo returns a promise, which React would take
  // for the effect's cleanup and call.
  useLayoutEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [media.path]);
  useEffect(() => onLayer(restoredCompare.open || asking !== null || confirmingComment || mapEnlarged), [restoredCompare.open, asking, confirmingComment, mapEnlarged]);
  // The chip under the name says how the file is shared; read again when its sharing, or that of
  // a folder above it, changes.
  const changed = sharingChanged.value;
  useEffect(() => {
    if (changed && (changed.path === media.path || media.path.startsWith(`${changed.path}/`))) void result.refetch();
  }, [changed]);
  const [exifOpen] = useSectionOpen('exif', false);
  // The exiftool dump is bigger than everything else in the sidebar put together, so it is
  // fetched only while its section is open — including when it was open from the start because
  // it was remembered, in which case `loadRawExif` has to run on mount and on every new file.
  useEffect(() => {
    if (exifOpen) loadRawExif();
  }, [exifOpen, loadRawExif]);

  const position = details?.position ?? null;
  const weatherLine = position?.weather && readingLine(position.weather);
  const location = details?.location ?? null;
  const albums = details?.albums ?? [];
  const people = details?.people ?? [];
  const unknownFaces = details?.unknownFaces ?? [];
  const faces = details?.faces ?? [];
  const comments = details?.comments ?? [];
  const versions = details?.versions ?? [];
  const shownCopy = versions.find((version) => version.shown);
  /** Show the copy `name` in the picture's place, or the picture again with null. */
  const showCopy = async (name: string | null) => {
    try {
      await setShownCopy(media.path, name);
    } catch (err) {
      notify({ color: 'red', message: err instanceof Error ? err.message : String(err) });
    }
    void result.refetch();
  };
  const exif = details?.exif ?? null;
  const albumStack = details?.albumStack;
  const canMutateStack = !!albumStack && albumStack.membersComplete && canWrite(albumStack.albumOwnership, access) &&
    albumStack.members.every((member) => canWrite(member.ownership, access));

  // A file may have GPS of its own, or only a link to a location that has coordinates. Either is
  // enough to draw the map; the file's own point wins when both exist.
  const mapPoint = position ?? (location?.lat !== undefined && location?.lng !== undefined ? { lat: location.lat, lng: location.lng, radius: location.radius } : null);

  const originalUrl = fileUrl(media.path);
  const summary = summaryLine(exif, media);
  const openPathInTerminal = () => openTerminalTab(mediaTerminalCommand(media.path));

  // The pattern at the panel's foot lies behind the scrolling details, or with a `foot` row behind
  // the frame that holds both, so it reaches the bottom edge.
  const ground = (
    <Box className='mrx-sidebar-foot'>
      <HatField pattern='neutral' kind='foot' />
    </Box>
  );
  const scroller = (
    <ScrollBox
      data-media-sidebar
      viewportRef={scrollRef}
      frameStyle={foot ? { flex: '1 1 0', minHeight: 0 } : {
        width: mobile ? '100%' : SIDEBAR_WIDTH,
        minWidth: mobile ? 0 : SIDEBAR_WIDTH,
        flex: mobile ? '1 1 100%' : undefined,
        height: mobile ? '100%' : undefined,
        maxHeight: mobile ? '100%' : undefined,
        background: 'var(--mrx-surface-raised)',
        isolation: 'isolate',
      }}
      ground={foot ? undefined : ground}
      style={{
        overflowY: mobile ? 'scroll' : 'auto',
        overscrollBehavior: 'contain',
        touchAction: 'pan-y',
        WebkitOverflowScrolling: 'touch',
      }}
    >
      <Stack p='lg' gap='xl'>
        {/* Identity: the filename is the download, and the lightbox's buttons sit beside it. */}
        <Group justify='space-between' gap='xs' wrap='nowrap' align='flex-start'>
          <Box style={{ minWidth: 0 }}>
            <Group gap={6} wrap='nowrap'>
              <TablerIcon name='download' size={14} style={{ flexShrink: 0, color: 'var(--mantine-color-dimmed)' }} />
              <Anchor href={originalUrl} download={media.name} fw={600} size='sm' style={{ wordBreak: 'break-word' }}>
                {media.name}
              </Anchor>
              {
                /* An unknown size stays absent rather than showing formatBytes'
                  em dash in parentheses next to the name. */
              }
              {(details?.size ?? media.size) !== undefined && (
                <Text size='xs' c='dimmed' style={{ whiteSpace: 'nowrap' }}>
                  ({formatBytes(details?.size ?? media.size)})
                </Text>
              )}
            </Group>
            {summary && <Text size='xs' c='dimmed' mt={4}>{summary}</Text>}
            {shownCopy && (
              <Text size='xs' c='dimmed' mt={4}>
                Shown as its restored copy, {shownCopy.name}
                {canEdit && (
                  <>
                    {' · '}
                    <Anchor component='button' size='xs' onClick={() => void showCopy(null)}>Show the original</Anchor>
                  </>
                )}
              </Text>
            )}
            <Group gap='xs' mt={8} wrap='wrap'>
              {/* A visitor is not told who else may see it. */}
              {details && access && !isGuest(access) && <SharingChip path={media.path} ownership={details.ownership} />}
              <NodeLabels path={media.path} />
            </Group>
          </Box>

          {headerActions && <Group gap={4} wrap='nowrap' style={{ flexShrink: 0 }}>{headerActions}</Group>}
        </Group>

        {details?.description && <DescriptionSection description={details.description} />}

        {/* A staged file's copies and look-alikes: what the reader decides on while sorting an import. */}
        <StagedDuplicates
          key={media.path}
          path={media.path}
          row={(children) => <SidebarSection id='duplicates' label='Copies' icon='copy'>{children}</SidebarSection>}
          onLayer={onLayer}
        />

        {
          /*
          Above the camera and below the description, not folded into "Details" with the other
          machine-written text. For an audio file the transcript *is* the content of the
          file, and for a video it is the half the poster cannot show — which puts it with
          the things someone came here to read rather than with the forensics.
        */
        }
        {details?.hasTranscript && (
          <SidebarSection id='transcript' label='Transcript' icon='blockquote'>
            <TranscriptPanel
              key={details.path}
              path={details.path}
              speakers={details.speakers}
              canEdit={canEdit}
              onReviewPerson={onReviewUnknown}
              onOpenPerson={(personId) => onNavigate(`/people/${personId}`)}
              onSpeakersChanged={result.refetch}
            />
          </SidebarSection>
        )}

        {details && (details.camera || details.photographer || exif?.model) && <CameraSection details={details} exif={exif} onOpen={onNavigate} />}

        {albums.length > 0 && (
          <SidebarSection id='albums' label='Albums' icon='books' count={albums.length}>
            {albums.map((album) => (
              <Group key={album.id} gap='xs' wrap='nowrap'>
                <CoverAvatar
                  path={album.path}
                  fallback={<TablerIcon name='books' size={16} />}
                  size={32}
                  radius='sm'
                  alt={album.name}
                />
                <Anchor size='sm' style={{ flex: 1, wordBreak: 'break-word' }} onClick={() => onNavigate(albumRoute(album.path))}>
                  {album.name}
                </Anchor>
              </Group>
            ))}
          </SidebarSection>
        )}

        {(people.length > 0 || unknownFaces.length > 0) && (
          <SidebarSection id='people' label='People' icon='users' count={people.length + unknownFaces.length}>
            {people.map((person) => (
              <FaceRow
                key={person.path}
                name={person.name}
                glance={<PersonGlance person={person} />}
                videoFace={faces.find((face) => face.personPath === person.path && face.atSeconds !== undefined)}
                personFace={faces.find((face) => face.personPath === person.path && face.doubt) ?? faces.find((face) => face.personPath === person.path)}
                canEdit={canEdit}
                mobile={mobile}
                // Hovering a name lights up that person's box on the image, and vice versa.
                highlighted={hoveredFace === faceKeyForPerson(person.path)}
                onPointer={(inside) => person.faceBox && onHoverFace?.(inside ? faceKeyForPerson(person.path) : null)}
                asking={asking === person.path}
                onAsk={(open) => setAsking(open ? person.path : null)}
                onShowFace={onShowFace}
                followed={followedFace}
                onChanged={result.refetch}
              >
                {/* The initial rather than a generic icon: in a list of names it identifies. */}
                <CoverAvatar
                  path={person.path}
                  fallback={person.name.charAt(0).toUpperCase()}
                  size={32}
                  alt={person.name}
                />
                <Anchor size='sm' style={{ flex: 1, wordBreak: 'break-word' }} onClick={() => onNavigate(`/people/${person.id}`)}>
                  {person.name}
                </Anchor>
                {person.age !== undefined && (
                  <Badge size='sm' variant='light' color='blue' tt='none' fw={500}>
                    {person.ageApprox ? '~' : ''}
                    {person.age === 0 && person.ageMonths !== undefined ? `${person.ageMonths} months` : `${person.age} years`}
                  </Badge>
                )}
              </FaceRow>
            ))}

            {
              /* Recognized as somebody, but nobody has said who. Shown as crops rather
                  than a bare count so it is visible *where in the picture* they are —
                  hovering one lights up its box, exactly like a named person's row. */
            }
            {unknownFaces.map((face) => (
              <FaceRow
                key={face.faceId}
                name={face.personName}
                glance={<UnknownGlance face={face} />}
                videoFace={faces.find((candidate) => candidate.faceId === face.faceId)}
                unknown={{ face: faces.find((candidate) => candidate.faceId === face.faceId), onName: () => onReviewUnknown(face.personId) }}
                canEdit={canEdit}
                mobile={mobile}
                highlighted={hoveredFace === `u-${face.faceId}`}
                onPointer={(inside) => face.faceBox && onHoverFace?.(inside ? `u-${face.faceId}` : null)}
                onShowFace={onShowFace}
                followed={followedFace}
                onChanged={result.refetch}
              >
                <FaceCrop facePath={face.facePath} size={32} alt={face.personName} lazy />
                <Anchor
                  size='sm'
                  style={{ flex: 1, wordBreak: 'break-word' }}
                  onClick={() => onReviewUnknown(face.personId)}
                >
                  {face.personName}
                </Anchor>
              </FaceRow>
            ))}
          </SidebarSection>
        )}

        {(mapPoint || location) && (
          <SidebarSection id='place' label={location?.name ?? 'Place'} icon='map-pin'>
            {location && (
              <Anchor size='sm' onClick={() => onNavigate(`/locations/${location.id}`)}>
                {location.name}
              </Anchor>
            )}
            {position?.address && <Text size='xs' c='dimmed'>{position.address}</Text>}
            {mapPoint && (
              // Small: the spot alone, and a button that enlarges it over the lightbox with the pickers.
              <Box className='mrx-sidebar-map' style={{ position: 'relative', borderRadius: 4, overflow: 'hidden' }}>
                <MapView
                  center={mapPoint}
                  zoom={14}
                  controls={{ fullscreen: true }}
                  title={location?.name ?? 'Where it was taken'}
                  onEnlargedChange={setMapEnlarged}
                  style={{ height: 240, minHeight: 240 }}
                >
                  <PlaceSpot shape={mapPoint} media={media} />
                </MapView>
              </Box>
            )}
          </SidebarSection>
        )}

        {weatherLine && (
          <SidebarSection id='weather' label='Weather' icon='cloud'>
            <Text size='sm'>{weatherLine}</Text>
            <Text size='xs' c='dimmed'>{readingSources(position!.weather!)}</Text>
          </SidebarSection>
        )}

        {albumStack && (
          <StackSection
            details={albumStack}
            selectedPath={media.path}
            canMutate={canMutateStack}
            busy={stackBusy}
            onPreview={onStackPreview}
            onAction={onStackAction}
          />
        )}

        {versions.length > 0 && <VersionsSection versions={versions} onCompare={restoredCompare.compare} onShow={canEdit ? (name) => void showCopy(name) : undefined} />}

        {similar?.length !== 0 && (
          <SidebarSection id='similar' label='Similar' icon='photo-search'>
            <SimilarMedia path={media.path} similar={similar} onNavigate={onNavigate} />
          </SidebarSection>
        )}

        {
          /* A comment is written under the picture, as its author: for whoever may change the
            picture. Everyone else reads them, and sees no row where there are none. */
        }
        {(comments.length > 0 || canEdit) && (
          <SidebarSection id='comments' label='Comments' icon='messages' count={comments.length}>
            <Comments
              key={media.path}
              comments={comments}
              writable={canEdit}
              onAdd={addComment}
              onRemove={removeComment}
              onDialog={setConfirmingComment}
            />
          </SidebarSection>
        )}

        {
          /* Everything a reader does not need but an investigator does: what the
            machines wrote about the file, and what identifies it. Folded until opened. */
        }
        <SidebarSection id='details' label='Details' icon='info-circle' defaultOpen={false} gap='sm'>
          {/* The guest has no terminal to open it in. */}
          {isGuest(access) ? <InfoRow label='Path' value={media.path} /> : (
            <Box>
              <Group gap={6} wrap='nowrap'>
                <TablerIcon name='terminal-2' size={14} style={{ flexShrink: 0, color: 'var(--mantine-color-dimmed)' }} />
                <Text size='xs' c='dimmed'>Path</Text>
              </Group>
              <Anchor
                component='button'
                type='button'
                size='sm'
                ta='left'
                title='Open a new terminal tab here'
                onClick={openPathInTerminal}
                style={{ display: 'block', wordBreak: 'break-all' }}
              >
                {media.path}
              </Anchor>
            </Box>
          )}
          {details?.content && (
            <Box>
              <Text size='xs' c='dimmed'>Text in image</Text>
              {/* A scanned page can run to thousands of characters; keep it in its own scroll. */}
              <Text size='sm' c='dimmed' style={{ whiteSpace: 'pre-wrap', maxHeight: 240, overflowY: 'auto' }}>
                {details.content}
                {details.contentTruncated ? '…' : ''}
              </Text>
            </Box>
          )}
          {details && details.mimetype?.startsWith('image/') && (details.content || details.contentLanguageManual) && (
            <TextLanguage key={details.path} details={details} canEdit={canEdit} onSet={setTextLanguage} />
          )}

          <InfoRow label='Type' value={details?.mimetype ?? media.mimetype ?? ''} />
          {
            /* The stored capture time verbatim — precision, offset and all — since the
              caption above the picture renders it for reading, and this is where one
              checks what the record actually says. */
          }
          <InfoRow label='Taken at' value={qualifiedDate(details?.takenAt ?? media.takenAt ?? '', details?.takenAtQualifier)} />
          <InfoRow label='Taken at (UTC)' value={details?.takenAtUtc ?? ''} />
          <InfoRow label='Time source' value={[timeSourceLabel(details?.takenAtSource, details?.digitized), details?.takenAtNote].filter(Boolean).join(' · ')} />
          {details?.damage && <InfoRow label='Damage' value={damageLabel(details.damage.kinds)} />}
          {details?.restoring && <InfoRow label='Restoring' value={details.restoring.failed ? `Failed: ${details.restoring.failed}` : 'Queued, waiting its turn'} />}
          <InfoRow label='Created' value={formatTimestamp(media.birthtime)} />
          <InfoRow label='Modified' value={formatTimestamp(media.modtime)} />
          {
            /* Whichever hashes the file has: sha256, md5, sha1. */
          }
          {Object.entries(details?.hashes ?? {}).map(([name, value]) => <InfoRow key={name} label={name} value={value} />)}
        </SidebarSection>

        {
          /* The exiftool dump, one row per tag, in the same shape as the rows in Details.
            Folded until opened, and fetched only then. */
        }
        {details && (
          <SidebarSection id='exif' label='EXIF' icon='aperture' defaultOpen={false} gap='sm'>
            {rawExifLoading && <Loader size='xs' />}
            {rawExif && Object.keys(rawExif).length === 0 && !rawExifLoading && <Text size='xs' c='dimmed'>No EXIF recorded</Text>}
            {rawExif &&
              Object.entries(rawExif).map(([key, value]) => <InfoRow key={key} label={key} value={typeof value === 'object' ? JSON.stringify(value) : String(value)} />)}
          </SidebarSection>
        )}
      </Stack>
      {restoredCompare.dialog}
    </ScrollBox>
  );
  if (!foot) return scroller;
  return (
    <Box className='mrx-media-sidebar-framed' style={{ width: SIDEBAR_WIDTH }}>
      {ground}
      {scroller}
      {foot}
    </Box>
  );
}
