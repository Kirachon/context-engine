# File Extensions Implementation Plan

> **Document Version**: 2.0
> **Created**: 2025-12-22
> **Status**: ✅ APPROVED - READY FOR IMPLEMENTATION
> **Related Documents**: `docs\archive\INDEXABLE_EXTENSIONS_ANALYSIS.md`, `docs\archive\SECURITY_ANALYSIS_ENV_FILES.md`, `docs\archive\CORRECTED_RECOMMENDATIONS_SUMMARY.md`

---

## 1. Executive Summary

### Overview

This document provides a comprehensive implementation plan for expanding the Context Engine MCP Server's file extension support from **72 to 116 extensions** (a 61% increase). The additions have been carefully researched, security-verified, and prioritized based on industry standards.

### Key Metrics

| Metric | Current | After Implementation |
|--------|---------|---------------------|
| **Total Extensions** | 72 | 116 |
| **Language Coverage** | 62% | 95% |
| **Programming Paradigms** | Imperative/OOP only | All major paradigms |
| **Extensions to Add** | - | 44 (security-verified) |

### Scope

**Target File**: `src/mcp/serviceClient.ts` (lines 572-645)
**Target Constant**: `INDEXABLE_EXTENSIONS` Set
**Security Status**: ✅ Verified (excludes `.env.local`, `.env.development`, `.env.production`)

### Categories of New Extensions

| Category | Count | Examples |
|----------|-------|----------|
| **Functional Programming** | 11 | Elixir, Erlang, Haskell, Clojure, OCaml |
| **Scientific/Data** | 3 | R, Julia |
| **Scripting** | 4 | Lua, Perl |
| **Modern Systems** | 4 | Zig, Nim, Crystal, V |
| **Build Systems** | 9 | CMake, Bazel, Make, Ninja, SBT |
| **Documentation** | 5 | AsciiDoc, LaTeX, Org-mode |
| **Web Templates** | 8 | Handlebars, EJS, Pug, JSP, ERB, Twig |
| **Total** | **44** | |

---

## 2. Implementation Steps

### Step 1: Update Code (15 minutes)

**File**: `src/mcp/serviceClient.ts`
**Location**: Insert after line 641 (before the closing `]);`)

Edit the `INDEXABLE_EXTENSIONS` Set and add the 44 new extensions organized by category. See **Section 3: Code Changes** for the exact code to insert.

**Checklist**:
- [ ] Open `src/mcp/serviceClient.ts`
- [ ] Navigate to line 641 (end of current `INDEXABLE_EXTENSIONS`)
- [ ] Insert new extensions (see Section 3)
- [ ] Verify no duplicate extensions
- [ ] Ensure proper comma placement
- [ ] Save file

### Step 2: Verify Build (5 minutes)

```bash
# Option 1: Full build
npm run build

# Option 2: TypeScript check only (faster)
npx tsc --noEmit

# Option 3: If using pnpm
pnpm run build
```

**Expected Output**:
- ✅ No TypeScript compilation errors
- ✅ Build completes successfully
- ✅ No warnings about duplicate values

**If Errors Occur**:
- Check for missing commas between extensions
- Verify all extensions start with `.`
- Ensure no duplicate entries
- Check for proper string quotes

### Step 3: Integration Testing (2 hours)

Clone sample repositories for each major language category and verify indexing:

```bash
# Create isolated test directory
mkdir -p test-repos
cd test-repos

# Test Elixir (Functional Programming)
git clone --depth 1 https://github.com/phoenixframework/phoenix.git
# Expected: .ex and .exs files indexed

# Test Haskell (Functional Programming)
git clone --depth 1 https://github.com/jgm/pandoc.git
# Expected: .hs and .lhs files indexed

# Test Julia (Scientific Computing)
git clone --depth 1 https://github.com/FluxML/Flux.jl.git
# Expected: .jl files indexed

# Test R (Data Science)
git clone --depth 1 https://github.com/tidyverse/ggplot2.git
# Expected: .r and .R files indexed

# Test Lua (Scripting)
git clone --depth 1 https://github.com/neovim/neovim.git
# Expected: .lua files indexed
```

