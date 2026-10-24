import type { StagingCategoryKind } from '@archive/staging/api';
import { CATEGORY_SLUG, categoryPath, parseStagedPath } from '@archive/staging/paths';
import { CommandForm, type FormField, type FormValues } from '@ein/ui/components';
import { shq } from '@ein/ui/lib';
import { useSearchParams } from 'react-router-dom';
import { categorySlug, KIND_LABELS, NEW_KINDS } from '../lib/overview.ts';

/** The shell's dialog takes its frame from here; as a page, this is its heading. */
export const handle = { title: 'New category', icon: 'folder-plus', pattern: 'staging', dialogSize: 'md', signedIn: true };

const FIELDS: FormField[] = [
  {
    key: 'kind',
    label: 'What it holds',
    type: 'select',
    required: true,
    options: NEW_KINDS.map((kind) => ({ value: kind, label: KIND_LABELS[kind] })),
    description: 'Sets how its files are treated by default.',
  },
  { key: 'label', label: 'Called', type: 'text', required: true, placeholder: 'Box 3' },
  {
    key: 'name',
    label: 'Folder name',
    type: 'text',
    placeholder: 'Made from what it is called',
    description: 'Its folder under staging/files, which never changes: lowercase letters, digits and dashes.',
  },
];

/** The command that makes the category, and with `move` (a staged folder) moves that folder into it. */
const build = (move: string | undefined) => (values: FormValues) => {
  const label = values.label.trim();
  const name = values.name?.trim() || categorySlug(label);
  if (!CATEGORY_SLUG.test(name)) throw new Error(`a folder name is lowercase letters, digits and dashes, at most 48: '${name}'`);
  const create = `staging category ${shq(name)} --create --kind ${shq(values.kind)} --label ${shq(label)}`;
  const owner = move ? parseStagedPath(move)?.user : undefined;
  return {
    command: move && owner ? `${create} && staging move ${shq(move)} ${shq(categoryPath(owner, name))}` : create,
    navigateTo: `/staging?c=${encodeURIComponent(name)}${move && owner ? '&tab=files' : ''}`,
  };
};

const isNewKind = (value: string | null): value is StagingCategoryKind => NEW_KINDS.includes(value as StagingCategoryKind);

/**
 * `/staging/categories/new`: a staging category (`staging category <name> --create`), of the kind
 * `?kind=` names or one chosen here; its page opens once it is made. With `?move=`, a staged folder
 * (one that looks like it came from that kind's source) is then moved into it (`staging move`), and
 * the page opens on its files. Opened in a dialog from the Staging page.
 */
export default function NewCategoryPage() {
  const [params] = useSearchParams();
  const kind = params.get('kind');
  const move = params.get('move') ?? undefined;
  const initial = { kind: isNewKind(kind) ? kind : 'generic', label: isNewKind(kind) && kind !== 'generic' ? KIND_LABELS[kind] : '' };
  return <CommandForm fields={FIELDS} initial={initial} build={build(move)} submitLabel={move ? `Create and move “${move.split('/').pop()}”` : undefined} />;
}
