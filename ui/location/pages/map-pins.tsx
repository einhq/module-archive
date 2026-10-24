import { type GeoBounds, MapMarkers, type MapMarkerSpec, MapShape, MapView, useMap } from '@ein/ui/components';
import type { PositionListing } from '@ein/api';
import { fileUrl, lightboxRoute, shq, THUMB_NAME } from '@ein/ui/lib';
import { execCommand, openFullscreen, openRoute } from '@ein/ui/signals';
import { Box, Center, Loader, Text } from '@mantine/core';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

const HEIGHT = 240;
/** More pins than a card can show apart; the map page is the place for all of them. */
const MAX_PINS = 100;
/** One pin alone: close enough to see the streets around it. */
const SINGLE_ZOOM = 14;
/** Degrees: pins closer together than about this many hundred metres are one spot. */
const SPOT = 0.005;
const METRES_PER_DEGREE = 111_320;

type Pin = {
  /** The node, what a click opens; an area has none. */
  path?: string;
  type?: string;
  label: string;
  lat: number;
  lng: number;
  radius?: number;
  polygon?: { lat: number; lng: number }[];
};

/** A box as `location-region` answers one, drawn as its outline and pinned at its middle. */
const areaPin = (label: string, answer: { north?: unknown; south?: unknown; east?: unknown; west?: unknown }): Pin | undefined => {
  const [north, south, east, west] = [answer.north, answer.south, answer.east, answer.west].map(Number);
  if (![north, south, east, west].every(Number.isFinite) || north < south) return undefined;
  return {
    label,
    lat: (north + south) / 2,
    lng: (east + west) / 2,
    polygon: [{ lat: north, lng: west }, { lat: north, lng: east }, { lat: south, lng: east }, { lat: south, lng: west }],
  };
};

/** Everything a pin covers: its outline, its circle, or itself. */
const extentOf = (pin: Pin): GeoBounds => {
  if (pin.polygon?.length) {
    const lats = pin.polygon.map((vertex) => vertex.lat);
    const lngs = pin.polygon.map((vertex) => vertex.lng);
    return { north: Math.max(...lats), south: Math.min(...lats), east: Math.max(...lngs), west: Math.min(...lngs) };
  }
  const dLat = (pin.radius ?? 0) / METRES_PER_DEGREE;
  const dLng = dLat / Math.max(0.01, Math.cos(pin.lat * Math.PI / 180));
  return { north: pin.lat + dLat, south: pin.lat - dLat, east: pin.lng + dLng, west: pin.lng - dLng };
};

const boundsOf = (pins: Pin[]): GeoBounds =>
  pins.map(extentOf).reduce((all, one) => ({
    north: Math.max(all.north, one.north),
    south: Math.min(all.south, one.south),
    east: Math.max(all.east, one.east),
    west: Math.min(all.west, one.west),
  }));

/** The chat scrolls under the wheel; a map that zoomed on it would catch every scroll that passed. */
function NoWheelZoom() {
  const map = useMap();
  useEffect(() => {
    map?.scrollWheelZoom.disable();
  }, [map]);
  return null;
}

/**
 * A small map of chosen things: the locations and pictures `paths` names, each where the archive
 * has it (`position-get`), and the areas `areas` names, each the box `location-region` gives. What
 * has no position is left out, so no coordinate on it is anyone's guess. It is what the chat
 * draws under an answer about where (a card archive offers), and a page of its own at the same
 * URL. A location is drawn with its outline or circle, an area as its box, a picture as its
 * thumbnail, which opens it.
 */
export default function MapPinsPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const title = params.get('title') ?? undefined;
  const paths = params.getAll('paths').slice(0, MAX_PINS);
  const areas = params.getAll('areas').slice(0, MAX_PINS);
  const key = JSON.stringify([paths, areas]);
  const [pins, setPins] = useState<Pin[] | null>(null);

  useEffect(() => {
    setPins(null);
    let live = true;
    const located = paths.length > 0
      ? execCommand<PositionListing>(`position-get ${paths.map(shq).join(' ')}`).then((answer) =>
        answer.nodes.flatMap((node): Pin[] => node.position ? [{ path: node.path, type: node.type, label: node.name ?? node.path, ...node.position }] : [])
      ).catch(() => [])
      : Promise.resolve([]);
    const boxes = Promise.all(
      areas.map((area) => execCommand<Record<string, unknown>>(`location-region ${shq(area)}`).then((answer) => areaPin(area, answer)).catch(() => undefined)),
    );
    Promise.all([located, boxes]).then(([nodes, regions]) => {
      if (live) setPins([...nodes, ...regions.filter((pin): pin is Pin => !!pin)].slice(0, MAX_PINS));
    });
    return () => {
      live = false;
    };
  }, [key]);

  const bounds = useMemo(() => pins?.length ? boundsOf(pins) : undefined, [pins]);
  const markers = useMemo<MapMarkerSpec[]>(() =>
    (pins ?? []).map((pin) => {
      const picture = pin.type === 'file' && pin.path;
      const route = pin.path && pin.type ? openRoute(pin.type, pin.path) : null;
      return {
        id: pin.path ?? `area:${pin.label}`,
        lat: pin.lat,
        lng: pin.lng,
        label: pin.label,
        ...(picture ? { thumbnailUrl: `${fileUrl(picture)}/thumbnails/${THUMB_NAME}` } : {}),
        onClick: picture ? () => openFullscreen(lightboxRoute(picture)) : route ? () => navigate(route) : undefined,
      };
    }), [pins, navigate]);

  if (!pins) {
    return (
      <Center mih={HEIGHT}>
        <Loader size='sm' />
      </Center>
    );
  }
  if (!bounds) return <Text size='sm' c='dimmed'>Nothing here has a position.</Text>;
  // Pins that all but share a spot: fitting to that would zoom in as far as the tiles go.
  const spot = bounds.north - bounds.south < SPOT && bounds.east - bounds.west < SPOT;
  const summary = `${title ? `${title}: ` : ''}${pins.map((pin) => pin.label).join(', ')}`;
  return (
    <Box role='region' aria-label={summary}>
      {title && <Text size='sm' fw={500} mb={6}>{title}</Text>}
      <Box style={{ height: HEIGHT, borderRadius: 'var(--mantine-radius-sm)', overflow: 'hidden' }}>
        <MapView
          {...(spot ? { center: { lat: (bounds.north + bounds.south) / 2, lng: (bounds.east + bounds.west) / 2 }, zoom: SINGLE_ZOOM } : { bounds })}
          style={{ height: HEIGHT, minHeight: HEIGHT }}
        >
          <NoWheelZoom />
          {pins.filter((pin) => pin.type !== 'file' && (pin.polygon || pin.radius)).map((pin) => (
            <MapShape key={pin.path ?? `area:${pin.label}`} shape={{ lat: pin.lat, lng: pin.lng, radius: pin.radius, polygon: pin.polygon }} />
          ))}
          <MapMarkers markers={markers} />
        </MapView>
      </Box>
    </Box>
  );
}
