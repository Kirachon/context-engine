# Release Notes - v1.5.0

**Release Date**: 2025-12-19

## Overview

Version 1.5.0 introduces **Phase 2: Safe Tool Consolidation** with a new internal architecture layer (Layer 2.5) that reduces code duplication while preserving all external MCP tool contracts. This release also adds comprehensive snapshot testing infrastructure and development tooling.

## What's New

### Layer 2.5: Internal Shared Handlers

A new architecture layer that provides shared internal logic for MCP tools without changing any external contracts.

#### New Internal Handlers (`src/internal/handlers/`)

1. **retrieval.ts** - Shared retrieval wrapper
   - Consistent timing and caching hooks
   - Used by `codebase_retrieval` and `semantic_search` tools

2. **context.ts** - Context assembly helpers
   - Shared context bundle creation
   - Snippet formatting utilities
   - Used by `get_context_for_prompt` tool

3. **enhancement.ts** - AI prompt enhancement
   - Extracted from `enhance.ts` (~100 lines consolidated)
   - Shared AI-powered prompt improvement logic
   - Used by `enhance_prompt` tool

4. **utilities.ts** - File and index helpers
   - Shared file operations
   - Index status formatting

5. **performance.ts** - Performance optimization hooks
   - Disabled-by-default caching
   - Batching support
   - Embedding reuse capabilities

6. **types.ts** - Shared type definitions

#### Advanced Retrieval Features (`src/internal/retrieval/`)

1. **retrieve.ts** - Core retrieval orchestration
2. **dedupe.ts** - Result deduplication
3. **expandQuery.ts** - Query expansion for better recall
4. **rerank.ts** - Result re-ranking for relevance
5. **types.ts** - Retrieval type definitions

### Snapshot Testing Infrastructure

Comprehensive regression testing system to ensure MCP tool outputs remain consistent.

#### Components

- **Snapshot Harness** (`tests/snapshots/snapshot-harness.ts`)
  - Byte-for-byte output verification
  - 22 baseline snapshots
  - Baseline creation and verification modes

- **Test Inputs** (`tests/snapshots/test-inputs.ts`)
  - Comprehensive test cases for core tools
  - Error validation scenarios
  - Tool manifest and visualization tests

- **Test Workspace** (`tests/snapshots/phase2/workspace/`)
  - Sample files for testing
  - Memory files for context testing

#### Usage

```bash
# Create/update baselines
npx --no-install tsx tests/snapshots/snapshot-harness.ts --update

# Verify outputs match baselines
npx --no-install tsx tests/snapshots/snapshot-harness.ts
```

### Development Tools

#### Tool Inventory Generator

New script to automatically document all MCP tools:

```bash
npx tsx scripts/extract-tool-inventory.ts
```

Generates `docs/PHASE2_TOOL_INVENTORY.md` with:
- All 28 tool names and handlers
- File locations
- Schema information
- Manifest inclusion status

## Code Consolidation

### Refactored Tools (No Output Changes)

Four MCP tools refactored to use internal handlers while preserving exact outputs:

1. **codebase_retrieval** - Uses `internalRetrieveCode()` and `internalIndexStatus()`
2. **semantic_search** - Uses `internalRetrieveCode()`
3. **get_context_for_prompt** - Uses `internalContextBundle()`
4. **enhance_prompt** - Uses `internalPromptEnhancer()` (~100 lines removed)

### Benefits

- **Reduced Duplication**: ~100 lines removed from enhance.ts alone
- **Improved Maintainability**: Shared logic in one place
- **Easier Testing**: Internal handlers can be tested independently
- **Future-Proof**: New tools can reuse existing handlers

## Configuration Updates

### TypeScript Configuration

- **New**: `tsconfig.test.json` for test-specific settings
  - ES2022 module system
  - Separate from production config

### Jest Configuration

- Uses `tsconfig.test.json` for test compilation
- Suppresses diagnostic warnings (codes 1343, 1378)

### Git Ignore

- Excludes `.augment-plans/` (runtime plan storage)
- Excludes `plan/` (personal planning notes)

## Documentation

### New Documents

1. **docs/PHASE2_SAFE_TOOL_CONSOLIDATION_PLAN.md** - Implementation strategy
2. **docs/PHASE2_TOOL_INVENTORY.md** - Complete tool inventory (28 tools)

### Updated Documents

1. **ARCHITECTURE.md** - Added Layer 2.5 documentation, updated tool count to 28
2. **README.md** - Updated test count to 213, added quieter test command
3. **TESTING.md** - Added snapshot testing documentation

## Test Coverage

- **Total Tests**: 213 (all passing) ✅
- **Increase**: +27 tests from v1.4.1 (186 tests)
- **Snapshot Baselines**: 22 regression test baselines

## Breaking Changes

**None.** This is a backward-compatible release.

All MCP tool schemas, names, descriptions, and outputs are preserved exactly.

## Migration Guide

No migration needed. All existing code continues to work.

## Upgrade Instructions

```bash
# Pull latest changes
git pull origin main

# Install dependencies
npm install

# Rebuild
npm run build

# Run tests to verify
npm test

# Optional: Run snapshot verification
npx --no-install tsx tests/snapshots/snapshot-harness.ts
```

## Known Issues

None.

## Future Roadmap

### v1.6.0 (Planned)
- Performance optimizations using Layer 2.5 hooks
- Enhanced caching strategies
- Batch processing capabilities
- Embedding reuse for faster retrieval

### v2.0.0 (Planned)
- Multi-workspace support
- Plan dependencies across projects
- Advanced visualization options
- Breaking changes to internal APIs (MCP contracts preserved)

## Contributors

- Kirachon (Lead Developer)

## Feedback

Please report issues or suggestions at:
- GitHub Issues: https://github.com/Kirachon/context-engine/issues
- Email: 149947919+Kirachon@users.noreply.github.com

## Acknowledgments

Thanks to the Augment Code team for the excellent Auggie SDK that powers this project.

---

For complete details, see:
- [CHANGELOG.md](CHANGELOG.md) - Full version history
- [ARCHITECTURE.md](ARCHITECTURE.md) - Technical architecture with Layer 2.5 documentation
- [docs/PHASE2_SAFE_TOOL_CONSOLIDATION_PLAN.md](docs/PHASE2_SAFE_TOOL_CONSOLIDATION_PLAN.md) - Phase 2 implementation details
- [docs/PHASE2_TOOL_INVENTORY.md](docs/PHASE2_TOOL_INVENTORY.md) - Complete tool inventory


