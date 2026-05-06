export const themeNames = [
  'dark',
  'light',
  'graphite',
  'midnight',
  'forest',
  'aurora',
  'sunset',
] as const;

export type ThemeName = (typeof themeNames)[number];

export interface ThemeOption {
  name: ThemeName;
  label: string;
  swatches: [string, string, string];
}

export const themeOptions: ThemeOption[] = [
  { name: 'dark', label: 'Dark', swatches: ['#0f0f11', '#1c1c22', '#ffffff'] },
  { name: 'light', label: 'Light', swatches: ['#f5f5f7', '#ffffff', '#1a1a1a'] },
  { name: 'graphite', label: 'Graphite', swatches: ['#111315', '#202327', '#d7dde5'] },
  { name: 'midnight', label: 'Midnight', swatches: ['#0b1020', '#16203a', '#79a8ff'] },
  { name: 'forest', label: 'Forest', swatches: ['#0f1713', '#1d2a22', '#8fc79c'] },
  { name: 'aurora', label: 'Aurora', swatches: ['#111827', '#253047', '#c084fc'] },
  { name: 'sunset', label: 'Sunset', swatches: ['#1f1716', '#33211f', '#ffb86b'] },
];

export function isThemeName(value: string | null): value is ThemeName {
  return themeNames.includes(value as ThemeName);
}
