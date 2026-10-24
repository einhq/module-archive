// deno-lint-ignore no-explicit-any
type NodeAttrs = Record<string, any>;
type NodeType = string;

export type DeviceAttrs = NodeAttrs & {
  /** Display name, e.g. "Canon EOS 5D Mark III" */
  name: string;
  /** EXIF Make */
  make?: string;
  /** EXIF Model */
  model?: string;
  /** EXIF SerialNumber — primary match key */
  serialNumber?: string;
  /** IANA timezone, e.g. "Europe/Stockholm" */
  timezone?: string;
  /** Scanner/digitizer dates describe file creation, never photograph capture. */
  digitizer?: boolean;
  /** Keeps a video's QuickTime `CreateDate` in UTC, even where the file does not say so. */
  quicktimeUtc?: boolean;
};

export const NODE_TYPE_DEVICE: NodeType = 'device';
