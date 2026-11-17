import { assertEquals } from '@std/assert';
import { screenSlideshowRoute, slideshowFromSearch, withoutSlideshowSearch } from '../slideshow-search.ts';

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

Deno.test('a list is given to a screen as its route and filters with the slideshow for a screen', () => {
  assertEquals(screenSlideshowRoute('/media', new URLSearchParams('q=sailboat at sea')), '/media?q=sailboat+at+sea&slideshow=screen');
  assertEquals(screenSlideshowRoute('/albums/x', new URLSearchParams()), '/albums/x?slideshow=screen');
  assertEquals(slideshowFromSearch(screenSlideshowRoute('/albums/x', new URLSearchParams('slideshow')).split('?')[1]), 'screen');
});
