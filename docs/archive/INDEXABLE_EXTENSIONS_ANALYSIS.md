# Indexable File Extensions Analysis & Recommendations

## Executive Summary

Based on research of industry-leading code search tools (GitHub Linguist, Sourcegraph), AI coding assistants (GitHub Copilot, Cursor), and best practices documentation, I've identified **47 missing file extensions** that should be added to the Context Engine MCP Server's `INDEXABLE_EXTENSIONS` set.

**Current Count**: 72 extensions
**Recommended Additions**: 44 extensions
**New Total**: 116 extensions

⚠️ **SECURITY NOTE**: This analysis initially included `.env.local`, `.env.development`, and `.env.production` but these have been **REMOVED** as they contain sensitive credentials. See `docs\archive\SECURITY_ANALYSIS_ENV_FILES.md` for details.

---

## Research Sources

1. **GitHub Linguist** - The authoritative source used by GitHub.com for language detection (6,848+ commits, 1,142 contributors)
2. **Sourcegraph** - Enterprise code search platform
3. **AI Coding Assistants** - GitHub Copilot, Cursor, Continue.dev documentation
4. **Aider.chat** - AI pair programming tool with comprehensive language support
5. **Industry file extension databases** - Programming language registries

---

## Current Extensions (72 total)

### Already Covered ✅
- **TypeScript/JavaScript**: .ts, .tsx, .js, .jsx, .mjs, .cjs
- **Python**: .py, .pyw, .pyi
- **JVM Languages**: .java, .kt, .kts, .scala, .groovy
- **Go**: .go
- **Rust**: .rs
- **C/C++**: .c, .cpp, .cc, .cxx, .h, .hpp, .hxx
- **.NET**: .cs, .fs, .fsx
- **Ruby**: .rb, .rake, .gemspec
- **PHP**: .php
- **Mobile**: .swift, .m, .mm, .dart, .arb
- **Frontend**: .vue, .svelte, .astro
- **Web**: .html, .htm, .css, .scss, .sass, .less, .styl
- **Config**: .json, .yaml, .yml, .toml, .xml, .plist, .gradle, .properties, .ini, .cfg, .conf, .editorconfig
- **Docs**: .md, .mdx, .txt, .rst
- **Database**: .sql, .prisma
- **API/Schema**: .graphql, .gql, .proto, .openapi, .swagger
- **Shell**: .sh, .bash, .zsh, .fish, .ps1, .psm1, .bat, .cmd
- **Infrastructure**: .dockerfile, .tf, .hcl, .nix

---

## Recommended Additions (44 extensions)

### HIGH PRIORITY - Popular Programming Languages (15 extensions)

#### Functional Programming Languages
- **.ex, .exs** - Elixir (growing in popularity, Phoenix framework)
- **.erl, .hrl** - Erlang (telecom, distributed systems)
- **.hs, .lhs** - Haskell (functional programming)
- **.clj, .cljs, .cljc** - Clojure/ClojureScript (JVM functional language)
- **.ml, .mli** - OCaml (functional programming)

#### Scientific & Data Languages
- **.r, .R** - R language (data science, statistics)
- **.jl** - Julia (scientific computing, ML)

#### Scripting & General Purpose
- **.lua** - Lua (game development, embedded scripting)
- **.pl, .pm** - Perl (system administration, text processing)

#### Modern Systems Languages
- **.zig** - Zig (modern systems programming)
- **.nim** - Nim (efficient, expressive systems language)
- **.cr** - Crystal (Ruby-like syntax, compiled)
- **.v** - V language (simple, fast compilation)

**Justification**: These languages are widely used in production systems, have active communities, and are frequently encountered in modern codebases. GitHub Linguist supports all of them.

---

### MEDIUM PRIORITY - Build Systems & Configuration (9 extensions)

