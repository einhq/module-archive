import { TablerIcon } from '@ein/ui/components';
import { Anchor, Button, Stack, Text } from '@mantine/core';
import type { PositionShape } from '@ein/ui/lib';
import { InfoFact, InfoSection } from '../../components/InfoSection.tsx';
import { UserText } from '../../components/UserText.tsx';
import type { LocationDetail, ResidentEntry } from '../hooks/useLocationDetail.ts';
import { LocationResidents } from './LocationResidents.tsx';
import { yearSpan } from '../../lib/year-span.ts';

type LocationInfoProps = {
  location: LocationDetail;
  residents: ResidentEntry[];
  editable: boolean;
  /** How many pictures are linked to it, and over what years. Absent while it loads. */
  media?: { total: number; truncated: boolean; range: { min: number; max: number } | null };
  /** Opens the Map tab. */
  onShowMap: () => void;
  /** Opens the edit dialog, where the shape is drawn. */
  onEdit: () => void;
  /** After a resident is added, changed or removed. */
  onResidentsChanged: () => void;
};

/** A shape's extent in words: what decides which pictures belong to the location. */
const areaLine = (shape: PositionShape): string =>
  shape.polygon ? `Polygon, ${shape.polygon.length} corners` : shape.radius ? `Circle, radius ${Math.round(shape.radius)} m` : 'A point, which holds no pictures';

/**
 * How the position was arrived at, so a wrong pin can be argued with: media points are measured,
 * an address is not.
 */
const sourceLine = (location: LocationDetail): string | undefined => {
  switch (location.locationSource) {
    case 'manual':
      return 'Set by hand';
    case 'media-centroid':
      return `Derived from ${location.locationPoints ?? 0} geotagged photo${location.locationPoints === 1 ? '' : 's'}` +
        (location.locationSpread !== undefined ? ` spread over ${location.locationSpread} m` : '');
    case 'track':
      return 'Where a camera stayed, from its track';
    case 'nominatim':
      return 'Geocoded from the address';
    default:
      return undefined;
  }
};

/**
 * Everything known about a location beside its timeline: where it is, who has lived there, and what
 * it is.
 */
export function LocationInfo({ location, residents, editable, media, onShowMap, onEdit, onResidentsChanged }: LocationInfoProps) {
  const { shape } = location;
  const suggestions = shape ? 0 : location.candidates.length;
  const source = shape && sourceLine(location);

  return (
    <Stack gap='md'>
      <InfoSection title='Place'>
        {location.address && (
          <InfoFact label='Address'>
            <span style={{ whiteSpace: 'pre-line' }}>{location.address}</span>
          </InfoFact>
        )}
        {location.displayName && location.displayName !== location.address && <InfoFact label='Found as'>{location.displayName}</InfoFact>}
        {location.city && <InfoFact label='City'>{location.city}</InfoFact>}
        {location.country && <InfoFact label='Country'>{location.country}</InfoFact>}
        <InfoFact label='Position'>
          {shape
            ? (
              <>
                {`${shape.lat.toFixed(5)}, ${shape.lng.toFixed(5)} · `}
                <Anchor component='button' size='sm' onClick={onShowMap}>On the map</Anchor>
                {source && <Text size='xs' c='dimmed'>{source}</Text>}
              </>
            )
            : suggestions > 0
            ? (
              <>
                {'Not placed yet · '}
                <Anchor component='button' size='sm' onClick={onShowMap}>{suggestions} suggested on the map</Anchor>
              </>
            )
            : (
              <Stack gap={6} align='flex-start'>
                Not placed yet
                {editable && (
                  <Button size='compact-xs' variant='light' leftSection={<TablerIcon name='map-pin' size={14} />} onClick={onEdit}>
                    Location on map
                  </Button>
                )}
              </Stack>
            )}
        </InfoFact>
        {shape && <InfoFact label='Area'>{areaLine(shape)}</InfoFact>}
        {media && media.total > 0 && (
          <InfoFact label='Photos'>
            {media.total.toLocaleString()}
            {media.truncated ? '+' : ''}
            {media.range ? ` · ${yearSpan(media.range)}` : ''}
          </InfoFact>
        )}
      </InfoSection>

      <LocationResidents location={location} residents={residents} editable={editable} onApplied={onResidentsChanged} />

      {location.description && (
        <InfoSection title='About'>
          <UserText text={location.description} size='sm' />
        </InfoSection>
      )}
    </Stack>
  );
}
