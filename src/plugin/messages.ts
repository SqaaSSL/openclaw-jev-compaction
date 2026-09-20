import { removedCallsNote, truncatedResultText } from '../core/compact.js';
import type { Message, ToolResult, ToolUse } from '../core/types.js';
import type {
  AssistantMessage,
  ImageContent,
  MessageLike,
  TextContent,
  ToolCallContent,
  ToolResultMessage,
} from './contract.js';

export type StoredAction = 'drop_call' | 'drop_result';
export type ActionMap = Readonly<Record<string, StoredAction>>;

/** Token estimate charged for one image block, matching OpenClaw's own heuristic. */
const IMAGE_CHARS = 8_000;
const CHARS_PER_TOKEN = 4;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Plain text of a message content field; images and unknown blocks become short notes. */
export function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) {
    if (content === undefined || content === null) return '';
    try {
      return JSON.stringify(content);
    } catch {
      return '';
    }
  }
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block.type === 'image') parts.push('[image omitted]');
    else if (block.type === 'thinking') continue;
    else if (block.type === 'toolCall') continue;
    else if (typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n');
}

function toolCallsOf(message: MessageLike): ToolCallContent[] {
  if (message.role !== 'assistant' || !Array.isArray(message.content)) return [];
  return (message.content as unknown[]).filter(
    (block): block is ToolCallContent =>
      isRecord(block) && block.type === 'toolCall' && typeof block.id === 'string',
  );
}

function isToolResult<M extends MessageLike>(message: M): message is M & ToolResultMessage {
  return message.role === 'toolResult' && typeof (message as unknown as ToolResultMessage).toolCallId === 'string';
}

/**
 * One library `Message` per runtime message, same order and count, so decisions
 * made on the library shape map back by index. Tool results become `user`
 * messages carrying `toolResults`; roles the library does not know become
 * text-only `user` entries and are never candidates for removal.
 */
export function toLibraryMessages(messages: readonly MessageLike[]): Message[] {
  return messages.map((message): Message => {
    if (message.role === 'assistant') {
      const toolUses: ToolUse[] = toolCallsOf(message).map((call) => ({
        tool_use_id: call.id,
        tool: call.name,
        input: isRecord(call.arguments) ? call.arguments : {},
      }));
      return { role: 'assistant', text: contentText(message.content), toolUses };
    }
    if (isToolResult(message)) {
      const result: ToolResult = {
        tool_use_id: message.toolCallId,
        text: contentText(message.content),
        isError: message.isError === true,
      };
      return { role: 'user', text: '', toolUses: [], toolResults: [result] };
    }
    if (message.role === 'user') {
      return { role: 'user', text: contentText(message.content), toolUses: [] };
    }
    const text = contentText(message.content);
    return { role: 'user', text: text ? `[${message.role}] ${text}` : `[${message.role}]`, toolUses: [] };
  });
}

function hasVisibleText(blocks: readonly (TextContent | ImageContent | ToolCallContent | { type: string })[]): boolean {
  return blocks.some(
    (block) => block.type === 'text' && typeof (block as TextContent).text === 'string' && (block as TextContent).text.trim().length > 0,
  );
}

/**
 * Applies stored decisions to runtime messages. A dropped call disappears from
 * its assistant message together with its tool result; a dropped result keeps
 * the first `headChars` characters plus a note. Untouched messages are returned
 * as the same objects. An assistant message left without text or tool calls is
 * removed; a rebuilt assistant message loses its thinking blocks, since their
 * signatures were bound to the original content.
 */
export function applyActions<M extends MessageLike>(
  messages: readonly M[],
  actions: ActionMap,
  headChars: number,
): { messages: M[]; changed: boolean } {
  if (Object.keys(actions).length === 0) return { messages: [...messages], changed: false };
  const kept: M[] = [];
  let changed = false;
  for (const message of messages) {
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      const calls = toolCallsOf(message);
      if (!calls.some((call) => actions[call.id] === 'drop_call')) {
        kept.push(message);
        continue;
      }
      changed = true;
      const content = (message.content as AssistantMessage['content']).filter(
        (block) =>
          block.type !== 'thinking' &&
          !(block.type === 'toolCall' && actions[(block as ToolCallContent).id] === 'drop_call'),
      );
      if (!hasVisibleText(content) && !content.some((block) => block.type === 'toolCall')) continue;
      // the turn keeps its narration: say that its evidence was removed
      const removed = calls.length - content.filter((block) => block.type === 'toolCall').length;
      if (removed > 0) content.push({ type: 'text', text: removedCallsNote(removed) });
      kept.push({ ...message, content });
      continue;
    }
    if (isToolResult(message)) {
      const action = actions[message.toolCallId];
      if (action === 'drop_call') {
        changed = true;
        continue;
      }
      if (action === 'drop_result') {
        const original = contentText(message.content);
        const text = truncatedResultText(original, message.isError === true, headChars);
        if (text !== original || (Array.isArray(message.content) && message.content.length !== 1)) {
          changed = true;
          const rebuilt = { ...message, content: [{ type: 'text', text }] as TextContent[] };
          delete (rebuilt as { details?: unknown }).details;
          kept.push(rebuilt);
          continue;
        }
      }
      kept.push(message);
      continue;
    }
    kept.push(message);
  }
  return { messages: kept, changed };
}

function messageChars(message: MessageLike): number {
  if (isRecord(message) && message.excludeFromContext === true) return 0;
  let chars = 0;
  const content = message.content;
  if (typeof content === 'string') chars += content.length;
  else if (Array.isArray(content)) {
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block.type === 'text' && typeof block.text === 'string') chars += block.text.length;
      else if (block.type === 'thinking' && typeof block.thinking === 'string') chars += block.thinking.length;
      else if (block.type === 'image') chars += IMAGE_CHARS;
      else if (block.type === 'toolCall') {
        chars += typeof block.name === 'string' ? block.name.length : 0;
        try {
          chars += JSON.stringify(block.arguments ?? {}).length;
        } catch {
          chars += 20;
        }
      }
    }
  } else if (content !== undefined) {
    try {
      chars += JSON.stringify(content).length;
    } catch {
      chars += 0;
    }
  }
  if (isToolResult(message)) chars += message.toolName.length + 16;
  return chars;
}

/** A conservative characters-per-token estimate in the spirit of OpenClaw's own. */
export function estimateAgentTokens(messages: readonly MessageLike[]): number {
  let chars = 0;
  for (const message of messages) chars += messageChars(message);
  return Math.ceil(chars / CHARS_PER_TOKEN);
}
