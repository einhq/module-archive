/**
 * A GPS tracker as core makes one: a device under `/dev` driven by core's `tracker`, whose
 * `position` endpoint is its track.
 */

import { DEV_PATH } from '@ein/paths';
import { shq } from '@ein/client';

/** The device `name`. */
export const deviceAt = (name: string): string => `${DEV_PATH}/${name}`;

/** The track the tracker `name` keeps: its device's position. */
export const positionOf = (name: string): string => `${deviceAt(name)}/position`;

/**
 * The shell command that makes the tracker `name` (`device-create --driver tracker`): its device
 * labelled `label`, of `deviceClass` when given, and its track with the string attrs `attrs`
 * (`kind`, `timezone`, …). Boot makes `/dev`; a test that does not boot has it made here.
 */
export const mkTracker = (name: string, label = name, attrs: Record<string, string> = {}, deviceClass?: string): string =>
  `mkdir -p ${DEV_PATH} && device-create ${shq(name)} --driver tracker --label ${shq(label)}${deviceClass ? ` --class ${shq(deviceClass)}` : ''}` +
  Object.entries(attrs).map(([key, value]) => ` && attrs ${positionOf(name)} -s ${shq(`${key}=${value}`)}`).join('');
