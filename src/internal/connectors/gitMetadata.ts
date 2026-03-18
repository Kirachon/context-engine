import { createHash } from 'crypto';
import { execGitCommand, getGitStatus } from '../../mcp/utils/gitUtils.js';
import type { ConnectorSignal, ContextConnector } from './types.js';

function parseChangedFiles(statusOutput: string): string[] {
  return statusOutput
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => line.length >= 3 ? line.slice(3).trim() : '')
    .filter(Boolean)
    .slice(0, 5);
}

function buildFingerprint(branch: string, statusOutput: string): string {
  return createHash('sha1')
    .update(`${branch}\n${statusOutput}`)
    .digest('hex')
    .slice(0, 12);
}

export function createGitMetadataConnector(): ContextConnector {
  return {
    id: 'git_metadata',
    label: 'Git metadata',
    async collect(workspacePath: string): Promise<ConnectorSignal | null> {
      const status = await getGitStatus(workspacePath);
      if (!status.is_git_repo) {
        return null;
      }

      const statusResult = await execGitCommand(['status', '--porcelain'], workspacePath);
      const changedFiles = parseChangedFiles(statusResult.stdout);
      const branch = status.current_branch?.trim() || 'detached';
      const fingerprint = `git:${branch}:${buildFingerprint(branch, statusResult.stdout)}`;
      const summary = status.has_changes
        ? `branch=${branch}; ${changedFiles.length} changed file(s); ${status.has_staged ? 'staged changes present' : 'no staged changes'}`
        : `branch=${branch}; clean working tree`;

      return {
        id: 'git_metadata',
        label: 'Git metadata',
        status: 'available',
        fingerprint,
        summary,
        details: [
          `current_branch=${branch}`,
          `has_changes=${status.has_changes}`,
          `has_staged=${status.has_staged}`,
          ...(changedFiles.length > 0 ? [`changed_files=${changedFiles.join(', ')}`] : []),
        ],
      };
    },
  };
}
