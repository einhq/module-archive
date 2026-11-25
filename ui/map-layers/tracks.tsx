import { Box } from '@mantine/core';
import { MapControl, MapTracks, useMapBusy, useMapViewport } from '@ein/ui/components';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useMapTracks } from '../location/hooks/useTracks.ts';
import { useLiveTracks } from '../location/hooks/useLiveTracks.ts';
import { LiveTrackLayers, LiveTrackList } from '../location/components/LiveTracks.tsx';

/**
 * `/map-layers/archive/tracks`: the reader's tracks on the map around it, those crossing the view,
 * thinned to its zoom; and the tracks recording now, each a pin where it is with the line it has
 * drawn since, listed in the map's top-left corner. Following one there keeps it in view until the
 * map is dragged.
 */
export default function TracksLayer() {
  const viewport = useMapViewport();
  const { tracks, refetchTracks, segments, loading, query } = useMapTracks(true);
  const { live, now } = useLiveTracks(tracks, refetchTracks);
  const [following, setFollowing] = useState<string | null>(null);
  const stopFollowing = useCallback(() => setFollowing(null), []);

  const queryRef = useRef(query);
  queryRef.current = query;
  useEffect(() => {
    if (viewport) queryRef.current(viewport.bounds, viewport.zoom);
  }, [viewport]);
  // Following a track moves the map at every fix, which is not worth a spinner.
  useMapBusy(loading && !following);

  return (
    <>
      <MapTracks tracks={segments} />
      <LiveTrackLayers live={live} now={now} following={following} onStopFollowing={stopFollowing} onPick={setFollowing} />
      {live.length > 0 && (
        <MapControl place='top-left'>
          <Box className='mrx-map-live' w={240} maw='100%'>
            <LiveTrackList live={live} now={now} following={following} onFollow={setFollowing} />
          </Box>
        </MapControl>
      )}
    </>
  );
}
