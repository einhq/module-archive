import { lifeSpan } from '@ein/ui/components';
import { countOf } from '@ein/ui/lib';
import { Box, Stack, Text, UnstyledButton } from '@mantine/core';
import type { MergeCard, MergeKind } from '../lib/gedcom-merge.ts';

/** Each kind of card's colour, its name in the legend, and its line on the card. */
export const MERGE_KINDS: Record<MergeKind, { color: string; label: string }> = {
  found: { color: 'teal', label: 'Found in the archive' },
  chosen: { color: 'marine', label: 'Chosen by you' },
  unsure: { color: 'orange', label: 'To decide' },
  new: { color: 'grape', label: 'New person' },
  skip: { color: 'red', label: 'Left out' },
  archive: { color: 'gray', label: 'Only in the archive' },
};

/** What a card says of who they are: the person they are matched to, or what becomes of them. */
const fateLine = (card: MergeCard): string => {
  const archiveName = card.archive?.name;
  switch (card.kind) {
    case 'found':
      return archiveName && archiveName !== card.individual?.name ? `= ${archiveName}` : 'In the archive';
    case 'chosen':
      return `Chosen: ${archiveName ?? card.person}`;
    case 'unsure':
      return `${countOf(card.individual?.candidates.length ?? 0, 'person', 'people')} could be them`;
    default:
      return MERGE_KINDS[card.kind].label;
  }
};

type Props = { card: MergeCard; selected: boolean; onSelect: (key: string) => void };

/**
 * The inside of one card of the merged tree: a stripe of the card's kind, the name and years the
 * file gives (the archive's, for a person only it has), and what becomes of them. Pressing it
 * selects it.
 */
export function GedcomMergeCard({ card, selected, onSelect }: Props) {
  const shown = card.individual ?? card.archive;
  const span = shown ? lifeSpan(shown) : undefined;
  const { color } = MERGE_KINDS[card.kind];
  return (
    <UnstyledButton
      onClick={() => onSelect(card.key)}
      aria-pressed={selected}
      aria-label={`${shown?.name || card.key}: ${fateLine(card)}`}
      style={{
        display: 'flex',
        width: '100%',
        height: '100%',
        overflow: 'hidden',
        borderRadius: 'calc(var(--mantine-radius-md) - 1px)',
        background: selected ? 'var(--mantine-color-marine-light)' : undefined,
        outline: selected ? '2px solid var(--mantine-color-marine-5)' : undefined,
        outlineOffset: -1,
        opacity: card.kind === 'skip' ? 0.6 : 1,
      }}
    >
      <Box style={{ flex: 'none', width: 6, background: `var(--mantine-color-${color}-6)` }} />
      <Stack gap={0} px={8} justify='center' style={{ flex: 1, minWidth: 0 }}>
        <Text fz={13} fw={600} lh={1.25} truncate td={card.kind === 'skip' ? 'line-through' : undefined}>{shown?.name || card.key}</Text>
        {span && <Text fz={11} c='dimmed' lh={1.3}>{span}</Text>}
        <Text fz={11} lh={1.3} c={`${color}.7`} truncate>{fateLine(card)}</Text>
      </Stack>
    </UnstyledButton>
  );
}
