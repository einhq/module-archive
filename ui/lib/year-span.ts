/** The years a set of media spans, as a heading's count shows them: `1948–2016`, or `2011` alone. */
export const yearSpan = ({ min, max }: { min: number; max: number }): string => min === max ? String(min) : `${min}–${max}`;
