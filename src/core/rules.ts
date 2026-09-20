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

/** Tools that change files. Their calls stay: they are small and record what changed. */
export const DEFAULT_EDIT_TOOLS: readonly string[] = [
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
  'edit',
  'write',
  'apply_patch',
];

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
 * of a protected tool, and an edit. Edits are small and record what changed;
 * the read that preceded an edit is left to Jev, since it holds the file as it
 * no longer is and re-reading gives the current one. Pinned calls are left
 * alone; they are never candidates anyway.
 */
export function ruleCalls(
  calls: readonly ToolCall[],
  options: { protectTools: ReadonlySet<string>; editTools: ReadonlySet<string> },
): void {
  for (const call of calls) {
    if (call.pinned) continue;
    let rule: CallRule | undefined;
    if (call.isError) rule = 'error';
    else if (options.protectTools.has(call.tool)) rule = 'protected_tool';
    else if (options.editTools.has(call.tool)) rule = 'edit';
    if (rule) call.rule = rule;
  }
}
