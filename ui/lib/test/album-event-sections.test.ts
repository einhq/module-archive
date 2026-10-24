/**
 * placeEvents: an album's dated texts among its media groups — under the group of their date,
 * or heading a section of their own where the album has no pictures from that date.
 */

import { assertEquals } from '@std/assert';
import { bucketByDate } from '@ein/ui/lib';
import { placeEvents, type TimelineSection } from '../album-event-sections.ts';

type Item = { takenAt?: string };
type Event = { date: string; text: string };

const day = (items: Item[]) => bucketByDate(items, (item) => item.takenAt, 'day');

/** Each section as `media:<key>[+texts]` or `events:<key>+texts`, in drawing order. */
const shape = (sections: TimelineSection<Item, Event>[]) =>
  sections.map((section) => {
    const texts = section.events?.map((event) => event.text).join(',');
    const head = section.kind === 'media' ? `media:${section.group.key}` : `events:${section.key}`;
    return texts ? `${head}+${texts}` : head;
  });

Deno.test('an album with no media shows its events, each under its own date', () => {
  const sections = placeEvents<Item, Event>([], [{ date: '1998-06-12', text: 'a' }, { date: '1998-06-14', text: 'b' }], { granularity: 'day' });
  assertEquals(shape(sections), ['events:1998-06-14+b', 'events:1998-06-12+a']);
  assertEquals(sections[0].kind === 'events' && sections[0].label, '14 June 1998');
});

Deno.test('an event on a day with pictures goes under that day; one on a day without heads its own section in date order', () => {
  const groups = day([{ takenAt: '1998-06-14T10:00' }, { takenAt: '1998-06-12T09:00' }]);
  const events = [{ date: '1998-06-12', text: 'arrival' }, { date: '1998-06-13', text: 'rain' }];

  assertEquals(shape(placeEvents(groups, events, { granularity: 'day' })), ['media:1998-06-14', 'events:1998-06-13+rain', 'media:1998-06-12+arrival']);
  assertEquals(
    shape(placeEvents(groups.toReversed(), events, { granularity: 'day', ascending: true })),
    ['media:1998-06-12+arrival', 'events:1998-06-13+rain', 'media:1998-06-14'],
  );
});

Deno.test('groups coarsened to months take an event by its month', () => {
  const groups = bucketByDate([{ takenAt: '1998-07-01' }, { takenAt: '1998-06-02' }], (item) => item.takenAt, 'month');
  assertEquals(shape(placeEvents(groups, [{ date: '1998-06-20', text: 'midsummer' }], { granularity: 'day' })), ['media:1998-07', 'media:1998-06+midsummer']);
});

Deno.test('an event goes before the undated pictures, which stay last', () => {
  const groups = day([{ takenAt: '1998-06-14' }, {}]);
  assertEquals(shape(placeEvents(groups, [{ date: '1998-06-01', text: 'early' }], { granularity: 'day' })), ['media:1998-06-14', 'events:1998-06-01+early', 'media:']);
});

Deno.test('only within what is loaded: an event past either end of a paged list waits for its page', () => {
  const groups = day([{ takenAt: '1998-06-14' }, { takenAt: '1998-06-10' }]);
  const events = [{ date: '1998-06-20', text: 'later' }, { date: '1998-06-12', text: 'between' }, { date: '1998-06-01', text: 'earlier' }];
  assertEquals(shape(placeEvents(groups, events, { granularity: 'day', hasNewer: true, hasMore: true })), [
    'media:1998-06-14',
    'events:1998-06-12+between',
    'media:1998-06-10',
  ]);
});
