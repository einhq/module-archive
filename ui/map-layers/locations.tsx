import { MapMarkers, type MapMarkerSpec, useMapBusy, useMapViewport } from '@ein/ui/components';
import { kindFill } from '@ein/ui/lib';
import { useEffect, useMemo, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useMapMedia } from '../hooks/useMapMedia.ts';
import { cellFor } from '../lib/map-clusters.ts';
import { mediaLayerQuery } from '../lib/map-layer.ts';

/** The location hue, so a pin reads as a location the same way a card's corner flag does. */
const LOCATION_COLOR = kindFill('location');

/**
 * `/map-layers/archive/locations`: the archive's locations on the map around it, a pin each, which
 * opens the location's page. It takes the media layer's query, and asks what that layer asks, so
 * the two on one map share one read; a search that narrows the media leaves no location, as
 * locations carry none of what it searches.
 */
export default function LocationsLayer() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { filters, years } = useMemo(() => mediaLayerQuery(params), [params.toString()]);
  const viewport = useMapViewport();
  const { locations, loading, query } = useMapMedia(years, filters);

  const queryRef = useRef(query);
  queryRef.current = query;
  useEffect(() => {
    if (viewport) queryRef.current(viewport.bounds, cellFor(viewport.zoom));
  }, [viewport]);
  useMapBusy(loading === 'view');

  const markers = useMemo(() =>
    locations.map((location): MapMarkerSpec => ({
      id: `p-${location.id}`,
      lat: location.lat,
      lng: location.lng,
      label: location.locationId.replaceAll('_', ' '),
      color: LOCATION_COLOR,
      onClick: () => navigate(`/locations/${location.locationId}`),
    })), [locations, navigate]);

  return <MapMarkers markers={markers} />;
}
