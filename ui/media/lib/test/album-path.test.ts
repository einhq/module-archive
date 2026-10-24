import { ALBUMS_ROOT } from '@archive/paths';
import { assertEquals } from '@std/assert';
import { albumContentDir, albumPathOf, albumRoute, stagingGroupRoute } from '../album-path.ts';
import type { NodeChildEntry } from '@ein/ui/lib';

Deno.test('album path: a file under an album reports the whole path', () => {
  assertEquals(albumPathOf(`${ALBUMS_ROOT}/Sommarfest/IMG_1234.jpg`), `${ALBUMS_ROOT}/Sommarfest`);
  // Only the album itself, not the sub-directory the file happens to sit in.
  assertEquals(albumPathOf(`${ALBUMS_ROOT}/Sailing trip/2013/day1/IMG_1.jpg`), `${ALBUMS_ROOT}/Sailing trip`);
  assertEquals(albumPathOf('/home/anna/staging/albums/inbox/Weekend/files/IMG_2.jpg'), '/home/anna/staging/albums/inbox/Weekend');
  assertEquals(albumPathOf('/home/anna/staging/albums/scans/box-3/IMG_3.jpg'), '/home/anna/staging/albums/scans/box-3');
});

Deno.test(`album path: a file outside ${ALBUMS_ROOT} has no album`, () => {
  assertEquals(albumPathOf('/uploads/loose.jpg'), undefined);
  assertEquals(albumPathOf(`${ALBUMS_ROOT}/only-a-directory`), undefined);
  assertEquals(albumPathOf(''), undefined);
  assertEquals(albumPathOf('/home/anna/staging/albums/inbox/Weekend'), undefined);
  assertEquals(albumPathOf('/home/anna/staging/files/inbox/upload-2026-10-16/IMG_4.jpg'), undefined);
});

Deno.test("album path: a reader's own suggested group, in any category, has a route into its Sort stream, any other album none", () => {
  assertEquals(stagingGroupRoute('/home/anna/staging/albums/inbox/auto-2019-06-14', 'anna'), '/staging?c=inbox&g=auto-2019-06-14');
  assertEquals(stagingGroupRoute('/home/anna/staging/albums/inbox/auto-2019-06-14/IMG_2.jpg', 'anna'), undefined);
  assertEquals(stagingGroupRoute('/home/anna/staging/albums/inbox', 'anna'), undefined);
  assertEquals(stagingGroupRoute('/home/anna/staging/albums/inbox/.organizer', 'anna'), undefined);
  assertEquals(stagingGroupRoute('/home/anna/staging/albums/scans/box-3', 'anna'), '/staging?c=scans&g=box-3');
  assertEquals(stagingGroupRoute(`${ALBUMS_ROOT}/Lake weekend`, 'anna'), undefined);
  // Another user's suggestion is not in this reader's stream, though an administrator may open its page.
  assertEquals(stagingGroupRoute('/home/anna/staging/albums/inbox/auto-2019-06-14', 'bertil'), undefined);
  assertEquals(stagingGroupRoute('/home/annabelle/staging/albums/inbox/auto-2019-06-14', 'anna'), undefined);
});

// `/albums/` here is the *browser route*, whose `:id` is the encoded VFS path.
const ALBUM_ROUTE_PREFIX = '/albums/';

Deno.test('album path: the route encodes the path the way the album page decodes it', () => {
  const path = `${ALBUMS_ROOT}/Ödla & Örn`;
  assertEquals(albumRoute(path), `${ALBUM_ROUTE_PREFIX}${encodeURIComponent(path)}`);
  assertEquals(decodeURIComponent(albumRoute(path).slice(ALBUM_ROUTE_PREFIX.length)), path);
});

/** The parts of a `ls -l` entry the content-directory rule reads; the rest is noise here. */
function entry(name: string, type: string, attrs: Record<string, unknown> = {}, softlink?: string): NodeChildEntry {
  return {
    node: {
      id: name,
      type,
      props: {
        uid: 1000,
        gid: 1000,
        mode: 0o755,
        birthtime: { uid: 1000, timestamp: 0 },
        changetime: { uid: 1000, timestamp: 0 },
        modtime: { uid: 1000, timestamp: 0 },
        count: 0,
        softlink,
      },
      attrs,
    },
    name,
    childCount: 0,
  };
}

Deno.test('album content dir: an imported album writes into its files/ child', () => {
  const children = [entry('files', 'directory'), entry('metadata', 'directory')];
  assertEquals(albumContentDir(`${ALBUMS_ROOT}/Sailing trip`, children), `${ALBUMS_ROOT}/Sailing trip/files`);
});

Deno.test('album content dir: an album holding media keeps its own path', () => {
  // Both spellings of "holds media": real files, and the softlinks an auto album
  // is made of. A files/ child alongside them is a folder like any other.
  const withFile = [entry('files', 'directory'), entry('IMG_1.jpg', 'file', { mimetype: 'image/jpeg' })];
  assertEquals(albumContentDir(`${ALBUMS_ROOT}/Jul`, withFile), `${ALBUMS_ROOT}/Jul`);

  const withLink = [entry('files', 'directory'), entry('IMG_2.jpg', 'softlink', {}, `${ALBUMS_ROOT}/Jul/IMG_2.jpg`)];
  assertEquals(albumContentDir(`${ALBUMS_ROOT}/2019`, withLink), `${ALBUMS_ROOT}/2019`);
});

Deno.test('album content dir: an empty or plain album keeps its own path', () => {
  assertEquals(albumContentDir(`${ALBUMS_ROOT}/Ny`, []), `${ALBUMS_ROOT}/Ny`);
  // `files` has to be a directory to be descended into, and a cover softlink is
  // not media the album holds.
  assertEquals(albumContentDir(`${ALBUMS_ROOT}/Ny`, [entry('files', 'file', { mimetype: 'text/plain' })]), `${ALBUMS_ROOT}/Ny`);
  assertEquals(albumContentDir(`${ALBUMS_ROOT}/Ny`, [entry('coverPhoto', 'softlink', {}, `${ALBUMS_ROOT}/Ny/a.jpg`)]), `${ALBUMS_ROOT}/Ny`);
});

Deno.test('album content dir: links to the neighbours in a series and the cover leave an imported album writing into files/', () => {
  const children = [
    entry('files', 'directory'),
    entry('coverPhoto', 'softlink', {}, `${ALBUMS_ROOT}/Sailing trip/files/a.jpg`),
    entry('previous', 'softlink', {}, `${ALBUMS_ROOT}/Sailing trip 2012`),
    entry('next', 'softlink', {}, `${ALBUMS_ROOT}/Sailing trip 2014`),
  ];
  assertEquals(albumContentDir(`${ALBUMS_ROOT}/Sailing trip`, children), `${ALBUMS_ROOT}/Sailing trip/files`);
});
