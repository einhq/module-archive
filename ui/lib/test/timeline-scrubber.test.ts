import { assertEquals, assertNotEquals } from '@std/assert';
import {
  buildScrubberModel,
  createSeekScheduler,
  dateAtPosition,
  offsetAtPosition,
  positionAtY,
  scrollAnchorsForSections,
  scrollAnchorsWithBounds,
  type ScrubberFacets,
  selectionAtY,
  yAtDate,
  yAtPosition,
} from '../timeline-scrubber.ts';

const facets = (months: [string, number][], days: [string, number][]): ScrubberFacets => ({
  months: months.map(([key, count]) => ({ key, count })),
  days: days.map(([key, count]) => ({ key, count })),
  years: [...new Set(months.map(([key]) => Number(key.slice(0, 4))))].map((year) => ({ year, count: 1 })),
});

Deno.test('scrubber: a long span exposes equal occupied months, not item density', () => {
  const model = buildScrubberModel(facets(
    [['2020-01', 1000], ['2020-07', 1], ['2021-04', 4]],
    [['2020-01-02', 1000], ['2020-07-12', 1], ['2021-04-09', 4]],
  ));
  assertEquals(model.mode, 'year');
  assertEquals(model.targets.map((target) => target.key), ['2021-04', '2020-07', '2020-01']);
  assertEquals(selectionAtY(model, 0, 300)?.date, '2021-04');
  assertEquals(selectionAtY(model, 100, 300)?.date, '2020-07');
  assertEquals(selectionAtY(model, 200, 300)?.date, '2020-01');
});

Deno.test('scrubber: a rolling span under one year exposes days across a year boundary', () => {
  const model = buildScrubberModel(facets(
    [['2024-12', 1], ['2025-01', 1]],
    [['2024-12-30', 1], ['2025-01-03', 1]],
  ));
  assertEquals(model.mode, 'subyear');
  assertEquals(model.targets.map((target) => target.key), ['2025-01-03', '2024-12-30']);
});

Deno.test('scrubber: empty calendar gaps collapse and ascending reverses visual order', () => {
  const input = facets(
    [['2025-01', 1], ['2025-11', 1]],
    [['2025-01-01', 1], ['2025-11-30', 1]],
  );
  assertEquals(buildScrubberModel(input).targets.length, 2);
  assertEquals(buildScrubberModel(input, true).targets.map((target) => target.key), ['2025-01-01', '2025-11-30']);
});

Deno.test('scrubber: partial dates keep their real precision', () => {
  const partialYear = buildScrubberModel(facets([['1815', 1], ['2019-06', 1]], [['2019-06-02', 1]]));
  assertEquals(partialYear.mode, 'year');
  assertEquals(partialYear.targets.map((target) => target.key), ['2019-06', '1815']);

  const partialMonth = buildScrubberModel(facets([['2025-03', 2]], [['2025-03-18', 1]]));
  assertEquals(partialMonth.mode, 'subyear');
  assertEquals(partialMonth.targets.map((target) => target.key), ['2025-03-18', '2025-03']);
});

Deno.test('scrubber: date to pixel and pixel to date round-trip', () => {
  const model = buildScrubberModel(facets(
    [['2025-04', 1], ['2025-05', 1], ['2025-06', 1]],
    [['2025-04-02', 1], ['2025-05-08', 1], ['2025-06-20', 1]],
  ));
  for (const target of model.targets) {
    const y = yAtDate(model, target.key, 600);
    assertNotEquals(y, undefined);
    assertEquals(selectionAtY(model, y!, 600)?.date, target.key);
  }
  // A month header in a day rail follows the nearest occupied day.
  assertEquals(selectionAtY(model, yAtDate(model, '2025-05', 600)!, 600)?.date, '2025-05-08');
  assertEquals(yAtDate(model, 'undated', 600), undefined);
});

Deno.test('scrubber: pointer geometry travels continuously between occupied dates', () => {
  const model = buildScrubberModel(facets(
    [['2025-01', 1], ['2025-03', 1], ['2025-06', 1]],
    [['2025-01-01', 1], ['2025-03-01', 1], ['2025-06-01', 1]],
  ));

  assertEquals(positionAtY(model, 0, 600), 0);
  assertEquals(positionAtY(model, 100, 600), 0.5);
  assertEquals(positionAtY(model, 200, 600), 1);
  assertEquals(yAtPosition(model, 0.5, 600), 100);
  assertEquals(selectionAtY(model, 100, 600), { position: 0.5, date: '2025-04-16' });
  assertEquals(dateAtPosition(model, 1), '2025-03-01');
  // The rail's top pixel is the first date; the bottom is the end of the last slice.
  assertEquals(yAtDate(model, '2025-06-01', 600), 0);
  assertEquals(positionAtY(model, 600, 600), 3);
  assertEquals(yAtPosition(model, 3, 600), 600);
  assertEquals(dateAtPosition(model, 3), '2025-01-01');
});

