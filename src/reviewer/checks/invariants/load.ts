import fs from 'fs';
import path from 'path';
import YAML from 'yaml';
import type { InvariantsConfig, ReviewInvariant } from './types.js';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeInvariant(raw: unknown): ReviewInvariant | null {
  if (!isObject(raw)) return null;

  const id = typeof raw.id === 'string' ? raw.id : undefined;
  const rule = typeof raw.rule === 'string' ? raw.rule : undefined;
  const paths = Array.isArray(raw.paths) ? raw.paths.filter(p => typeof p === 'string') : undefined;
  const severity = typeof raw.severity === 'string' ? raw.severity : undefined;
  const category = typeof raw.category === 'string' ? raw.category : undefined;

  if (!id || !rule || !paths || paths.length === 0 || !severity || !category) return null;

  const action = typeof raw.action === 'string' ? raw.action : undefined;
  const when = isObject(raw.when) ? raw.when : undefined;
  const require = isObject(raw.require) ? raw.require : undefined;
  const deny = isObject(raw.deny) ? raw.deny : undefined;

  return {
    id,
    rule,
    paths,
    severity: severity as ReviewInvariant['severity'],
    category: category as ReviewInvariant['category'],
    action: action as ReviewInvariant['action'],
    when: when as ReviewInvariant['when'],
    require: require as ReviewInvariant['require'],
    deny: deny as ReviewInvariant['deny'],
  };
}

export function loadInvariantsConfig(workspacePath: string, invariantsPath: string): InvariantsConfig {
  const resolved =
    path.isAbsolute(invariantsPath) ? invariantsPath : path.join(workspacePath, invariantsPath);

  if (!fs.existsSync(resolved)) {
    throw new Error(`Invariants file not found: ${resolved}`);
  }

  const rawText = fs.readFileSync(resolved, 'utf-8');
  const parsed = YAML.parse(rawText) as unknown;

  if (!isObject(parsed)) {
    throw new Error('Invalid invariants config: expected a mapping object');
  }

  const config: InvariantsConfig = {};
  for (const [section, value] of Object.entries(parsed)) {
    if (!Array.isArray(value)) continue;
    const invariants: ReviewInvariant[] = [];
    for (const entry of value) {
      const inv = normalizeInvariant(entry);
      if (inv) invariants.push(inv);
    }
    if (invariants.length > 0) config[section] = invariants;
  }

  return config;
}

