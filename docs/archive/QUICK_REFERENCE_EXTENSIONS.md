# Quick Reference: File Extensions to Add

⚠️ **SECURITY NOTICE**: This document was corrected to remove `.env.local`, `.env.development`, and `.env.production` which contain sensitive credentials. See `docs\archive\SECURITY_ANALYSIS_ENV_FILES.md` for full details.

## Copy-Paste Ready Lists

### Phase 1: HIGH PRIORITY (15 extensions)
```typescript
// Functional Programming Languages
'.ex', '.exs',      // Elixir
'.erl', '.hrl',     // Erlang
'.hs', '.lhs',      // Haskell
'.clj', '.cljs', '.cljc',  // Clojure
'.ml', '.mli',      // OCaml

// Scientific & Data Languages
'.r', '.R',         // R language
'.jl',              // Julia

// Scripting Languages
'.lua',             // Lua
'.pl', '.pm', '.pod',  // Perl

// Modern Systems Languages
'.zig',             // Zig
'.nim',             // Nim
'.cr',              // Crystal
'.v',               // V language
```

### Phase 2: MEDIUM PRIORITY (24 extensions)
```typescript
// Build Systems
'.cmake',           // CMake
'.mk', '.mak',      // Make
'.bazel', '.bzl',   // Bazel
'.ninja',           // Ninja
'.sbt',             // Scala Build Tool
'.podspec',         // CocoaPods

// Documentation
'.adoc', '.asciidoc',  // AsciiDoc
'.tex', '.latex',      // LaTeX
'.org',                // Org-mode
'.wiki',               // Wiki markup

// Web Templates
'.hbs', '.handlebars',  // Handlebars
'.ejs',                 // Embedded JavaScript
'.pug', '.jade',        // Pug templates
'.jsp',                 // JavaServer Pages
'.erb',                 // Embedded Ruby
'.twig',                // Twig (PHP)
```

⚠️ **SECURITY**: `.env.local`, `.env.development`, `.env.production` were REMOVED as they contain sensitive credentials.

### Phase 3: LOW PRIORITY (5 extensions - Optional)
```typescript
// Blockchain/Smart Contracts
'.sol',             // Solidity
'.move',            // Move language
'.cairo',           // Cairo

// Hardware Description
'.vhdl', '.vhd',    // VHDL
```

---

## Single-Line Arrays for Easy Copy-Paste

### Phase 1 (15 extensions)
```typescript
['.ex', '.exs', '.erl', '.hrl', '.hs', '.lhs', '.clj', '.cljs', '.cljc', '.ml', '.mli', '.r', '.R', '.jl', '.lua', '.pl', '.pm', '.pod', '.zig', '.nim', '.cr', '.v']
```

### Phase 2 (24 extensions)
```typescript
['.cmake', '.mk', '.mak', '.bazel', '.bzl', '.ninja', '.sbt', '.podspec', '.adoc', '.asciidoc', '.tex', '.latex', '.org', '.wiki', '.hbs', '.handlebars', '.ejs', '.pug', '.jade', '.jsp', '.erb', '.twig']
```

### Phase 3 (5 extensions)
```typescript
['.sol', '.move', '.cairo', '.vhdl', '.vhd']
```

---

## Verification Checklist

After adding extensions, verify:

- [ ] No duplicate extensions in the Set
- [ ] All extensions start with a dot (.)
- [ ] Extensions are lowercase (except .R for R language)
- [ ] Comments are clear and organized by category
- [ ] No binary file extensions (.pyc, .class, .o, etc.)
- [ ] No media file extensions (.png, .jpg, .mp4, etc.)
- [ ] No archive extensions (.zip, .tar, .gz, etc.)

---

## Language Justifications (Quick Reference)

| Extension | Language | Why Include? |
|-----------|----------|--------------|
| .ex, .exs | Elixir | Phoenix framework, growing in web dev |
| .erl, .hrl | Erlang | Distributed systems, telecom, WhatsApp |
| .hs, .lhs | Haskell | Functional programming, Pandoc |
| .clj, .cljs, .cljc | Clojure | JVM functional language, data processing |
| .ml, .mli | OCaml | Functional programming, type systems |
| .r, .R | R | Data science, statistics, academia |
| .jl | Julia | Scientific computing, ML, performance |
| .lua | Lua | Game dev (Roblox), Neovim, embedded |
| .pl, .pm, .pod | Perl | System admin, text processing, legacy |
| .zig | Zig | Modern C replacement, growing adoption |
| .nim | Nim | Efficient, expressive, Python-like |
| .cr | Crystal | Ruby-like syntax, compiled performance |
| .v | V | Simple, fast compilation |
| .cmake | CMake | Cross-platform build system (C/C++) |
| .bazel, .bzl | Bazel | Google's build tool, monorepos |
| .adoc, .asciidoc | AsciiDoc | Technical documentation, books |
| .tex, .latex | LaTeX | Academic papers, technical docs |
| .hbs, .handlebars | Handlebars | Template engine (JavaScript) |
| .ejs | EJS | Embedded JavaScript templates |
| .pug, .jade | Pug | Template engine (Node.js) |
| .erb | ERB | Embedded Ruby templates (Rails) |
| .twig | Twig | Template engine (PHP/Symfony) |

---

## Testing Commands

After implementation, test with these repositories:

```bash
# Elixir
git clone https://github.com/phoenixframework/phoenix.git

# Haskell
git clone https://github.com/jgm/pandoc.git

# Julia
git clone https://github.com/FluxML/Flux.jl.git

# R
git clone https://github.com/tidyverse/ggplot2.git

# Lua
git clone https://github.com/neovim/neovim.git

# Zig
git clone https://github.com/ziglang/zig.git

# Crystal
git clone https://github.com/crystal-lang/crystal.git
```

---

## Performance Considerations

**Expected Impact**:
- Index size: +10-15% (depends on repository composition)
- Indexing time: +5-10% (minimal, as most repos don't use all languages)
- Memory usage: Negligible (extensions are just strings in a Set)

**Mitigation**:
- Extensions are checked via Set lookup (O(1) complexity)
- No performance degradation expected
- Can add extensions incrementally if concerned

---

## Rollback Plan

If issues arise, remove extensions in reverse order:

1. Remove Phase 3 (blockchain/hardware) first
2. Remove Phase 2 (build systems, docs, templates) next
3. Keep Phase 1 (popular languages) as they have highest value

---

## Next Steps

1. ✅ Review this quick reference
2. ⬜ Decide which phases to implement
3. ⬜ Update `src/mcp/serviceClient.ts` (lines 572-645)
4. ⬜ Test with sample repositories
5. ⬜ Monitor performance metrics
6. ⬜ Update documentation
7. ⬜ Announce new language support to users

