import { ALBUMS_ROOT } from '@archive/paths';
import { CommandForm, type FormField, type FormValues } from '@ein/ui/components';
import { shq } from '@ein/ui/lib';

/** The shell's dialog takes its frame from here; as a page, this is its heading. */
export const handle = { title: 'Create Album', icon: 'photo', pattern: 'album', dialogSize: 'md', signedIn: true };

const FIELDS: FormField[] = [
  { key: 'name', label: 'Name', type: 'text', required: true, placeholder: 'Summer 2020' },
  { key: 'description', label: 'Description', type: 'markdown', placeholder: 'Optional' },
];

const build = (v: FormValues) => {
  const path = `${ALBUMS_ROOT}/${v.name}`;
  let command = `album create ${shq(path)}`;
  if (v.description) command += ` --description ${shq(v.description)}`;
  return { command, navigateTo: `/albums/${encodeURIComponent(path)}` };
};

/** `/albums/new`, in the dialog from the top bar's Create menu or as a page of its own. */
export default function NewAlbumPage() {
  return <CommandForm fields={FIELDS} build={build} />;
}
