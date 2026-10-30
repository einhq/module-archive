import { Group, Stack, Text } from '@mantine/core';
import { CoverAvatar, TablerIcon } from '@ein/ui/components';
import type { PersonTag, UnknownFace } from '@archive/media/api';
import { usePerson } from '../../people/hooks/usePeople.ts';
import { currentHome, lifeLine } from '../../people/components/PersonHeader.tsx';
import { FaceCrop } from '../../people/components/FaceCrop.tsx';

/** The picture's side, and the height the card keeps while the facts beside it load. */
const PICTURE = 72;

/**
 * Who a named person in the lightbox is, at the top of their row's card (`FaceRow`): their cover,
 * larger than the row's, and what places them, as their page's header has it (`person-info`):
 * the full name, their years, where they live now, and the start of their description.
 */
export function PersonGlance({ person }: { person: PersonTag }) {
  const { person: info } = usePerson(person.id);
  const life = info ? lifeLine(info) : undefined;
  const home = info ? currentHome(info) : undefined;
  const alsoKnown = info?.fullname && info.fullname !== person.name ? info.fullname : undefined;
  return (
    <Group gap='sm' wrap='nowrap' align='flex-start' mih={PICTURE}>
      <CoverAvatar path={person.path} fallback={person.name.charAt(0).toUpperCase()} size={PICTURE} radius='md' alt={person.name} eager />
      <Stack gap={2} style={{ minWidth: 0 }}>
        <Text size='sm' fw={600}>{person.name}</Text>
        {alsoKnown && <Text size='xs' c='dimmed'>{alsoKnown}</Text>}
        {life && <Text size='xs'>{life}</Text>}
        {home && (
          <Group gap={4} wrap='nowrap'>
            <TablerIcon name='home' size={13} color='var(--mantine-color-dimmed)' />
            <Text size='xs' c='dimmed' truncate>{home.label}</Text>
          </Group>
        )}
        {info?.description && <Text size='xs' c='dimmed' lineClamp={2}>{info.description}</Text>}
      </Stack>
    </Group>
  );
}

/** A face recognition grouped as one person nobody has named: its crop, larger than the row's. */
export function UnknownGlance({ face }: { face: UnknownFace }) {
  return (
    <Group gap='sm' wrap='nowrap' align='flex-start'>
      <FaceCrop facePath={face.facePath} size={PICTURE} alt={face.personName} />
      <Stack gap={2} style={{ minWidth: 0 }}>
        <Text size='sm' fw={600}>{face.personName}</Text>
        <Text size='xs' c='dimmed'>Not named yet. Click the name to say who it is.</Text>
      </Stack>
    </Group>
  );
}
