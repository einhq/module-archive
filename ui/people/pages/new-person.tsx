import { PEOPLE_ROOT } from '@archive/paths';
import { CommandForm, type FormField, type FormValues } from '@ein/ui/components';
import { shq } from '@ein/ui/lib';
import { personSlug } from '../lib/person-slug.ts';

/** The shell's dialog takes its frame from here; as a page, this is its heading. */
export const handle = { title: 'Create Person', icon: 'user', pattern: 'person', signedIn: true };

const GENDER_OPTIONS = [
  { value: 'female', label: 'Female' },
  { value: 'male', label: 'Male' },
  { value: 'other', label: 'Other' },
  { value: 'unknown', label: 'Unknown' },
];

const FIELDS: FormField[] = [
  { key: 'name', label: 'Name', type: 'text', required: true, placeholder: 'Anna Andersson', half: true },
  { key: 'fullname', label: 'Full name', type: 'text', placeholder: 'Optional', half: true },
  { key: 'gender', label: 'Gender', type: 'select', options: GENDER_OPTIONS, half: true },
];

const build = (v: FormValues) => {
  const id = personSlug(v.name);
  let command = `person-create ${shq(`${PEOPLE_ROOT}/${id}`)} --name ${shq(v.name)}`;
  if (v.fullname) command += ` --fullname ${shq(v.fullname)}`;
  if (v.gender) command += ` --gender ${v.gender}`;
  return { command, navigateTo: `/people/${id}` };
};

/** `/people/new`, in the dialog from the top bar's Create menu or as a page of its own. */
export default function NewPersonPage() {
  return <CommandForm fields={FIELDS} build={build} />;
}
