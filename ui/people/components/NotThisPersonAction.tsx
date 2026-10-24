import { Dialog, DialogActions, SelectionActionButton, TablerIcon, useSelectionBar } from '@ein/ui/components';
import { Button, Group, List, Radio, SimpleGrid, Stack, Text } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { useMemo, useState } from 'react';
import { execCommand, MediaItem } from '@ein/ui/signals';
import type { PersonEntry } from '../hooks/usePeople.ts';
import type { MediaSelection } from '@ein/ui/hooks';
import { detachFromPerson, type RematchedFace, rematchFaces } from '../lib/person-detach.ts';
import { regionCount } from '../lib/face-crop.ts';
import { EntityPicker, personOptions } from '../../components/EntityPicker.tsx';

type Choice = 'rematch' | 'person' | 'new-person' | 'unassign';

type Props = {
  selection: MediaSelection;
  /** The region crops, in grid order; each path is `<region>/image.avif`. */
  items: MediaItem[];
  /** Regions among them that are tags — no vector, so recognition cannot match them again. */
  tags: ReadonlySet<string>;
  person: { path: string; name: string };
  /** Named people, as a destination for "this is somebody I know". */
  named: PersonEntry[];
  /** The person the selected faces look like, offered as "someone I know" when it is one of `named`. */
  suggested?: string;
  /** The faces that left this person, once they have. */
  onApplied: (facePaths: string[]) => void;
};

/** The four answers, as the dialog offers them. */
const CHOICES = (name: string, count: string): { value: Choice; label: string; description: string }[] => [
  {
    value: 'rematch',
    label: 'Let recognition decide',
    description: `Each face is matched again against everyone except ${name}. It joins whoever it looks like, or becomes a new unidentified person.`,
  },
  { value: 'person', label: 'Someone I know', description: 'Move them to the person you pick.' },
  { value: 'new-person', label: 'One new unidentified person', description: `All ${count} are the same person, not yet named. Name them later from the unidentified list.` },
  { value: 'unassign', label: 'Not a face', description: 'They lose their identity and are locked, so recognition leaves them alone from now on.' },
];

/** The region a crop belongs to. */
const faceOf = (cropPath: string): string => cropPath.replace(/\/[^/]+$/, '');

/** "2 to Anna Andersson, 1 to a new unidentified person, 1 left unassigned". */
const summarize = (faces: RematchedFace[]): string[] => {
  const byPerson = new Map<string, { label: string; count: number }>();
  let fresh = 0;
  let unassigned = 0;
  for (const face of faces) {
    if (!face.person) unassigned++;
    else if (face.person.unnamed) fresh++;
    else {
      const entry = byPerson.get(face.person.id) ?? { label: face.person.name, count: 0 };
      entry.count++;
      byPerson.set(face.person.id, entry);
    }
  }
  const n = (count: number) => `${count} ${count === 1 ? 'face' : 'faces'}`;
  return [
    ...[...byPerson.values()].map((entry) => `${n(entry.count)} matched to ${entry.label}`),
    ...(fresh ? [`${n(fresh)} became unidentified people`] : []),
    ...(unassigned ? [`${n(unassigned)} left unassigned — too small or unclear to start a new person`] : []),
  ];
};

/**
 * Take the selected faces off this person.
 *
 * Four answers to "then who is it?", which are four different things a reviewer knows:
 * nothing but that it is not them (recognition decides again, without this person), who it
 * is, that the faces are all one other person nobody has named yet, or that it is not a face.
 * The first is the default because it is what someone scrolling a person's faces usually knows.
 */
