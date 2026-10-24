import { PEOPLE_ROOT } from '@archive/paths';
import { type ComboboxItem, type OptionsFilter, Select, type SelectProps } from '@mantine/core';
import { matchesText } from '@ein/ui/lib';

/** Who or what a picker picks, for its default words. */
type PickerKind = 'person' | 'location';

const DEFAULTS: Record<PickerKind, { placeholder: string; nothingFound: string }> = {
  person: { placeholder: 'Pick someone', nothingFound: 'Nobody by that name' },
  location: { placeholder: 'Pick a location', nothingFound: 'No location by that name' },
};

/** Options as `matchesText` reads them: case and accents aside, every word in any order. */
const filter: OptionsFilter = ({ options, search }) => (options as ComboboxItem[]).filter((option) => 'label' in option && matchesText([option.label], search));

type EntityPickerProps = Omit<SelectProps, 'searchable' | 'filter'> & { kind: PickerKind };

/** "Anna Berg (Anna Maria Berg)": the name a person goes by, and their full name when it says more. */
const personLabel = (person: { name: string; fullname?: string }): string =>
  person.fullname && person.fullname !== person.name ? `${person.name} (${person.fullname})` : person.name;

/** People as picker options: their path as the value, by name, leaving out `except` (a path). */
export const personOptions = (people: readonly { id: string; name: string; fullname?: string }[], except?: string): ComboboxItem[] =>
  people
    .map((person) => ({ value: `${PEOPLE_ROOT}/${person.id}`, label: personLabel(person) }))
    .filter((option) => option.value !== except)
    .sort((a, b) => a.label.localeCompare(b.label, 'sv'));

/**
 * Pick one person or location from a list the page already holds.
 *
 * Every picker the same: typed words match the way the list filters match (`matchesText`), with
 * the same words when nothing does. The options are the caller's, so each picker keeps its own
 * value format — a slug or a path — and its own list.
 */
export function EntityPicker({ kind, placeholder, nothingFoundMessage, maxDropdownHeight = 260, limit = 50, ...props }: EntityPickerProps) {
  return (
    <Select
      searchable
      filter={filter}
      placeholder={placeholder ?? DEFAULTS[kind].placeholder}
      nothingFoundMessage={nothingFoundMessage ?? DEFAULTS[kind].nothingFound}
      maxDropdownHeight={maxDropdownHeight}
      limit={limit}
      {...props}
    />
  );
}
