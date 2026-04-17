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

The non-TypeScript grammar packages are **not** declared in `package.json` today
because:

1. Tree-sitter grammars require native compilation (C toolchain + Python) that
   many CI and developer environments do not have by default.
2. Grammar versions at 0.23.x require a `tree-sitter` major bump from the current
   `^0.21.1`; that bump needs its own validation pass against the existing TS/TSX
   chunker baselines.

Until that upgrade lands, operators who want polyglot parsing can install the
grammars explicitly in their own environment:

```bash
npm install --no-save \
  tree-sitter-python \
  tree-sitter-go \
  tree-sitter-rust \
  tree-sitter-java \
  tree-sitter-c-sharp
```

At runtime, `createTreeSitterRuntime()` attempts `require()` for each grammar; if
the module is absent or fails to load, the chunker silently falls back to
heuristic chunking for that file. `listSupportedTreeSitterLanguages()` returns
the subset currently available.

## Tests

- `tests/retrieval/polyglotChunking.test.ts` exercises each grammar if installed
  and `it.skip`s otherwise (the skip reason is logged). This is intentional — see
  tracking item `p2-polyglot-deps` for the follow-up that declares the grammars
  and upgrades `tree-sitter`.
- `tests/retrieval/polyglotFixturePack.test.ts` validates that the retrieval
  fixture pack's polyglot cases reference real fixture files on disk regardless
  of grammar availability.
