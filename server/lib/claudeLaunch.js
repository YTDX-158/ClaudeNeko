import { randomUUID } from 'node:crypto';
import { toClaudePermissionMode } from './permissionConfig.js';

const ASK_TOOLS = ['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'WebSearch'];

export function reserveClaudeSession({ session, update, newId = randomUUID, transcriptExists }) {
  if (!session?.id) throw new TypeError('session with id is required');
  if (typeof update !== 'function') throw new TypeError('update is required');
  if (typeof transcriptExists !== 'function') throw new TypeError('transcriptExists is required');

  let claudeSessionId = session.claudeSessionId;
  if (!claudeSessionId) {
    claudeSessionId = newId();
    update(session.id, { claudeSessionId });
  }

  return {
    claudeSessionId,
    isNewClaudeSession: !transcriptExists(claudeSessionId),
  };
}

export function buildClaudeArgs({
  claudeSessionId,
  isNewClaudeSession = false,
  model,
  permissionMode,
} = {}) {
  const args = [];
  if (claudeSessionId) {
    args.push(isNewClaudeSession ? '--session-id' : '--resume', claudeSessionId);
  }
  if (model) args.push('--model', model);
  if (permissionMode === 'ask' || permissionMode === 'smart') {
    args.push('--settings', JSON.stringify({ permissions: { ask: ASK_TOOLS } }));
  }
  if (permissionMode) {
    args.push('--permission-mode', toClaudePermissionMode(permissionMode));
  }
  return args;
}
