import { Autocomplete, Button, Group, Loader, type OptionsFilter } from '@mantine/core';
import { type KeyboardEvent, useMemo, useState } from 'react';
import { PEOPLE_ROOT } from '@archive/paths';
import { namesHaveWords, nameWords } from '@archive/people/name-match';
import { notify } from '@ein/ui/signals';
import type { PersonEntry } from '../hooks/usePeople.ts';
import { PersonOption } from './PersonOption.tsx';

type Props = {
  /** The unidentified person this names. */
  path: string;
  /** Everyone already named, offered as the box fills. */
  named: PersonEntry[];
  onName: (path: string, name: string) => Promise<string>;
  onMerge: (srcPath: string, dstPath: string) => Promise<void>;
  /** Told once the person has been named or merged. */
  onDone?: () => void;
  /** Told when saving starts and when it ends, done or failed. */
  onBusy?: (busy: boolean) => void;
  /**
   * The review dialog's form rather than a card's box: a label, the keyboard on open, and a button
   * beside it saying what Enter does — name, or add to someone already named.
   */
  form?: boolean;
};

/**
 * "Who is this?" for an unidentified person: Enter names them — or, when the name is someone
 * already named, folds this person into them, as picking someone from the list does at once. On a
 * card it is the box alone, and a click in it stays in it, so it does not open the card.
 */
export function QuickName({ path, named, onName, onMerge, onDone, onBusy, form = false }: Props) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  /** Each name once, with whoever has it first, for their picture in the list. */
  const byName = useMemo(() => {
    const map = new Map<string, PersonEntry>();
    for (const person of named) if (!map.has(person.name)) map.set(person.name, person);
    return map;
  }, [named]);
  const names = useMemo(() => [...byName.keys()], [byName]);
  /** As the finder matches people: every typed word in one of a person's names, so "Anna Andersson" offers "Anna B Andersson". */
  const filter: OptionsFilter = ({ options, search, limit }) => {
    const words = nameWords(search);
    return options.filter((option) => {
      const person = 'value' in option ? byName.get(option.value) : undefined;
      return person && namesHaveWords(words, [person.name, person.fullname, person.birthname]);
    }).slice(0, limit);
  };
  const name = value.trim();
  const existing = useMemo(() => named.find((person) => person.name.toLocaleLowerCase() === name.toLocaleLowerCase()), [named, name]);

  /** Names the person `typed`, or folds them into whoever already has that name. */
  const submit = async (typed = name) => {
    if (!typed || busy) return;
    const match = named.find((person) => person.name.toLocaleLowerCase() === typed.toLocaleLowerCase());
    setBusy(true);
    onBusy?.(true);
    try {
      if (match) {
        await onMerge(path, `${PEOPLE_ROOT}/${match.id}`);
        notify({ message: `Added to ${match.name}`, color: 'green' });
      } else {
        await onName(path, typed);
        notify({ message: `Named ${typed}`, color: 'green' });
      }
      setValue('');
      onDone?.();
    } catch (err) {
      notify({ message: err instanceof Error ? err.message : String(err), color: 'red' });
    } finally {
      setBusy(false);
      onBusy?.(false);
    }
  };

  const box = (
    <Autocomplete
      size={form ? 'sm' : 'xs'}
      label={form ? 'Who is this?' : undefined}
      placeholder={form ? 'A new name, or someone you already have' : 'Who is this?'}
      value={value}
      onChange={setValue}
      // Nothing until something is typed: the dialog's box has the keyboard as it opens, and a list
      // of eight unrelated names dropped over the faces and recordings would hide what it is for.
      data={name ? names : []}
      limit={8}
      filter={filter}
      renderOption={({ option }) => {
        const person = byName.get(option.value);
        return person ? <PersonOption path={`${PEOPLE_ROOT}/${person.id}`} name={person.name} /> : option.value;
      }}
      disabled={busy}
      // The form's button spins instead.
      rightSection={busy && !form ? <Loader size={14} /> : undefined}
      data-autofocus={form || undefined}
      // On the wrapper, so it runs after the box's own Enter: when that picked a highlighted person
      // it has already been submitted, and the typed text is not.
      wrapperProps={{
        onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
          if (event.key !== 'Enter' || event.defaultPrevented) return;
          event.preventDefault();
          void submit();
        },
      }}
      onOptionSubmit={(option) => {
        setValue(option);
        void submit(option);
      }}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      aria-label='Name this person'
      w='100%'
    />
  );
  if (!form) return box;

  return (
    <Group align='flex-end' gap='xs' wrap='nowrap'>
      {box}
      <Button onClick={() => submit()} loading={busy} disabled={!name} style={{ flexShrink: 0 }}>
        {existing ? `Add to ${existing.name}` : 'Name'}
      </Button>
    </Group>
  );
}
