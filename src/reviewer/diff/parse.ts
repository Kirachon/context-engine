import type { DiffHunk, DiffLine, ParsedDiff, ParsedDiffFile } from '../../mcp/types/codeReview.js';

/**
 * Parse a unified diff into the ParsedDiff structure used by the existing code review system.
 *
 * Intentionally matches the legacy behavior of CodeReviewService.parseDiff() so we can reuse
 * parsing across multiple reviewers without changing outputs.
 */
export function parseUnifiedDiff(diffContent: string): ParsedDiff {
  const files: ParsedDiffFile[] = [];
  let totalAdded = 0;
  let totalRemoved = 0;

  // Split by file headers
  const fileRegex = /^diff --git a\/(.+?) b\/(.+?)$/gm;
  const matches = [...diffContent.matchAll(fileRegex)];

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const oldPath = match[1];
    const newPath = match[2];
    const startIdx = match.index ?? 0;
    const endIdx = matches[i + 1]?.index ?? diffContent.length;
    const fileSection = diffContent.slice(startIdx, endIdx);

    const file = parseFileSection(fileSection, oldPath, newPath);
    files.push(file);
    totalAdded += file.hunks.reduce((sum, h) => sum + h.lines.filter(l => l.type === 'add').length, 0);
    totalRemoved += file.hunks.reduce((sum, h) => sum + h.lines.filter(l => l.type === 'remove').length, 0);
  }

  return {
    files,
    lines_added: totalAdded,
    lines_removed: totalRemoved,
  };
}

function parseFileSection(section: string, oldPath: string, newPath: string): ParsedDiffFile {
  const isNew = section.includes('new file mode');
  const isDeleted = section.includes('deleted file mode');
  const isBinary = section.includes('Binary files');

  const hunks: DiffHunk[] = [];
  const changedLines = new Set<number>();

  // Parse hunks
  const hunkRegex = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm;
  const hunkMatches = [...section.matchAll(hunkRegex)];

  for (let i = 0; i < hunkMatches.length; i++) {
    const hunkMatch = hunkMatches[i];
    const hunkStart = hunkMatch.index ?? 0;
    const hunkEnd = hunkMatches[i + 1]?.index ?? section.length;
    const hunkContent = section.slice(hunkStart, hunkEnd);

    const oldStart = parseInt(hunkMatch[1], 10);
    const oldLines = parseInt(hunkMatch[2] || '1', 10);
    const newStart = parseInt(hunkMatch[3], 10);
    const newLines = parseInt(hunkMatch[4] || '1', 10);

    const lines = parseHunkLines(hunkContent, oldStart, newStart, changedLines);

    hunks.push({
      old_start: oldStart,
      old_lines: oldLines,
      new_start: newStart,
      new_lines: newLines,
      lines,
    });
  }

  return {
    old_path: oldPath,
    new_path: newPath,
    is_new: isNew,
    is_deleted: isDeleted,
    is_binary: isBinary,
    hunks,
    changed_lines: changedLines,
  };
}

function parseHunkLines(
  hunkContent: string,
  oldStart: number,
  newStart: number,
  changedLines: Set<number>
): DiffLine[] {
  const lines: DiffLine[] = [];
  const contentLines = hunkContent.split('\n').slice(1); // Skip the @@ header

  let newLineNum = newStart;
  let oldLineNum = oldStart; // Properly track old file line numbers

  for (const line of contentLines) {
    if (line.startsWith('+')) {
      lines.push({
        type: 'add',
        content: line.slice(1),
        new_line_number: newLineNum,
      });
      changedLines.add(newLineNum);
      newLineNum++;
    } else if (line.startsWith('-')) {
      lines.push({
        type: 'remove',
        content: line.slice(1),
        old_line_number: oldLineNum,
      });
      oldLineNum++;
    } else if (line.startsWith(' ') || line === '') {
      lines.push({
        type: 'context',
        content: line.slice(1) || '',
        old_line_number: oldLineNum,
        new_line_number: newLineNum,
      });
      oldLineNum++;
      newLineNum++;
    }
  }

  return lines;
}

