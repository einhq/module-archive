/**
 * Track colors.
 *
 * Two levels. A track gets a set of three colors; that track's days cycle
 * through the set, so two consecutive days of the same trip never share a color
 * and a track is still recognisable as one thing. Different tracks get different
 * sets.
 *
 * The set is chosen by hashing the track's path rather than by load order, so a
 * track keeps its colors across reloads and between the map and its detail page.
 */

/** Four sets of three, each set internally distinct and distinct from the others. */
const PALETTES = [
  ['#e6194b', '#4363d8', '#f58231'], // red / blue / orange
  ['#3cb44b', '#911eb4', '#469990'], // green / purple / teal
  ['#f032e6', '#000075', '#808000'], // magenta / navy / olive
  ['#9a6324', '#42d4f4', '#800000'], // brown / cyan / maroon
];

/** FNV-1a, for a stable spread over the palettes without pulling in a dependency. */
function hash(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** The three colors belonging to a track. */
export function colorsForTrack(trackId: string): string[] {
  return PALETTES[hash(trackId) % PALETTES.length];
}

/**
 * The color of one day of one track.
 *
 * Keyed on the absolute day number since the epoch rather than an index into the
 * days we happen to have loaded, so a date's color does not change when the
 * viewport drops a neighbouring day.
 */
export function dayColor(trackId: string, day: string): string {
  const colors = colorsForTrack(trackId);
  const parsed = Date.parse(day);
  if (Number.isNaN(parsed)) return colors[0];
  const dayNumber = Math.floor(parsed / 86400000);
  return colors[((dayNumber % colors.length) + colors.length) % colors.length];
}
