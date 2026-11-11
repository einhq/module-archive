// deno-lint-ignore no-explicit-any
type NodeAttrs = Record<string, any>;
type NodeType = string;

export type CameraAttrs = NodeAttrs & {
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
  /** For a camera linking a device with a stream: what opens a clip of it, `face`, `motion` or `off`. */
  clips?: string;
  /** How many days its clips are kept; 0 keeps them. */
  clipDays?: number;
};

export const NODE_TYPE_CAMERA: NodeType = 'camera';