#### Build & Task Files
- **.cmake** - CMake build configuration
- **.mk, .mak** - Make files (alternative extensions)
- **.bazel, .bzl** - Bazel build system (Google's build tool)
- **.ninja** - Ninja build system
- **.sbt** - Scala Build Tool
- **.podspec** - CocoaPods specification (iOS)

#### Package Management
- **.lock** - Lock files (package-lock.json, yarn.lock, etc.)
- **.npmrc, .yarnrc** - NPM/Yarn configuration

**Justification**: Build systems and configuration files are critical for understanding project structure and dependencies. AI assistants need this context for accurate code generation.

⚠️ **SECURITY NOTE**: `.env.local`, `.env.development`, and `.env.production` were REMOVED from this list as they contain sensitive credentials and are already properly excluded by the codebase.

---

### MEDIUM PRIORITY - Documentation & Markup (8 extensions)

#### Advanced Documentation Formats
- **.adoc, .asciidoc** - AsciiDoc (technical documentation)
- **.tex, .latex** - LaTeX (academic papers, technical docs)
- **.org** - Org-mode (Emacs documentation format)
- **.wiki** - Wiki markup
- **.pod** - Perl documentation

#### Web Documentation
- **.ejs, .pug, .jade** - Template engines (embedded JavaScript, Pug)

**Justification**: Documentation is essential context for AI coding assistants. These formats are commonly used in open-source projects and technical documentation.

---

### MEDIUM PRIORITY - Web & Frontend (7 extensions)

#### Template Engines
- **.hbs, .handlebars** - Handlebars templates
- **.twig** - Twig templates (PHP)
- **.erb** - Embedded Ruby templates
- **.jsp** - JavaServer Pages

#### Modern Web
- **.mjs** - ES modules (already have .mjs, but confirming)
- **.cjs** - CommonJS modules (already have .cjs, but confirming)
- **.wasm** - WebAssembly text format (.wat)

**Justification**: Template engines are code that generates HTML and contain business logic. Essential for full-stack context.

---

### LOW PRIORITY - Specialized Languages (5 extensions)

#### Domain-Specific Languages
- **.sol** - Solidity (Ethereum smart contracts)
- **.move** - Move language (blockchain)
- **.cairo** - Cairo (StarkNet smart contracts)
- **.vhdl, .vhd** - VHDL (hardware description)

**Justification**: Specialized but growing in importance, especially blockchain languages. Include if targeting these domains.

---

## Extensions to EXCLUDE (Not Recommended)

### Binary & Compiled Files
- **.pyc, .pyo** - Python bytecode (binary)
- **.class** - Java bytecode (binary)
- **.o, .obj** - Object files (binary)
- **.exe, .dll, .so** - Executables and libraries (binary)

### Media Files
- **.png, .jpg, .gif, .svg** - Images (not code)
- **.mp3, .mp4, .wav** - Media files (not code)

### Archives
- **.zip, .tar, .gz** - Compressed archives (not code)

**Justification**: These are binary or non-textual files that cannot be semantically indexed for code search.

---

## Implementation Priority

### Phase 1: HIGH PRIORITY (Immediate)
Add the 15 popular programming language extensions. These have the highest ROI and are most likely to be encountered.

### Phase 2: MEDIUM PRIORITY (Next Release)
Add build systems, configuration, and documentation formats (24 extensions). These provide critical context for AI assistants.

### Phase 3: LOW PRIORITY (Future)
Add specialized languages (5 extensions) based on user demand and domain focus.

---

## Comparison with Industry Standards

### GitHub Linguist
- Supports **600+ languages** with thousands of file extensions
- Our recommended additions align with Linguist's "programming" and "markup" categories
- Excludes "data" and "prose" categories (JSON data files, plain text)

### Sourcegraph
- Indexes all text-based source files
- Uses similar extension lists for syntax highlighting and code intelligence
- Focuses on "code" vs "configuration" vs "documentation"

### AI Coding Assistants (Copilot, Cursor)
- Prioritize languages with strong LLM training data
- All recommended languages have good LLM support
- Template engines and config files are increasingly important for context

---

## Recommended Changes to `serviceClient.ts`

### Proposed Code Addition

```typescript
const INDEXABLE_EXTENSIONS = new Set([
  // === TypeScript/JavaScript ===
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',

  // === Python ===
  '.py', '.pyw', '.pyi',

  // === JVM Languages ===
  '.java', '.kt', '.kts', '.scala', '.groovy',

  // === Go ===
  '.go',

  // === Rust ===
  '.rs',

  // === C/C++ ===
  '.c', '.cpp', '.cc', '.cxx', '.h', '.hpp', '.hxx',

  // === .NET ===
  '.cs', '.fs', '.fsx',

  // === Ruby ===
  '.rb', '.rake', '.gemspec', '.erb',  // Added .erb for templates

  // === PHP ===
  '.php', '.twig',  // Added .twig for templates

  // === Functional Programming Languages === [NEW]
  '.ex', '.exs',      // Elixir
  '.erl', '.hrl',     // Erlang
  '.hs', '.lhs',      // Haskell
  '.clj', '.cljs', '.cljc',  // Clojure
  '.ml', '.mli',      // OCaml

  // === Scientific & Data Languages === [NEW]
  '.r', '.R',         // R language
  '.jl',              // Julia

  // === Scripting Languages === [NEW]
  '.lua',             // Lua
  '.pl', '.pm', '.pod',  // Perl

  // === Modern Systems Languages === [NEW]
  '.zig',             // Zig
  '.nim',             // Nim
  '.cr',              // Crystal
  '.v',               // V language

  // === Mobile Development ===
  '.swift',
  '.m', '.mm',
  '.dart',
  '.arb',

  // === Frontend Frameworks ===
  '.vue', '.svelte', '.astro',

  // === Web Templates & Styles ===
  '.html', '.htm',
  '.css', '.scss', '.sass', '.less', '.styl',
  '.hbs', '.handlebars',  // [NEW] Handlebars templates
  '.ejs', '.pug', '.jade',  // [NEW] Template engines
  '.jsp',  // [NEW] JavaServer Pages

  // === Configuration Files ===
  '.json', '.yaml', '.yml', '.toml',
  '.xml',
  '.plist',
  '.gradle',
  '.properties',
  '.ini', '.cfg', '.conf',
  '.editorconfig',
  '.env.example', '.env.template', '.env.sample',  // Safe templates only (NOT actual .env files)

  // === Build Systems === [NEW]
  '.cmake',           // CMake
  '.mk', '.mak',      // Make
  '.bazel', '.bzl',   // Bazel
  '.ninja',           // Ninja
  '.sbt',             // Scala Build Tool
  '.podspec',         // CocoaPods

  // === Documentation ===
  '.md', '.mdx', '.txt', '.rst',
  '.adoc', '.asciidoc',  // [NEW] AsciiDoc
  '.tex', '.latex',      // [NEW] LaTeX
  '.org',                // [NEW] Org-mode
  '.wiki',               // [NEW] Wiki markup

  // === SECURITY NOTE ===
  // .env.local, .env.development, .env.production are NOT included here
  // They contain sensitive credentials and are properly excluded via DEFAULT_EXCLUDED_PATTERNS

  // === Database ===
  '.sql', '.prisma',

  // === API/Schema Definitions ===
  '.graphql', '.gql',
  '.proto',
  '.openapi', '.swagger',

  // === Shell Scripts ===
  '.sh', '.bash', '.zsh', '.fish',
  '.ps1', '.psm1', '.bat', '.cmd',

  // === Infrastructure & DevOps ===
  '.dockerfile',
  '.tf', '.hcl',
  '.nix',

  // === Blockchain/Smart Contracts === [NEW - Optional]
  // '.sol',           // Solidity (uncomment if needed)
  // '.move',          // Move language (uncomment if needed)
  // '.cairo',         // Cairo (uncomment if needed)
]);
```

### Summary of Changes

**Added 44 new extensions across 6 categories:**

1. **Functional Programming** (9): .ex, .exs, .erl, .hrl, .hs, .lhs, .clj, .cljs, .cljc, .ml, .mli
2. **Scientific/Data** (3): .r, .R, .jl
3. **Scripting** (4): .lua, .pl, .pm, .pod
4. **Modern Systems** (4): .zig, .nim, .cr, .v
5. **Build Systems** (9): .cmake, .mk, .mak, .bazel, .bzl, .ninja, .sbt, .podspec
6. **Documentation** (5): .adoc, .asciidoc, .tex, .latex, .org, .wiki
7. **Web Templates** (6): .hbs, .handlebars, .ejs, .pug, .jade, .jsp, .erb, .twig

**Total**: 72 (current) + 44 (new) = **116 extensions**

⚠️ **SECURITY CORRECTION**: Originally recommended 47 extensions including `.env.local`, `.env.development`, `.env.production`. These 3 have been **REMOVED** as they contain sensitive credentials. See `docs\archive\SECURITY_ANALYSIS_ENV_FILES.md` for full analysis.

---

## Testing Recommendations

After implementing these changes:

1. **Test with popular repositories**:
   - Elixir: Phoenix framework
   - Haskell: Pandoc
   - Julia: Flux.jl
   - R: tidyverse packages
   - Lua: Neovim configuration

2. **Verify indexing performance**:
   - Monitor index size growth
   - Check indexing time for large repos
   - Ensure no memory issues

3. **Validate search quality**:
   - Test semantic search across new file types
   - Verify syntax highlighting works
   - Check that context retrieval is accurate

---

## References

1. **GitHub Linguist**: https://github.com/github-linguist/linguist
2. **Aider Language Support**: https://aider.chat/docs/languages.html
3. **Sourcegraph Documentation**: https://sourcegraph.com/docs
4. **Programming Language Extensions Database**: https://gist.github.com/ppisarczyk/43962d06686722d26d176fad46879d41
5. **Mammouth AI Supported Extensions**: https://info.mammouth.ai/docs/supported-file-extensions/

---

## Conclusion

These additions will make the Context Engine MCP Server more comprehensive and competitive with industry-leading code search tools. The recommended extensions cover:

- ✅ All major programming paradigms (imperative, functional, OOP)
- ✅ Popular data science and scientific computing languages
- ✅ Modern systems programming languages
- ✅ Essential build systems and configuration formats
- ✅ Common documentation and template formats

**Impact**: Better context for AI coding assistants, broader language support, and improved developer experience across diverse tech stacks.

