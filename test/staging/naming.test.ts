/**
 * A suggested group's name: its parts in order, the dates at the precision its members were dated
 * to, holidays and birthdays, and the names of lanes.
 */
import { assertEquals } from '@std/assert';
import { easterSunday, formatDates, groupName, holidayOf, holidayPair, laneName, momentOf, occasionOf, withGuests } from '../../lib/staging/naming.ts';

Deno.test('a year is a year, never the instant it starts on', () => {
  assertEquals(formatDates(['1975', '1975']), '1975');
  assertEquals(formatDates(['1975', '1977', '1976']), '1975–1977');
});

Deno.test('a month is a month', () => {
  assertEquals(formatDates(['1975-06', '1975-06']), 'Jun 1975');
  assertEquals(formatDates(['1975-08', '1975-06']), 'Jun–Aug 1975');
  assertEquals(formatDates(['1975-11', '1976-02']), 'Nov 1975 – Feb 1976');
  // A member known only to the year makes the whole name a year.
  assertEquals(formatDates(['1975-06', '1975']), '1975');
});

Deno.test('days fold as far as they share month and year', () => {
  assertEquals(formatDates(['2014-08-03T10:00:00+02:00', '2014-08-03T18:30:00+02:00']), '3 Aug 2014');
  assertEquals(formatDates(['2014-08-09T09:00', '2014-08-03T10:00:00+02:00']), '3–9 Aug 2014');
  assertEquals(formatDates(['2014-07-28', '2014-08-03T12:00']), '28 Jul – 3 Aug 2014');
  assertEquals(formatDates(['2014-12-30T20:00:00+01:00', '2015-01-02T08:00:00+01:00']), '30 Dec 2014 – 2 Jan 2015');
});

Deno.test("the day is the photographer's, whatever the offset", () => {
  // 23:30 in New York is the next morning in UTC.
  assertEquals(formatDates(['2014-08-03T23:30:00-04:00']), '3 Aug 2014');
});

Deno.test('members dated to the day decide over coarser ones', () => {
  assertEquals(formatDates(['1975', '1975-06-03', '1975-06-05']), '3–5 Jun 1975');
});

Deno.test('nothing that is a capture time gives no dates', () => {
  assertEquals(formatDates([]), undefined);
  assertEquals(formatDates(['yesterday']), undefined);
});

Deno.test('a name is what, where and when, each only when known', () => {
  assertEquals(groupName({ what: 'Christmas Eve', where: 'Harbour cottage', when: '24 Dec 2019' }), 'Christmas Eve · Harbour cottage · 24 Dec 2019');
  assertEquals(groupName({ where: 'Lisbon', when: '3–9 Aug 2014' }), 'Lisbon · 3–9 Aug 2014');
  assertEquals(groupName({ when: '3 Aug 2014' }), '3 Aug 2014');
  assertEquals(groupName({ what: ' ', when: '1975' }), '1975');
});

Deno.test('Easter is computed; Midsummer Eve is the Friday from 19 to 25 June', () => {
  assertEquals([easterSunday(2019), easterSunday(2024), easterSunday(2025), easterSunday(1975)], ['2019-04-21', '2024-03-31', '2025-04-20', '1975-03-30']);
  assertEquals(holidayOf('2019-04-20')?.name, 'Easter Saturday');
  assertEquals(holidayOf('2019-06-21')?.name, 'Midsummer Eve');
  assertEquals(holidayOf('2019-06-22')?.name, 'Midsummer Day');
  assertEquals(holidayOf('2019-06-28'), undefined);
  assertEquals(holidayOf('2014-12-24T18:00:00')?.name, 'Christmas Eve');
});

Deno.test('a holiday pair is two days of one holiday', () => {
  assertEquals(holidayPair('2019-12-24', '2019-12-25'), true);
  assertEquals(holidayPair('2019-12-31', '2020-01-01'), true);
  assertEquals(holidayPair('2019-12-26', '2019-12-31'), false);
  assertEquals(holidayPair('2019-06-21', '2019-06-22'), true);
});

Deno.test('an occasion: the holiday, its family over several of its days, or a birthday in the picture', () => {
  assertEquals(occasionOf(['2019-12-24']), 'Christmas Eve');
  assertEquals(occasionOf(['2019-12-24', '2019-12-25']), 'Christmas');
  const anna = { name: 'Anna Andersson', born: '1950-06-07' };
  assertEquals(occasionOf(['2019-06-07'], [anna]), "Anna Andersson's birthday");
  assertEquals(occasionOf(['2019-06-08'], [anna]), undefined);
  // A year of birth alone is no day.
  assertEquals(occasionOf(['2019-01-01'], [{ name: 'Bo', born: '1950' }]), "New Year's Day");
  assertEquals(occasionOf(['2019-03-01'], [{ name: 'Bo', born: '1950' }]), undefined);
});

Deno.test('guests: one or two of them', () => {
  assertEquals(withGuests([]), undefined);
  assertEquals(withGuests(['Anna Andersson']), 'With Anna Andersson');
  assertEquals(withGuests(['Anna Andersson', 'Bo Berg', 'Cecilia Carlsson']), 'With Anna Andersson and Bo Berg');
});

Deno.test('lanes have names of their own', () => {
  assertEquals(laneName({ kind: 'loose', period: '2014' }), 'Everyday · 2014');
  assertEquals(laneName({ kind: 'loose', period: '2014-06', chunk: 2 }), 'Everyday · Jun 2014 (2)');
  assertEquals(laneName({ kind: 'clutter', period: '2019' }), 'Screenshots and saved images · 2019');
  assertEquals(laneName({ kind: 'clutter' }), 'Screenshots and saved images · Undated');
  assertEquals(laneName({ kind: 'undated', folder: 'box-3' }), 'Undated · box-3');
  assertEquals(laneName({ kind: 'period', period: '1987', folder: 'box-3' }), '1987 · box-3');
  assertEquals(laneName({ kind: 'month', period: '2019-03', folder: 'chats' }), 'chats · Mar 2019');
});

Deno.test('a day whose times all fall in one part of it is named by its weekday and that part', () => {
  // 3 Aug 2014 is a Sunday.
  assertEquals(momentOf(['2014-08-03T19:10:00+02:00', '2014-08-03T22:40:00+02:00']), 'Sunday evening');
  assertEquals(momentOf(['2014-08-03T09:00', '2014-08-03T11:59']), 'Sunday morning');
  assertEquals(momentOf(['2014-08-03T12:00', '2014-08-03T16:30']), 'Sunday afternoon');
  // Across parts, in the small hours, or with no time of day: nothing.
  assertEquals(momentOf(['2014-08-03T11:00', '2014-08-03T13:00']), undefined);
  assertEquals(momentOf(['2014-08-03T02:00']), undefined);
  assertEquals(momentOf(['2014-08-03T19:00', '2014-08-03']), undefined);
  assertEquals(momentOf(['1975-06']), undefined);
});

Deno.test('a Saturday and Sunday, with or without the Friday, is a weekend; other runs of days are not', () => {
  assertEquals(momentOf(['2014-08-02T10:00', '2014-08-03T15:00']), 'Weekend');
  assertEquals(momentOf(['2014-08-01T18:00', '2014-08-02T10:00', '2014-08-03T15:00']), 'Weekend');
  assertEquals(momentOf(['2014-08-03T10:00', '2014-08-04T15:00']), undefined);
  assertEquals(momentOf(['2014-08-02T10:00', '2014-08-10T15:00']), undefined);
});