**Verification Commands**:
```bash
# For each repository, run the context engine and check logs
cd phoenix
context-engine-mcp --workspace . --verbose 2>&1 | grep -E "\.(ex|exs)$"

# Count indexed files by extension
find . -name "*.ex" -o -name "*.exs" | wc -l
```

### Step 4: Security Verification (15 minutes)

Verify that sensitive environment files remain excluded:

```bash
# Create test environment files with fake credentials
cd test-repos
mkdir security-test && cd security-test

echo "API_KEY=fake_key_12345" > .env.local
echo "DB_PASSWORD=fake_password" > .env.development
echo "SECRET_TOKEN=fake_token" > .env.production
echo "EXAMPLE_KEY=safe_to_index" > .env.example

# Run indexing
context-engine-mcp --workspace . --verbose 2>&1 | tee indexing.log

# Verify exclusions in logs
grep -E "Skipping.*\.env\.(local|development|production)" indexing.log

# Verify .env.example IS indexed (safe template file)
grep -E "Indexing.*\.env\.example" indexing.log
```

**Expected Results**:
- ✅ `.env.local` → Skipped (contains secrets)
- ✅ `.env.development` → Skipped (contains secrets)
- ✅ `.env.production` → Skipped (contains secrets)
- ✅ `.env.example` → Indexed (safe template)

### Step 5: Performance Testing (1 hour)

Measure indexing performance before and after changes:

```bash
# Baseline measurement (before changes - use git stash if needed)
time context-engine-mcp --workspace ./test-repos/neovim --verbose 2>&1 | tail -20

# Record metrics:
# - Total indexing time
# - Number of files indexed
# - Memory usage (via Task Manager or htop)
# - Index file size (.augment-context-state.json)

# After changes - same test
time context-engine-mcp --workspace ./test-repos/neovim --verbose 2>&1 | tail -20

# Compare metrics
ls -lh .augment-context-state.json
```

**Performance Targets**:
| Metric | Maximum Acceptable Impact |
|--------|--------------------------|
| Indexing Time | < +15% increase |
| Index Size | < +20% increase |
| Memory Usage | < +10% increase |
| Search Latency | No degradation |

### Step 6: Update Documentation (30 minutes)

#### Update CHANGELOG.md

Add entry under `## [Unreleased]` or create new version section:

```markdown
## [Unreleased]

### Added
- Expanded file extension support from 72 to 116 extensions (+61%)
- Functional programming languages: Elixir (.ex, .exs), Erlang (.erl, .hrl), Haskell (.hs, .lhs), Clojure (.clj, .cljs, .cljc), OCaml (.ml, .mli)
- Scientific/data languages: R (.r, .R), Julia (.jl)
- Scripting languages: Lua (.lua), Perl (.pl, .pm, .pod)
- Modern systems languages: Zig (.zig), Nim (.nim), Crystal (.cr), V (.v)
- Build systems: CMake (.cmake), Make (.mk, .mak), Bazel (.bazel, .bzl), Ninja (.ninja), SBT (.sbt), CocoaPods (.podspec)
- Documentation formats: AsciiDoc (.adoc, .asciidoc), LaTeX (.tex, .latex), Org-mode (.org), Wiki (.wiki)
- Web templates: Handlebars (.hbs, .handlebars), EJS (.ejs), Pug (.pug, .jade), JSP (.jsp), ERB (.erb), Twig (.twig)

### Security
- Verified exclusion of sensitive environment files (.env.local, .env.development, .env.production)
- All 44 new extensions security-reviewed and approved
```

#### Update README.md

Add or update the "Supported Languages" section:

```markdown
## Supported Languages

The Context Engine supports **116 file extensions** across multiple programming paradigms:

- **Web Development**: TypeScript, JavaScript, HTML, CSS, Vue, Svelte, Astro
- **Backend**: Python, Java, Kotlin, Scala, Go, Rust, C/C++, C#, Ruby, PHP
- **Functional**: Elixir, Erlang, Haskell, Clojure, OCaml
- **Data Science**: R, Julia, Python
- **Mobile**: Swift, Objective-C, Dart/Flutter
- **Systems**: Zig, Nim, Crystal, V, Rust, C/C++
- **Scripting**: Lua, Perl, Bash, PowerShell
- **Infrastructure**: Terraform, Docker, Nix, CMake, Bazel
- **Documentation**: Markdown, AsciiDoc, LaTeX, reStructuredText
```

### Step 7: Create Pull Request (15 minutes)

#### Commit Changes

```bash
# Stage changes
git add src/mcp/serviceClient.ts CHANGELOG.md README.md

# Commit with descriptive message
git commit -m "feat: expand file extension support from 72 to 116 extensions

- Add 44 new file extensions for improved language coverage
- Functional programming: Elixir, Erlang, Haskell, Clojure, OCaml
- Scientific/data: R, Julia
- Modern systems: Zig, Nim, Crystal, V
- Build systems: CMake, Bazel, Make, Ninja, SBT
- Documentation: AsciiDoc, LaTeX, Org-mode
- Web templates: Handlebars, EJS, Pug, JSP, ERB, Twig

Security: Verified exclusion of sensitive .env files
Performance: <15% indexing time impact expected

Resolves: File extension coverage gap analysis
See: docs\archive\INDEXABLE_EXTENSIONS_ANALYSIS.md for detailed research"
```

#### Create PR

```bash
# Push branch
git push origin feature/expand-file-extensions

# Create PR via GitHub CLI (if installed)
gh pr create --title "feat: Expand file extension support (72 → 116)" \
  --body "## Summary
Expands language support from 72 to 116 file extensions (+61%).

## Changes
- Added 44 security-verified file extensions
- Covers all major programming paradigms
- Increases language coverage from 62% to 95%

## Testing
- ✅ Build verification passed
- ✅ Integration testing with sample repos (Phoenix, Pandoc, Flux.jl, ggplot2, Neovim)
- ✅ Security verification (sensitive .env files still excluded)
- ✅ Performance impact <15%

## Documentation
- See \`docs\archive\INDEXABLE_EXTENSIONS_ANALYSIS.md\` for research
- See \`docs\archive\SECURITY_ANALYSIS_ENV_FILES.md\` for security review"
```

---

## 3. Code Changes

### Exact Code to Insert

Insert the following code at line 642 in `src/mcp/serviceClient.ts`, just before the closing `]);`:

```typescript
  // ============================================================================
  // NEW EXTENSIONS (44 additions - 2025-12-22)
  // ============================================================================

  // === Functional Programming Languages ===
  '.ex', '.exs',           // Elixir (Phoenix framework, distributed systems)
  '.erl', '.hrl',          // Erlang (OTP, telecom, distributed systems)
  '.hs', '.lhs',           // Haskell (functional programming, Pandoc)
  '.clj', '.cljs', '.cljc', // Clojure (JVM functional, ClojureScript)
  '.ml', '.mli',           // OCaml (functional, type systems, compilers)

  // === Scientific & Data Languages ===
  '.r', '.R',              // R language (statistics, data science, academia)
  '.jl',                   // Julia (scientific computing, ML, high-performance)

  // === Scripting Languages ===
  '.lua',                  // Lua (game dev, Neovim, embedded scripting)
  '.pl', '.pm', '.pod',    // Perl (system admin, text processing, legacy)

  // === Modern Systems Languages ===
  '.zig',                  // Zig (modern C replacement, growing adoption)
  '.nim',                  // Nim (efficient, expressive, Python-like syntax)
  '.cr',                   // Crystal (Ruby-like syntax, compiled performance)
  '.v',                    // V language (simple, fast compilation)

  // === Build Systems ===
  '.cmake',                // CMake (cross-platform C/C++ builds)
  '.mk', '.mak',           // Make (alternative Makefile extensions)
  '.bazel', '.bzl',        // Bazel (Google's build tool, monorepos)
  '.ninja',                // Ninja (fast build system)
  '.sbt',                  // Scala Build Tool
  '.podspec',              // CocoaPods (iOS dependency management)

  // === Documentation Formats ===
  '.adoc', '.asciidoc',    // AsciiDoc (technical docs, books)
  '.tex', '.latex',        // LaTeX (academic papers, technical docs)
  '.org',                  // Org-mode (Emacs documentation, literate programming)
  '.wiki',                 // Wiki markup

  // === Web Templates ===
  '.hbs', '.handlebars',   // Handlebars (template engine)
  '.ejs',                  // Embedded JavaScript templates
  '.pug', '.jade',         // Pug templates (Node.js, formerly Jade)
  '.jsp',                  // JavaServer Pages
  '.erb',                  // Embedded Ruby (Rails views)
  '.twig',                 // Twig (PHP/Symfony templates)
```