Deno.test('scrubber: continuous geometry follows oldest-first target order too', () => {
  const model = buildScrubberModel(
    facets(
      [['2024-12', 1], ['2025-01', 1]],
      [['2024-12-30', 1], ['2025-01-03', 1]],
    ),
    true,
  );

  assertEquals(selectionAtY(model, 100, 400), { position: 0.5, date: '2025-01-01' });
});

Deno.test('scrubber: loaded scroll geometry interpolates without extrapolating', () => {
  const anchors = [{ position: 2, offset: 900 }, { position: 0, offset: 100 }, { position: 1, offset: 500 }];
  assertEquals(offsetAtPosition(anchors, 0), 100);
  assertEquals(offsetAtPosition(anchors, 0.25), 200);
  assertEquals(offsetAtPosition(anchors, 1.5), 700);
  assertEquals(offsetAtPosition(anchors, -0.1), undefined);
  assertEquals(offsetAtPosition(anchors, 2.1), undefined);
});

Deno.test('scrubber: day landmarks spread through a loaded month section', () => {
  const model = buildScrubberModel(facets(
    [['2025-04', 1], ['2025-05', 2]],
    [['2025-04-30', 1], ['2025-05-01', 1], ['2025-05-20', 1]],
  ));
  const anchors = scrollAnchorsForSections(model, [
    { key: '2025-05', offset: 100, size: 400 },
    { key: '2025-04', offset: 520, size: 200 },
  ]);
  assertEquals(anchors, [
    { position: 0, offset: 100 },
    { position: 1, offset: 300 },
    { position: 2, offset: 520 },
  ]);
});

Deno.test('scrubber: a year-only target lands on its own section, not on a month of that year', () => {
  const model = buildScrubberModel(facets([['1975', 1], ['1975-06', 2]], []));
  const anchors = scrollAnchorsForSections(model, [
    { key: '1975-06', offset: 0, size: 200 },
    { key: '1975', offset: 200, size: 100 },
  ]);
  assertEquals(model.targets.map((target) => target.key), ['1975-06', '1975']);
  assertEquals(anchors, [
    { position: 0, offset: 0 },
    { position: 1, offset: 200 },
  ]);
});

Deno.test('scrubber: loaded archive endpoints reach the real scroll bounds', () => {
  const anchors = scrollAnchorsWithBounds(
    [{ position: 0, offset: 100 }, { position: 1, offset: 500 }, { position: 2, offset: 900 }],
    3,
    0,
    1200,
  );
  // The first slice starts at the scroll start, covering the 100px above the
  // first header at the same rate as the section under it; the last runs to the end.
  assertEquals(anchors, [
    { position: 0, offset: 0 },
    { position: 1, offset: 500 },
    { position: 2, offset: 900 },
    { position: 3, offset: 1200 },
  ]);
  assertEquals(offsetAtPosition(anchors, 0), 0);
  assertEquals(offsetAtPosition(anchors, 0.5), 250);
  assertEquals(offsetAtPosition(anchors, 2.5), 1050);
  assertEquals(offsetAtPosition(anchors, 3), 1200);

  // A page that does not contain either archive end must not invent it.
  assertEquals(scrollAnchorsWithBounds([{ position: 1, offset: 500 }], 3, 0, 1200), [{ position: 1, offset: 500 }]);
});

Deno.test('scrubber: live seeks are leading, trailing, deduplicated and flush the release', () => {
  let now = 0;
  let nextId = 1;
  const queue = new Map<number, { at: number; callback: () => void }>();
  const timers = {
    set(callback: () => void, delay: number) {
      const id = nextId++;
      queue.set(id, { at: now + delay, callback });
      return id;
    },
    clear(id: number) {
      queue.delete(id);
    },
  };
  const advance = (ms: number) => {
    now += ms;
    for (const [id, item] of [...queue].sort((a, b) => a[1].at - b[1].at)) {
      if (item.at > now) continue;
      queue.delete(id);
      item.callback();
    }
  };

  const sent: string[] = [];
  const scheduler = createSeekScheduler((date) => sent.push(date), 125, timers);
  scheduler.push('2025-06-01');
  scheduler.push('2025-06-02');
  scheduler.push('2025-06-03');
  assertEquals(sent, ['2025-06-01']);
  advance(124);
  assertEquals(sent, ['2025-06-01']);
  advance(1);
  assertEquals(sent, ['2025-06-01', '2025-06-03']);
  scheduler.push('2025-06-03');
  scheduler.push('2025-06-04');
  scheduler.flush('2025-06-05');
  assertEquals(sent, ['2025-06-01', '2025-06-03', '2025-06-05']);
  scheduler.cancel();
});
