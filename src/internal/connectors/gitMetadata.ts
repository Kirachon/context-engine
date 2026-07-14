import { createHash } from 'crypto';
import { execGitCommand, getGitStatus, parseGitPorcelainStatus } from '../../mcp/utils/gitUtils.js';
import type { ConnectorSignal, ContextConnector } from './types.js';

/** Maximum number of file names rendered in the human-readable summary/details. */
const MAX_DISPLAYED_CHANGED_FILES = 5;

interface ChangedFilesSummary {
  /** Exact total changed-file count; never reduced by display truncation. */
  total: number;
  /** Truncated list of file paths for human-readable display only. */
  displayed: string[];
}

function summarizeChangedFiles(statusOutput: string): ChangedFilesSummary {
  const entries = parseGitPorcelainStatus(statusOutput);
  const paths = entries.map((entry) => entry.path);
  return {
    total: paths.length,
    displayed: paths.slice(0, MAX_DISPLAYED_CHANGED_FILES),
  };
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
      const { total: totalChangedFiles, displayed: displayedChangedFiles } = summarizeChangedFiles(
        statusResult.stdout
      );
      const branch = status.current_branch?.trim() || 'detached';
      const fingerprint = `git:${branch}:${buildFingerprint(branch, statusResult.stdout)}`;
      const summary = status.has_changes
        ? `branch=${branch}; ${totalChangedFiles} changed file(s); ${status.has_staged ? 'staged changes present' : 'no staged changes'}`
        : `branch=${branch}; clean working tree`;
      const omittedCount = totalChangedFiles - displayedChangedFiles.length;
      const changedFilesDetail =
        displayedChangedFiles.length > 0
          ? `changed_files=${displayedChangedFiles.join(', ')}${omittedCount > 0 ? ` (+${omittedCount} more)` : ''}`
          : undefined;

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
          `total_changed_files=${totalChangedFiles}`,
          ...(changedFilesDetail ? [changedFilesDetail] : []),
        ],
      };
    },
  };
}
