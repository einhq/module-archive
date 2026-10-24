import { BASE_LAYERS, GeoBounds, InterpretedFilter, MapMarkers, type MapMarkerSpec, MapTracks, MapView, SearchInput, TablerIcon } from '@ein/ui/components';
import { ActionIcon, Box, Group, Loader, Stack, Tooltip } from '@mantine/core';
import { MAP_CONTROL_Z, MapBaseLayerPicker, MapTypeMenu, MapYears } from '../components/MapControls.tsx';
import { MapClusterMedia } from '../components/MapClusterMedia.tsx';
import { hitToMediaItem, type MediaHit } from '../lib/map-hits.ts';
import { cellFor, clusterMarkers } from '../lib/map-clusters.ts';
import { type MapCluster, useMapMedia } from '../hooks/useMapMedia.ts';
import { useMapTracks } from '../location/hooks/useTracks.ts';
import { useSearchFacets } from '../hooks/useSearchFacets.ts';
import { kindFill, type Mention, type MentionKind, naturalSearchDetails, subjectRefs, textFromFilters } from '@ein/ui/lib';
import { subjectsOf } from '../lib/subjects.ts';
import { openMediaAt } from '@ein/ui/signals';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { type MapFilters, type MapLayers, mapStateFromParams, paramsFromMapState } from '../lib/map-params.ts';

/**
 * What an `@` may resolve to here.
 *
 * No album and no device: an album is a place in the tree rather than a location on
 * the ground, and both would narrow the map to a handful of pins that the album
 * and device pages already show better.
 */
const MENTION_KINDS: readonly MentionKind[] = ['person', 'location', 'label'];

/**
 * What the map draws, as one exclusive choice like the Search page's type: all
 * of it, or one layer on its own.
 */
const MAP_LAYER_FILTERS: readonly { value: string; label: string; icon: ReactNode; layers: MapLayers }[] = [
  { value: 'all', label: 'All', icon: <TablerIcon name='filter' size={20} />, layers: { media: true, locations: true, tracks: true } },
  { value: 'media', label: 'Media', icon: <TablerIcon name='photo' size={20} />, layers: { media: true, locations: false, tracks: false } },
  { value: 'locations', label: 'Locations', icon: <TablerIcon name='map-pin' size={20} />, layers: { media: false, locations: true, tracks: false } },
  { value: 'tracks', label: 'Tracks', icon: <TablerIcon name='route' size={20} />, layers: { media: false, locations: false, tracks: true } },
];

/** The choice a set of layers is. A link with two layers on reads as All — more than one layer is not one layer. */
function layerFilterOf(layers: MapLayers): string {
  const on = MAP_LAYER_FILTERS.slice(1).filter((entry) => layers[entry.value as keyof MapLayers]);
  return on.length === 1 ? on[0].value : 'all';
}

const FALLBACK_YEARS: [number, number] = [1900, new Date().getFullYear()];

/** The location hue, so a pin reads as a location the same way a card's corner flag does. */
const LOCATION_COLOR = kindFill('location');

/** An open cluster and the cell it stands for. */
type OpenCluster = { cluster: MapCluster; bounds: GeoBounds; view?: boolean };

/** The open cluster rides in the history entry's state, which the page does not otherwise use. */
function openClusterFromState(state: unknown): OpenCluster | null {
  const open = (state as { mapCluster?: OpenCluster } | null)?.mapCluster;
  return open ?? null;
}

export const handle = { fullBleed: true };

/** The base layer a plain /map opens on, which the URL then leaves out. */
const DEFAULT_BASE = BASE_LAYERS[0].name;

