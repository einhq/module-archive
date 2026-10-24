/**
 * What a lasso over the Sort stream takes, from geometry the page holds rather than from the
 * page's layout: a closed section is where the stream's arithmetic puts it, its header and its
 * strip of pictures a fixed height, and the open group's pictures are where its grids laid them
 * out, indexed by row. Pure, so it is tested without a page.
 */
import { type LassoHits, type LassoRect, sectionHit, type TileIndex, tilesInRect } from '@ein/ui/lib';

/** A section the band crosses, as the stream places it: px from the stream's top. */
type CrossedSection = { key: string; top: number; height: number; open: boolean };

/** Where the stream is on the page, and what a closed section is made of, read once as the lasso starts. */
export type StreamGeometry = {
  /** The stream's edges, in page px. */
  left: number;
  right: number;
  top: number;
  /** A closed section's padding at either side, header height and strip height. */
  inset: number;
  header: number;
  strip: number;
  /** The open group: its key, where its grids start in page px, its pictures' boxes indexed, and their paths in order. */
  open?: { key: string; left: number; top: number; index: TileIndex; paths: readonly string[] };
};

/**
 * What `band` (page px) takes of the sections it crosses: a closed section whole when it touches
 * its header or covers half of its strip; in the open group, each picture it touches.
 */
export function streamHits(band: LassoRect, crossed: readonly CrossedSection[], geometry: StreamGeometry): LassoHits {
  const sections = new Set<string>();
  const items = new Map<string, string>();
  const left = geometry.left + geometry.inset;
  const right = geometry.right - geometry.inset;
  for (const section of crossed) {
    if (section.open) {
      const open = geometry.open;
      if (open?.key !== section.key) continue;
      const local = { left: band.left - open.left, right: band.right - open.left, top: band.top - open.top, bottom: band.bottom - open.top };
      for (const at of tilesInRect(open.index, local)) items.set(open.paths[at], section.key);
      continue;
    }
    const top = geometry.top + section.top;
    const header = { left, right, top, bottom: top + geometry.header };
    const strip = { left, right, top: header.bottom, bottom: header.bottom + geometry.strip };
    if (sectionHit(band, { header, strip })) sections.add(section.key);
  }
  return { sections, items };
}
