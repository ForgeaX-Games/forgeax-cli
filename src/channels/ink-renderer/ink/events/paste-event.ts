import { TerminalEvent } from './terminal-event.js'

export class PasteEvent extends TerminalEvent {
  readonly data: string

  constructor(data: string) {
    super('paste')
    this.data = data
  }
}
