/**
 * `search --subject person:…` / `location:…`, answered by archive's `subject-person` and
 * `subject-location`: the reverse lookups from a subject to the media that refers to it, over all
 * three link conventions (a `location` softlink, boxless `people/<slug>` tags and assigned
 * `regions/<name>` boxes), plus paging and combination with the other facets.
 */

import { ALBUMS_ROOT, LOCATIONS_ROOT, PEOPLE_ROOT } from '@archive/paths';
import { assert, assertEquals } from '@std/assert';
import { ADMIN_ACCESS } from '@ein/testing';
import { captureTime, createTestContext, testCommands } from '@ein/testing';

const testCtx = createTestContext({ boot: true, modules: ['archive'] });

type Hit = { path: string; name: string; takenAt?: string };
type Results = { results: Hit[]; truncated: boolean; cursor: string | null; offset: number; filters: Record<string, unknown> };
type LayoutRow = [number, string, number, string, string, number, number, string, number, number, number, number];
type LayoutResults = {
  layout: { directories: string[]; mimetypes: string[]; items: LayoutRow[] };
  truncated: boolean;
  cursor: null;
  offset: number;
};

type Facets = {
  total: number;
  range: { min: number; max: number } | null;
  days: { key: string; count: number }[];
  months: { key: string; count: number }[];
  years: { year: number; count: number }[];
};

const names = (r: Results) => r.results.map((e) => e.path.split('/').pop());
const layoutPaths = (r: LayoutResults) => r.layout.items.map((row) => `${r.layout.directories[row[0]]}/${row[1]}`);

