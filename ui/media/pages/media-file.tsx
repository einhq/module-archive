import { Box } from '@mantine/core';
import { effect } from '@preact/signals-react';
import { useEffect, useLayoutEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { MediaLightbox } from '../components/MediaLightbox.tsx';
import { useSurface } from '@ein/ui/hooks';
import { lightboxRoute } from '@ein/ui/lib';
import { currentMediaItem, endLightbox, showLightboxPath } from '@ein/ui/signals';

export const handle = { fullBleed: true };

/**
 * One media file in the lightbox. Opened from a grid it is shown full screen over the page,
 * walking the list it was opened from (`openMediaAt`); opened by its URL it is the page, and
 * walks what the page behind offers, or nothing.
 */
export default function MediaPage() {
  const { id } = useParams();
  const path = id ? decodeURIComponent(id) : undefined;
  const navigate = useNavigate();
  const surface = useSurface();

  useLayoutEffect(() => {
    if (path) showLightboxPath(path);
  }, [path]);

  // The route follows the lightbox: arrowing to the next picture replaces it, so the URL names
  // what is shown and Back still closes the whole visit in one step.
  useEffect(() =>
    effect(() => {
      const item = currentMediaItem.value;
      if (item && item.path !== path) navigate(lightboxRoute(item.path), { replace: true });
    }), [navigate, path]);

  // Gone — Back, or the surface closed under it — while a picture was still open: the grid
  // takes it back. A layout cleanup, so the picture is still laid out to shrink into its tile.
  useLayoutEffect(() => () => endLightbox(true), []);

  if (surface.kind !== 'page') return <MediaLightbox />;
  return (
    <Box h='calc(100dvh - var(--app-shell-header-height))' pos='relative'>
      <MediaLightbox />
    </Box>
  );
}