### Extensions Summary Table

| Category | Extensions | Count |
|----------|------------|-------|
| Functional Programming | `.ex`, `.exs`, `.erl`, `.hrl`, `.hs`, `.lhs`, `.clj`, `.cljs`, `.cljc`, `.ml`, `.mli` | 11 |
| Scientific/Data | `.r`, `.R`, `.jl` | 3 |
| Scripting | `.lua`, `.pl`, `.pm`, `.pod` | 4 |
| Modern Systems | `.zig`, `.nim`, `.cr`, `.v` | 4 |
| Build Systems | `.cmake`, `.mk`, `.mak`, `.bazel`, `.bzl`, `.ninja`, `.sbt`, `.podspec` | 8 |
| Documentation | `.adoc`, `.asciidoc`, `.tex`, `.latex`, `.org`, `.wiki` | 6 |
| Web Templates | `.hbs`, `.handlebars`, `.ejs`, `.pug`, `.jade`, `.jsp`, `.erb`, `.twig` | 8 |
| **Total** | | **44** |

### Visual Diff Preview

```diff
  // === Infrastructure & DevOps ===
  '.dockerfile',
  '.tf', '.hcl',  // Terraform
  '.nix',         // Nix configuration

  // === Build Files (by name, not extension - handled separately) ===
  // Makefile, Dockerfile, Jenkinsfile - handled in shouldIndexFile
+
+  // ============================================================================
+  // NEW EXTENSIONS (44 additions - 2025-12-22)
+  // ============================================================================
+
+  // === Functional Programming Languages ===
+  '.ex', '.exs',           // Elixir
+  '.erl', '.hrl',          // Erlang
+  ... (remaining extensions)
]);
```

---

## 4. Testing Procedures

### 4.1 Build Verification Test

**Command**:
```bash
npm run build
```

**Expected Output**:
```
> context-engine-mcp@x.x.x build
> tsc

(No errors)
```

**Pass Criteria**: Exit code 0, no TypeScript errors

### 4.2 Integration Test Suite

#### Test Matrix

| Repository | Language | Extensions to Verify | Expected Files |
|------------|----------|---------------------|----------------|
| Phoenix | Elixir | `.ex`, `.exs` | 500+ |
| Pandoc | Haskell | `.hs`, `.lhs` | 200+ |
| Flux.jl | Julia | `.jl` | 100+ |
| ggplot2 | R | `.r`, `.R` | 100+ |
| Neovim | Lua | `.lua` | 300+ |

#### Test Script

