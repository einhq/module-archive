import { DEVICES_ROOT } from '@archive/paths';
import { CommandForm, type FormField, type FormValues } from '@ein/ui/components';
import { shq } from '@ein/ui/lib';
import { useSearchParams } from 'react-router-dom';
import { deviceSlug } from '../device-slug.ts';

/** The shell's dialog takes its frame from here; as a page, this is its heading. */
export const handle = { title: 'Register Device', icon: 'device-camera-phone', pattern: 'device', signedIn: true };

const FIELDS: FormField[] = [
  { key: 'name', label: 'Name', type: 'text', required: true, placeholder: 'Canon EOS 5D Mark III' },
  { key: 'make', label: 'Make', type: 'text', placeholder: 'Canon', description: 'As the camera writes it in exif: what files are matched on.', half: true },
  { key: 'model', label: 'Model', type: 'text', placeholder: 'Canon EOS 5D Mark III', description: 'As the camera writes it in exif.', half: true },
  {
    key: 'serial',
    label: 'Serial number',
    type: 'text',
    placeholder: 'Optional',
    description: 'Tells one body apart, where make and model tell only the model.',
    half: true,
  },
  { key: 'timezone', label: 'Timezone', type: 'timezone', placeholder: 'Optional', description: 'The zone its clock was set to.', half: true },
  {
    key: 'digitizer',
    label: 'Scanner or digitizer',
    type: 'checkbox',
    description: 'Its EXIF device dates describe digitisation, not when the photograph was taken.',
  },
  {
    key: 'quicktimeUtc',
    label: 'Video times in UTC',
    type: 'checkbox',
    description: 'Its videos keep their recording time in UTC, as phones do.',
  },
];

const build = (v: FormValues) => {
  const id = deviceSlug(v.name);
  let command = `device-create ${shq(`${DEVICES_ROOT}/${id}`)} --name ${shq(v.name)}`;
  if (v.make) command += ` --make ${shq(v.make)}`;
  if (v.model) command += ` --model ${shq(v.model)}`;
  if (v.serial) command += ` --serial ${shq(v.serial)}`;
  if (v.timezone) command += ` --timezone ${shq(v.timezone)}`;
  if (v.digitizer === 'true') command += ' --digitizer';
  if (v.quicktimeUtc === 'true') command += ' --quicktime-utc';
  return { command, navigateTo: `/devices/${id}` };
};

/**
 * `/devices/new`: register a device — in the dialog from the top bar's Create menu or a scan
 * proposal (whose make, model and serial come along in the query), or as a page of its own.
 */
export default function NewDevicePage() {
  const [params] = useSearchParams();
  const initial = Object.fromEntries(['name', 'make', 'model', 'serial'].flatMap((key) => (params.get(key) ? [[key, params.get(key)!]] : [])));
  return <CommandForm fields={FIELDS} initial={initial} build={build} submitLabel='Register' />;
}
