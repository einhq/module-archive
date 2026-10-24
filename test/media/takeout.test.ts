/**
 * Google Photos Takeout sidecars (`@archive/media/takeout`): what a photo's JSON and an album's
 * `metadata.json` say, and how a folder's JSONs pair with its photos by Google's naming: both name
 * forms, names cut at 51 characters, the `(1)` numbering that moves to the end, edited copies and
 * Live Photo videos sharing their original's, and nothing paired that two photos could claim.
 *
 * Every JSON here is invented.
 */
import { assertEquals } from '@std/assert';
import { matchTakeout, parseTakeoutJson, takeoutName } from '@archive/media/takeout';

const PHOTO = {
  title: 'IMG_20190601_123456.jpg',
  description: 'En segelbåt vid bryggan',
  imageViews: '3',
  creationTime: { timestamp: '1561975200', formatted: '1 Jul 2019, 10:00:00 UTC' },
  photoTakenTime: { timestamp: '1559392496', formatted: '1 Jun 2019, 12:34:56 UTC' },
  geoData: { latitude: 57.7, longitude: 11.95, altitude: 0, latitudeSpan: 0, longitudeSpan: 0 },
  geoDataExif: { latitude: 57.7, longitude: 11.95, altitude: 0, latitudeSpan: 0, longitudeSpan: 0 },
  people: [{ name: 'Anna Andersson' }, { name: 'Bo Berg' }],
  url: 'https://photos.google.com/photo/AF1Qip-example',
  googlePhotosOrigin: { mobileUpload: { deviceFolder: { localFolderName: 'WhatsApp Images' }, deviceType: 'ANDROID_PHONE' } },
  favorited: true,
};

Deno.test("a photo's JSON gives its times in UTC, its place, caption, people, favourite and phone folder", () => {
  assertEquals(parseTakeoutJson(JSON.stringify(PHOTO)), {
    kind: 'takeout',
    title: 'IMG_20190601_123456.jpg',
    takenAt: '2019-06-01T12:34:56Z',
    uploadedAt: '2019-07-01T10:00:00Z',
    where: { lat: 57.7, lng: 11.95 },
    description: 'En segelbåt vid bryggan',
    people: ['Anna Andersson', 'Bo Berg'],
    favorited: true,
    localFolder: 'WhatsApp Images',
  });
});

Deno.test('a place set in Google Photos is marked edited; 0,0 and a time of 0 are nothing', () => {
  const moved = { ...PHOTO, geoData: { latitude: 59.33, longitude: 18.07 } };
  const edited = parseTakeoutJson(JSON.stringify(moved));
  assertEquals(edited?.kind === 'takeout' && [edited.where, edited.whereEdited], [{ lat: 59.33, lng: 18.07 }, true]);
  const same = parseTakeoutJson(JSON.stringify(PHOTO));
  assertEquals(same?.kind === 'takeout' && same.whereEdited, undefined);
  // A place only Google has, none in the file's own tags, is a person's too.
  const added = parseTakeoutJson(JSON.stringify({ ...PHOTO, geoDataExif: { latitude: 0, longitude: 0 } }));
  assertEquals(added?.kind === 'takeout' && [added.where, added.whereEdited], [{ lat: 57.7, lng: 11.95 }, true]);
  const blank = parseTakeoutJson(JSON.stringify({
    title: 'IMG_0001.jpg',
    photoTakenTime: { timestamp: '0' },
    geoData: { latitude: 0, longitude: 0 },
    geoDataExif: { latitude: 0, longitude: 0 },
    archived: true,
    trashed: true,
  }));
  assertEquals(blank, { kind: 'takeout', title: 'IMG_0001.jpg', archived: true, trashed: true });
});

Deno.test("an album's metadata gives its title, caption and date, in either export's shape; other JSON is nothing", () => {
  assertEquals(
    parseTakeoutJson(JSON.stringify({ title: 'Sommar i Exempelstad', description: 'Veckan vid sjön', access: 'protected', date: { timestamp: '1561975200' } })),
    { kind: 'takeout-album', title: 'Sommar i Exempelstad', description: 'Veckan vid sjön', date: '2019-07-01T10:00:00Z' },
  );
  assertEquals(parseTakeoutJson(JSON.stringify({ albumData: { title: 'Fjällen 2018', date: { timestamp: '0' } } })), { kind: 'takeout-album', title: 'Fjällen 2018' });
  assertEquals(parseTakeoutJson(JSON.stringify({ name: 'package', version: '1.0.0' })), undefined);
  assertEquals(parseTakeoutJson(JSON.stringify({ title: 'a title alone' })), undefined);
  assertEquals(parseTakeoutJson('[1, 2]'), undefined);
  assertEquals(parseTakeoutJson('{ not json'), undefined);
});

