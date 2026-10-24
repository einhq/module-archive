/**
 * Lightbox info sidebar.
 *
 * The order is the order somebody looks for things in: what the file is, when it
 * was taken, what a person wrote about it, what took it and who owned that, the
 * albums holding it, who is in it, where it was, what was said about it — and
 * only then, folded away under "Details", the machine-written text and the
 * forensics (EXIF, hashes).
 *
 * Every section is an icon beside a content column, which keeps it readable at a
 * glance.
 *
 * The `media-details` answer arrives as `result`: the face overlay draws from the
 * same response, and a read of its own would mean two round trips per photo.
 */

import { CoverAvatar, HatField, MapShape, MapView, ScrollBox, SharingChip, TablerIcon } from '@ein/ui/components';
import { Accordion, ActionIcon, Anchor, Badge, Box, Button, Group, Loader, Menu, Select, Stack, Text, Textarea } from '@mantine/core';
import { type ReactNode, useEffect, useState } from 'react';
import { useAccessIds } from '@ein/ui/hooks';
import { canWrite, fileUrl, formatBytes, formatClock, isGuest, thumbnailUrl } from '@ein/ui/lib';
import { SimilarMedia, useSimilarMedia } from './SimilarMedia.tsx';
import type { CommentEntry, MediaDetails, MediaExif, OrientationChange, StackMemberRef, UseMediaDetailsResult } from '../hooks/useMediaDetails.ts';
import { MediaItem, openShareModal, openTerminalTab, shareModalPath, sharingChanged } from '@ein/ui/signals';
import { useSignals } from '@preact/signals-react/runtime';
import { mediaTerminalCommand } from '../lib/lightbox-presentation.ts';
import { faceKeyForPerson } from './FaceOverlay.tsx';
import { ShowFace } from './ShowFace.tsx';
import { TranscriptPanel } from './TranscriptPanel.tsx';
import { albumRoute } from '../lib/album-path.ts';
import { timeSourceLabel } from '../lib/capture-time.ts';
import { FaceCrop } from '../../people/components/FaceCrop.tsx';
import { NodeLabels } from '../../components/NodeLabels.tsx';
import { StagedDuplicates } from '../../staging/components/StagedDuplicates.tsx';
import { MediaEditModal } from './MediaEditModal.tsx';
import { LightboxActionItems } from './LightboxActionItems.tsx';
import { UserText } from '../../components/UserText.tsx';

/** Wide enough for the iconed rows. */
export const SIDEBAR_WIDTH = 400;

const SECTION_ICON_SIZE = 32;

