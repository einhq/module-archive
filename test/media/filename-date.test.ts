/**
 * Capture times in file names (`@archive/media/filename-date`): each writer's form at the precision
 * it carries, UTC where the writer keeps its clock in UTC, and nothing for a name that only looks
 * like a date.
 */
import { assertEquals } from '@std/assert';
import { filenameDate } from '@archive/media/filename-date';

Deno.test('every writer form gives its capture time, at the precision it has', () => {
  const cases: [string, string][] = [
    ['IMG_20190601_123456.jpg', '2019-06-01T12:34:56'],
    ['VID_20190601_123456.mp4', '2019-06-01T12:34:56'],
    ['PANO_20190601_123456.jpg', '2019-06-01T12:34:56'],
    ['MVIMG_20190601_123456.jpg', '2019-06-01T12:34:56'],
    ['IMG_20190601_123456_1.jpg', '2019-06-01T12:34:56'],
    ['20190601_123456.jpg', '2019-06-01T12:34:56'],
    ['20190601_123456(0).heic', '2019-06-01T12:34:56'],
    ['PXL_20190601_103456789.jpg', '2019-06-01T10:34:56Z'],
    ['PXL_20190601_103456789.MP.jpg', '2019-06-01T10:34:56Z'],
    ['IMG-20190601-WA0001.jpg', '2019-06-01'],
    ['VID-20190601-WA0012.mp4', '2019-06-01'],
    ['AUD-20190601-WA0003.opus', '2019-06-01'],
    ['PTT-20190601-WA0004.opus', '2019-06-01'],
    ['signal-2019-06-01-123456.jpg', '2019-06-01T12:34:56'],
    ['Screenshot_20190601-123456.png', '2019-06-01T12:34:56'],
    ['Screenshot_20190601-123456_Maps.jpg', '2019-06-01T12:34:56'],
    ['Screenshot_2019-06-01-12-34-56.png', '2019-06-01T12:34:56'],
    ['Screenshot 2019-06-01 at 12.34.56.png', '2019-06-01T12:34:56'],
    ['2019-06-01 12.34.56.jpg', '2019-06-01T12:34:56'],
    ['2019-06-01 12.34.56-1.jpg', '2019-06-01T12:34:56'],
    ['2019-06-01_12.34.56.jpg', '2019-06-01T12:34:56'],
    ['2019-06-01_12.34.56-2.png', '2019-06-01T12:34:56'],
    ['image-20190601_123456.jpg', '2019-06-01T12:34:56'],
    ['download_20190601_123456.jpeg', '2019-06-01T12:34:56'],
    ['IMG_20190601_123456:nopm:.jpg', '2019-06-01T12:34:56'],
    ['FB_IMG_1559392496000.jpg', '2019-06-01T12:34:56Z'],
  ];
  assertEquals(cases.map(([name]) => [name, filenameDate(name)]), cases);
});

Deno.test("a scanner's running number, an ordinary name and a date inside a name spell nothing", () => {
  for (
    const name of [
      'IMG_20190601_0001.jpg',
      'IMG_0001.jpg',
      'scan0001.tif',
      'DSC01234.JPG',
      'Sommar 2019-06-01 12.34.56.jpg',
      'P1090014.JPG',
      'IMG_20190601_1234567.jpg',
      '20190601_1234.jpg',
      'IMG-20190601.jpg',
    ]
  ) {
    assertEquals(filenameDate(name), undefined, name);
  }
});

Deno.test('a date the calendar or the clock does not have, or out of range, is refused', () => {
  for (
    const name of [
      'IMG_20190230_120000.jpg',
      'IMG_20191301_120000.jpg',
      'IMG_20190601_250000.jpg',
      'IMG_20190601_126100.jpg',
      'IMG_19940601_120000.jpg',
      `IMG_${new Date().getUTCFullYear() + 2}0601_120000.jpg`,
      '1990-06-01 12.00.00.jpg',
      'IMG-00000000-WA0001.jpg',
    ]
  ) {
    assertEquals(filenameDate(name), undefined, name);
  }
  assertEquals(filenameDate('IMG_19950101_000000.jpg'), '1995-01-01T00:00:00');
});
