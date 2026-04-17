# Polyglot tree-sitter chunking

`treeSitterChunkParser.ts` supports language-aware chunking for:

| Language | Extensions | Grammar package                |
| -------- | ---------- | ------------------------------ |
| TypeScript | `.ts`, `.tsx` | `tree-sitter-typescript` (bundled) |
| Python   | `.py`      | `tree-sitter-python` (opt-in)  |
| Go       | `.go`      | `tree-sitter-go` (opt-in)      |
| Rust     | `.rs`      | `tree-sitter-rust` (opt-in)    |
| Java     | `.java`    | `tree-sitter-java` (opt-in)    |
| C#       | `.cs`      | `tree-sitter-c-sharp` (opt-in) |

## Enabling polyglot parsing

The non-TypeScript grammar packages are pinned to the 0.21-era releases that
match the repo's current `tree-sitter@^0.21.1` runtime:

- `tree-sitter-python@0.21.0`
- `tree-sitter-go@0.21.2`
- `tree-sitter-rust@0.21.0`
- `tree-sitter-java@0.21.0`
- `tree-sitter-c-sharp@0.21.3`

They remain opt-in because these grammar bindings can require native build
tooling (for example Python + a C/C++ toolchain) during installation. Install
them only when you need polyglot parsing:

```bash
npm run install:polyglot-grammars
```

The script uses `npm install --no-save`, so default installs avoid running the
native grammar build steps and do not widen the baseline dependency surface.

At runtime, `createTreeSitterRuntime()` attempts `require()` for each grammar; if
the module is absent or fails to load, the chunker falls back to heuristic
chunking for that file. `listSupportedTreeSitterLanguages()` returns the subset
currently available.

## Tests

- `tests/retrieval/polyglotChunking.test.ts` now treats an installed grammar as
  required at runtime: if `node_modules` contains the pinned optional dependency
  but the parser still does not advertise support, the test fails loudly instead
  of silently skipping. Environments that do not install the opt-in grammars
  still skip cleanly.
- `tests/retrieval/polyglotFixturePack.test.ts` validates that the retrieval
  fixture pack's polyglot cases reference real fixture files on disk and that
  the opt-in installer keeps the expected grammar versions pinned.
