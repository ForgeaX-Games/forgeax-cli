declare module 'bidi-js' {
  function getEmbeddingLevels(text: string, dir?: 'ltr' | 'rtl' | 'auto'): {
    paragraphs: Array<{ level: number; start: number; length: number }>
    levels: Uint8Array
  }
  export default { getEmbeddingLevels }
  export { getEmbeddingLevels }
}
