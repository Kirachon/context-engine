import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..", "..");
const PACKAGE_JSON_PATH = resolve(REPO_ROOT, "package.json");
const FIXTURE_PATH = resolve(
  REPO_ROOT,
  "config",
  "ci",
  "retrieval-quality-fixture-pack.json",
);

const NEW_LANGUAGES = ["python", "go", "rust", "java", "csharp"] as const;
const EXPECTED_GRAMMAR_DEPENDENCIES: Record<(typeof NEW_LANGUAGES)[number], string> = {
  python: "tree-sitter-python@0.21.0",
  go: "tree-sitter-go@0.21.2",
  rust: "tree-sitter-rust@0.21.0",
  java: "tree-sitter-java@0.21.0",
  csharp: "tree-sitter-c-sharp@0.21.3",
};

type Case = {
  id: string;
  query: string;
  language?: string;
  file?: string;
  gold_chunk_ranges?: Array<{ start_line: number; end_line: number }>;
  judgments: Array<{ path: string; grade: number }>;
};

function loadPack(): any {
  const raw = readFileSync(FIXTURE_PATH, "utf8");
  return JSON.parse(raw);
}

function collectAllCases(pack: any): Case[] {
  const datasets = pack?.holdout?.datasets ?? {};
  const out: Case[] = [];
  for (const key of Object.keys(datasets)) {
    const cases = datasets[key]?.cases;
    if (Array.isArray(cases)) out.push(...cases);
  }
  return out;
}

describe("polyglot retrieval fixture pack", () => {
  test("JSON still parses and preserves top-level schema keys", () => {
    const pack = loadPack();
    expect(pack.schema_version).toBe(2);
    expect(pack.holdout).toBeDefined();
    expect(pack.holdout.datasets.holdout_v1).toBeDefined();
    expect(Array.isArray(pack.holdout.datasets.holdout_v1.cases)).toBe(true);
    expect(pack.calibration).toBeDefined();
    expect(Array.isArray(pack.checks)).toBe(true);
    expect(pack.gate_rules).toBeDefined();
  });

  test("all case ids are globally unique", () => {
    const pack = loadPack();
    const cases = collectAllCases(pack);
    const ids = cases.map((c) => c.id);
    const seen = new Set<string>();
    const dups: string[] = [];
    for (const id of ids) {
      if (seen.has(id)) dups.push(id);
      seen.add(id);
    }
    expect(dups).toEqual([]);
  });

  test("every polyglot case has existing file and valid gold_chunk_ranges", () => {
    const pack = loadPack();
    const cases = collectAllCases(pack).filter(
      (c) => typeof c.language === "string" &&
        (NEW_LANGUAGES as readonly string[]).includes(c.language!),
    );
    expect(cases.length).toBeGreaterThanOrEqual(10);

    for (const c of cases) {
      expect(typeof c.file).toBe("string");
      const abs = resolve(REPO_ROOT, c.file!);
      expect(existsSync(abs)).toBe(true);

      expect(Array.isArray(c.gold_chunk_ranges)).toBe(true);
      expect(c.gold_chunk_ranges!.length).toBeGreaterThan(0);
      for (const r of c.gold_chunk_ranges!) {
        expect(r.start_line).toBeGreaterThan(0);
        expect(r.end_line).toBeGreaterThanOrEqual(r.start_line);
      }

      expect(Array.isArray(c.judgments)).toBe(true);
      expect(c.judgments.length).toBeGreaterThan(0);
      for (const j of c.judgments) {
        expect(typeof j.path).toBe("string");
        expect(typeof j.grade).toBe("number");
      }
    }
  });

  test("at least one case exists per new language", () => {
    const pack = loadPack();
    const cases = collectAllCases(pack);
    const distribution: Record<string, number> = {};
    for (const c of cases) {
      if (c.language) distribution[c.language] = (distribution[c.language] ?? 0) + 1;
    }
    for (const lang of NEW_LANGUAGES) {
      expect(distribution[lang] ?? 0).toBeGreaterThanOrEqual(2);
    }
    // Snapshot stable language coverage for downstream slicers.
    const covered = NEW_LANGUAGES.filter((l) => (distribution[l] ?? 0) > 0).sort();
    expect(covered).toEqual([...NEW_LANGUAGES].sort());
  });

  test("package.json exposes an opt-in polyglot grammar installer with pinned versions", () => {
    const packageJson = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8")) as {
      scripts?: Record<string, string>;
    };
    const installScript = packageJson.scripts?.["install:polyglot-grammars"];

    expect(typeof installScript).toBe("string");
    expect(installScript).toContain("npm install --no-save");

    for (const lang of NEW_LANGUAGES) {
      expect(installScript).toContain(EXPECTED_GRAMMAR_DEPENDENCIES[lang]);
    }
  });

  test("existing TS/TSX-era cases are preserved (no language field mutation)", () => {
    const pack = loadPack();
    const cases = pack.holdout.datasets.holdout_v1.cases as Case[];
    const legacyIds = [
      "bench-suite-mode-policy",
      "bench-provenance",
      "holdout-validator",
      "quality-report",
      "weekly-trend-report",
    ];
    for (const id of legacyIds) {
      const hit = cases.find((c) => c.id === id);
      expect(hit).toBeDefined();
      expect(hit!.language).toBeUndefined();
      expect(hit!.file).toBeUndefined();
      expect(hit!.gold_chunk_ranges).toBeUndefined();
    }
  });
});
