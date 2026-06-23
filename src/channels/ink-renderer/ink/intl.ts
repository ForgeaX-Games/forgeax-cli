// Stub: Intl.Segmenter wrapper (replaces claude-code src/utils/intl.js)
let _segmenter: Intl.Segmenter | undefined
export function getGraphemeSegmenter(): Intl.Segmenter {
  if (!_segmenter) _segmenter = new Intl.Segmenter()
  return _segmenter
}
