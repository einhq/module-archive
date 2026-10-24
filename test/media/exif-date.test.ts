/**
 * What `parseExifDate` accepts, and — the point of the module — what it refuses. Then which
 * tag `pickCaptureDate` believes, where the refusals matter most: every scan in the corpus
 * carries a `CreateDate` that is the day it was digitised.
 */

import { assertEquals } from '@std/assert';
import { exifPartsToWallClock, parseExifDate, pickCaptureDate } from '@archive/media/exif-date';

Deno.test('parseExifDate accepts a capture time', () => {
  assertEquals(parseExifDate('2015:07:25 14:03:11'), {
    year: '2015',
    month: '07',
    day: '25',
    hour: '14',
    minute: '03',
    second: '11',
  });
});

Deno.test('parseExifDate keeps the zone, normalizing Z', () => {
  assertEquals(parseExifDate('2015:07:25 14:03:11Z')?.timezone, '+00:00');
  assertEquals(parseExifDate('2015:07:25 14:03:11+02:00')?.timezone, '+02:00');
  assertEquals(parseExifDate('2015:07:25 14:03:11.250+02:00')?.timezone, '+02:00');
});

Deno.test('parseExifDate accepts a tag without seconds', () => {
  const parts = parseExifDate('2015/07/25 14:03');
  assertEquals(parts?.minute, '03');
  assertEquals(parts?.second, undefined);
});

Deno.test('parseExifDate rejects zero-clock sentinels', () => {
  for (
    const input of [
      '0000:00:00 00:00:00',
      '0000:00:00 00:00:00Z',
      '1970:01:01 00:00:00',
      '1904:01:01 00:00:00',
    ]
  ) {
    assertEquals(parseExifDate(input), null, input);
  }
});

Deno.test('parseExifDate rejects a year no camera could have captured', () => {
  assertEquals(parseExifDate('1800:05:04 10:00:00'), null);
  assertEquals(parseExifDate(`${new Date().getUTCFullYear() + 5}:05:04 10:00:00`), null);
});

Deno.test('parseExifDate rejects days that do not exist', () => {
  assertEquals(parseExifDate('2015:02:30 10:00:00'), null);
  assertEquals(parseExifDate('2015:13:01 10:00:00'), null);
  assertEquals(parseExifDate('2015:07:25 25:00:00'), null);
});

Deno.test('parseExifDate rejects what is not a date at all', () => {
  assertEquals(parseExifDate(''), null);
  assertEquals(parseExifDate('undef'), null);
  assertEquals(parseExifDate('2015:07:25'), null);
});

Deno.test('exifPartsToWallClock defaults only the parts that may be absent, and never claims a zone', () => {
  const parts = parseExifDate('2015:07:25 14:03')!;
  assertEquals(exifPartsToWallClock(parts), '2015-07-25T14:03:00');
  // The tag's own offset is parsed and kept in the parts, but it is not appended here:
  // whether it reaches `takenAt` is @archive/media/resolve-time's call, weighed against the GPS fix
  // and the device registry.
  assertEquals(parseExifDate('2015:07:25 14:03:11Z')!.timezone, '+00:00');
  assertEquals(exifPartsToWallClock(parseExifDate('2015:07:25 14:03:11Z')!), '2015-07-25T14:03:11');
});

/** A scanned negative's own tags: its `CreateDate` is the day Photoshop saved it. */
Deno.test('pickCaptureDate refuses an editor CreateDate on a still image', () => {
  assertEquals(
    pickCaptureDate({
      MIMEType: 'image/jpeg',
      CreateDate: '2008:01:08 15:48:25+01:00',
      ModifyDate: '2008:01:14 16:50:27',
      CreatorTool: 'Adobe Photoshop CS2 Windows',
      XMPToolkit: '3.1.1-111',
    }),
    null,
  );
});

Deno.test('pickCaptureDate refuses a flatbed CreateDate on a still image', () => {
  // A scanner writes ExifVersion, so that tag can never stand in for capture evidence.
  assertEquals(
    pickCaptureDate({
      MIMEType: 'image/jpeg',
      CreateDate: '2016:03:10 18:05:55',
      Model: 'CanoScan 9000F Mark II',
      Software: 'IJ Scan Utility',
      ExifVersion: '0230',
    }),
    null,
  );
});

