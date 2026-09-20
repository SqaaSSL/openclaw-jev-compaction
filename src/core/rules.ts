import type { CallRule, ToolCall } from './types.js';

/**
 * Tools whose results cannot be reproduced by running the tool again:
 * delegated work, questions to the user, messages sent. Claude Code and
 * OpenClaw names; replace with `protectTools` for other hosts.
 */
export const DEFAULT_PROTECTED_TOOLS: readonly string[] = [
  'Agent',
  'Task',
  'AskUserQuestion',
  'sessions_spawn',
  'sessions_send',
  'subagents',
  'message',
];

/** Tools that change files. Their calls stay so a kept read never shows a file as it no longer is. */
export const DEFAULT_EDIT_TOOLS: readonly string[] = [
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
  'edit',
  'write',
  'apply_patch',
];

const READ_TOOLS: ReadonlySet<string> = new Set(['Read', 'read']);
const PATH_KEYS = ['file_path', 'path', 'filePath', 'notebook_path'] as const;

/** The file a call is about, when its input names one. */
export function pathOf(input: Record<string, unknown>): string | undefined {
  for (const key of PATH_KEYS) {
    const value = input[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/**
 * Marks the calls that are kept without a Jev question: a failed call, a call
 * of a protected tool, an edit, and the newest read of a file that was edited
 * afterwards. Pinned calls are left alone; they are never candidates anyway.
 */
export function ruleCalls(
  calls: readonly ToolCall[],
  options: { protectTools: ReadonlySet<string>; editTools: ReadonlySet<string> },
): void {
  // the newest read of each file at the time of its last edit
  const newestRead = new Map<string, ToolCall>();
  const readBeforeLastEdit = new Map<string, ToolCall>();
  for (const call of calls) {
    const path = pathOf(call.input);
    if (!path || call.isError) continue;
    if (READ_TOOLS.has(call.tool)) newestRead.set(path, call);
    else if (options.editTools.has(call.tool)) {
      const read = newestRead.get(path);
      if (read) readBeforeLastEdit.set(path, read);
      else readBeforeLastEdit.delete(path);
    }
  }
  const beforeEdit = new Set(readBeforeLastEdit.values());
  for (const call of calls) {
    if (call.pinned) continue;
    let rule: CallRule | undefined;
    if (call.isError) rule = 'error';
    else if (options.protectTools.has(call.tool)) rule = 'protected_tool';
    else if (options.editTools.has(call.tool)) rule = 'edit';
    else if (beforeEdit.has(call)) rule = 'read_before_edit';
    if (rule) call.rule = rule;
  }
}
