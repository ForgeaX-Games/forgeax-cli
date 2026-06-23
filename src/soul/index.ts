/** 数字生命引擎(R6)—— 编排层 public API。 */
export * from './types';
export {
  soulMemoryRoot,
  readLayeredMemory,
  readMemoryIndex,
  composeStableMemory,
  composeEpisodicRecall,
  composeReincarnationNotice,
  searchMemory,
  writeMemoryEntry,
  classifyAndWrite,
} from './layered-memory';
export { loadAgentRecord, findSoulPack, trustForSource } from './soul-pack-loader';
export { emitLifeEvent, onLifeEvent, recentLifeEvents } from './life-events';
