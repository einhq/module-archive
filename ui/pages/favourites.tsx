import { Box, Button, Text } from '@mantine/core';
import { useEffect, useState } from 'react';
import { useSignals } from '@preact/signals-react/runtime';
import { homePath } from '@ein/paths';
import { EmptyState, EntityDetailHeader, PageLoader } from '@ein/ui/components';
import { currentUser, loadStars, starredPaths } from '@ein/ui/signals';
import { useNavigate } from 'react-router-dom';
import { MediaTimeline } from '../components/MediaTimeline.tsx';

export const handle = { fullBleed: true, signedIn: true };

/**
 * The reader's favourites: the files their `$HOME/stars` links to, by day, as an album shows
 * its members. A heart in the selection bar or the lightbox puts a picture here.
 */
export default function FavouritesPage() {
  useSignals();
  const navigate = useNavigate();
  const user = currentUser.value?.username;
  const count = starredPaths.value.size;
  const [loaded, setLoaded] = useState(false);
  useEffect(() => void loadStars().then(() => setLoaded(true)), []);

  return (
    <Box>
      <EntityDetailHeader
        title='Favourites'
        pattern='mixed'
        subtitle={<Text size='sm' c='gray.2'>The pictures you have hearted</Text>}
        flowContent
      />
      <Box px='md' py='lg'>
        {!loaded && <PageLoader />}
        {loaded && user && count > 0 && <MediaTimeline album={`${homePath(user)}/stars`} granularity='day' emptyMessage='No favourites yet.' />}
        {loaded && count === 0 && (
          <EmptyState title='No favourites yet' actions={<Button variant='light' onClick={() => navigate('/media')}>Open Media</Button>}>
            Select pictures and choose Favourite, or press the heart in the lightbox.
          </EmptyState>
        )}
      </Box>
    </Box>
  );
}
