// Ink custom JSX intrinsic element declarations
import type { DOMElement } from './dom.js'

declare global {
  namespace JSX {
    interface IntrinsicElements {
      'ink-box': DOMElement & { [key: string]: unknown }
      'ink-text': DOMElement & { [key: string]: unknown }
      'ink-raw-ansi': DOMElement & { [key: string]: unknown }
      'ink-virtual-text': DOMElement & { [key: string]: unknown }
    }
  }
}
export {}
