import wrapAnsiNpm from 'wrap-ansi'

type WrapAnsiOptions = {
  hard?: boolean
  wordWrap?: boolean
  trim?: boolean
}

  // @ts-ignore
const wrapAnsiBun =
  // @ts-ignore
  typeof Bun !== 'undefined' && typeof Bun.wrapAnsi === 'function'
  // @ts-ignore
    ? Bun.wrapAnsi
    : null

const wrapAnsi: (
  input: string,
  columns: number,
  options?: WrapAnsiOptions,
  // @ts-ignore
) => string = wrapAnsiBun ?? wrapAnsiNpm

export { wrapAnsi }

