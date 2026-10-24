import { HeaderChoice, TablerIcon } from '@ein/ui/components';
import { usePersistedState } from '@ein/ui/hooks';

type AlbumSort = 'newest' | 'oldest';

/**
 * Persisted across albums: a sort preference is about the reader, not the album.
 * Hand-made and suggested albums read the same way.
 *
 * Oldest first by default — an album is one occasion and starts at its
 * beginning. The key is versioned so a `newest` stored under the unversioned
 * key, from when that was the default, does not keep winning.
 */
const SORT_KEY = 'albums.detail.sort.v2';

export function useAlbumSort(): [AlbumSort, (value: AlbumSort) => void] {
  return usePersistedState<AlbumSort>(SORT_KEY, 'oldest');
}

const SORT_OPTIONS = [
  { value: 'oldest', label: 'Oldest first', icon: <TablerIcon name='sort-ascending' size={18} /> },
  { value: 'newest', label: 'Newest first', icon: <TablerIcon name='sort-descending' size={18} /> },
];

export function AlbumSortSelect({ value, onChange }: { value: AlbumSort; onChange: (value: AlbumSort) => void }) {
  return <HeaderChoice label='Sort' value={value} onChange={(next) => onChange(next === 'newest' ? 'newest' : 'oldest')} options={SORT_OPTIONS} />;
}