Deno.test("a JSON's own name gives the photo's name as far as Google kept it, and its number", () => {
  assertEquals(takeoutName('IMG_0001.jpg.json'), { base: 'IMG_0001.jpg' });
  assertEquals(takeoutName('IMG_0001.jpg.supplemental-metadata.json'), { base: 'IMG_0001.jpg' });
  assertEquals(takeoutName('IMG_0001.jpg.supplemental-metad.json'), { base: 'IMG_0001.jpg' });
  assertEquals(takeoutName('IMG_0001.jpg.s.json'), { base: 'IMG_0001.jpg' });
  assertEquals(takeoutName('IMG_0001.jpg(1).json'), { base: 'IMG_0001.jpg', counter: 1 });
  assertEquals(takeoutName('IMG_0001.jpg.supplemental-metadata(2).json'), { base: 'IMG_0001.jpg', counter: 2 });
  assertEquals(takeoutName('IMG_0001.JSON'), { base: 'IMG_0001' });
  assertEquals(takeoutName('metadata.json'), { base: 'metadata' });
  assertEquals(takeoutName('IMG_0001.jpg'), undefined);
});

/** The pairs of a folder, as JSON name → photo name, and the shared, as photo name → JSON name. */
const pairs = (sidecars: [string, string?][], media: string[]) => {
  const match = matchTakeout(sidecars.map(([name, title]) => ({ name, ...(title ? { title } : {}) })), media);
  return { paired: Object.fromEntries(match.paired), shared: Object.fromEntries(match.shared) };
};

Deno.test('both name forms pair by title, and by the name alone when the title says something else', () => {
  assertEquals(
    pairs([['IMG_0001.jpg.json', 'IMG_0001.jpg'], ['IMG_0002.jpg.supplemental-metadata.json', 'IMG_0002.jpg'], ['IMG_0003.jpg.json', 'Renamed in Google.jpg']], [
      'IMG_0001.jpg',
      'IMG_0002.jpg',
      'IMG_0003.jpg',
    ]).paired,
    { 'IMG_0001.jpg.json': 'IMG_0001.jpg', 'IMG_0002.jpg.supplemental-metadata.json': 'IMG_0002.jpg', 'IMG_0003.jpg.json': 'IMG_0003.jpg' },
  );
  // A case Google wrote differently in the name than in the file.
  assertEquals(pairs([['IMG_0004.JPG.json', 'IMG_0004.JPG']], ['IMG_0004.jpg']).paired, { 'IMG_0004.JPG.json': 'IMG_0004.jpg' });
});

Deno.test('the number Google moves to the end goes back before the extension', () => {
  assertEquals(
    pairs([
      ['IMG_0001.jpg.json', 'IMG_0001.jpg'],
      ['IMG_0001.jpg(1).json', 'IMG_0001.jpg'],
      ['IMG_0001.jpg.supplemental-metadata(2).json', 'IMG_0001.jpg'],
    ], ['IMG_0001.jpg', 'IMG_0001(1).jpg', 'IMG_0001(2).jpg']).paired,
    { 'IMG_0001.jpg.json': 'IMG_0001.jpg', 'IMG_0001.jpg(1).json': 'IMG_0001(1).jpg', 'IMG_0001.jpg.supplemental-metadata(2).json': 'IMG_0001(2).jpg' },
  );
});

Deno.test('a name cut at 51 characters pairs with the one photo it starts, never by its length', () => {
  const long = 'Exempelstad_hamnfest_med_segelbatar_och_musik_2019.jpg';
  // The supplemental suffix gone, and the photo's own name cut short of its extension.
  const cut = `${long.slice(0, 46)}.json`;
  assertEquals(cut.length, 51);
  assertEquals(pairs([[cut]], [long, 'IMG_0001.jpg']).paired, { [cut]: long });
  // Google cut the photo's name too: the title is the whole name, the file holds its start.
  const shortened = `${long.slice(0, 43)}.jpg`;
  assertEquals(pairs([[cut, long]], [shortened, 'IMG_0001.jpg']).paired, { [cut]: shortened });
  // Two photos the cut name starts: neither.
  assertEquals(pairs([['Exempelstad_hamnfest_med_segel.json']], ['Exempelstad_hamnfest_med_segel_A.jpg', 'Exempelstad_hamnfest_med_segel_B.jpg']).paired, {});
  // Too short a start to be believed.
  assertEquals(pairs([['IMG.json']], ['IMG_0001.jpg']).paired, {});
});

Deno.test("an edited copy and a Live Photo's video share their original's JSON; a photo is claimed once", () => {
  const match = pairs([['IMG_0005.HEIC.json', 'IMG_0005.HEIC'], ['IMG_0006.jpg.json', 'IMG_0006.jpg']], [
    'IMG_0005.HEIC',
    'IMG_0005.MP4',
    'IMG_0006.jpg',
    'IMG_0006-edited.jpg',
    'IMG_0006-redigerad.jpg',
    'IMG_0007-edited.jpg',
  ]);
  assertEquals(match.paired, { 'IMG_0005.HEIC.json': 'IMG_0005.HEIC', 'IMG_0006.jpg.json': 'IMG_0006.jpg' });
  assertEquals(match.shared, { 'IMG_0005.MP4': 'IMG_0005.HEIC.json', 'IMG_0006-edited.jpg': 'IMG_0006.jpg.json', 'IMG_0006-redigerad.jpg': 'IMG_0006.jpg.json' });
  // Two JSONs for one photo: the first by name takes it, the other is left.
  assertEquals(pairs([['IMG_0008.jpg.json', 'IMG_0008.jpg'], ['IMG_0008.jpg.supplemental-metadata.json', 'IMG_0008.jpg']], ['IMG_0008.jpg']).paired, {
    'IMG_0008.jpg.json': 'IMG_0008.jpg',
  });
});
