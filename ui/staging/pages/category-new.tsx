import { categoryPath, parseStagedPath } from '@archive/staging/paths';
import { CommandForm, type FormField, type FormValues } from '@ein/ui/components';
import { shq } from '@ein/ui/lib';
import { currentUser } from '@ein/ui/signals';
import { useSignals } from '@preact/signals-react/runtime';
import { useSearchParams } from 'react-router-dom';
import { useStagingStatus } from '../hooks/useStagingStatus.ts';
import { categorySlug, freeSlug } from '../lib/overview.ts';

/** The shell's dialog takes its frame from here; as a page, this is its heading. */
export const handle = { title: 'New category', icon: 'folder-plus', pattern: 'staging', dialogSize: 'md', signedIn: true };

const FIELDS: FormField[] = [{ key: 'label', label: 'Name', type: 'text', required: true, placeholder: 'Box 3' }];

/**
 * The command that makes the category, its folder made from its name and kept apart from the
 * `taken` ones, and with `move` (a staged folder) moves that folder into it.
 */
const build = (taken: string[], move: string | undefined) => (values: FormValues) => {
  const label = values.label.trim();
  const name = freeSlug(categorySlug(label), taken) || freeSlug('category', taken);
  const create = `staging category ${shq(name)} --create --label ${shq(label)}`;
  const owner = move ? parseStagedPath(move)?.user : undefined;
  return {
    command: move && owner ? `${create} && staging move ${shq(move)} ${shq(categoryPath(owner, name))}` : create,
    navigateTo: `/staging?c=${encodeURIComponent(name)}`,
  };
};

/**
 * `/staging/categories/new`: a staging category (`staging category <name> --create`), named what
 * `?label=` says to begin with, in a folder made from its name; its page opens on its files once it
 * is made. With `?move=`, a staged folder is then moved into it (`staging move`). Opened in a
 * dialog from the Staging page.
 */
export default function NewCategoryPage() {
  useSignals();
  const [params] = useSearchParams();
  const status = useStagingStatus(currentUser.value?.username ?? '');
  const taken = status.data?.categories.map((category) => category.name) ?? [];
  const move = params.get('move') ?? undefined;
  const initial = { label: params.get('label') ?? '' };
  return <CommandForm fields={FIELDS} initial={initial} build={build(taken, move)} submitLabel={move ? `Create and move “${move.split('/').pop()}”` : undefined} />;
}
