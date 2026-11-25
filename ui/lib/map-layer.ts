/**
 * What the archive's map layers take and what the page around them may lend them: the media and
 * locations layers' settings as their route's query (the search constraints and the years), and
 * the host a page gives the media layer to open a cluster's pictures in its own way.
 */

import { createContext } from 'react';
import type { GeoBounds, MapLayerSettings } from '@ein/ui/components';
import type { MapCluster, YearRange } from '../hooks/useMapMedia.ts';
import type { MapFilters } from './map-params.ts';

/** The archive's map layers, by their navigation ids. */
export const MEDIA_LAYER = 'archive.media';
export const LOCATIONS_LAYER = 'archive.locations';

/** A cluster opened, with the cell it stands for; `view` when it is everything the map shows. */
export type OpenCluster = { cluster: MapCluster; bounds: GeoBounds; view?: boolean };

/**
 * What the Map page lends its media layer: where a cluster's pictures open (the page's grid, which
 * Back closes), and a word when the layer is reading for a changed search rather than a move.
 * Without one the layer opens a cluster in a grid of its own.
 */
export type MediaLayerHost = {
  openCluster: (open: OpenCluster) => void;
  searching: (busy: boolean) => void;
};

export const MediaLayerHostContext = createContext<MediaLayerHost | null>(null);

/** The media and locations layers' settings for search constraints and years, leaving out what is unset. */
export const mediaLayerSettings = (filters: MapFilters, years: YearRange = {}): MapLayerSettings => {
  const settings: MapLayerSettings = {};
  if (filters.query) settings.q = filters.query;
  if (filters.person) settings.person = filters.person;
  if (filters.location) settings.location = filters.location;
  if (filters.tag) settings.tag = filters.tag;
  if (filters.under) settings.under = filters.under;
  if (years.fromYear !== undefined) settings.from = years.fromYear;
  if (years.toYear !== undefined) settings.to = years.toYear;
  return settings;
};

const yearOf = (text: string | null): number | undefined => {
  const year = text === null || text.trim() === '' ? NaN : Number(text);
  return Number.isInteger(year) ? year : undefined;
};

/** A media or locations layer's search constraints and years, back out of its query. */
export const mediaLayerQuery = (params: URLSearchParams): { filters: MapFilters; years: YearRange } => {
  const text = (key: string) => params.get(key)?.trim() || undefined;
  const filters: MapFilters = {};
  for (const [key, name] of [['q', 'query'], ['person', 'person'], ['location', 'location'], ['tag', 'tag'], ['under', 'under']] as const) {
    const value = text(key);
    if (value) filters[name] = value;
  }
  const years: YearRange = {};
  const fromYear = yearOf(params.get('from'));
  const toYear = yearOf(params.get('to'));
  if (fromYear !== undefined) years.fromYear = fromYear;
  if (toYear !== undefined) years.toYear = toYear;
  return { filters, years };
};
