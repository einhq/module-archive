import { useSearchParams } from 'react-router-dom';
import { TAGS_ROOT } from '@ein/paths';
import { LabelSuggestions } from '../components/LabelSuggestions.tsx';

/**
 * What else looks like a label, for the Search page's `search.label` panel (`archive.looks-like`):
 * `path` is the label's tag directory, `/archive/tags/<label>`.
 */
export default function LooksLike() {
  const [searchParams] = useSearchParams();
  const path = searchParams.get('path') ?? '';
  const label = path.startsWith(`${TAGS_ROOT}/`) ? path.slice(TAGS_ROOT.length + 1) : '';
  return label ? <LabelSuggestions key={label} label={label} /> : null;
}