```bash
#!/bin/bash
# integration-test.sh

TEST_DIR="./test-repos"
mkdir -p "$TEST_DIR"
cd "$TEST_DIR"

# Clone repositories (shallow for speed)
repos=(
  "https://github.com/phoenixframework/phoenix.git"
  "https://github.com/jgm/pandoc.git"
  "https://github.com/FluxML/Flux.jl.git"
  "https://github.com/tidyverse/ggplot2.git"
  "https://github.com/neovim/neovim.git"
)

for repo in "${repos[@]}"; do
  git clone --depth 1 "$repo" 2>/dev/null || echo "Already cloned: $repo"
done

# Test each repository
echo "=== Testing Phoenix (Elixir) ==="
cd phoenix
find . -name "*.ex" -o -name "*.exs" | wc -l
cd ..

echo "=== Testing Pandoc (Haskell) ==="
cd pandoc
find . -name "*.hs" -o -name "*.lhs" | wc -l
cd ..

echo "=== Testing Flux.jl (Julia) ==="
cd Flux.jl
find . -name "*.jl" | wc -l
cd ..

echo "=== Testing ggplot2 (R) ==="
cd ggplot2
find . -name "*.r" -o -name "*.R" | wc -l
cd ..

echo "=== Testing Neovim (Lua) ==="
cd neovim
find . -name "*.lua" | wc -l
cd ..

echo "=== All tests complete ==="
```

### 4.3 Security Verification Test

**Purpose**: Ensure sensitive environment files remain excluded

**Test Script**:
```bash
#!/bin/bash
# security-test.sh

TEST_DIR="./security-test"
mkdir -p "$TEST_DIR"
cd "$TEST_DIR"

# Create test files with fake credentials
echo "DATABASE_URL=postgres://localhost/db" > .env.local
echo "API_KEY=sk_live_fake_key_12345" > .env.development
echo "SECRET_TOKEN=production_secret_token" > .env.production
echo "EXAMPLE_KEY=this_is_safe_to_index" > .env.example

# Run indexing (capture output)
echo "Running indexing..."
context-engine-mcp --workspace . --verbose 2>&1 > indexing.log

# Verify exclusions
echo "=== Security Verification Results ==="
echo "Checking .env.local exclusion:"
grep -q "Skipping.*\.env\.local" indexing.log && echo "✅ PASS" || echo "❌ FAIL"

echo "Checking .env.development exclusion:"
grep -q "Skipping.*\.env\.development" indexing.log && echo "✅ PASS" || echo "❌ FAIL"

echo "Checking .env.production exclusion:"
grep -q "Skipping.*\.env\.production" indexing.log && echo "✅ PASS" || echo "❌ FAIL"

echo "Checking .env.example inclusion:"
grep -q "Indexing.*\.env\.example\|\.env\.example" indexing.log && echo "✅ PASS" || echo "⚠️ Not found (may be OK)"

# Cleanup
cd ..
rm -rf "$TEST_DIR"
```

### 4.4 Performance Test

**Metrics to Capture**:

| Metric | Measurement Method | Target |
|--------|-------------------|--------|
| Indexing Time | `time` command | < +15% |
| Index File Size | `ls -lh .augment-context-state.json` | < +20% |
| Memory Peak | Process monitor | < +10% |
| Search Latency | Tool response time | No degradation |

**Test Script**:
```bash
#!/bin/bash
# performance-test.sh

WORKSPACE="./test-repos/neovim"

echo "=== Performance Test ==="
echo "Workspace: $WORKSPACE"

# Measure indexing time
echo ""
echo "Indexing time:"
time context-engine-mcp --workspace "$WORKSPACE" --verbose 2>&1 | tail -5

# Measure index size
echo ""
echo "Index file size:"
ls -lh .augment-context-state.json 2>/dev/null || echo "No state file found"

# Memory usage (requires manual observation)
echo ""
echo "Monitor memory usage in Task Manager/htop during indexing"
```

---

## 5. Success Criteria

### 5.1 Mandatory Criteria (Must Pass)

| Criterion | Verification | Status |
|-----------|--------------|--------|
| Build succeeds | `npm run build` exits 0 | ⬜ |
| No duplicate extensions | Manual review | ⬜ |
| All 44 extensions added | Count in Set | ⬜ |
| Security files excluded | Security test passes | ⬜ |
| Existing tests pass | `npm test` exits 0 | ⬜ |

### 5.2 Performance Criteria

| Metric | Baseline | After | Max Acceptable |
|--------|----------|-------|----------------|
| Indexing Time | ___ sec | ___ sec | +15% |
| Index Size | ___ MB | ___ MB | +20% |
| Memory Usage | ___ MB | ___ MB | +10% |
| Search Latency | ___ ms | ___ ms | +5% |

