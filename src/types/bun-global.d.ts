// Stub: declare Bun global for code that checks typeof Bun !== 'undefined'
declare const Bun: {
  version: string
  semver: {
    order(a: string, b: string): -1 | 0 | 1
    satisfies(version: string, range: string): boolean
  }
  wrapAnsi?: (...args: any[]) => string
  stringWidth?: (...args: any[]) => number
  [key: string]: any
} | undefined
