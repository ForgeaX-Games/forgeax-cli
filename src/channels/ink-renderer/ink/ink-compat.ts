/**
 * Ink-internal re-export facade.
 * Replaces the external src/ink.ts so ink fork components
 * don't need to reach outside src/ink/.
 */
export { default as Box } from './components/Box.js';
export { default as Text } from './components/Text.js';
export { Ansi } from './Ansi.js';
export { default as createRenderer } from './renderer.js';

// useTheme — always 'dark' in agenteam_os
import type { ThemeName } from '../utils/theme.js';
const FIXED_THEME: ThemeName = 'dark';
export function useTheme(): [ThemeName, (theme: ThemeName) => void] {
  return [FIXED_THEME, () => {}];
}
