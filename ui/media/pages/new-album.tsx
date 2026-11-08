import { ALBUMS_ROOT } from '@archive/paths';
import { CommandForm, type FormField, type FormValues } from '@ein/ui/components';
import { shq } from '@ein/ui/lib';
import { useSearchParams } from 'react-router-dom';

/** The shell's dialog takes its frame from here; as a page, this is its heading. */
export const handle = { title: 'Create Album', icon: 'photo', pattern: 'album', dialogSize: 'md', signedIn: true };

const fields = (of: string | null): FormField[] => [
  { key: 'name', label: 'Name', type: 'text', required: true, placeholder: 'Summer 2020', description: of ? `An album of the trip ${of}` : undefined },
  { key: 'description', label: 'Description', type: 'markdown', placeholder: 'Optional' },
];

/** A trip of a track the new album is made of (`trip-album`). */
type TripOf = { track: string; trip: string };

const build = (tripOf: TripOf | null) => (v: FormValues) => {
  const path = `${ALBUMS_ROOT}/${v.name.trim()}`;
  let command = `album create ${shq(path)}`;
  if (v.description) command += ` --description ${shq(v.description)}`;
  if (tripOf) command += ` && trip-album ${shq(tripOf.track)} ${shq(tripOf.trip)} --album=${shq(path)}`;
  return { command, navigateTo: `/albums/${encodeURIComponent(path)}` };
};

/**
 * `/albums/new`, in the dialog from the top bar's Create menu or as a page of its own. With
 * `?track=` (a track's path) and `?trip=` the album is made of that trip of the track
 * (`trip-album --album`), from its card on the track's Trips tab; `?name=` is the name it starts
 * with and `?of=` the trip's days as the card shows them.
 */
export default function NewAlbumPage() {
  const [params] = useSearchParams();
  const track = params.get('track');
  const trip = params.get('trip');
  const tripOf = track && trip ? { track, trip } : null;
  return <CommandForm fields={fields(tripOf && params.get('of'))} initial={{ name: params.get('name') ?? '' }} build={build(tripOf)} />;
}
