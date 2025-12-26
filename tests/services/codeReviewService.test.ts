/**
 * Unit tests for CodeReviewService
 *
 * Tests the Layer 2 - Service Layer for code review.
 * Focus on diff parsing and filtering which are pure functions.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { CodeReviewService } from '../../src/mcp/services/codeReviewService.js';
import type { ReviewFinding, ParsedDiff, ReviewCategory, ReviewPriority } from '../../src/mcp/types/codeReview.js';

describe('CodeReviewService', () => {
  let codeReviewService: CodeReviewService;
  let mockServiceClient: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockServiceClient = {
      searchAndAsk: jest.fn(),
      getContextForPrompt: jest.fn(),
    };
    codeReviewService = new CodeReviewService(mockServiceClient);
  });

  // ============================================================================
  // Sample Diffs for Testing
  // ============================================================================

  const SIMPLE_DIFF = `diff --git a/src/example.ts b/src/example.ts
index 1234567..abcdefg 100644
--- a/src/example.ts
+++ b/src/example.ts
@@ -1,5 +1,6 @@
 function hello() {
-  console.log('Hello');
+  console.log('Hello, World!');
+  return true;
 }
 
 export { hello };`;

  const MULTI_FILE_DIFF = `diff --git a/src/file1.ts b/src/file1.ts
index 1234567..abcdefg 100644
--- a/src/file1.ts
+++ b/src/file1.ts
@@ -1,3 +1,4 @@
 const a = 1;
+const b = 2;
 export { a };
diff --git a/src/file2.ts b/src/file2.ts
index 1234567..abcdefg 100644
--- a/src/file2.ts
+++ b/src/file2.ts
@@ -5,4 +5,3 @@
 function test() {
-  return 'old';
   return 'new';
 }`;

  const NEW_FILE_DIFF = `diff --git a/src/newFile.ts b/src/newFile.ts
new file mode 100644
index 0000000..abcdefg
--- /dev/null
+++ b/src/newFile.ts
@@ -0,0 +1,5 @@
+export function newFunction() {
+  console.log('New file!');
+  return 42;
+}
+`;

  const DELETED_FILE_DIFF = `diff --git a/src/oldFile.ts b/src/oldFile.ts
deleted file mode 100644
index 1234567..0000000
--- a/src/oldFile.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-function oldFunction() {
-  return 'deprecated';
-}`;

  const BINARY_FILE_DIFF = `diff --git a/assets/image.png b/assets/image.png
new file mode 100644
index 0000000..abcdefg
Binary files /dev/null and b/assets/image.png differ`;

  // ============================================================================
  // parseDiff Tests
  // ============================================================================

  describe('parseDiff', () => {
    describe('Simple Diff', () => {
      it('should parse a simple single-file diff', () => {
        const result = codeReviewService.parseDiff(SIMPLE_DIFF);

        expect(result.files).toHaveLength(1);
        expect(result.files[0].old_path).toBe('src/example.ts');
        expect(result.files[0].new_path).toBe('src/example.ts');
        expect(result.files[0].is_new).toBe(false);
        expect(result.files[0].is_deleted).toBe(false);
        expect(result.files[0].is_binary).toBe(false);
      });

      it('should count added and removed lines correctly', () => {
        const result = codeReviewService.parseDiff(SIMPLE_DIFF);

        // 2 lines added (+console.log and +return true)
        // 1 line removed (-console.log)
        expect(result.lines_added).toBe(2);
        expect(result.lines_removed).toBe(1);
      });

      it('should track changed line numbers', () => {
        const result = codeReviewService.parseDiff(SIMPLE_DIFF);

        // Line 2 and 3 should be marked as changed (added lines)
        expect(result.files[0].changed_lines.has(2)).toBe(true);
        expect(result.files[0].changed_lines.has(3)).toBe(true);
      });
    });

    describe('Multi-File Diff', () => {
      it('should parse multiple files correctly', () => {
        const result = codeReviewService.parseDiff(MULTI_FILE_DIFF);

        expect(result.files).toHaveLength(2);
        expect(result.files[0].new_path).toBe('src/file1.ts');
        expect(result.files[1].new_path).toBe('src/file2.ts');
      });

      it('should aggregate line counts across files', () => {
        const result = codeReviewService.parseDiff(MULTI_FILE_DIFF);

        // file1: +1 added, file2: +0 added (return 'new' is context), -1 removed
        expect(result.lines_added).toBe(1);
        expect(result.lines_removed).toBe(1);
      });
    });

    describe('New File Diff', () => {
      it('should detect new file', () => {
        const result = codeReviewService.parseDiff(NEW_FILE_DIFF);

        expect(result.files).toHaveLength(1);
        expect(result.files[0].is_new).toBe(true);
        expect(result.files[0].is_deleted).toBe(false);
      });

      it('should count all lines as added for new file', () => {
        const result = codeReviewService.parseDiff(NEW_FILE_DIFF);

        // 5 lines: 4 code lines + 1 empty line at end (from trailing +)
        expect(result.lines_added).toBe(5);
        expect(result.lines_removed).toBe(0);
      });
    });

    describe('Deleted File Diff', () => {
      it('should detect deleted file', () => {
        const result = codeReviewService.parseDiff(DELETED_FILE_DIFF);

        expect(result.files).toHaveLength(1);
        expect(result.files[0].is_new).toBe(false);
        expect(result.files[0].is_deleted).toBe(true);
      });

      it('should count all lines as removed for deleted file', () => {
        const result = codeReviewService.parseDiff(DELETED_FILE_DIFF);

        expect(result.lines_added).toBe(0);
        expect(result.lines_removed).toBe(3);
      });
    });

    describe('Binary File Diff', () => {
      it('should detect binary file', () => {
        const result = codeReviewService.parseDiff(BINARY_FILE_DIFF);

        expect(result.files).toHaveLength(1);
        expect(result.files[0].is_binary).toBe(true);
      });

      it('should have zero line counts for binary file', () => {
        const result = codeReviewService.parseDiff(BINARY_FILE_DIFF);

        expect(result.files[0].hunks).toHaveLength(0);
        expect(result.lines_added).toBe(0);
        expect(result.lines_removed).toBe(0);
      });
    });

    describe('Edge Cases', () => {
      it('should handle empty diff string', () => {
        const result = codeReviewService.parseDiff('');

        expect(result.files).toHaveLength(0);
        expect(result.lines_added).toBe(0);
        expect(result.lines_removed).toBe(0);
      });

      it('should handle diff with only context lines', () => {
        const contextOnlyDiff = `diff --git a/src/file.ts b/src/file.ts
index 1234567..abcdefg 100644
--- a/src/file.ts
+++ b/src/file.ts
@@ -1,3 +1,3 @@
 const a = 1;
 const b = 2;
 const c = 3;`;

        const result = codeReviewService.parseDiff(contextOnlyDiff);

        expect(result.files).toHaveLength(1);
        expect(result.lines_added).toBe(0);
        expect(result.lines_removed).toBe(0);
      });

      it('should handle malformed diff gracefully', () => {
        const malformedDiff = 'This is not a valid diff format';

        const result = codeReviewService.parseDiff(malformedDiff);

        expect(result.files).toHaveLength(0);
      });
    });

    describe('Hunk Parsing', () => {
      it('should parse hunk header correctly', () => {
        const result = codeReviewService.parseDiff(SIMPLE_DIFF);

        const hunk = result.files[0].hunks[0];
        expect(hunk.old_start).toBe(1);
        expect(hunk.old_lines).toBe(5);
        expect(hunk.new_start).toBe(1);
        expect(hunk.new_lines).toBe(6);
      });

      it('should parse multiple hunks in a single file', () => {
        const multiHunkDiff = `diff --git a/src/file.ts b/src/file.ts
index 1234567..abcdefg 100644
--- a/src/file.ts
+++ b/src/file.ts
@@ -1,3 +1,4 @@
 const a = 1;
+const b = 2;
 const c = 3;
@@ -10,3 +11,4 @@
 function test() {
+  console.log('test');
   return true;
 }`;

        const result = codeReviewService.parseDiff(multiHunkDiff);

        expect(result.files[0].hunks).toHaveLength(2);
        expect(result.files[0].hunks[0].new_start).toBe(1);
        expect(result.files[0].hunks[1].new_start).toBe(11);
      });

      it('should identify line types correctly', () => {
        const result = codeReviewService.parseDiff(SIMPLE_DIFF);

        const lines = result.files[0].hunks[0].lines;

        // First line is context
        expect(lines[0].type).toBe('context');
        expect(lines[0].content).toBe('function hello() {');

        // Find the removed line
        const removedLine = lines.find(l => l.type === 'remove');
        expect(removedLine).toBeDefined();
        expect(removedLine!.content).toContain('Hello');

        // Find added lines
        const addedLines = lines.filter(l => l.type === 'add');
        expect(addedLines.length).toBe(2);
      });
    });
  });

  // ============================================================================
  // filterExcludedFiles Tests
  // ============================================================================

  describe('filterExcludedFiles', () => {
    // Helper to create a minimal ParsedDiff
    function createParsedDiff(filePaths: string[]): ParsedDiff {
      return {
        files: filePaths.map(path => ({
          old_path: path,
          new_path: path,
          is_new: false,
          is_deleted: false,
          is_binary: false,
          hunks: [{
            old_start: 1,
            old_lines: 1,
            new_start: 1,
            new_lines: 2,
            lines: [
              { line_number: 1, type: 'context' as const, content: 'const a = 1;' },
              { line_number: 2, type: 'add' as const, content: 'const b = 2;' },
            ],
          }],
          changed_lines: new Set([2]),
        })),
        lines_added: filePaths.length,
        lines_removed: 0,
      };
    }

    it('should return unchanged diff when no exclude patterns', () => {
      const diff = createParsedDiff(['src/file1.ts', 'src/file2.ts']);
      const result = codeReviewService.filterExcludedFiles(diff, []);

      expect(result.files).toHaveLength(2);
    });

    it('should filter files matching exact pattern', () => {
      const diff = createParsedDiff(['src/file1.ts', 'src/file2.ts', 'test/test.ts']);
      const result = codeReviewService.filterExcludedFiles(diff, ['test/test.ts']);

      expect(result.files).toHaveLength(2);
      expect(result.files.map(f => f.new_path)).not.toContain('test/test.ts');
    });

    it('should filter files matching glob pattern', () => {
      const diff = createParsedDiff([
        'src/file1.ts',
        'test/file1.test.ts',
        'test/file2.test.ts',
      ]);
      const result = codeReviewService.filterExcludedFiles(diff, ['test/*']);

      expect(result.files).toHaveLength(1);
      expect(result.files[0].new_path).toBe('src/file1.ts');
    });

    it('should filter files matching multiple patterns', () => {
      const diff = createParsedDiff([
        'src/file.ts',
        'test/test.ts',
        'docs/readme.md',
      ]);
      const result = codeReviewService.filterExcludedFiles(diff, ['test/*', 'docs/*']);

      expect(result.files).toHaveLength(1);
      expect(result.files[0].new_path).toBe('src/file.ts');
    });

    it('should recalculate line counts after filtering', () => {
      const diff = createParsedDiff(['src/file1.ts', 'test/test.ts']);
      const result = codeReviewService.filterExcludedFiles(diff, ['test/*']);

      expect(result.files).toHaveLength(1);
      expect(result.lines_added).toBe(1);
    });
  });

  // ============================================================================
  // filterFindings Tests
  // ============================================================================

  describe('filterFindings', () => {
    // Helper to create a minimal finding
    function createFinding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
      return {
        id: 'finding-1',
        title: 'Test Finding',
        body: 'Description of the finding',
        category: 'correctness' as ReviewCategory,
        priority: 2 as ReviewPriority,
        confidence_score: 0.8,
        code_location: {
          file_path: 'src/file.ts',
          line_range: { start: 10, end: 10 },
        },
        is_on_changed_line: true,
        suggestion: { description: 'Fix suggestion', can_auto_fix: false },
        ...overrides,
      };
    }

    // Helper to create default options
    function createOptions(overrides: Partial<Required<import('../../src/mcp/types/codeReview.js').ReviewOptions>> = {}): Required<import('../../src/mcp/types/codeReview.js').ReviewOptions> {
      return {
        confidence_threshold: 0.7,
        max_findings: 20,
        categories: ['correctness', 'security', 'performance', 'maintainability', 'style', 'documentation'],
        changed_lines_only: false,
        custom_instructions: '',
        exclude_patterns: [],
        ...overrides,
      };
    }

    // Minimal parsed diff for tests
    const emptyDiff: ParsedDiff = {
      files: [],
      lines_added: 0,
      lines_removed: 0,
    };

    const diffWithChangedLines: ParsedDiff = {
      files: [
        {
          old_path: 'src/file.ts',
          new_path: 'src/file.ts',
          is_new: false,
          is_deleted: false,
          is_binary: false,
          hunks: [],
          changed_lines: new Set([10]),
        },
      ],
      lines_added: 1,
      lines_removed: 0,
    };

    describe('Confidence Threshold Filtering', () => {
      it('should include findings above confidence threshold', () => {
        const findings = [
          createFinding({ id: 'f1', confidence_score: 0.9 }),
          createFinding({ id: 'f2', confidence_score: 0.8 }),
          createFinding({ id: 'f3', confidence_score: 0.7 }),
        ];
        const opts = createOptions({ confidence_threshold: 0.7 });

        const result = codeReviewService.filterFindings(findings, emptyDiff, opts);

        expect(result).toHaveLength(3);
      });

      it('should exclude findings below confidence threshold', () => {
        const findings = [
          createFinding({ id: 'f1', confidence_score: 0.9 }),
          createFinding({ id: 'f2', confidence_score: 0.5 }),
          createFinding({ id: 'f3', confidence_score: 0.3 }),
        ];
        const opts = createOptions({ confidence_threshold: 0.7 });

        const result = codeReviewService.filterFindings(findings, emptyDiff, opts);

        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('f1');
      });

      it('should handle high confidence threshold', () => {
        const findings = [
          createFinding({ id: 'f1', confidence_score: 0.95 }),
          createFinding({ id: 'f2', confidence_score: 0.85 }),
        ];
        const opts = createOptions({ confidence_threshold: 0.9 });

        const result = codeReviewService.filterFindings(findings, emptyDiff, opts);

        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('f1');
      });
    });

    describe('Priority Sorting', () => {
      it('should sort findings by priority (lower is higher priority)', () => {
        const findings = [
          createFinding({ id: 'f1', priority: 2 }),
          createFinding({ id: 'f2', priority: 0 }),
          createFinding({ id: 'f3', priority: 1 }),
        ];
        const opts = createOptions();

        const result = codeReviewService.filterFindings(findings, emptyDiff, opts);

        expect(result.map(f => f.id)).toEqual(['f2', 'f3', 'f1']);
      });
    });

    describe('Changed Lines Only Filtering', () => {
      it('should include all findings when changed_lines_only is false', () => {
        const findings = [
          createFinding({ id: 'f1', is_on_changed_line: false }),
          createFinding({ id: 'f2', is_on_changed_line: true }),
        ];
        const opts = createOptions({ changed_lines_only: false });

        const result = codeReviewService.filterFindings(findings, emptyDiff, opts);

        expect(result).toHaveLength(2);
      });

      it('should filter out findings not on changed lines when enabled', () => {
        const findings = [
          createFinding({ id: 'f1', is_on_changed_line: false }),
          createFinding({ id: 'f2', is_on_changed_line: true }),
        ];
        const opts = createOptions({ changed_lines_only: true });

        const result = codeReviewService.filterFindings(findings, emptyDiff, opts);

        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('f2');
      });

      it('should always include P0 findings even if not on changed lines', () => {
        const findings = [
          createFinding({ id: 'f1', priority: 0, is_on_changed_line: false }),
          createFinding({ id: 'f2', priority: 2, is_on_changed_line: false }),
        ];
        const opts = createOptions({ changed_lines_only: true });

        const result = codeReviewService.filterFindings(findings, emptyDiff, opts);

        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('f1');
        expect(result[0].priority).toBe(0);
      });

      it('should backfill is_on_changed_line when missing and location is on a changed line', () => {
        const findings = [
          createFinding({
            id: 'f1',
            is_on_changed_line: undefined as any,
            code_location: { file_path: 'src/file.ts', line_range: { start: 10, end: 10 } },
          }),
        ];
        const opts = createOptions({ changed_lines_only: true });

        const result = codeReviewService.filterFindings(findings, diffWithChangedLines, opts);

        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('f1');
        expect(result[0].is_on_changed_line).toBe(true);
      });

      it('should backfill is_on_changed_line when missing and exclude when not on a changed line', () => {
        const findings = [
          createFinding({
            id: 'f1',
            is_on_changed_line: undefined as any,
            code_location: { file_path: 'src/file.ts', line_range: { start: 11, end: 11 } },
          }),
        ];
        const opts = createOptions({ changed_lines_only: true });

        const result = codeReviewService.filterFindings(findings, diffWithChangedLines, opts);

        expect(result).toHaveLength(0);
      });
    });

    describe('Category Filtering', () => {
      it('should filter by specified categories', () => {
        const findings = [
          createFinding({ id: 'f1', category: 'correctness' }),
          createFinding({ id: 'f2', category: 'security' }),
          createFinding({ id: 'f3', category: 'style' }),
        ];
        const opts = createOptions({ categories: ['correctness', 'security'] });

        const result = codeReviewService.filterFindings(findings, emptyDiff, opts);

        expect(result).toHaveLength(2);
        expect(result.map(f => f.category)).toEqual(['correctness', 'security']);
      });
    });

    describe('Max Findings Limit', () => {
      it('should limit findings to max_findings', () => {
        const findings = Array.from({ length: 10 }, (_, i) =>
          createFinding({ id: `f${i}`, priority: (i % 4) as ReviewPriority })
        );
        const opts = createOptions({ max_findings: 5 });

        const result = codeReviewService.filterFindings(findings, emptyDiff, opts);

        expect(result).toHaveLength(5);
      });

      it('should prioritize higher priority findings when limiting', () => {
        const findings = [
          createFinding({ id: 'f1', priority: 3 }),
          createFinding({ id: 'f2', priority: 0 }),
          createFinding({ id: 'f3', priority: 1 }),
          createFinding({ id: 'f4', priority: 2 }),
        ];
        const opts = createOptions({ max_findings: 2 });

        const result = codeReviewService.filterFindings(findings, emptyDiff, opts);

        expect(result).toHaveLength(2);
        expect(result.map(f => f.id)).toEqual(['f2', 'f3']);
      });
    });
  });
});
