import { assertEquals } from '@std/assert';
import { screenSlideshow, screenSlideshowRoute, slideshowFromSearch, slideshowKeys, withoutSlideshowSearch } from '../slideshow-search.ts';

Deno.test('the slideshow parameter asks for a slideshow, and screen for one on a screen', () => {
  assertEquals(slideshowFromSearch(''), undefined);
  assertEquals(slideshowFromSearch('?q=boat'), undefined);
  assertEquals(slideshowFromSearch('?slideshow'), 'show');
  assertEquals(slideshowFromSearch('?q=boat&slideshow='), 'show');
  assertEquals(slideshowFromSearch('?slideshow=screen&fullscreen=%2Fmedia%2Fx'), 'screen');
  assertEquals(slideshowFromSearch('?slideshow=anything'), 'show');
});

Deno.test('taking the slideshow off keeps the other parameters', () => {
  assertEquals(withoutSlideshowSearch('?slideshow'), '');
  assertEquals(withoutSlideshowSearch('?q=boat&slideshow=screen&fullscreen=%2Fmedia%2Fx'), '?q=boat&fullscreen=%2Fmedia%2Fx');
  assertEquals(withoutSlideshowSearch('?q=boat'), '?q=boat');
});

Deno.test('a page is given to a screen as its route and filters with the slideshow for a screen', () => {
  assertEquals(screenSlideshowRoute('/media', new URLSearchParams('q=sailboat at sea')), '/media?q=sailboat+at+sea&slideshow=screen');
  assertEquals(screenSlideshowRoute('/albums/x', new URLSearchParams()), '/albums/x?slideshow=screen');
  assertEquals(slideshowFromSearch(screenSlideshowRoute('/albums/x', new URLSearchParams('slideshow')).split('?')[1]), 'screen');
});

Deno.test('a list is given to a screen as the slideshow page over what its filters find', () => {
  assertEquals(screenSlideshow(new URLSearchParams('q=sailboat at sea')), '/slideshow?q=sailboat+at+sea&slideshow=screen');
  assertEquals(screenSlideshow(new URLSearchParams('under=/albums/Summer'), { oldest: true }), '/slideshow?under=%2Falbums%2FSummer&order=oldest&slideshow=screen');
  assertEquals(slideshowFromSearch(screenSlideshow(new URLSearchParams('slideshow')).split('?')[1]), 'screen');
});

Deno.test('a held slideshow says Space as Play, and one that plays as Pause', () => {
  const space = (held: boolean) => slideshowKeys(held).find((each) => each.key === 'Space');
  assertEquals(space(false), { key: 'Space', label: 'Pause', icon: 'player-pause' });
  assertEquals(space(true), { key: 'Space', label: 'Play', icon: 'player-play' });
  assertEquals(slideshowKeys(true).map((each) => each.key), ['ArrowLeft', 'Space', 'ArrowRight']);
});