Deno.test({
  name: 'search subjects',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  const mklink = (parent: string, name: string, target: string) =>
    vfs.create(ADMIN_ACCESS, 'softlink', parent, name, {
      props: { uid: ADMIN_ACCESS.uid, gid: ADMIN_ACCESS.gid, mode: 0o777, softlink: target },
    });

  try {
    await cmd.shouldSucceed('mkdir -p /media');
    await cmd.shouldSucceed(`mkdir -p ${PEOPLE_ROOT}`);
    await cmd.shouldSucceed(`mkdir -p ${LOCATIONS_ROOT}`);

    await vfs.create(ADMIN_ACCESS, 'person', PEOPLE_ROOT, 'anna', { attrs: { name: 'Anna' } });
    await vfs.create(ADMIN_ACCESS, 'person', PEOPLE_ROOT, 'anna-andersson', { attrs: { name: 'Anna Andersson' } });
    await vfs.create(ADMIN_ACCESS, 'person', PEOPLE_ROOT, 'bo', { attrs: { name: 'Bo' } });
    await vfs.create(ADMIN_ACCESS, 'location', LOCATIONS_ROOT, 'park');
    await vfs.create(ADMIN_ACCESS, 'location', LOCATIONS_ROOT, 'beach');
    const annaId = (await vfs.get(ADMIN_ACCESS, `${PEOPLE_ROOT}/anna`)).id;

    const fixtures: [name: string, takenAt?: string][] = [
      ['a1995.jpg', '1995-06-01T10:00:00'],
      ['b1998.jpg', '1998-03-12T08:30:00'],
      ['c2001.jpg', '2001-01-01T00:00:00'],
      ['d2010.jpg', '2010-05-05T12:00:00'],
      ['undated.jpg'],
    ];
    for (const [name, takenAt] of fixtures) {
      await cmd.shouldSucceed(`echo x > /media/${name}`);
      await vfs.update(ADMIN_ACCESS, `/media/${name}`, {
        attrs: { mimetype: 'image/jpeg', ...(takenAt ? captureTime(takenAt) : {}) },
      });
    }

    await t.step('a location link drives a time-ordered result', async () => {
      await mklink('/media/a1995.jpg', 'location', `${LOCATIONS_ROOT}/park`);
      await mklink('/media/c2001.jpg', 'location', `${LOCATIONS_ROOT}/park`);
      await mklink('/media/d2010.jpg', 'location', `${LOCATIONS_ROOT}/beach`);

      assertEquals(names(await client.execJson<Results>('search --subject location:park')), ['c2001.jpg', 'a1995.jpg']);
      assertEquals(names(await client.execJson<Results>('search --subject location:park --sort time')), ['a1995.jpg', 'c2001.jpg']);
      // A full path works as well as a slug.
      assertEquals(names(await client.execJson<Results>(`search --subject location:${LOCATIONS_ROOT}/beach`)), ['d2010.jpg']);
    });

    await t.step('a sort value starting with a dash survives arg parsing', async () => {
      // @std/cli reads `-time` as flags unless the value is joined to the flag;
      // this is the exact command the UI's media timeline sends.
      const ui = await client.execJson<Results>('search --subject location:park -l 60 --sort -time');
      assertEquals(names(ui), ['c2001.jpg', 'a1995.jpg']);
      assertEquals(ui.filters.sort, '-time');

      // The explicit joined form has to keep working too.
      assertEquals(names(await client.execJson<Results>('search --subject location:park --sort=-time')), ['c2001.jpg', 'a1995.jpg']);
    });

    await t.step('a boxless people/<slug> tag counts as being in the picture', async () => {
      await vfs.ensure(ADMIN_ACCESS, 'directory', '/media/a1995.jpg', 'people', { props: { mode: 0o775 } });
      await mklink('/media/a1995.jpg/people', 'anna', `${PEOPLE_ROOT}/anna`);
      await vfs.ensure(ADMIN_ACCESS, 'directory', '/media/b1998.jpg', 'people', { props: { mode: 0o775 } });
      await mklink('/media/b1998.jpg/people', 'bo', `${PEOPLE_ROOT}/bo`);

      assertEquals(names(await client.execJson<Results>('search --subject person:anna')), ['a1995.jpg']);
      assertEquals(names(await client.execJson<Results>('search --subject person:bo')), ['b1998.jpg']);
    });

    await t.step('an assigned face counts too, and merges with the tags', async () => {
      await vfs.ensure(ADMIN_ACCESS, 'directory', '/media/c2001.jpg', 'regions', { props: { mode: 0o775 } });
      await vfs.create(ADMIN_ACCESS, 'media-region', '/media/c2001.jpg/regions', 'face-0', {
        attrs: { personId: annaId, confidence: 0.9 },
      });
      // A face of someone else in the same photo must not pull it in for Anna.
      await vfs.ensure(ADMIN_ACCESS, 'directory', '/media/d2010.jpg', 'regions', { props: { mode: 0o775 } });
      await vfs.create(ADMIN_ACCESS, 'media-region', '/media/d2010.jpg/regions', 'face-0', {
        attrs: { personId: (await vfs.get(ADMIN_ACCESS, `${PEOPLE_ROOT}/bo`)).id },
      });

      assertEquals(names(await client.execJson<Results>('search --subject person:anna')), ['c2001.jpg', 'a1995.jpg']);
      assertEquals(names(await client.execJson<Results>('search --subject person:bo')), ['d2010.jpg', 'b1998.jpg']);
    });

    await t.step('a photographer credit is not being in the picture', async () => {
      await mklink('/media/d2010.jpg', 'photographer', `${PEOPLE_ROOT}/anna`);
      assertEquals(names(await client.execJson<Results>('search --subject person:anna')), ['c2001.jpg', 'a1995.jpg']);
    });

    await t.step('undated media still appear, sorted last', async () => {
      await vfs.ensure(ADMIN_ACCESS, 'directory', '/media/undated.jpg', 'people', { props: { mode: 0o775 } });
      await mklink('/media/undated.jpg/people', 'anna', `${PEOPLE_ROOT}/anna`);

      assertEquals(names(await client.execJson<Results>('search --subject person:anna')), ['c2001.jpg', 'a1995.jpg', 'undated.jpg']);
      assertEquals(names(await client.execJson<Results>('search --subject person:anna --sort time')), ['a1995.jpg', 'c2001.jpg', 'undated.jpg']);
    });

    await t.step('layout returns a complete compact person or location timeline', async () => {
      const person = await client.execJson<LayoutResults>('search --subject person:anna --layout -l 1');
      assertEquals(layoutPaths(person), ['/media/c2001.jpg', '/media/a1995.jpg', '/media/undated.jpg']);
      assertEquals(person.cursor, null);
      assertEquals(person.offset, 0);
      assertEquals(person.truncated, false);

      const location = await client.execJson<LayoutResults>('search --subject location:park --layout');
      assertEquals(layoutPaths(location), ['/media/c2001.jpg', '/media/a1995.jpg']);
      assertEquals(location.truncated, false);

      const narrowed = await client.execJson<LayoutResults>('search --subject person:anna --layout --from 2000');
      assertEquals(layoutPaths(narrowed), ['/media/c2001.jpg']);

      assertEquals((await client.exec('JSON_OUTPUT=1 search --layout')).success, false);
      assertEquals((await client.exec('JSON_OUTPUT=1 search --subject person:anna --layout --cursor 1')).success, false);
    });

    await t.step('renditions of a subject-linked file are never results', async () => {
      await cmd.shouldSucceed('echo t > /media/thumb.webp');
      await vfs.update(ADMIN_ACCESS, '/media/thumb.webp', {
        attrs: { mimetype: 'image/webp', ...captureTime('1995-06-01T10:00:00'), sourceId: 'a1995-original' },
      });
      await mklink('/media/thumb.webp', 'location', `${LOCATIONS_ROOT}/park`);

      assertEquals(names(await client.execJson<Results>('search --subject location:park')), ['c2001.jpg', 'a1995.jpg']);
    });

    await t.step('pages with a cursor, without gaps or repeats', async () => {
      const first = await client.execJson<Results>('search --subject person:anna -l 2');
      assertEquals(names(first), ['c2001.jpg', 'a1995.jpg']);
      assert(first.cursor, 'expected a cursor while results remain');

      const second = await client.execJson<Results>(`search --subject person:anna -l 2 --cursor ${first.cursor}`);
      assertEquals(names(second), ['undated.jpg']);
      assertEquals(second.cursor, null);
    });

    await t.step('--at starts the list at a date, and the answer says where', async () => {
      // Anna: c2001, a1995, undated — newest first.
      const whole = await client.execJson<Results>('search --subject person:anna');
      assertEquals(names(whole), ['c2001.jpg', 'a1995.jpg', 'undated.jpg']);
      assertEquals(whole.offset, 0);

      // Seeking to 1995 starts below everything newer, and says how far down
      // that was — which is what walking back up subtracts from.
      const seeked = await client.execJson<Results>('search --subject person:anna --at 1995');
      assertEquals(names(seeked), ['a1995.jpg', 'undated.jpg']);
      assertEquals(seeked.offset, 1);

      // Climbing is the same list from an earlier position, in the same order,
      // which is why paging up needs no second direction.
      const climbed = await client.execJson<Results>(`search --subject person:anna -l 1 --cursor ${seeked.offset - 1}`);
      assertEquals(names(climbed), ['c2001.jpg']);

      // A date newer than everything starts at the top; older than everything
      // runs off the end rather than wrapping.
      assertEquals((await client.execJson<Results>('search --subject person:anna --at 2030')).offset, 0);
      assertEquals(names(await client.execJson<Results>('search --subject person:anna --at 1900')), []);

      // Oldest-first, the same date means the *start* of that bucket: the list
      // runs the other way, so "from 1995" is 1995 onwards, not up to it.
      const ascending = await client.execJson<Results>('search --subject person:anna --sort time --at 1995');
      assertEquals(names(ascending), ['a1995.jpg', 'c2001.jpg', 'undated.jpg']);
      assertEquals(ascending.offset, 0);
      const later = await client.execJson<Results>('search --subject person:anna --sort time --at 2001');
      assertEquals(names(later), ['c2001.jpg', 'undated.jpg']);
      assertEquals(later.offset, 1);

      await cmd.shouldFailWith('search --subject person:anna --at notadate', "cannot parse --at date 'notadate'");
      await cmd.shouldFailWith('search --subject person:anna --at 1995 --cursor 1', '--at starts a list');

      // A seek needs an order to seek into, and only a time order has dates in
      // it. Score-ranked and name-ordered answers do not.
      await cmd.shouldFailWith('search --subject person:anna --at 1995 --sort name', '--at needs a time sort');
      // `--kind album` already defaults to a name sort, so it trips the check
      // above; asking for a time sort explicitly is what reaches this one.
      await cmd.shouldFailWith('search --kind album --sort -time --at 1995', 'carry no capture time');
    });

    await t.step('--facets counts the subject by day, month and year', async () => {
      const facets = await client.execJson<Facets>('search --subject person:anna --facets');
      assertEquals(facets.years, [{ year: 1995, count: 1 }, { year: 2001, count: 1 }]);
      assertEquals(facets.months, [{ key: '1995-06', count: 1 }, { key: '2001-01', count: 1 }]);
      assertEquals(facets.days, [{ key: '1995-06-01', count: 1 }, { key: '2001-01-01', count: 1 }]);
      assertEquals(facets.range, { min: 1995, max: 2001 });
      // Undated media has no year bucket but remains part of the total answer.
      assertEquals(facets.total, 3);

      // The counts are of the filtered set, not of the subject.
      const narrowed = await client.execJson<Facets>('search --subject person:anna --facets --from 2000');
      assertEquals(narrowed.years, [{ year: 2001, count: 1 }]);
      assertEquals(narrowed.days, [{ key: '2001-01-01', count: 1 }]);
      assertEquals(narrowed.total, 1);
    });

    await t.step('combines with the other facets', async () => {
      assertEquals(names(await client.execJson<Results>('search --subject person:anna --from 2000')), ['c2001.jpg']);
      assertEquals(names(await client.execJson<Results>('search --subject person:anna --kind video')), []);

      // Person and location intersect rather than one winning.
      assertEquals(names(await client.execJson<Results>('search --subject person:anna --subject location:park')), ['c2001.jpg', 'a1995.jpg']);
      assertEquals(names(await client.execJson<Results>('search --subject person:bo --subject location:park')), []);
    });

    await t.step('repeating --subject intersects: everyone must be in the picture', async () => {
      // "photos of Anna and Bo together" — the query a natural-language search produces.
      // Bo joins Anna in c2001; a1995 has only Anna, d2010 only Bo.
      await vfs.ensure(ADMIN_ACCESS, 'directory', '/media/c2001.jpg', 'people', { props: { mode: 0o775 } });
      await mklink('/media/c2001.jpg/people', 'bo', `${PEOPLE_ROOT}/bo`);

      assertEquals(names(await client.execJson<Results>('search --subject person:anna --subject person:bo')), ['c2001.jpg']);
      // Order of the flags must not matter: the first is only the driving set.
      assertEquals(names(await client.execJson<Results>('search --subject person:bo --subject person:anna')), ['c2001.jpg']);
      // Still intersects with the rest of the facets.
      assertEquals(names(await client.execJson<Results>('search --subject person:anna --subject person:bo --subject location:beach')), []);
    });

    await t.step('--subject-name ANDs words within each partial-name match', async () => {
      await vfs.ensure(ADMIN_ACCESS, 'directory', '/media/d2010.jpg', 'people', { props: { mode: 0o775 } });
      await mklink('/media/d2010.jpg/people', 'anna-andersson', `${PEOPLE_ROOT}/anna-andersson`);

      const partial = await client.execJson<Results>('search --subject-name person:ann');
      assertEquals(names(partial), ['d2010.jpg', 'c2001.jpg', 'a1995.jpg', 'undated.jpg']);
      assertEquals(partial.filters.subjectNames, [{
        kind: 'person',
        query: 'ann',
        matches: [`${PEOPLE_ROOT}/anna`, `${PEOPLE_ROOT}/anna-andersson`],
        truncated: false,
      }]);
      // Word order and intervening name parts do not matter, but both words
      // must match one candidate person rather than two different people.
      const allWords = await client.execJson<Results>("search --subject-name 'person:anders ann'");
      assertEquals(names(allWords), ['d2010.jpg']);
      assertEquals(allWords.filters.subjectNames, [{
        kind: 'person',
        query: 'anders ann',
        matches: [`${PEOPLE_ROOT}/anna-andersson`],
        truncated: false,
      }]);
      assertEquals(names(await client.execJson<Results>("search --subject-name 'person:anna bo'")), []);
      // The name group is OR, while a separate exact person remains an AND predicate.
      assertEquals(names(await client.execJson<Results>('search --subject-name person:ann --subject person:bo')), ['d2010.jpg', 'c2001.jpg']);
      assertEquals(names(await client.execJson<Results>('search --subject-name person:nobody')), []);
    });

    await t.step('reports the subjects it filtered on', async () => {
      const res = await client.execJson<Results>('search --subject person:anna --subject person:bo --subject location:park');
      assertEquals(res.filters.subjects, [
        { kind: 'person', path: `${PEOPLE_ROOT}/anna` },
        { kind: 'person', path: `${PEOPLE_ROOT}/bo` },
        { kind: 'location', path: `${LOCATIONS_ROOT}/park` },
      ]);
      // A path names its own kind.
      assertEquals(names(await client.execJson<Results>(`search --subject ${PEOPLE_ROOT}/anna`)), names(await client.execJson<Results>('search --subject person:anna')));
    });

    await t.step('an unknown subject is an error, not an empty result', async () => {
      const missing = await client.exec('search --subject person:nobody');
      assertEquals(missing.success, false);
      // The error names the way forward: a town is a region, not a location node.
      await cmd.shouldFailWith('search --subject location:Exempelstad', "location-region 'Exempelstad'");
      await cmd.shouldFailWith('search --subject person:nobody', "--subject-name 'person:nobody'");
      // A kind no module answers for, and a value that is not one.
      await cmd.shouldFailWith('search --subject spaceship:x', 'no subject-spaceship on PATH');
      await cmd.shouldFailWith('search --subject anna', 'expected <kind>:<ref>');
    });
    // Last, because it adds media for Anna: every step above asserts an exact
    // result list for her.
    await t.step('--group-by album groups the matches by the album holding them', async () => {
      type Albums = { total: number; groups: { path: string; type: string; name: string; count: number; from?: string; to?: string }[]; truncated: boolean };

      await cmd.shouldSucceed(`mkdir -p ${ALBUMS_ROOT}`);
      await vfs.create(ADMIN_ACCESS, 'album', ALBUMS_ROOT, 'trip', { attrs: { name: 'The Trip' } });
      await vfs.create(ADMIN_ACCESS, 'album', ALBUMS_ROOT, 'party', { attrs: { name: 'The Party' } });
      // An imported album keeps its media a level down in `files/`; a hand-made
      // one holds it directly. Both have to resolve to the album.
      await cmd.shouldSucceed(`mkdir -p ${ALBUMS_ROOT}/trip/files`);

      const tagged: [string, string][] = [
        [`${ALBUMS_ROOT}/trip/files/t1.jpg`, '2004-07-02T09:00:00'],
        [`${ALBUMS_ROOT}/trip/files/t2.jpg`, '2004-07-05T18:00:00'],
        [`${ALBUMS_ROOT}/party/p1.jpg`, '2009-12-24T20:00:00'],
      ];
      for (const [path, takenAt] of tagged) {
        await cmd.shouldSucceed(`echo x > ${path}`);
        await vfs.update(ADMIN_ACCESS, path, { attrs: { mimetype: 'image/jpeg', ...captureTime(takenAt) } });
        await vfs.ensure(ADMIN_ACCESS, 'directory', path, 'people', { props: { mode: 0o775 } });
        await mklink(`${path}/people`, 'anna', `${PEOPLE_ROOT}/anna`);
      }

      const albums = await client.execJson<Albums>('search --subject person:anna --group-by album');
      // Newest first. `/media/*` sits under a plain directory and contributes
      // nothing — the count is of matches in albums, not of all matches.
      assertEquals(albums.groups.map((a) => a.path), [`${ALBUMS_ROOT}/party`, `${ALBUMS_ROOT}/trip`]);
      assertEquals(albums.groups.map((a) => [a.name, a.type]), [['The Party', 'album'], ['The Trip', 'album']]);
      assertEquals(albums.total, 3);
      assertEquals(albums.truncated, false);
      // A scan budget smaller than the set is reported: the tally is then a floor.
      assertEquals((await client.execJson<Albums>('search --subject person:anna --group-by album --max-scan 1')).truncated, true);

      const trip = albums.groups.find((a) => a.path === `${ALBUMS_ROOT}/trip`)!;
      assertEquals(trip.count, 2);
      // The span is of the matching media, not of the album.
      assertEquals(trip.from, '2004-07-02T09:00:00');
      assertEquals(trip.to, '2004-07-05T18:00:00');

      // A single-photo album has a span of one instant, not a missing one.
      const party = albums.groups.find((a) => a.path === `${ALBUMS_ROOT}/party`)!;
      assertEquals(party.from, party.to);

      // Narrowing the search narrows the grouping with it.
      const narrowed = await client.execJson<Albums>('search --subject person:anna --group-by album --from 2009');
      assertEquals(narrowed.groups.map((a) => a.path), [`${ALBUMS_ROOT}/party`]);

      // Someone with no media in any album gets an empty list, not an error.
      const none = await client.execJson<Albums>('search --subject person:bo --group-by album');
      assertEquals(none.groups, []);
      assertEquals(none.total, 0);
    });

    await t.step('an album is found by the pictures it holds', async () => {
      // The Search page's question: entities, with a filter only a picture can meet.
      assertEquals(names(await client.execJson<Results>('search --kind album --subject person:anna')), ['party', 'trip']);
      assertEquals(names(await client.execJson<Results>('search --kind album --subject person:anna --sort -time')), ['party', 'trip']);
      assertEquals(names(await client.execJson<Results>('search --kind album --subject person:anna --sort time')), ['trip', 'party']);
      // A year alone asks the same of every picture, and narrows with a person.
      assertEquals(names(await client.execJson<Results>('search --kind album --from 2004 --to 2004')), ['trip']);
      assertEquals(names(await client.execJson<Results>('search --kind album --subject person:anna --from 2009')), ['party']);
      assertEquals(names(await client.execJson<Results>('search --kind album --subject person:bo')), []);

      // People and locations answer through the pictures as well: the ones those pictures have.
      const entities = await client.execJson<Results>('search --kind album,person,location --subject person:anna');
      assertEquals(names(entities), ['anna', 'bo', 'park', 'party', 'trip']);
      assertEquals(entities.truncated, false);
      const people = await client.execJson<Results>('search --kind person --subject person:anna');
      assertEquals(names(people), ['anna', 'bo']);
      assertEquals(people.truncated, false);
    });

    await t.step('an album a picture was added to holds it, and a cover or a relation does not', async () => {
      type Albums = { total: number; groups: { path: string; count: number }[] };

      // `album add` files a picture by linking it; the picture stays where it is.
      await vfs.create(ADMIN_ACCESS, 'album', ALBUMS_ROOT, 'picnic', { attrs: { name: 'The Picnic' } });
      await cmd.shouldSucceed(`album add ${ALBUMS_ROOT}/picnic /media/a1995.jpg`);
      await mklink(`${ALBUMS_ROOT}/party`, 'coverPhoto', '/media/undated.jpg');
      // A relation below a picture in an album points at another picture without filing it there.
      await vfs.ensure(ADMIN_ACCESS, 'directory', `${ALBUMS_ROOT}/party/p1.jpg`, 'relations', { props: { mode: 0o775 } });
      await mklink(`${ALBUMS_ROOT}/party/p1.jpg/relations`, 'related-1', '/media/undated.jpg');

      const albums = await client.execJson<Albums>('search --subject person:anna --group-by album');
      assertEquals(albums.groups.map((a) => [a.path, a.count]), [[`${ALBUMS_ROOT}/party`, 1], [`${ALBUMS_ROOT}/trip`, 2], [`${ALBUMS_ROOT}/picnic`, 1]]);
      assertEquals(albums.total, 4);
      assertEquals(names(await client.execJson<Results>('search --kind album --subject person:anna --sort -time')), ['party', 'trip', 'picnic']);
    });

    await t.step('--group-by person counts the people in the matches, and the matches showing someone nobody has named', async () => {
      type People = { total: number; groups: { path: string; type: string; name: string; count: number; from?: string; to?: string }[]; unnamed?: number; truncated: boolean };

      // A group of faces nobody has named lives below the people root, not directly in it.
      await cmd.shouldSucceed(`mkdir -p ${PEOPLE_ROOT}/unknown`);
      const stranger = await vfs.create(ADMIN_ACCESS, 'person', `${PEOPLE_ROOT}/unknown`, 'u1', { attrs: {} });
      await vfs.ensure(ADMIN_ACCESS, 'directory', `${ALBUMS_ROOT}/trip/files/t1.jpg`, 'regions', { props: { mode: 0o775 } });
      await vfs.create(ADMIN_ACCESS, 'media-region', `${ALBUMS_ROOT}/trip/files/t1.jpg/regions`, 'face-0', { attrs: { personId: stranger.id, confidence: 0.9 } });
      const another = await vfs.create(ADMIN_ACCESS, 'person', `${PEOPLE_ROOT}/unknown`, 'u2', { attrs: {} });
      await vfs.create(ADMIN_ACCESS, 'media-region', `${ALBUMS_ROOT}/trip/files/t1.jpg/regions`, 'face-1', { attrs: { personId: another.id, confidence: 0.9 } });
      await mklink(`${ALBUMS_ROOT}/trip/files/t2.jpg/people`, 'bo', `${PEOPLE_ROOT}/bo`);

      const trip = await client.execJson<People>(`search --under ${ALBUMS_ROOT}/trip --group-by person`);
      assertEquals(trip.groups.map((p) => [p.path, p.type, p.name, p.count]), [[`${PEOPLE_ROOT}/bo`, 'person', 'Bo', 1], [`${PEOPLE_ROOT}/anna`, 'person', 'Anna', 2]]);
      // The span is of the pictures they are in.
      assertEquals(trip.groups.find((p) => p.name === 'Anna')!.from, '2004-07-02T09:00:00');
      // Two unnamed faces in one picture: one picture showing someone nobody has named.
      assertEquals(trip.unnamed, 1);
      assertEquals(trip.truncated, false);

      // A recording's voices name their person: being heard counts as being in it.
      const party = await vfs.get(ADMIN_ACCESS, `${ALBUMS_ROOT}/party/p1.jpg`);
      await vfs.ensure(ADMIN_ACCESS, 'directory', `${ALBUMS_ROOT}/party/p1.jpg`, 'speakers', { props: { mode: 0o775 } });
      await vfs.create(ADMIN_ACCESS, 'embedding', `${ALBUMS_ROOT}/party/p1.jpg/speakers`, 's0', {
        attrs: { embeddingType: 'voice', fileId: party.id, personId: (await vfs.get(ADMIN_ACCESS, `${PEOPLE_ROOT}/bo`)).id },
      });
      const heard = await client.execJson<People>(`search --under ${ALBUMS_ROOT}/party --group-by person`);
      assertEquals(heard.groups.map((p) => [p.name, p.count]), [['Anna', 1], ['Bo', 1]]);

      // Who is in the pictures with someone: everyone the pictures of them hold, themselves too.
      const withAnna = await client.execJson<People>('search --subject person:anna --group-by person --from 2001');
      assertEquals(withAnna.groups.map((p) => [p.name, p.count]), [['Anna', 4], ['Bo', 3]]);
      assertEquals(withAnna.unnamed, 1);

      // A location, or an album beside the people: each grouping counts its own.
      const places = await client.execJson<People>('search --subject person:anna --group-by location');
      assertEquals(places.groups.map((p) => [p.path, p.type, p.count]), [[`${LOCATIONS_ROOT}/park`, 'location', 2]]);
      const both = await client.execJson<People>(`search --under ${ALBUMS_ROOT}/trip --group-by album,person`);
      assertEquals(both.groups.map((p) => p.type).sort(), ['album', 'person', 'person']);

      // An entity search with a filter only a picture can meet asks the same: the people in the pictures.
      assertEquals(names(await client.execJson<Results>('search --kind person --from 2004 --to 2004')), ['anna', 'bo']);
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
