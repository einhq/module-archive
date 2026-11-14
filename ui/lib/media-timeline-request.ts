import { type SearchFilters, subjectArg } from '@ein/ui/lib';

/** What shapes a media timeline's search. */
type MediaTimelineRequest = {
  person?: string;
  location?: string;
  under?: string;
  within?: string;
  camera?: string;
  kinds?: SearchFilters['kinds'];
  filters?: SearchFilters;
  rankByRelevance?: boolean;
  ascending?: boolean;
  anchor?: string | null;
};

/**
 * The search a media timeline asks, shaped apart from the hook so its sort and anchor contract
 * stays testable without React.
 */
export function mediaTimelineSearchRequest(opts: MediaTimelineRequest): { filters: SearchFilters; anchor: string | null; layout: boolean } {
  const { person, location, under, within, camera, kinds, filters, rankByRelevance = false, ascending = false, anchor = null } = opts;
  const subject = person ? subjectArg('person', person) : location ? subjectArg('location', location) : camera ? subjectArg('camera', camera) : undefined;
  // Words, a picture to look like and a label each drive the search ahead of a subject or a
  // container, and `search --layout` lays out only what those two drive.
  const driven = Boolean(filters?.query?.trim() || filters?.like || filters?.tags?.length);

  return {
    filters: {
      ...filters,
      ...(subject ? { subjects: [subject] } : {}),
      ...(under ? { under } : {}),
      ...(within ? { within } : {}),
      ...(kinds?.length ? { kinds } : {}),
      sort: rankByRelevance ? 'score' : ascending ? 'time' : '-time',
    },
    // `search --at` is defined only for a time-ordered result set.
    anchor: rankByRelevance ? null : anchor,
    // Containers, people and locations already materialize their complete ordered sets on the
    // server, and a subtree is laid out whole while it is small enough. One compact index gives
    // their grids exact geometry; a subtree too large for one, cameras and general search page by
    // cursor.
    layout: (under !== undefined || within !== undefined || person !== undefined || location !== undefined) && !driven,
  };
}
