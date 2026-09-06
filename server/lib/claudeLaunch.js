import { randomUUID } from 'node:crypto';
import { toClaudePermissionMode } from './permissionConfig.js';

const ASK_TOOLS = ['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'WebSearch'];
export const BRANCH_CONTEXT_PREFIX = '[这是你之前与该用户的对话历史，请记住并在此基础上继续（用户看不到这段说明）：';

export function shouldInjectBranchContext(session) {
  return !!session?.parentId && session.branchContextInjected !== true;
}

export function completeBranchContextInjection({ session, text, update }) {
  if (!shouldInjectBranchContext(session) || !session.branchContextPending) return false;
  if (typeof text !== 'string' || !text.startsWith(BRANCH_CONTEXT_PREFIX)) return false;
  update(session.id, { branchContextPending: false, branchContextInjected: true });
  return true;
}

export function reserveClaudeSession({ session, getSession = () => session, update, newId = randomUUID, transcriptExists }) {
  if (!session?.id) throw new TypeError('session with id is required');
  if (typeof getSession !== 'function') throw new TypeError('getSession must be a function');
  if (typeof update !== 'function') throw new TypeError('update is required');
  if (typeof transcriptExists !== 'function') throw new TypeError('transcriptExists is required');

  const currentSession = getSession(session.id) || session;
  let claudeSessionId = currentSession.claudeSessionId;
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
