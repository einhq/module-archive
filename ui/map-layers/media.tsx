import { ActionIcon, Tooltip } from '@mantine/core';
import { MapControl, MapMarkers, TablerIcon, useMapBusy, useMapViewport } from '@ein/ui/components';
import { openMediaAt } from '@ein/ui/signals';
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { MapClusterMedia } from '../components/MapClusterMedia.tsx';
import { useMapMedia } from '../hooks/useMapMedia.ts';
import { cellFor, clusterMarkers } from '../lib/map-clusters.ts';
import { hitToMediaItem, type MediaHit } from '../lib/map-hits.ts';
import { MediaLayerHostContext, mediaLayerQuery, type OpenCluster } from '../lib/map-layer.ts';

/**
 * `/map-layers/archive/media`: the archive's pictures and videos on the map around it, clustered
 * by the server (`find-within`): a cell of one drawn as its picture, which opens in the lightbox
 * with every other picture drawn as a picture, and a cell of several as a counted pile, which opens
 * the pictures behind it. Its query narrows them as the Map page's search does (`q`, `person`,
 * `location`, `tag`, `under`, `from` and `to` years). The page around it may open a pile in its own
 * grid (`MediaLayerHostContext`), and then gets a button that lists everything in view; without
 * one a pile opens in a grid of the layer's own.
 */
export default function MediaLayer() {
  const [params] = useSearchParams();
  const { filters, years } = useMemo(() => mediaLayerQuery(params), [params.toString()]);
  const host = useContext(MediaLayerHostContext);
  const viewport = useMapViewport();
  const { clusters, total, loading, query } = useMapMedia(years, filters);
  const [ownOpen, setOwnOpen] = useState<OpenCluster | null>(null);

  // Asked again on each move; a change of search asks again by itself.
  const queryRef = useRef(query);
  queryRef.current = query;
  useEffect(() => {
    if (viewport) queryRef.current(viewport.bounds, cellFor(viewport.zoom));
  }, [viewport]);

  useMapBusy(loading === 'view');
  useEffect(() => {
    host?.searching(loading === 'search');
  }, [host, loading]);
  useEffect(() => () => host?.searching(false), [host]);

  const open = useCallback((cluster: OpenCluster) => (host ? host.openCluster(cluster) : setOwnOpen(cluster)), [host]);

  // The lightbox walks every picture drawn as a picture, not just the one that was clicked, so the
  // arrow keys keep working after opening a marker. What is behind a count is behind the count.
  const singles = useMemo(() => clusters.flatMap((cluster) => cluster.hit ? [cluster.hit] : []), [clusters]);
  const openHit = useCallback((hit: MediaHit) => {
    openMediaAt(Math.max(singles.findIndex((candidate) => candidate.id === hit.id), 0), singles.map(hitToMediaItem));
  }, [singles]);

  const markers = useMemo(
    () => viewport ? clusterMarkers(clusters, viewport.zoom, openHit, (cluster, bounds) => open({ cluster, bounds })) : [],
    [clusters, viewport?.zoom, openHit, open],
  );

  const bounds = viewport?.bounds;
  const listLabel = `List the ${total} photos in this view`;
  return (
    <>
      <MapMarkers markers={markers} />
      {host && bounds && total > 0 && (
        <MapControl>
          <Tooltip label={listLabel} position='left'>
            <ActionIcon
              className='mrx-map-button'
              aria-label={listLabel}
              onClick={() =>
                open({
                  cluster: { key: 'view', lat: (bounds.north + bounds.south) / 2, lng: (bounds.east + bounds.west) / 2, count: total },
                  bounds,
                  view: true,
                })}
            >
              <TablerIcon name='layout-grid' size={22} />
            </ActionIcon>
          </Tooltip>
        </MapControl>
      )}
      {!host && <MapClusterMedia open={ownOpen} years={years} filters={filters} onClose={() => setOwnOpen(null)} />}
    </>
  );
}
