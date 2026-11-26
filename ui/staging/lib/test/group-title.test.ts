import { assertEquals } from '@std/assert';
import { cardTitle } from '../group-title.ts';

Deno.test('the dates that end a name are left to the line under it', () => {
  assertEquals(cardTitle('Christmas Eve · 24 Dec 1975'), 'Christmas Eve');
  assertEquals(cardTitle('Sailing · Archipelago · 28 Jul – 3 Aug 2014'), 'Sailing · Archipelago');
  assertEquals(cardTitle('Cornwall · Jun–Aug 1968'), 'Cornwall');
  assertEquals(cardTitle('Highbury · 1975–1977'), 'Highbury');
  assertEquals(cardTitle('London · 30 Dec 2014 – 2 Jan 2015'), 'London');
});

Deno.test('a name of dates only, or one ending in something else, is kept', () => {
  assertEquals(cardTitle('24 Dec 1975'), '24 Dec 1975');
  assertEquals(cardTitle('Wedding · Highbury'), 'Wedding · Highbury');
  assertEquals(cardTitle('Room 2014 · Hotel'), 'Room 2014 · Hotel');
  assertEquals(cardTitle('Trip · May the 4th'), 'Trip · May the 4th');
});
