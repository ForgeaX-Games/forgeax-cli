// Global type declarations for Ink in forgeax-cli
// IMPORTANT: export {} makes this a module → declare module 'react' is augmentation, not replacement

export {}

// Bun runtime global (may not exist; checked via typeof Bun !== 'undefined')
declare global {
  // eslint-disable-next-line no-var
  var Bun:
    | { version: string; semver: { order(a: string, b: string): -1 | 0 | 1; satisfies(v: string, r: string): boolean }; wrapAnsi?: (...args: any[]) => string; stringWidth?: (...args: any[]) => number; [key: string]: any }
    | undefined
}

// React Compiler runtime — emitted by the compiler as `import { c as _c } from "react/compiler-runtime"`
declare module 'react/compiler-runtime' {
  export function c(size: number): any[]
}

// Ink custom JSX elements — augment React.JSX.IntrinsicElements for react-jsx transform
declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'ink-box': { [key: string]: any }
      'ink-text': { [key: string]: any }
      'ink-raw-ansi': { [key: string]: any }
      'ink-virtual-text': { [key: string]: any }
    }
  }
}
