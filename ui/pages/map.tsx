import {
  chosenMapLayers,
  defaultMapStyle,
  GeoBounds,
  InterpretedFilter,
  keepMapChoice,
  MAP_CONTROL_Z,
  type MapLayerSettings,
  MapView,
  offeredMapLayers,
  SearchInput,
  TablerIcon,
} from '@ein/ui/components';
import { Box, Group, Loader } from '@mantine/core';
import { useSignals } from '@preact/signals-react/runtime';
import { MapYears } from '../components/MapControls.tsx';
import { MapClusterMedia } from '../components/MapClusterMedia.tsx';
import { useSearchFacets } from '../hooks/useSearchFacets.ts';
import { type Mention, type MentionKind, naturalSearchDetails, subjectRefs, textFromFilters } from '@ein/ui/lib';
import { subjectsOf } from '../lib/subjects.ts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { type MapFilters, mapStateFromParams, paramsFromMapState } from '../lib/map-params.ts';
import { LOCATIONS_LAYER, MEDIA_LAYER, type MediaLayerHost, MediaLayerHostContext, mediaLayerSettings, type OpenCluster } from '../lib/map-layer.ts';

/**
 * What an `@` may resolve to here.
 *
 * No album and no camera: an album is a place in the tree rather than a location on
 * the ground, and both would narrow the map to a handful of pins that the album
 * and camera pages already show better.
 */
const MENTION_KINDS: readonly MentionKind[] = ['person', 'location', 'label'];

const FALLBACK_YEARS: [number, number] = [1900, new Date().getFullYear()];

/** The open cluster rides in the history entry's state, which the page does not otherwise use. */
function openClusterFromState(state: unknown): OpenCluster | null {
  const open = (state as { mapCluster?: OpenCluster } | null)?.mapCluster;
  return open ?? null;
}

export const handle = { fullBleed: true };

/**
 * `/map`: every layer core and the modules offer over the style the reader picks, each switched on
 * or off in the map's picker; what was picked last is the reader's own (`keepMapChoice`) and opens
 * a plain `/map` again. The search and the years at its foot narrow the archive's media and
 * locations layers, and a pile of pictures opens in a grid that Back closes.
 */
export default function MapPage() {
  useSignals();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const state = useMemo(() => mapStateFromParams(searchParams), [searchParams]);
  const { fromYear, toYear, filters } = state;
  const style = state.style ?? defaultMapStyle();
  // Read at each drawing: the reader's settings and the layers on offer may arrive after the page.
  const layers = state.layers ? offeredMapLayers(state.layers) : chosenMapLayers();

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

  // The archive's layers take the search and the years as their settings.
  const layerSettings = useMemo((): Record<string, MapLayerSettings> => {
    const settings = mediaLayerSettings(filters, { fromYear, toYear });
    return { [MEDIA_LAYER]: settings, [LOCATIONS_LAYER]: settings };
  }, [filters.query, filters.person, filters.location, filters.tag, fromYear, toYear]);

  // What a cluster the user opened holds is fetched for that cell alone, at the
  // moment it is going to be shown — the map itself only ever knew the count.
  //
  // Opening it pushes a history entry holding the cluster, so Back — a phone's
  // back gesture above all — closes the grid rather than leaving the map. The
  // lightbox it opens into carries this state into its own entry, so Back from
  // a picture lands on the grid again.
  const openCluster = openClusterFromState(location.state);
  // A pan rewrites the entry it is on, which keeps its state: the open cluster, and the mark the
  // lightbox's opening leaves on its own entry, without which closing it would not step Back.
  const entryStateRef = useRef(location.state);
  entryStateRef.current = location.state;
  const searchRef = useRef(location.search);
  searchRef.current = location.search;
  const closeCluster = useCallback(() => navigate(-1), [navigate]);

  // The media layer asks for its piles to open here, and says when it reads for a changed search.
  const [searching, setSearching] = useState(false);
  const host = useMemo((): MediaLayerHost => ({
    openCluster: (open) => navigate({ search: searchRef.current }, { state: { mapCluster: open } }),
    searching: setSearching,
  }), [navigate]);

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
    // Functional form: a pan fires this often and must not race the render's
    // view of the other parameters.
    const center = { lat: (bounds.north + bounds.south) / 2, lng: (bounds.east + bounds.west) / 2 };
    setSearchParams((current) => paramsFromMapState({ ...mapStateFromParams(current), center, zoom: z }, current), {
      replace: true,
      state: entryStateRef.current,
    });
  }, [setSearchParams]);

  // The slider is uncontrolled between drags: committing on every tick would
  // re-query the viewport per pixel.
  const [yearDraft, setYearDraft] = useState<[number, number] | null>(null);
  const yearValue: [number, number] = yearDraft ?? [fromYear ?? yearBounds[0], toYear ?? yearBounds[1]];

  const commitYears = useCallback((value: [number, number]) => {
    setYearDraft(null);
    const atFullRange = value[0] === yearBounds[0] && value[1] === yearBounds[1];
    commit({ fromYear: atFullRange ? undefined : value[0], toYear: atFullRange ? undefined : value[1] });
  }, [commit, yearBounds]);

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
        <MediaLayerHostContext.Provider value={host}>
          <MapView
            center={opening.current.center}
            zoom={opening.current.zoom}
            onMoveEnd={onMoveEnd}
            mapStyle={style}
            onMapStyleChange={(id) => {
              commit({ style: id });
              keepMapChoice({ style: id });
            }}
            layers={layers}
            onLayersChange={(ids) => {
              commit({ layers: ids });
              keepMapChoice({ layers: ids });
            }}
            layerSettings={layerSettings}
            controls={{ style: true, layers: true }}
            style={{ height: '100%' }}
          />
        </MediaLayerHostContext.Provider>

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
                rightSection={searching ? <Loader size={16} aria-label='Searching' /> : undefined}
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
