import { Autocomplete, Button, Group } from '@mantine/core';
import { useMemo, useState } from 'react';
import { PEOPLE_ROOT } from '@archive/paths';
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
  /**
   * The review dialog's form rather than a card's box: a label, the keyboard on open, and a button
   * beside it saying what Enter does — name, or add to someone already named.
   */
  form?: boolean;
};

/**
 * "Who is this?" for an unidentified person: Enter names them — or, when the name is someone
 * already named, folds this person into them. On a card it is the box alone, and a click in it
 * stays in it, so it does not open the card.
 */
export function QuickName({ path, named, onName, onMerge, onDone, form = false }: Props) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  /** Each name once, with whoever has it first, for their picture in the list. */
  const byName = useMemo(() => {
    const map = new Map<string, PersonEntry>();
    for (const person of named) if (!map.has(person.name)) map.set(person.name, person);
    return map;
  }, [named]);
  const names = useMemo(() => [...byName.keys()], [byName]);
  const name = value.trim();
  const existing = useMemo(() => named.find((person) => person.name.toLocaleLowerCase() === name.toLocaleLowerCase()), [named, name]);

  const submit = async () => {
    if (!name || busy) return;
    setBusy(true);
    try {
      if (existing) {
        await onMerge(path, `${PEOPLE_ROOT}/${existing.id}`);
        notify({ message: `Added to ${existing.name}`, color: 'green' });
      } else {
        await onName(path, name);
        notify({ message: `Named ${name}`, color: 'green' });
      }
      setValue('');
      onDone?.();
    } catch (err) {
      notify({ message: err instanceof Error ? err.message : String(err), color: 'red' });
    } finally {
      setBusy(false);
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
      renderOption={({ option }) => {
        const person = byName.get(option.value);
        return person ? <PersonOption path={`${PEOPLE_ROOT}/${person.id}`} name={person.name} /> : option.value;
      }}
      disabled={busy}
      data-autofocus={form || undefined}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          void submit();
        }
      }}
      onOptionSubmit={(option) => setValue(option)}
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
      <Button onClick={submit} loading={busy} disabled={!name} style={{ flexShrink: 0 }}>
        {existing ? `Add to ${existing.name}` : 'Name'}
      </Button>
    </Group>
  );
}