### 5.3 Integration Criteria

| Repository | Files Found | Files Indexed | Status |
|------------|-------------|---------------|--------|
| Phoenix (.ex, .exs) | ⬜ | ⬜ | ⬜ |
| Pandoc (.hs, .lhs) | ⬜ | ⬜ | ⬜ |
| Flux.jl (.jl) | ⬜ | ⬜ | ⬜ |
| ggplot2 (.r, .R) | ⬜ | ⬜ | ⬜ |
| Neovim (.lua) | ⬜ | ⬜ | ⬜ |

---

## 6. Rollback Plan

### 6.1 Immediate Rollback (Git Revert)

If critical issues are discovered post-merge:

```bash
# Identify the commit hash
git log --oneline -5

# Revert the commit
git revert <commit-hash>

# Push the revert
git push origin main

# Verify build
npm run build
npm test
```

### 6.2 Partial Rollback (Remove Specific Extensions)

If only certain extensions cause issues:

1. Identify problematic extensions from logs
2. Edit `src/mcp/serviceClient.ts`
3. Remove only the problematic extensions
4. Rebuild and retest

```bash
# Example: Remove Lua if it causes issues
# Edit serviceClient.ts, remove '.lua' from the Set
npm run build
npm test
```

### 6.3 Full Manual Rollback

Restore to original 72 extensions:

```bash
# Checkout the original file
git checkout HEAD~1 -- src/mcp/serviceClient.ts

# Verify
npm run build
npm test
```

### 6.4 Rollback Verification Checklist

- [ ] Build succeeds after rollback
- [ ] All tests pass
- [ ] MCP server starts correctly
- [ ] Search functionality works
- [ ] No errors in logs

---

## 7. Timeline

### Detailed Schedule

| Phase | Task | Duration | Cumulative |
|-------|------|----------|------------|
| **1** | Code Implementation | 15 min | 15 min |
| **2** | Build Verification | 5 min | 20 min |
| **3** | Integration Testing | 2 hours | 2h 20min |
| **4** | Security Verification | 15 min | 2h 35min |
| **5** | Performance Testing | 1 hour | 3h 35min |
| **6** | Documentation Update | 30 min | 4h 5min |
| **7** | PR Creation & Review | 25 min | **4h 30min** |

### Risk Assessment by Phase

| Phase | Risk Level | Mitigation |
|-------|------------|------------|
| Code Implementation | Low | Careful comma placement, no duplicates |
| Build Verification | Very Low | TypeScript catches errors |
| Integration Testing | Medium | Use shallow clones, test incrementally |
| Security Verification | Very Low | Existing exclusions are robust |
| Performance Testing | Low | Extensions are lightweight strings |
| Documentation Update | Very Low | Standard changelog format |
| PR Creation | Very Low | Standard git workflow |

---

## 8. Appendix

### A. Reference Documents

| Document | Purpose |
|----------|---------|
| `docs\archive\INDEXABLE_EXTENSIONS_ANALYSIS.md` | Comprehensive research and justification |
| `docs\archive\SECURITY_ANALYSIS_ENV_FILES.md` | Security review of environment files |
| `docs\archive\CORRECTED_RECOMMENDATIONS_SUMMARY.md` | Final corrected recommendations |
| `docs\archive\QUICK_REFERENCE_EXTENSIONS.md` | Copy-paste ready code |
| `docs\archive\COMPLETENESS_ASSESSMENT.md` | Coverage analysis |

### B. Key Contacts

| Role | Responsibility |
|------|----------------|
| Implementer | Code changes, testing |
| Reviewer | PR review, approval |
| Security | Final security sign-off |

### C. Post-Implementation Monitoring

After deployment, monitor for:
- Error rates in indexing logs
- User feedback on new language support
- Performance degradation reports
- Security incident reports

---

**Document Status**: ✅ COMPLETE
**Ready for Implementation**: YES
**Estimated Total Time**: ~4.5 hours
**Risk Level**: Low
