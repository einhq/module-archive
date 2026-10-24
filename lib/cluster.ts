/**
 * Grid clustering for map viewports.
 *
 * Pure so it can be tested without a VFS: the command feeds it points that came
 * out of the location registry and gets back one row per occupied cell.
 *
 * The cell is a size in degrees, which is what the caller can derive from its
 * own zoom level — the server has no opinion about how far apart two markers
 * have to be before they stop overlapping, and only the client knows how many
 * pixels a degree is worth.
 */

type ClusterPoint = {
  id: string;
  lat: number;
  lng: number;
};

type Cluster = {
  /** Cell coordinates, stable for a given cell size — the client's marker key. */
  key: string;
  /** Centroid of the points in the cell, which is where the marker goes. */
  lat: number;
  lng: number;
  count: number;
  /** Location ids in this cell, kept for callers that deliberately inline a small answer. */
  memberIds: string[];
  /** Set only when the cell holds exactly one point, so it can be resolved. */
  singleId?: string;
};

/**
 * Bucket points into a `cell`-degree grid.
 *
 * Ordered by count descending, then by key, so the output is deterministic and
 * a caller that truncates keeps the clusters that matter.
 */
export function clusterPoints(points: ClusterPoint[], cell: number): Cluster[] {
  const buckets = new Map<string, ClusterPoint[]>();

  for (const point of points) {
    const key = `${Math.floor(point.lng / cell)}:${Math.floor(point.lat / cell)}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(point);
    else buckets.set(key, [point]);
  }

  const clusters: Cluster[] = [];

  for (const [key, bucket] of buckets) {
    let sumLat = 0;
    let sumLng = 0;

    for (const point of bucket) {
      sumLat += point.lat;
      sumLng += point.lng;
    }

    clusters.push({
      key,
      lat: sumLat / bucket.length,
      lng: sumLng / bucket.length,
      count: bucket.length,
      memberIds: bucket.map((point) => point.id),
      ...(bucket.length === 1 ? { singleId: bucket[0].id } : {}),
    });
  }

  clusters.sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return clusters;
}
