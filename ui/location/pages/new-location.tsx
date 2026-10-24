import { LOCATIONS_ROOT } from '@archive/paths';
import { CommandForm, type FormField, type FormValues } from '@ein/ui/components';
import { shq } from '@ein/ui/lib';
import { personSlug } from '../../people/lib/person-slug.ts';

/** The shell's dialog takes its frame from here (wide, the map beside the fields); as a page, this is its heading. */
export const handle = { title: 'Create Location', icon: 'map-pin', pattern: 'location', dialogSize: 'xl', signedIn: true };

const FIELDS: FormField[] = [
  { key: 'name', label: 'Name', type: 'text', required: true, placeholder: 'Grandma’s house' },
  {
    key: 'address',
    label: 'Address',
    type: 'textarea',
    placeholder: 'Exempelgatan 1, 123 45 Exempelstad',
    description: 'Looked up on the map when no coordinates are given, and again whenever it is edited.',
  },
  { key: 'coordinates', label: 'Coordinates', type: 'coordinates', description: 'Click the map to place it, or type the coordinates.' },
];

const build = (v: FormValues) => {
  // Location slugs follow the person rule: lower case, transliterated.
  const id = personSlug(v.name);
  const path = `${LOCATIONS_ROOT}/${id}`;
  const lat = v.lat?.trim();
  const lng = v.lng?.trim();
  if (Boolean(lat) !== Boolean(lng)) throw new Error('Give both latitude and longitude, or neither.');

  // The shape is the location's `position` child, not attrs. With no
  // coordinates the address is what location-upkeep places it from.
  let command = `mknode -t location ${shq(path)} --as ${shq(`name=${v.name}`)}`;
  if (v.address?.trim()) command += ` --as ${shq(`address=${v.address.trim()}`)}`;
  if (lat && lng) {
    command += ` && position-set ${shq(`${path}/position`)} --lat=${Number(lat)} --lng=${Number(lng)}`;
    command += ` && geocode-location ${shq(path)} --drawn`;
  }
  return { command, navigateTo: `/locations/${id}` };
};

/** `/locations/new`, in the dialog from the top bar's Create menu or as a page of its own. */
export default function NewLocationPage() {
  return <CommandForm fields={FIELDS} build={build} />;
}
