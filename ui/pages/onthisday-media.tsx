import { useSearchParams } from 'react-router-dom';
import { MemoryRing } from '../components/MemoryRings.tsx';

/**
 * One `onthisday-media` entry, as the home page's On this day draws it: a ring round the year's
 * first picture, opening that year's story. Everything it shows is in its query (`day`, `year`,
 * `cover`), so it runs nothing. The page holds it in a list item of its own.
 */
export default function OnThisDayMediaEntry() {
  const [params] = useSearchParams();
  const year = Number(params.get('year'));
  const cover = params.get('cover');
  if (!Number.isInteger(year) || !cover) return null;
  return <MemoryRing monthDay={params.get('day') ?? ''} year={year} cover={cover} />;
}
