import { type SearchFilters, subjectArg } from '@ein/ui/lib';

/** What shapes a media timeline's search. */
type MediaTimelineRequest = {
  person?: string;
  location?: string;
  under?: string;
  within?: string;
  device?: string;
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
export function mediaTimelineSearchRequest(opts: MediaTimelineRequest): { filters: SearchFilters; anchor: string | null } {
  const { person, location, under, within, device, kinds, filters, rankByRelevance = false, ascending = false, anchor = null } = opts;
  const subject = person ? subjectArg('person', person) : location ? subjectArg('location', location) : device ? subjectArg('device', device) : undefined;

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
  };
}
