/**
 * A GPS tracker as the archive finds one, made of plain nodes: a device under `/archive/devices`,
 * its `position` entity, and the track that is that position's history.
 */

import { ARCHIVE_PATH } from '@ein/paths';
import { shq } from '@ein/client';

export const DEVICES = `${ARCHIVE_PATH}/devices`;

/** The track the tracker `name` keeps: the history of its device's position. */
export const historyOf = (name: string): string => `${DEVICES}/${name}/position/history`;

/**
 * The shell command that makes the tracker `name`: its device labelled `label`, and its track with
 * the string attrs `attrs` (`kind`, `timezone`, …).
 */
export const mkTracker = (name: string, label = name, attrs: Record<string, string> = {}): string =>
  `mknode -p -t device ${DEVICES}/${name} --as label=${shq(label)} && mknode -t entity ${DEVICES}/${name}/position && ` +
  `mknode -t track ${historyOf(name)}${Object.entries(attrs).map(([key, value]) => ` --as ${shq(`${key}=${value}`)}`).join('')}`;