function formatTimestamp(ts?: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
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
 * many megapixels that comes to, and what the camera was set to.
 *
 * One line rather than a stack of labelled rows because none of it is worth a
 * row of its own — it is the caption a photographer glances at, not data.
 */
function summaryLine(exif: MediaExif | null, media: MediaItem): string {
  const parts: string[] = [];

  const width = exif?.displayWidth ?? media.width;
  const height = exif?.displayHeight ?? media.height;
  if (width && height) {
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
 * Whether the Details fold is open. An investigator who opened it wants it open on the next
 * photograph too, and on the next visit, so it is remembered in localStorage until closed by
 * hand. Only the fold: the sidebar itself follows the screen size, not a saved preference.
 */
const DETAILS_OPEN_KEY = 'ein.lightbox.detailsOpen';

function readDetailsOpen(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(DETAILS_OPEN_KEY) === '1';
  } catch {
    return false;
  }
}

function writeDetailsOpen(open: boolean): void {
  try {
    if (typeof localStorage === 'undefined') return;
    if (open) localStorage.setItem(DETAILS_OPEN_KEY, '1');
    else localStorage.removeItem(DETAILS_OPEN_KEY);
  } catch {
    // Storage may be full or disabled; the fold still works, it just is not remembered.
  }
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

function InfoRow({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <Box>
      <Text size='xs' c='dimmed'>{label}</Text>
      <Text size='sm' style={{ wordBreak: 'break-word' }}>{value}</Text>
    </Box>
  );
}

/**
 * One section: a fixed icon gutter with the content beside it.
 *
 * The gutter is what makes the sections scannable — the eye runs down a column
 * of icons rather than reading every heading.
 */
function IconRow({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <Group align='flex-start' gap='sm' wrap='nowrap'>
      <Box style={{ flex: `0 0 ${SECTION_ICON_SIZE}px`, color: 'var(--mantine-color-dimmed)' }}>{icon}</Box>
      <Stack gap={6} style={{ flex: 1, minWidth: 0 }}>{children}</Stack>
    </Group>
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
    <IconRow icon={<TablerIcon name='stack-2' size={SECTION_ICON_SIZE} />}>
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
    </IconRow>
  );
}

function CommentRow({ comment, canDelete, onDelete }: {
  comment: CommentEntry;
  canDelete: boolean;
  onDelete: () => void;
}) {
  return (
    <Box>
      <Group justify='space-between' gap='xs' wrap='nowrap'>
        <Text size='xs' c='dimmed'>
          {comment.author}
          {comment.createdAt ? ` · ${formatTimestamp(comment.createdAt)}` : ''}
        </Text>
        {canDelete && (
          <ActionIcon variant='subtle' color='gray' size='sm' onClick={onDelete} aria-label='Delete comment'>
            <TablerIcon name='trash' size={14} />
          </ActionIcon>
        )}
      </Group>
      <Text size='sm' style={{ whiteSpace: 'pre-wrap' }}>{comment.body}</Text>
    </Box>
  );
}

/** The description a person wrote, changed in the file's edit dialog. */
function DescriptionSection({ description }: { description: string }) {
  return (
    <IconRow icon={<TablerIcon name='file-description' size={SECTION_ICON_SIZE} />}>
      <UserText text={description} size='sm' />
    </IconRow>
  );
}

/**
 * What took the picture, and whose it was.
 *
 * The device over `Owned by …`, with the photographer folded in — who pressed
 * the button belongs with what they pressed it on, not among
 * the people who happen to be *in* the frame.
 */
function DeviceSection({ details, exif, onOpen }: {
  details: MediaDetails;
  exif: MediaExif | null;
  onOpen: (path: string) => void;
}) {
  const device = details.device;
  const camera = [exif?.make, exif?.model].filter(Boolean).join(' ');
  if (!device && !camera && !details.photographer) return null;

  return (
    <IconRow icon={<TablerIcon name='camera' size={SECTION_ICON_SIZE} />}>
      {device ? <Anchor size='sm' onClick={() => onOpen(device.path)}>{device.name}</Anchor> : camera ? <Text size='sm'>{camera}</Text> : null}

      {device && device.owners.length > 0 && (
        <Text size='xs' c='dimmed'>
          Owned by {device.owners.map((owner, index) => (
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
    </IconRow>
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
    onOpenMap,
    canEdit,
    addToAlbumPath,
    canOrient,
    orienting,
    onTurn,
    addingFace = false,
    onAddFace,
    stackBusy = false,
    onStackPreview,
    onStackAction,
    onLayer,
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
    /** Open the lightbox-owned, enlarged view of this media location. */
    onOpenMap?: () => void;
    canEdit: boolean;
    /** The picture the edit menu's add-to-album row puts in an album; absent for the guest. */
    addToAlbumPath?: string;
    canOrient: boolean;
    orienting: boolean;
    onTurn: (change: OrientationChange) => Promise<void>;
    addingFace?: boolean;
    /** Desktop-only hand-off: the lightbox image itself owns the draw gesture. */
    onAddFace?: () => void;
    stackBusy?: boolean;
    onStackPreview: (member: StackMemberRef) => void;
    onStackAction: (action: 'front' | 'separate' | 'allow', member: StackMemberRef) => Promise<void>;
    /** A dialog of the sidebar's opened or closed over the lightbox, which leaves it the keys while open. */
    onLayer: (open: boolean) => void;
  },
) {
  useSignals();
  const access = useAccessIds();
  // Asked here rather than in the strip, so a picture with nothing like it has no row at all.
  const similar = useSimilarMedia(media.type === 'audio' ? undefined : media.path);
  const { details, addComment, removeComment, setDescription, setTextLanguage, rawExif, loadRawExif, rawExifLoading } = result;
  const [draft, setDraft] = useState('');
  const [posting, setPosting] = useState(false);
  const [editing, setEditing] = useState(false);
  const sharing = shareModalPath.value === media.path;
  useEffect(() => onLayer(editing || sharing), [editing, sharing]);
  // The chip under the name says how the file is shared; read again when its sharing, or that of
  // a folder above it, changes.
  const changed = sharingChanged.value;
  useEffect(() => {
    if (changed && (changed.path === media.path || media.path.startsWith(`${changed.path}/`))) void result.refetch();
  }, [changed]);
  const [detailsOpen, setDetailsOpen] = useState(readDetailsOpen);
  // The exiftool dump is bigger than everything else in the sidebar put together, so it is
  // fetched only while the fold is open — including when it was open from the start because
  // it was remembered, in which case `loadRawExif` has to run on mount and on every new file.
  useEffect(() => {
    if (detailsOpen) loadRawExif();
  }, [detailsOpen, loadRawExif]);
  const toggleDetails = (value: string | null) => {
    const open = value === 'details';
    setDetailsOpen(open);
    writeDetailsOpen(open);
  };

  const position = details?.position ?? null;
  const location = details?.location ?? null;
  const albums = details?.albums ?? [];
  const people = details?.people ?? [];
  const unknownFaces = details?.unknownFaces ?? [];
  const faces = details?.faces ?? [];
  const comments = details?.comments ?? [];
  const exif = details?.exif ?? null;
  const albumStack = details?.albumStack;
  const canMutateStack = !!albumStack && albumStack.membersComplete && canWrite(albumStack.albumOwnership, access) &&
    albumStack.members.every((member) => canWrite(member.ownership, access));

  // A file may have GPS of its own, or only a link to a location that has coordinates. Either is
  // enough to draw the map; the file's own point wins when both exist.
  const mapPoint = position ?? (location?.lat !== undefined && location?.lng !== undefined ? { lat: location.lat, lng: location.lng, radius: location.radius } : null);

  const post = async () => {
    if (!draft.trim()) return;
    setPosting(true);
    try {
      await addComment(draft);
      setDraft('');
    } finally {
      setPosting(false);
    }
  };

  const originalUrl = fileUrl(media.path);
  const summary = summaryLine(exif, media);
  const openPathInTerminal = () => openTerminalTab(mediaTerminalCommand(media.path));

  return (
    <ScrollBox
      data-media-sidebar
      frameStyle={{
        width: mobile ? '100%' : SIDEBAR_WIDTH,
        minWidth: mobile ? 0 : SIDEBAR_WIDTH,
        flex: mobile ? '1 1 100%' : undefined,
        height: mobile ? '100%' : undefined,
        maxHeight: mobile ? '100%' : undefined,
        background: 'var(--mrx-surface-raised)',
        isolation: 'isolate',
      }}
      ground={
        <Box className='mrx-sidebar-foot'>
          <HatField pattern='neutral' kind='foot' />
        </Box>
      }
      style={{
        overflowY: mobile ? 'scroll' : 'auto',
        overscrollBehavior: 'contain',
        touchAction: 'pan-y',
        WebkitOverflowScrolling: 'touch',
      }}
    >
      <Stack p='lg' gap='xl'>
        {/* Identity: the filename is the download, and the edit actions sit beside it. */}
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
            <Group gap='xs' mt={8} wrap='wrap'>
              {/* A visitor is not told who else may see it. */}
              {details && access && !isGuest(access) && <SharingChip path={media.path} ownership={details.ownership} />}
              <NodeLabels path={media.path} />
            </Group>
          </Box>

          {(canEdit || addToAlbumPath) && (
            // Kept mounted, so the album picker outlives the menu closing on the click that opened it.
            <Menu position='bottom-end' withinPortal shadow='md' keepMounted keepMountedMode='display-none'>
              <Menu.Target>
                <ActionIcon variant='subtle' color='gray' size='lg' loading={orienting} aria-label='Edit media'>
                  <TablerIcon name='pencil' size={20} />
                </ActionIcon>
              </Menu.Target>
              <Menu.Dropdown>
                {canEdit && (
                  <Menu.Item leftSection={<TablerIcon name='pencil' size={16} />} disabled={!details} onClick={() => setEditing(true)}>
                    Edit
                  </Menu.Item>
                )}
                {canEdit && (
                  <Menu.Item leftSection={<TablerIcon name='share' size={16} />} onClick={() => openShareModal(media.path)}>
                    Share
                  </Menu.Item>
                )}
                {addToAlbumPath && <LightboxActionItems path={addToAlbumPath} />}
                {canEdit && !mobile && media.type === 'photo' && onAddFace && (
                  <Menu.Item
                    leftSection={<TablerIcon name='user-square-rounded' size={16} />}
                    rightSection={addingFace ? <TablerIcon name='check' size={14} /> : undefined}
                    color={addingFace ? 'marine' : undefined}
                    onClick={onAddFace}
                  >
                    Edit faces
                  </Menu.Item>
                )}
                {canEdit && canOrient && (
                  <>
                    <Menu.Item leftSection={<TablerIcon name='rotate-2' size={16} />} disabled={orienting} onClick={() => onTurn({ rotate: 'ccw' })}>
                      Rotate left
                    </Menu.Item>
                    <Menu.Item leftSection={<TablerIcon name='rotate-clockwise-2' size={16} />} disabled={orienting} onClick={() => onTurn({ rotate: 'cw' })}>
                      Rotate right
                    </Menu.Item>
                    <Menu.Item
                      leftSection={<TablerIcon name='flip-vertical' size={16} />}
                      rightSection={details?.mirror ? <TablerIcon name='check' size={14} /> : undefined}
                      color={details?.mirror ? 'marine' : undefined}
                      disabled={orienting}
                      onClick={() => onTurn({ mirror: 'toggle' })}
                    >
                      Mirror horizontally
                    </Menu.Item>
                  </>
                )}
              </Menu.Dropdown>
            </Menu>
          )}
        </Group>

        {details?.description && <DescriptionSection description={details.description} />}

        {/* A staged file's copies and look-alikes: what the reader decides on while sorting an import. */}
        <StagedDuplicates
          path={media.path}
          row={(children) => <IconRow icon={<TablerIcon name='copy' size={SECTION_ICON_SIZE} />}>{children}</IconRow>}
          onLayer={onLayer}
        />

        {
          /*
          Above the device and below the description, not folded into "Details" with the other
          machine-written text. For an audio file the transcript *is* the content of the
          file, and for a video it is the half the poster cannot show — which puts it with
          the things someone came here to read rather than with the forensics.
        */
        }
        {details?.hasTranscript && (
          <IconRow icon={<TablerIcon name='blockquote' size={SECTION_ICON_SIZE} />}>
            <TranscriptPanel
              path={details.path}
              speakers={details.speakers}
              canEdit={canEdit}
              onReviewPerson={onReviewUnknown}
              onOpenPerson={(personId) => onNavigate(`/people/${personId}`)}
              onSpeakersChanged={result.refetch}
            />
          </IconRow>
        )}

        {details && (details.device || details.photographer || exif?.model) && <DeviceSection details={details} exif={exif} onOpen={onNavigate} />}

        {albums.length > 0 && (
          <IconRow icon={<TablerIcon name='books' size={SECTION_ICON_SIZE} />}>
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
          </IconRow>
        )}

        {(people.length > 0 || unknownFaces.length > 0) && (
          <IconRow icon={<TablerIcon name='users' size={SECTION_ICON_SIZE} />}>
            {people.map((person) => (
              <Group
                key={person.path}
                gap='xs'
                wrap='nowrap'
                // Hovering a name lights up that person's box on the image, and vice versa.
                onMouseEnter={() => person.faceBox && onHoverFace?.(faceKeyForPerson(person.path))}
                onMouseLeave={() => person.faceBox && onHoverFace?.(null)}
                style={{
                  borderRadius: 4,
                  background: hoveredFace === faceKeyForPerson(person.path) ? 'var(--mrx-surface-overlay)' : undefined,
                }}
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
                <ShowFace
                  face={faces.find((face) => face.personPath === person.path && face.atSeconds !== undefined)}
                  name={person.name}
                  onShow={onShowFace}
                  followed={followedFace}
                />
              </Group>
            ))}

            {
              /* Recognized as somebody, but nobody has said who. Shown as crops rather
                  than a bare count so it is visible *where in the picture* they are —
                  hovering one lights up its box, exactly like a named person's row. */
            }
            {unknownFaces.map((face) => (
              <Group
                key={face.faceId}
                gap='xs'
                wrap='nowrap'
                onMouseEnter={() => face.faceBox && onHoverFace?.(`u-${face.faceId}`)}
                onMouseLeave={() => face.faceBox && onHoverFace?.(null)}
                style={{
                  borderRadius: 4,
                  background: hoveredFace === `u-${face.faceId}` ? 'var(--mrx-surface-overlay)' : undefined,
                }}
              >
                <FaceCrop facePath={face.facePath} size={32} alt={face.personName} lazy />
                <Anchor
                  size='sm'
                  style={{ flex: 1, wordBreak: 'break-word' }}
                  onClick={() => onReviewUnknown(face.personId)}
                >
                  {face.personName}
                </Anchor>
                <ShowFace face={faces.find((candidate) => candidate.faceId === face.faceId)} name={face.personName} onShow={onShowFace} followed={followedFace} />
              </Group>
            ))}
          </IconRow>
        )}

        {(mapPoint || location) && (
          <IconRow icon={<TablerIcon name='map-pin' size={SECTION_ICON_SIZE} />}>
            {location && (
              <Anchor size='sm' onClick={() => onNavigate(`/locations/${location.id}`)}>
                {location.name}
              </Anchor>
            )}
            {position?.address && <Text size='xs' c='dimmed'>{position.address}</Text>}
            {mapPoint && (
              <Box style={{ position: 'relative', borderRadius: 4, overflow: 'hidden' }}>
                <MapView center={mapPoint} zoom={14} style={{ height: 180, minHeight: 180 }}>
                  <MapShape shape={mapPoint} />
                </MapView>
                {onOpenMap && (
                  <ActionIcon
                    variant='filled'
                    color='dark'
                    size={44}
                    onClick={onOpenMap}
                    aria-label='Enlarge map'
                    title='Enlarge map'
                    style={{ position: 'absolute', top: '50%', right: 8, zIndex: 1, transform: 'translateY(-50%)' }}
                  >
                    <TablerIcon name='maximize' size={22} />
                  </ActionIcon>
                )}
              </Box>
            )}
          </IconRow>
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

        {similar?.length !== 0 && (
          <IconRow icon={<TablerIcon name='photo-search' size={SECTION_ICON_SIZE} />}>
            <SimilarMedia path={media.path} similar={similar} onNavigate={onNavigate} />
          </IconRow>
        )}

        {
          /* A comment is written under the picture, as its author: for whoever may change the
            picture. Everyone else reads them, and sees no row where there are none. */
        }
        {(comments.length > 0 || canEdit) && (
          <IconRow icon={<TablerIcon name='messages' size={SECTION_ICON_SIZE} />}>
            {comments.map((comment) => (
              <CommentRow
                key={comment.slug}
                comment={comment}
                canDelete={access?.uid === comment.uid}
                onDelete={() => removeComment(comment.slug)}
              />
            ))}
            {canEdit && (
              <>
                <Textarea
                  value={draft}
                  onChange={(e) => setDraft(e.currentTarget.value)}
                  placeholder='Add a comment…'
                  autosize
                  minRows={2}
                  maxRows={6}
                />
                {draft.trim() && (
                  <Group>
                    <Button size='xs' onClick={post} loading={posting}>Comment</Button>
                  </Group>
                )}
              </>
            )}
          </IconRow>
        )}

        {
          /* Everything a reader does not need but an investigator does: what the
            machines wrote about the file, and what identifies it. Open or closed
            is remembered across files and visits (see `DETAILS_OPEN_KEY`). */
        }
        <Accordion variant='filled' chevronPosition='left' value={detailsOpen ? 'details' : null} onChange={toggleDetails}>
          <Accordion.Item value='details'>
            <Accordion.Control px={0}>
              <Text size='xs' c='dimmed'>Details</Text>
            </Accordion.Control>
            <Accordion.Panel px={0}>
              <Stack gap='sm'>
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
                  <TextLanguage details={details} canEdit={canEdit} onSet={setTextLanguage} />
                )}

                <InfoRow label='Type' value={details?.mimetype ?? media.mimetype ?? ''} />
                {
                  /* The stored capture time verbatim — precision, offset and all — since the
                    caption above the picture renders it for reading, and this is where one
                    checks what the record actually says. */
                }
                <InfoRow label='Taken at' value={details?.takenAt ?? media.takenAt ?? ''} />
                <InfoRow label='Taken at (UTC)' value={details?.takenAtUtc ?? ''} />
                <InfoRow label='Time source' value={[timeSourceLabel(details?.takenAtSource, details?.digitized), details?.takenAtNote].filter(Boolean).join(' · ')} />
                <InfoRow label='Created' value={formatTimestamp(media.birthtime)} />
                <InfoRow label='Modified' value={formatTimestamp(media.modtime)} />
                {
                  /* Whichever hashes the file has: sha256, md5, sha1. */
                }
                {Object.entries(details?.hashes ?? {}).map(([name, value]) => <InfoRow key={name} label={name} value={value} />)}

                {
                  /* The exiftool dump, one row per tag, in the same shape as the rows above it
                    rather than under a heading of its own: to the reader they are all just
                    attributes of the file. */
                }
                {rawExifLoading && <Loader size='xs' />}
                {rawExif && Object.keys(rawExif).length === 0 && !rawExifLoading && <Text size='xs' c='dimmed'>No EXIF recorded</Text>}
                {rawExif &&
                  Object.entries(rawExif).map(([key, value]) => <InfoRow key={key} label={key} value={typeof value === 'object' ? JSON.stringify(value) : String(value)} />)}
              </Stack>
            </Accordion.Panel>
          </Accordion.Item>
        </Accordion>
      </Stack>
      {details && (
        <MediaEditModal
          opened={editing}
          onClose={() => setEditing(false)}
          details={details}
          setDescription={setDescription}
          onSaved={result.refetch}
        />
      )}
    </ScrollBox>
  );
}
