/** Typed final-wire guard for multimodal provider requests.
 *
 * The body contains several kinds of objects whose `type` field is not a
 * content block (`cache_control`, thinking configuration, tool schemas, and
 * provider metadata). The validator therefore carries explicit structural
 * context instead of treating every nested `type` as model content.
 *
 * Tool inputs/arguments/JSON schemas remain opaque. A path-shaped value in a
 * tool argument is an execution contract, not a historical media part.
 */

export type WireProvider = 'anthropic' | 'openai' | 'responses' | 'gemini';

type WalkContext = 'generic' | 'content-block' | 'responses-item' | 'tool-output';

const FORBIDDEN_HISTORY_TAGS = new Set(['image_file', 'text_file', 'audio_file', 'video_file']);
const ALLOWED_CONTENT_TYPES: Record<WireProvider, ReadonlySet<string>> = {
  anthropic: new Set(['text', 'image', 'document', 'tool_use', 'tool_result', 'thinking', 'redacted_thinking', 'server_tool_use']),
  openai: new Set(['text', 'image_url', 'file', 'input_audio']),
  responses: new Set(['input_text', 'input_image', 'input_file', 'output_text']),
  gemini: new Set(['text', 'inlineData', 'functionCall', 'functionResponse']),
};

// Responses allows these item types directly in `input`, in addition to the
// usual message/function-call items. They are checked separately from nested
// message content because `input` is an item envelope, not a content array.
const RESPONSES_ITEM_TYPES = new Set([
  'message',
  'function_call',
  'function_call_output',
  'input_text',
  'input_image',
  'input_file',
  'output_text',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isOpaqueKey(key: string): boolean {
  return key === 'input' || key === 'arguments' || key === 'args' || key === 'parameters' || key === 'input_schema';
}

function looksLikeHostPath(value: unknown): boolean {
  return typeof value === 'string' && (
    value.startsWith('/') ||
    value.startsWith('~/') ||
    /^file:\/\//i.test(value) ||
    /^[a-z]:[\\/]/i.test(value)
  );
}

function validateContentBlock(
  value: Record<string, unknown>,
  provider: WireProvider,
  path: string,
  errors: string[],
): void {
  if (provider === 'gemini') {
    const geminiKeys = ['text', 'inlineData', 'functionCall', 'functionResponse'];
    const present = geminiKeys.filter((key) => Object.prototype.hasOwnProperty.call(value, key));
    if (present.length !== 1) {
      errors.push(`${path}: Gemini part must contain exactly one allowlisted part key`);
    }
    if (typeof value.type === 'string') {
      if (FORBIDDEN_HISTORY_TAGS.has(value.type) || value.type === 'image' || value.type === 'file' || value.type === 'document') {
        errors.push(`${path}: neutral/history type ${value.type} leaked to Gemini wire`);
      }
    }
    if (Object.prototype.hasOwnProperty.call(value, 'path')) {
      errors.push(`${path}: host path leaked to provider wire`);
    }
    return;
  }
  if (typeof value.type !== 'string') {
    errors.push(`${path}: content block has no type`);
    return;
  }
  if (FORBIDDEN_HISTORY_TAGS.has(value.type)) {
    errors.push(`${path}: forbidden history tag ${value.type}`);
  }
  // OpenAI Chat's final wire legitimately uses `{type:'file',file:{...}}`.
  // A neutral history file is distinguishable because it still carries the
  // canonical top-level data/mimeType pair.
  if (value.type === 'file' && ('data' in value || 'mimeType' in value)) {
    errors.push(`${path}: neutral file data/mimeType leaked to wire`);
  }
  if (value.type === 'image' && ('data' in value || 'mimeType' in value)) {
    errors.push(`${path}: neutral image data/mimeType leaked to wire`);
  }
  if (!ALLOWED_CONTENT_TYPES[provider].has(value.type)) {
    errors.push(`${path}: ${provider} content type ${value.type} is not allowlisted`);
  }
  if (Object.prototype.hasOwnProperty.call(value, 'path')) {
    errors.push(`${path}: host path leaked to provider wire`);
  }

  // Provider-native wrappers may legally carry a data URL, but never a host
  // path disguised as a URL/file_data/source field.
  if (value.type === 'image_url' && isRecord(value.image_url) && looksLikeHostPath(value.image_url.url)) {
    errors.push(`${path}: host image URL leaked to provider wire`);
  }
  if (value.type === 'input_file' && looksLikeHostPath(value.file_data)) {
    errors.push(`${path}: host file_data leaked to provider wire`);
  }
  if (value.type === 'file' && isRecord(value.file) && looksLikeHostPath(value.file.file_data)) {
    errors.push(`${path}: host file_data leaked to provider wire`);
  }
  if ((value.type === 'image' || value.type === 'document') && isRecord(value.source)) {
    if (looksLikeHostPath(value.source.path) || looksLikeHostPath(value.source.url)) {
      errors.push(`${path}: host source path leaked to provider wire`);
    }
  }
}

function validateResponsesItem(
  value: Record<string, unknown>,
  path: string,
  errors: string[],
): void {
  const type = typeof value.type === 'string' ? value.type : undefined;
  if (type && !RESPONSES_ITEM_TYPES.has(type)) {
    errors.push(`${path}: Responses input item type ${type} is not allowlisted`);
  }
  if (Object.prototype.hasOwnProperty.call(value, 'path')) {
    errors.push(`${path}: host path leaked to Responses input item`);
  }
  if ((type === 'input_image' || type === 'input_file') && ('data' in value || 'mimeType' in value)) {
    errors.push(`${path}: neutral media fields leaked to Responses input item`);
  }
  if (type === 'input_file' && looksLikeHostPath(value.file_data)) {
    errors.push(`${path}: host file_data leaked to Responses input item`);
  }
  if (type === 'input_image' && looksLikeHostPath(value.image_url)) {
    errors.push(`${path}: host image URL leaked to Responses input item`);
  }
}

function walk(value: unknown, provider: WireProvider, context: WalkContext, path: string, errors: string[]): void {
  if (context === 'tool-output') {
    if (typeof value === 'string') {
      if (value.length === 0) errors.push(`${path}: empty function_call_output.output`);
      return;
    }
    if (Array.isArray(value)) {
      if (value.length === 0) errors.push(`${path}: empty function_call_output.output`);
      value.forEach((item, index) => walk(item, provider, 'content-block', `${path}[${index}]`, errors));
      return;
    }
    if (isRecord(value)) {
      walk(value, provider, 'content-block', path, errors);
      return;
    }
    errors.push(`${path}: function_call_output.output must be non-empty text or output blocks`);
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, provider, context, `${path}[${index}]`, errors));
    return;
  }
  if (!isRecord(value)) return;

  if (context === 'content-block') validateContentBlock(value, provider, path, errors);
  else if (context === 'responses-item') validateResponsesItem(value, path, errors);

  for (const [key, child] of Object.entries(value)) {
    if (isOpaqueKey(key) && !(provider === 'responses' && path === '$' && key === 'input')) continue;
    const childPath = `${path}.${key}`;
    let childContext: WalkContext = 'generic';
    if (key === 'content' || key === 'parts') childContext = 'content-block';
    else if (key === 'output' && value.type === 'function_call_output') childContext = 'tool-output';
    else if (provider === 'responses' && path === '$' && key === 'input') childContext = 'responses-item';
    // A content block's metadata (`cache_control.type`, `source.type`, etc.)
    // is generic data. Only explicit content-bearing children restart block
    // validation; this keeps metadata/tool schemas out of the block allowlist.
    walk(child, provider, childContext, childPath, errors);
  }
}

export function assertProviderWireSafe(value: unknown, provider: WireProvider): void {
  const errors: string[] = [];
  walk(value, provider, 'generic', '$', errors);
  if (errors.length > 0) {
    throw new Error(`unsafe ${provider} provider wire: ${errors.slice(0, 3).join('; ')}`);
  }
}
