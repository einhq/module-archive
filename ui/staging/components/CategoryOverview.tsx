import type { StagingStatus } from '@archive/staging/api';
import { uploadsUnder } from '@ein/ui/lib';
import { uploadSummaryByTarget } from '@ein/ui/signals';
import { SimpleGrid } from '@mantine/core';
import { useSignals } from '@preact/signals-react/runtime';
import { CategoryCard } from './CategoryCard.tsx';

type Props = {
  status: StagingStatus;
  /** How long each category's files still being prepared take, in ms, by name. */
  eta: Record<string, number | undefined>;
  /** Open a category's page. */
  onOpen: (category: string) => void;
};

/**
 * `/staging` without a category: a card per category, two side by side at most and one on a phone,
 * with the uploads into it from this browser. What waits to be sorted is on the category pages: the folders
 * of the default category that look like one source, and the GPS tracks and family trees, on its
 * page.
 */
export function CategoryOverview({ status, eta, onOpen }: Props) {
  useSignals();
  const uploads = uploadSummaryByTarget.value;
  return (
    <SimpleGrid cols={{ base: 1, sm: 2 }} spacing='md' px='md'>
      {status.categories.map((category) => (
        <CategoryCard
          key={category.name}
          category={category}
          eta={eta[category.name]}
          uploads={uploadsUnder(uploads, category.path)}
          onOpen={() => onOpen(category.name)}
        />
      ))}
    </SimpleGrid>
  );
}