export default function MapPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const state = useMemo(() => mapStateFromParams(searchParams), [searchParams]);
  const { layers, fromYear, toYear, filters } = state;

  // Where a shared link points. Read once: after mount the map owns the camera,
  // and feeding its own position back in would fight every pan.
  const opening = useRef({ center: state.center, zoom: state.zoom });

  // Not `facets.range`: some files carry a broken EXIF date that buckets
  // as year 0, and letting that be the left end squeezes the century anyone
  // actually has pictures from into the last few percent of the slider. A year
  // below 1000 is a missing date, not an early one.
  const { facets } = useSearchFacets(undefined);
  const yearBounds = useMemo((): [number, number] => {
    const dated = (facets?.years ?? []).filter((bucket) => bucket.year >= 1000);
    return dated.length > 0 ? [dated[0].year, dated[dated.length - 1].year] : FALLBACK_YEARS;
  }, [facets]);
  const datedYears = useMemo(() => (facets?.years ?? []).filter((bucket) => bucket.year >= 1000 && bucket.count > 0).map((bucket) => bucket.year), [facets]);

  const seededSearch = useMemo(() =>
    textFromFilters(
      {
        query: filters.query,
        subjects: subjectsOf(filters),
        tags: filters.tag ? [filters.tag] : undefined,
      },
      (kind, value) => kind === 'label' ? value : value.replaceAll('_', ' '),
    ), [filters.query, filters.person, filters.location, filters.tag]);
  const [text, setText] = useState(seededSearch.text);
  const [mentions, setMentions] = useState<Mention[]>(seededSearch.mentions);

  // Back/forward and shared links rewrite the field as well as the map. Typing
  // does not touch the URL until commit, so it is not disturbed mid-edit.
  useEffect(() => {
    setText(seededSearch.text);
    setMentions(seededSearch.mentions);
  }, [seededSearch]);

  // What the box narrowed the map to; the years have their own slider. Names come from the
  // mentions the box holds, which the URL seeds as well as a pick.
  const filtered = Boolean(filters.query || filters.person || filters.location || filters.tag);
  const details = useMemo(() =>
    naturalSearchDetails(
      {
        query: filters.query,
        subjects: subjectsOf(filters),
        tags: filters.tag ? [filters.tag] : undefined,
      },
      undefined,
      (kind, value) => mentions.find((mention) => mention.kind === kind && mention.value === value)?.label,
    ), [filters.query, filters.person, filters.location, filters.tag, mentions]);

  const { clusters, locations, loading, query, total } = useMapMedia({ fromYear, toYear }, filters);
  // What the map shows now, for listing every picture in it.
  const [viewBounds, setViewBounds] = useState<GeoBounds | null>(null);
  const { segments, loading: tracksLoading, query: queryTracks } = useMapTracks(layers.tracks);

  const [zoom, setZoom] = useState(opening.current.zoom ?? 12);

  // What a cluster the user opened holds is fetched for that cell alone, at the
  // moment it is going to be shown — the map itself only ever knew the count.
  //
  // Opening it pushes a history entry holding the cluster, so Back — a phone's
  // back gesture above all — closes the grid rather than leaving the map. The
  // lightbox it opens into carries this state into its own entry, so Back from
  // a picture lands on the grid again.
  const openCluster = openClusterFromState(location.state);
  const openClusterRef = useRef(openCluster);
  openClusterRef.current = openCluster;
  const showCluster = useCallback((open: OpenCluster) => {
    navigate({ search: location.search }, { state: { mapCluster: open } });
  }, [location.search, navigate]);
  const closeCluster = useCallback(() => navigate(-1), [navigate]);

  /**
   * Replace the URL with a view. `replace` so panning does not fill history.
   *
   * The current parameters go in so the codec can carry through what is not the
   * map's — the lightbox's open media rides in this same query string. The
   * entry's state goes in too, or a replace would drop the open cluster.
   */
  const commit = useCallback((changes: Partial<typeof state>) => {
    setSearchParams(paramsFromMapState({ ...state, ...changes }, searchParams), { replace: true, state: location.state });
  }, [location.state, searchParams, setSearchParams, state]);

  const onMoveEnd = useCallback((bounds: GeoBounds, z: number) => {
    setZoom(z);
    setViewBounds(bounds);
    query(bounds, cellFor(z));
    queryTracks(bounds, z);

    // Functional form: a pan fires this often and must not race the render's
    // view of the other parameters.
    const center = { lat: (bounds.north + bounds.south) / 2, lng: (bounds.east + bounds.west) / 2 };
    setSearchParams((current) => paramsFromMapState({ ...mapStateFromParams(current), center, zoom: z }, current), {
      replace: true,
      state: openClusterRef.current ? { mapCluster: openClusterRef.current } : undefined,
    });
  }, [query, queryTracks, setSearchParams]);

  // The slider is uncontrolled between drags: committing on every tick would
  // re-query the viewport per pixel.
  const [yearDraft, setYearDraft] = useState<[number, number] | null>(null);
  const yearValue: [number, number] = yearDraft ?? [fromYear ?? yearBounds[0], toYear ?? yearBounds[1]];

  const commitYears = useCallback((value: [number, number]) => {
    setYearDraft(null);
    const atFullRange = value[0] === yearBounds[0] && value[1] === yearBounds[1];
    commit({ fromYear: atFullRange ? undefined : value[0], toYear: atFullRange ? undefined : value[1] });
  }, [commit, yearBounds]);

  const visibleClusters = layers.media ? clusters : [];

  // The lightbox walks every picture drawn as a picture, not just the one that
  // was clicked, so the arrow keys keep working after opening a marker. What is
  // behind a count is not here — it is behind the count.
  const singles = useMemo(() => visibleClusters.flatMap((cluster) => cluster.hit ? [cluster.hit] : []), [
    visibleClusters,
  ]);
  const lightboxItems = useMemo(() => singles.map(hitToMediaItem), [singles]);

  const openHit = useCallback((hit: MediaHit) => {
    const index = singles.findIndex((candidate) => candidate.id === hit.id);
    openMediaAt(Math.max(index, 0), lightboxItems);
  }, [singles, lightboxItems]);

  const markers = useMemo((): MapMarkerSpec[] => {
    const mediaMarkers = clusterMarkers(visibleClusters, zoom, openHit, (cluster, bounds) => showCluster({ cluster, bounds }));

    const locationMarkers = layers.locations
      ? locations.map((location): MapMarkerSpec => ({
        id: `p-${location.id}`,
        lat: location.lat,
        lng: location.lng,
        label: location.locationId.replaceAll('_', ' '),
        color: LOCATION_COLOR,
        onClick: () => navigate(`/locations/${location.locationId}`),
      }))
      : [];

    return [...locationMarkers, ...mediaMarkers];
  }, [visibleClusters, locations, layers.locations, zoom, openHit, showCluster, navigate]);

  return (
    <Box
      style={{
        display: 'flex',
        flexDirection: 'column',
        // The rest of the viewport under the header, using the shell's own
        // variable so the two cannot drift apart.
        height: 'calc(100dvh - var(--app-shell-header-height))',
      }}
    >
      <Box style={{ position: 'relative', flex: 1, minHeight: 0 }}>
        <MapView
          center={opening.current.center}
          zoom={opening.current.zoom}
          onMoveEnd={onMoveEnd}
          baseLayer={state.baseLayer ?? DEFAULT_BASE}
          layerSwitcher={false}
          style={{ height: '100%' }}
        >
          <MapMarkers markers={markers} />
          <MapTracks tracks={segments} />
        </MapView>

        {/* What the map is reading for where it was moved to. A search shows its own in the box. Zoom is by wheel and pinch, so the top-left corner is free. */}
        {(loading === 'view' || tracksLoading) && (
          <Box className='mrx-map-loading' role='status' aria-label='Loading the map' style={{ zIndex: MAP_CONTROL_Z }}>
            <Loader size={18} />
          </Box>
        )}

        {/* The map's own layer switcher is off, so Leaflet leaves the top-right corner free. */}
        <Stack className='mrx-map-corner' gap='xs' style={{ zIndex: MAP_CONTROL_Z }}>
          <MapTypeMenu
            value={layerFilterOf(layers)}
            onChange={(value) => commit({ layers: (MAP_LAYER_FILTERS.find((entry) => entry.value === value) ?? MAP_LAYER_FILTERS[0]).layers })}
            options={MAP_LAYER_FILTERS}
          />
          <MapBaseLayerPicker
            value={state.baseLayer ?? DEFAULT_BASE}
            onChange={(name) => commit({ baseLayer: name === DEFAULT_BASE ? undefined : name })}
            center={state.center}
            zoom={state.zoom}
          />
          {layers.media && viewBounds && total > 0 && (
            <Tooltip label={`List the ${total} photos in this view`} position='left'>
              <ActionIcon
                className='mrx-map-button'
                aria-label={`List the ${total} photos in this view`}
                onClick={() =>
                  showCluster({
                    cluster: { key: 'view', lat: (viewBounds.north + viewBounds.south) / 2, lng: (viewBounds.east + viewBounds.west) / 2, count: total },
                    bounds: viewBounds,
                    view: true,
                  })}
              >
                <TablerIcon name='layout-grid' size={22} />
              </ActionIcon>
            </Tooltip>
          )}
        </Stack>

        {
          /* The search floats over the foot of the map: the box, a hairline, then the
            years, as one control. A search rather than a filter, and it says so: the
            map holds counts, not pictures, so the text goes to the server's search
            (embedded, ranked, capped, kept to the view) on the arrow or Enter —
            nothing narrows as you type the way a list page's filter box does.
            `MAP_CONTROL_Z` because this is outside the Leaflet container's
            isolation, so a larger number would paint over the lightbox. */
        }
        <Box className='mrx-map-search' style={{ zIndex: MAP_CONTROL_Z }}>
          <Group gap={4} wrap='nowrap' align='center' pr={filtered ? 4 : 0}>
            <Box style={{ flex: 1, minWidth: 0 }}>
              <SearchInput
                value={text}
                onChange={setText}
                mentions={mentions}
                onMentionsChange={setMentions}
                onCommit={(next) =>
                  commit({
                    filters: {
                      query: next.query,
                      // One each: the command intersects a set, and a map narrowed to
                      // "both of them, in this view" is a pin or two.
                      person: subjectRefs(next.subjects, 'person').at(-1),
                      location: subjectRefs(next.subjects, 'location').at(-1),
                      tag: next.tags?.at(-1),
                    } satisfies MapFilters,
                  })}
                kinds={MENTION_KINDS}
                size='md'
                placeholder='Search this view — type @ for a person, location or label'
                shortPlaceholder='Search this view…'
                leftSection={<TablerIcon name='search' size={18} />}
                rightSection={loading === 'search' ? <Loader size={16} aria-label='Searching' /> : undefined}
              />
            </Box>
            {filtered && <InterpretedFilter details={details} size='sm' color='gray' />}
          </Group>
          <Box className='mrx-map-search-divider' />
          <MapYears
            bounds={yearBounds}
            years={datedYears}
            value={yearValue}
            onChange={setYearDraft}
            onChangeEnd={commitYears}
          />
        </Box>
      </Box>

      <MapClusterMedia
        open={openCluster}
        years={{ fromYear, toYear }}
        filters={filters}
        onClose={closeCluster}
      />
    </Box>
  );
}
