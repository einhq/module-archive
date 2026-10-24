import { useCommand } from '@ein/ui/hooks';
import type { DayInHistory } from '@archive/media/api';

/**
 * Today on the viewer's own clock, as `MM-DD`. The command defaults to the server's day, which
 * for a viewer in another time zone is not always theirs.
 */
const localMonthDay = (): string => {
  const now = new Date();
  return `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
};

/** This day in the years before, one picture a year in front and a few behind it (`dayinhistory`). */
export const useDayInHistory = () => useCommand<DayInHistory>(`dayinhistory ${localMonthDay()}`);
