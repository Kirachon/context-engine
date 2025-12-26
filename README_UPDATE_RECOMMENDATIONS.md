# README.md Update Recommendations

**Analysis Date**: 2025-12-26  
**Current Version**: 1.9.0  
**Analysis Status**: ⚠️ **NEEDS UPDATES**

## Executive Summary

The README.md file is **mostly accurate** but is **missing critical v1.9.0 features** added on 2025-12-26. The tool count needs correction (38 → 40), and new static analysis capabilities are not documented.

## Detailed Findings

### ✅ What's Correct

1. **Architecture Documentation** - Clean 5-layer architecture is well-documented
2. **Installation Instructions** - All setup steps are current and accurate
3. **CLI Options** - Command-line flags are up-to-date
4. **Configuration Examples** - MCP client configs are correct
5. **Planning Workflow** - v1.4.0+ planning features are well-documented
6. **Memory System** - v1.4.1 memory features are documented
7. **Reactive Optimizations** - v1.8.0 performance improvements are documented

### ❌ What's Missing or Incorrect

#### 1. Tool Count (Line 48)
**Current**: "MCP Tools (38 tools available)"  
**Should be**: "MCP Tools (40 tools available)"

**Reason**: v1.9.0 added 2 new tools:
- `check_invariants` (tool #39)
- `run_static_analysis` (tool #40)

#### 2. Missing v1.9.0 Tools Documentation

**New Tools Not Documented:**

**Tool #31: `review_diff`** (Enterprise Review)
- Deterministic diff-first preflight review
- Risk scoring (1-5) based on deterministic analysis
- Change classification (feature/bugfix/refactor/infra/docs)
- Hotspot detection for sensitive areas
- Optional static analysis integration
- Structured JSON output for CI/IDE

**Tool #39: `check_invariants`**
- Run YAML invariants deterministically against unified diff
- No LLM required (pure deterministic checking)
- Custom rules via `.review-invariants.yml`
- Suitable for CI/CD pipelines

**Tool #40: `run_static_analysis`**
- Run local static analyzers (TypeScript, Semgrep)
- TypeScript typecheck via `tsc --noEmit`
- Optional Semgrep integration (when installed)
- Structured findings output
- Configurable timeout and max findings

#### 3. Missing v1.9.0 Features in "Key Characteristics" Section

**Should Add (after line 135):**
```markdown
- ✅ **Static analysis integration**: Optional TypeScript and Semgrep analyzers for deterministic feedback (v1.9.0)
- ✅ **Invariants checking**: YAML-based custom rules for deterministic code review (v1.9.0)
- ✅ **Per-phase telemetry**: Detailed timing breakdowns for review pipeline optimization (v1.9.0)
```

#### 4. Test Count Outdated (Line 569)

**Current**: "**Test Status:** 379 tests passing (100% completion) ✅"  
**Should be**: "**Test Status:** 397 tests passing (100% completion) ✅"

**Reason**: Additional tests added in recent versions

#### 5. Missing Documentation Links

**Should Add (after line 5):**
```markdown
> 📚 **New here?** Check out [INDEX.md](INDEX.md) for a complete documentation guide!
> 
> 🚀 **Quick Start**: [QUICKSTART.md](QUICKSTART.md) → [GETTING_STARTED.md](GETTING_STARTED.md) → [API_REFERENCE.md](API_REFERENCE.md)
> 
> 🏗️ **Architecture**: [TECHNICAL_ARCHITECTURE.md](TECHNICAL_ARCHITECTURE.md) for deep technical dive
```

#### 6. Code Review Section Needs Expansion

**Current Section (Lines 102-104):**
```markdown
#### Code Review (2)
30. **`review_changes(diff, file_contexts?, options?)`** - AI-powered code review with structured output
31. **`review_git_diff(target?, base?, include_patterns?, options?)`** - Review code changes from git automatically
```

**Should be (Lines 102-113):**
```markdown
#### Code Review (5)
30. **`review_changes(diff, file_contexts?, options?)`** - AI-powered code review with structured output
31. **`review_git_diff(target?, base?, include_patterns?, options?)`** - Review code changes from git automatically
32. **`review_diff(diff, changed_files?, options?)`** - Enterprise review with risk scoring and static analysis
    - Risk scoring (1-5) based on deterministic preflight
    - Change classification (feature/bugfix/refactor/infra/docs)
    - Optional static analysis (TypeScript, Semgrep)
    - Per-phase timing telemetry
33. **`check_invariants(diff, changed_files?, invariants_path?)`** - Run YAML invariants deterministically (no LLM)
34. **`run_static_analysis(changed_files?, options?)`** - Run local static analyzers (tsc, semgrep)
```

#### 7. Missing v1.9.0 Section

**Should Add (after line 157):**
```markdown
## Static Analysis & Invariants (v1.9.0)

Version 1.9.0 introduces optional static analysis and deterministic invariants checking for enhanced code review capabilities.

### Static Analysis Features

| Analyzer | Description | Opt-in |
|----------|-------------|--------|
| **TypeScript** | Type checking via `tsc --noEmit` | Default |
| **Semgrep** | Pattern-based security/quality checks | Optional (requires installation) |

### Usage

#### Enable Static Analysis in review_diff

```javascript
review_diff({
  diff: "<unified diff>",
  changed_files: ["src/file.ts"],
  options: {
    enable_static_analysis: true,
    static_analyzers: ["tsc", "semgrep"],
    static_analysis_timeout_ms: 60000
  }
})
```

#### Run Static Analysis Standalone

```javascript
run_static_analysis({
  changed_files: ["src/file.ts"],
  options: {
    analyzers: ["tsc", "semgrep"],
    timeout_ms: 60000,
    max_findings_per_analyzer: 20
  }
})
```

#### Check Custom Invariants

```javascript
check_invariants({
  diff: "<unified diff>",
  changed_files: ["src/file.ts"],
  invariants_path: ".review-invariants.yml"
})
```

### Invariants Configuration

Create `.review-invariants.yml` in your workspace root:

```yaml
invariants:
  - id: no-console-log
    pattern: "console\\.log"
    message: "Remove console.log statements before committing"
    severity: MEDIUM
    
  - id: no-todo-comments
    pattern: "TODO|FIXME"
    message: "Resolve TODO/FIXME comments"
    severity: LOW
```

### Benefits

- ✅ **Deterministic**: No LLM required for invariants/static analysis
- ✅ **Fast**: Local execution, no API calls
- ✅ **CI-Friendly**: Structured JSON output
- ✅ **Customizable**: YAML-based rules, configurable analyzers
- ✅ **Opt-in**: Disabled by default, enable as needed
```

## Priority Recommendations

### 🔴 **High Priority** (Must Fix)

1. **Update tool count**: 38 → 40 (line 48)
2. **Add v1.9.0 tools**: Document `review_diff`, `check_invariants`, `run_static_analysis`
3. **Add v1.9.0 section**: Document static analysis and invariants features
4. **Update test count**: 379 → 397 (line 569)

### 🟡 **Medium Priority** (Should Fix)

5. **Add documentation links**: Link to new docs (GETTING_STARTED.md, API_REFERENCE.md, etc.)
6. **Update Key Characteristics**: Add v1.9.0 features to the list

### 🟢 **Low Priority** (Nice to Have)

7. **Add version badge**: Show current version (1.9.0) prominently
8. **Add changelog link**: Link to CHANGELOG.md for version history

## Verification Checklist

After updates, verify:

- [ ] Tool count is 40 (not 38)
- [ ] All 40 tools are documented with descriptions
- [ ] v1.9.0 features are documented (static analysis, invariants)
- [ ] Test count is 397 (not 379)
- [ ] Links to new documentation files work
- [ ] Code examples for new tools are provided
- [ ] Configuration examples for static analysis are included

## Files to Reference

When making updates, reference these files for accuracy:

1. **src/mcp/server.ts** (lines 227-262) - Tool registration
2. **src/mcp/tools/manifest.ts** - Tool manifest and feature list
3. **CHANGELOG.md** (lines 1-22) - v1.9.0 changes
4. **src/mcp/tools/reviewDiff.ts** - review_diff tool implementation
5. **src/mcp/tools/checkInvariants.ts** - check_invariants tool
6. **src/mcp/tools/staticAnalysis.ts** - run_static_analysis tool
7. **API_REFERENCE.md** - Complete API documentation for all tools

## Conclusion

The README.md is **mostly accurate** but needs updates to reflect v1.9.0 changes. The most critical updates are:

1. Tool count correction (38 → 40)
2. Documentation of 3 new tools
3. Static analysis features section
4. Test count update (379 → 397)

**Estimated Update Time**: 30-45 minutes  
**Impact**: High - Users need to know about new v1.9.0 capabilities  
**Risk**: Low - Additive changes only, no breaking changes