export function NotThisPersonAction({ selection, items, tags, person, named, suggested, onApplied }: Props) {
  const { reportError } = useSelectionBar();
  const [opened, modal] = useDisclosure(false);
  const [choice, setChoice] = useState<Choice>('rematch');
  const [target, setTarget] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ lines: string[]; moved: string[] } | null>(null);

  const facePaths = items.filter((item) => selection.selected.has(item.path)).map((item) => faceOf(item.path));
  const tagCount = facePaths.filter((path) => tags.has(path)).length;
  const count = regionCount(facePaths.length - tagCount, tagCount);

  const others = useMemo(() => personOptions(named, person.path), [named, person.path]);

  const open = () => {
    const offered = suggested && others.some((option) => option.value === suggested) ? suggested : null;
    setChoice(offered ? 'person' : 'rematch');
    setTarget(offered);
    setResult(null);
    modal.open();
  };

  // The bar unmounts once the selection is empty, taking this dialog with it — so after a
  // rematch the selection is kept until the result has been read.
  const finish = (moved: string[]) => {
    selection.clear();
    onApplied(moved);
  };

  const close = () => {
    modal.close();
    if (result) finish(result.moved);
    setResult(null);
  };

  const apply = async () => {
    if (choice === 'person' && !target) return;
    reportError(null);
    setBusy(true);
    const moving = facePaths;
    try {
      if (choice === 'rematch') {
        // A tag has no vector to match with: all a reviewer has said is that the name on it is
        // wrong, so it just loses the name.
        const tagged = moving.filter((path) => tags.has(path));
        const faces = moving.filter((path) => !tags.has(path));
        if (tagged.length > 0) await detachFromPerson(execCommand, tagged, { kind: 'unassign' });
        const lines = faces.length > 0 ? summarize(await rematchFaces(execCommand, faces)) : [];
        if (tagged.length > 0) lines.push(`${regionCount(0, tagged.length)} taken off ${person.name}`);
        setResult({ lines, moved: moving });
      } else {
        await detachFromPerson(execCommand, moving, choice === 'person' ? { kind: 'person', path: target! } : { kind: choice });
        modal.close();
        finish(moving);
      }
    } catch (err) {
      // A batch that fails part way has moved some faces already; the page refetches either way.
      modal.close();
      reportError(err instanceof Error ? err.message : String(err));
      onApplied([]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <SelectionActionButton icon={<TablerIcon name='user-x' size={14} />} onClick={open} color='orange'>
        Not {person.name}
      </SelectionActionButton>

      <Dialog
        opened={opened}
        onClose={close}
        title={result ? 'Faces moved' : `Not ${person.name}?`}
        subtitle={result ? undefined : count}
        icon='user-x'
        pattern='person'
        size={result ? 'sm' : 'lg'}
      >
        {result
          ? (
            <>
              <List size='sm' spacing={4}>
                {result.lines.map((line) => <List.Item key={line}>{line}</List.Item>)}
              </List>
              <DialogActions>
                <Button onClick={close}>Done</Button>
              </DialogActions>
            </>
          )
          : (
            <>
              <Stack gap='md'>
                <Radio.Group value={choice} onChange={(value) => setChoice(value as Choice)}>
                  <SimpleGrid cols={{ base: 1, sm: 2 }} spacing='sm'>
                    {CHOICES(person.name, count).map((option) => (
                      <Radio.Card key={option.value} value={option.value} p='md' radius='md'>
                        <Group wrap='nowrap' align='flex-start'>
                          <Radio.Indicator />
                          <Stack gap={2}>
                            <Text size='sm' fw={500}>{option.label}</Text>
                            <Text size='xs' c='dimmed'>{option.description}</Text>
                          </Stack>
                        </Group>
                      </Radio.Card>
                    ))}
                  </SimpleGrid>
                </Radio.Group>
                {choice === 'person' && (
                  <EntityPicker kind='person' label='Who it is' data-autofocus value={target} onChange={setTarget} data={others} comboboxProps={{ zIndex: 400 }} />
                )}
              </Stack>
              <DialogActions>
                <Button variant='default' onClick={close}>Cancel</Button>
                <Button onClick={apply} loading={busy} disabled={facePaths.length === 0 || (choice === 'person' && !target)}>
                  {choice === 'unassign' ? 'Unassign and lock' : 'Move'}
                </Button>
              </DialogActions>
            </>
          )}
      </Dialog>
    </>
  );
}
