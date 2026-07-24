/** Option shape shared by Select and SegToggle. A bare string is shorthand for `{value: s, label: s}`. */
export interface DSOption {
  value: string;
  label: string;
}

export type DSOptionInput = DSOption | string;

export function normalizeOption(o: DSOptionInput): DSOption {
  return typeof o === 'string' ? { value: o, label: o } : o;
}