Deno.test('pickCaptureDate keeps a CreateDate a camera stands behind', () => {
  // A phone photo whose DateTimeOriginal an editor stripped, but the exposure tags survived.
  const picked = pickCaptureDate({
    MIMEType: 'image/jpeg',
    CreateDate: '2015:06:16 20:39:21',
    Model: 'Nexus 4',
    FNumber: 2.4,
    ExposureTime: 0.033,
    ISO: 100,
    SubSecTimeOriginal: '478032',
  });
  assertEquals(picked?.source, 'CreateDate');
  assertEquals(exifPartsToWallClock(picked!.parts), '2015-06-16T20:39:21');
});

Deno.test('pickCaptureDate takes DateTimeOriginal with no evidence to back it', () => {
  const picked = pickCaptureDate({
    MIMEType: 'image/jpeg',
    DateTimeOriginal: '2020:06:15 12:30:00',
    CreateDate: '2024:01:01 09:00:00',
  });
  assertEquals(picked?.source, 'DateTimeOriginal');
  assertEquals(exifPartsToWallClock(picked!.parts), '2020-06-15T12:30:00');
});

Deno.test('pickCaptureDate keeps a container CreateDate — the recorder wrote it', () => {
  for (const MIMEType of ['video/mp4', 'video/quicktime', 'audio/mp4']) {
    const picked = pickCaptureDate({ MIMEType, CreateDate: '2019:08:03 11:15:00' });
    assertEquals(picked?.source, 'CreateDate', MIMEType);
    assertEquals(exifPartsToWallClock(picked!.parts), '2019-08-03T11:15:00', MIMEType);
  }
});

Deno.test('pickCaptureDate prefers CreationDate on an Apple video', () => {
  const picked = pickCaptureDate({
    MIMEType: 'video/quicktime',
    Make: 'Apple',
    CreationDate: '2021:05:02 18:00:00+02:00',
    CreateDate: '2021:05:02 16:00:00',
  });
  assertEquals(picked?.source, 'CreationDate');
  assertEquals(exifPartsToWallClock(picked!.parts), '2021-05-02T18:00:00');
});

Deno.test("pickCaptureDate reads a phone's or ffmpeg's container CreateDate as UTC", () => {
  const records = [
    { MIMEType: 'video/mp4', AndroidVersion: '10', CreateDate: '2023:06:02 17:48:23' },
    { MIMEType: 'video/quicktime', Make: 'Apple', CreateDate: '2023:06:02 17:48:23' },
    { MIMEType: 'video/mp4', Encoder: 'Lavf61.7.103', CreateDate: '2023:06:02 17:48:23' },
  ];
  for (const raw of records) {
    const picked = pickCaptureDate(raw);
    assertEquals(picked?.source, 'CreateDate');
    assertEquals(picked?.parts.timezone, 'Z');
    assertEquals(exifPartsToWallClock(picked!.parts), '2023-06-02T17:48:23');
  }
});

Deno.test("pickCaptureDate leaves a camera's container CreateDate a wall clock, marked as one", () => {
  const picked = pickCaptureDate({ MIMEType: 'video/mp4', DeviceManufacturer: 'Sony', CreateDate: '2019:08:03 11:15:00' });
  assertEquals(picked?.parts.timezone, undefined);
  assertEquals(picked?.parts.quicktime, true);
});

Deno.test('pickCaptureDate marks no still image CreateDate as a container one', () => {
  const picked = pickCaptureDate({ MIMEType: 'image/jpeg', FNumber: 2.8, CreateDate: '2019:08:03 11:15:00' });
  assertEquals(picked?.source, 'CreateDate');
  assertEquals(picked?.parts.quicktime, undefined);
});

Deno.test('pickCaptureDate treats an unknown mimetype as a still image', () => {
  assertEquals(pickCaptureDate({ CreateDate: '2016:03:10 18:05:55' }), null);
});

Deno.test('pickCaptureDate still refuses a sentinel, evidence or not', () => {
  assertEquals(
    pickCaptureDate({
      MIMEType: 'image/jpeg',
      DateTimeOriginal: '0000:00:00 00:00:00',
      FNumber: 2.8,
    }),
    null,
  );
});
