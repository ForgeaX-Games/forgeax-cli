/**
 * VirtualMessageList — virtualized rendering of completed turns using
 * the RendererMessage type system and MessageRow dispatch.
 *
 * Core mechanisms retained from claude-code:
 *   - Incremental key array (append-only delta push, avoids O(n) rebuild)
 *   - useVirtualScroll integration (range, spacers, measureRef)
 *   - VirtualItem wrapper with stable measureRef for Yoga height measurement
 *   - Streaming content rendered outside virtualization (always visible)
 */

import React, { memo, useRef } from 'react'
import type { RefObject } from 'react'
import { default as Box } from '../ink/components/Box.js'
import { default as Text } from '../ink/components/Text.js'
import type { ScrollBoxHandle } from '../ink/components/ScrollBox.js'
import type { DOMElement } from '../ink/dom.js'
import { StreamingMarkdown } from '../ink/components/StreamingMarkdown.js'
import { useVirtualScroll } from '../hooks/use-virtual-scroll.js'
import type { CompletedTurn } from '../types.js'
import { MessageRow } from './MessageRow.js'
import { theme } from '../lib/theme.js'

function turnKey(turn: CompletedTurn, index: number): string {
  return `${turn.timestamp}-${index}`
}

interface VirtualItemProps {
  itemKey: string
  turn: CompletedTurn
  prevAgent: string | undefined
  isFirst: boolean
  measureRef: (key: string) => (el: DOMElement | null) => void
}

const VirtualItem = memo(function VirtualItem({ itemKey, turn, prevAgent, isFirst, measureRef }: VirtualItemProps): React.JSX.Element {
  const ref = measureRef(itemKey)
  const agent = turn.agent || "";
  const isAgentTurn = agent !== "" && agent !== "user";
  const agentChanged = isAgentTurn && agent !== (prevAgent || "");
  return (
    <Box ref={ref} flexDirection="column" width="100%">
      {agentChanged && (
        <Box marginTop={isFirst ? 0 : 1}>
          <Text color={theme.agentLabel.color} bold>{theme.agentLabel.char} [{agent}]</Text>
        </Box>
      )}
      {turn.messages.map((msg, i) => (
        <MessageRow key={i} msg={msg} indent={isAgentTurn} />
      ))}
    </Box>
  )
})

interface VirtualMessageListProps {
  turns: CompletedTurn[]
  scrollRef: RefObject<ScrollBoxHandle | null>
  columns: number
  streamText: string
}

export function VirtualMessageList({
  turns,
  scrollRef,
  columns,
  streamText,
}: VirtualMessageListProps): React.JSX.Element {
  const keysRef = useRef<string[]>([])
  const prevTurnsRef = useRef<typeof turns>(turns)

  if (
    turns.length < keysRef.current.length ||
    (turns.length > 0 && keysRef.current.length > 0 && turns[0] !== prevTurnsRef.current[0])
  ) {
    keysRef.current = turns.map((t, i) => turnKey(t, i))
  } else {
    for (let i = keysRef.current.length; i < turns.length; i++) {
      keysRef.current.push(turnKey(turns[i]!, i))
    }
  }
  prevTurnsRef.current = turns
  const keys = keysRef.current

  const {
    range,
    topSpacer,
    bottomSpacer,
    measureRef,
    spacerRef,
  } = useVirtualScroll(scrollRef, keys, columns)

  const [start, end] = range

  return (
    <>
      {/* Top spacer */}
      <Box ref={spacerRef} height={topSpacer} flexShrink={0} />

      {/* Visible items */}
      {turns.slice(start, end).map((turn, i) => {
        const idx = start + i
        const k = keys[idx]!
        const prevAgent = idx > 0 ? turns[idx - 1]!.agent : undefined
        return (
          <VirtualItem
            key={k}
            itemKey={k}
            turn={turn}
            prevAgent={prevAgent}
            isFirst={idx === 0}
            measureRef={measureRef}
          />
        )
      })}

      {/* Bottom spacer */}
      {bottomSpacer > 0 && <Box height={bottomSpacer} flexShrink={0} />}

      {/* Live streaming text */}
      {streamText ? <StreamingMarkdown text={streamText} /> : null}
    </>
  )
}
