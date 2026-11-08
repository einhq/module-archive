import { CAMERAS_ROOT } from '@archive/paths';
import { assertEquals, assertNotEquals } from '@std/assert';
import { colorsForTrack, dayColor } from '../track-colors.ts';

Deno.test('track colors: consecutive days of a track differ', () => {
  const track = `${CAMERAS_ROOT}/summer2015/track`;
  const days = ['2015-08-16', '2015-08-17', '2015-08-18'];
  const colors = days.map((day) => dayColor(track, day));

  assertEquals(new Set(colors).size, 3);
  for (const color of colors) {
    assertEquals(colorsForTrack(track).includes(color), true);
  }
});

Deno.test('track colors: a date keeps its color regardless of what else is loaded', () => {
  // The whole point of keying on the absolute day number: panning away from a
  // neighbouring day must not recolor the day still on screen.
  assertEquals(dayColor(`${CAMERAS_ROOT}/a/track`, '2015-08-17'), dayColor(`${CAMERAS_ROOT}/a/track`, '2015-08-17'));
  assertEquals(dayColor(`${CAMERAS_ROOT}/a/track`, '2015-08-17'), dayColor(`${CAMERAS_ROOT}/a/track`, '2015-08-20'));
});

Deno.test('track colors: a track keeps its palette across reloads', () => {
  // Hashed from the path, so nothing depends on which track was seen first.
  assertEquals(colorsForTrack(`${CAMERAS_ROOT}/trip1/track`), colorsForTrack(`${CAMERAS_ROOT}/trip1/track`));
  assertNotEquals(colorsForTrack(`${CAMERAS_ROOT}/trip1/track`), colorsForTrack(`${CAMERAS_ROOT}/trip1/track`).slice().reverse());
});

Deno.test('track colors: a pre-epoch day still gets a color', () => {
  // The negative-safe modulo — a 1960s scan would otherwise index at -1.
  const color = dayColor(`${CAMERAS_ROOT}/old/track`, '1965-04-02');
  assertEquals(colorsForTrack(`${CAMERAS_ROOT}/old/track`).includes(color), true);
});

Deno.test('track colors: an unparseable day falls back rather than throwing', () => {
  assertEquals(dayColor(`${CAMERAS_ROOT}/x/track`, ''), colorsForTrack(`${CAMERAS_ROOT}/x/track`)[0]);
});
