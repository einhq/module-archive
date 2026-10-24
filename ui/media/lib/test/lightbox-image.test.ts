import { ALBUMS_ROOT } from '@archive/paths';
import { assertEquals } from '@std/assert';
import { mediaItemFrom } from '@ein/ui/lib';
import { itemAtAngle, lightboxPhotoSources } from '../lightbox-image.ts';

const path = `${ALBUMS_ROOT}/trip/photo.jpg`;

Deno.test('lightbox photo sources drop the failed rendition ladder for the original', () => {
  assertEquals(
    lightboxPhotoSources({
      path,
      fullUrl: `/file${path}/thumbnails/1600x1600.avif`,
      srcSet: `/file${path}/thumbnails/800x800.avif 800w, /file${path}/thumbnails/1600x1600.avif 1600w`,
    }, 2),
    {
      primary: {
        src: `/file${path}/thumbnails/1600x1600.avif?v=2`,
        srcSet: `/file${path}/thumbnails/800x800.avif?v=2 800w, /file${path}/thumbnails/1600x1600.avif?v=2 1600w`,
      },
      fallback: { src: `/file${path}?v=2` },
    },
  );
});

Deno.test('lightbox photo sources do not retry an original as its own fallback', () => {
  assertEquals(lightboxPhotoSources({ path, fullUrl: `/file${path}`, srcSet: '' }, 0), {
    primary: { src: `/file${path}` },
  });
});

Deno.test('an item turned a quarter describes its renditions at the swapped shape', () => {
  const landscape = mediaItemFrom({ path, mimetype: 'image/jpeg', width: 4000, height: 3000 });
  assertEquals(landscape.srcSet.split(', ').map((entry) => entry.split(' ')[1]), ['800w', '1600w', '2560w']);

  const turned = itemAtAngle(landscape, 90);
  assertEquals(turned.angle, 90);
  assertEquals(turned.id, landscape.id);
  assertEquals(turned.srcSet.split(', ').map((entry) => entry.split(' ')[1]), ['600w', '1200w', '1920w']);
  assertEquals(itemAtAngle(turned, 0).srcSet, landscape.srcSet);
});
