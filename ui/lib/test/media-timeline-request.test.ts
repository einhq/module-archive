import { assertEquals } from '@std/assert';
import { mediaTimelineSearchRequest } from '../media-timeline-request.ts';

Deno.test('relevance-ranked media search uses score order and never sends a time anchor', () => {
  const request = mediaTimelineSearchRequest({ filters: { query: 'sailing boat' }, rankByRelevance: true, ascending: true, anchor: '2024-06' });
  assertEquals(request.filters.sort, 'score');
  assertEquals(request.anchor, null);
});

Deno.test('the feed with no filter is the plain newest-first browse', () => {
  assertEquals(mediaTimelineSearchRequest({ filters: {} }).filters, { sort: '-time' });
});

Deno.test('a subject is a facet, and a time-ordered timeline keeps its anchor', () => {
  const request = mediaTimelineSearchRequest({ person: 'anna-andersson', kinds: ['photo'], ascending: true, anchor: '2008-01' });
  assertEquals(request.filters, { subjects: ['person:anna-andersson'], kinds: ['photo'], sort: 'time' });
  assertEquals(request.anchor, '2008-01');
});

Deno.test('a subtree is a facet of its own, listed by time', () => {
  const request = mediaTimelineSearchRequest({ within: '/home/anna/staging/files', ascending: true });
  assertEquals(request.filters, { within: '/home/anna/staging/files', sort: 'time' });
});

Deno.test('an album is laid out whole, and narrowed to a person it still is', () => {
  assertEquals(mediaTimelineSearchRequest({ under: '/archive/albums/Summer' }).layout, true);
  assertEquals(mediaTimelineSearchRequest({ under: '/archive/albums/Summer', filters: { subjects: ['person:anna-andersson'] } }).layout, true);
});

Deno.test('words, a picture or a label in an album page by cursor, since they drive the search', () => {
  for (const filters of [{ query: 'sailboat' }, { like: '/archive/albums/Summer/boat.jpg' }, { tags: ['boats'] }]) {
    assertEquals(mediaTimelineSearchRequest({ under: '/archive/albums/Summer', filters, rankByRelevance: true }).layout, false);
  }
});

Deno.test('a search with no subject or container is never laid out', () => {
  assertEquals(mediaTimelineSearchRequest({ filters: {} }).layout, false);
  assertEquals(mediaTimelineSearchRequest({ camera: '/cameras/x100' }).layout, false);
});
