import { assertEquals } from '@std/assert';
import { isBareDate, nameGiver } from '../merge-name.ts';

const row = (title: string, memberCount: number, named = false) => ({ title, memberCount, staging: named ? { named: true as const } : {} });

Deno.test('a name of dates only is told from one that says what or where', () => {
  for (const name of ['3 Aug 2014', '3–9 Aug 2014', '28 Jul – 3 Aug 2014', '30 Dec 2014 – 2 Jan 2015', 'Jun 1975', 'Jun–Aug 1975', '1975', '1975–1977']) {
    assertEquals(isBareDate(name), true, name);
  }
  for (const name of ['Lake weekend · 14 Jun 2019', 'Midsummer · 21 Jun 2019', 'Box 3', 'Everyday · 2014', 'Jun', '14']) {
    assertEquals(isBareDate(name), false, name);
  }
});

Deno.test('a name a person gave wins, wherever it is', () => {
  const into = row('Lake weekend · 14 Jun 2019', 80);
  const other = row('Grandparents visit', 3, true);
  assertEquals(nameGiver(into, other), other);
  assertEquals(nameGiver(other, into), other);
  // Both a person's: the larger keeps its own.
  const mine = row('Sunday swim', 5, true);
  assertEquals(nameGiver(mine, other), mine);
  assertEquals(nameGiver(other, mine), mine);
});

Deno.test('then what or where over bare dates', () => {
  const dated = row('15 Jun 2019', 200);
  const placed = row('Lake weekend · 14 Jun 2019', 12);
  assertEquals(nameGiver(dated, placed), placed);
  assertEquals(nameGiver(placed, dated), placed);
});

Deno.test('then the larger group, and on a tie the one merged into', () => {
  assertEquals(nameGiver(row('14 Jun 2019', 10), row('15 Jun 2019', 30)).title, '15 Jun 2019');
  assertEquals(nameGiver(row('Lake weekend', 30), row('Cottage', 10)).title, 'Lake weekend');
  assertEquals(nameGiver(row('14 Jun 2019', 10), row('15 Jun 2019', 10)).title, '14 Jun 2019');
});
