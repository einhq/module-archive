// deno-lint-ignore no-explicit-any
type NodeAttrs = Record<string, any>;
type NodeType = string;

/** One Nominatim answer kept for a human to choose from, see `geocodeStatus`. */
type GeocodeCandidateAttr = {
  lat: number;
  lng: number;
  displayName: string;
  type: string;
  importance: number;
};

/**
 * A location's attrs. Where it is on the map is not here: that is its child
 * `position`, a core position node.
 */
export type LocationAttrs = NodeAttrs & {
  name?: string;
  description?: string;
  /**
   * The address as a human wrote it — the *input* to forward geocoding, kept
   * apart from `displayName`, which is whatever the geocoder resolved it to.
   */
  address?: string;
  country?: string;
  state?: string;
  city?: string;
  road?: string;
  houseNumber?: string;
  postcode?: string;
  displayName?: string;
  /** Set once coordinates were successfully derived (either direction). */
  geocodedAt?: string;
  /**
   * Where the shape came from. `media-centroid` is derived from the geotagged
   * files linked to the location and is preferred over an address lookup: it is
   * measured rather than looked up, and it describes the location's extent.
   * `nominatim` means the written address was geocoded instead. `manual` means
   * a human drew it, which outranks both — and which is why editing a shape has
   * to overwrite this rather than leave the old answer standing.
   */
  locationSource?: 'media-centroid' | 'nominatim' | 'manual';
  /** `media-centroid` only: how many files the position rests on. */
  locationPoints?: number;
  /** `media-centroid` only: how far those files spread, in meters. */
  locationSpread?: number;
  /**
   * Forward geocoding only. `review` means the answer was not certain enough to
   * apply and `geocodeCandidates` is waiting for someone to pick one; `none`
   * means the geocoder had nothing at all.
   */
  geocodeStatus?: 'applied' | 'review' | 'none';
  /** Marks that we asked, so a re-run does not hammer the geocoder again. */
  geocodeAttemptedAt?: string;
  geocodeSource?: string;
  /** The address text the last attempt read, so an edited address is looked up again. */
  geocodeInput?: string;
  /** The text actually sent to the geocoder, which a relaxed lookup shortens. */
  geocodeQuery?: string;
  /**
   * The full address found nothing and only its street line did, so the answer
   * rests on the postcode matching rather than on the address as written.
   */
  geocodeRelaxed?: boolean;
  geocodePrecision?: 'house' | 'road' | 'area';
  geocodeCandidates?: GeocodeCandidateAttr[];
};

export const NODE_TYPE_LOCATION: NodeType = 'location';
