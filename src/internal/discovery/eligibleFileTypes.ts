/**
 * R3a — canonical eligible-file-type allowlist.
 *
 * This is a standalone copy of the indexable extension/name allowlist used
 * by the legacy discovery path (`src/mcp/serviceClient.ts`). It is the
 * canonical successor list for the discovery manifest; existing consumers
 * are not migrated to it in this task (see R3b1-3).
 */

/** Bump when the eligibility allowlist or matching semantics change. */
export const ELIGIBLE_FILE_TYPES_ENGINE_VERSION = 'discovery-eligible-types-v1';

/** Special files indexed by exact name (no extension-based matching). */
export const ELIGIBLE_FILE_NAMES: ReadonlySet<string> = new Set([
  'Makefile', 'makefile', 'GNUmakefile', 'Dockerfile', 'dockerfile', 'Containerfile',
  'Jenkinsfile', 'Vagrantfile', 'Procfile', 'Rakefile', 'Gemfile', 'Brewfile',
  '.gitignore', '.gitattributes', '.dockerignore', '.npmrc', '.nvmrc', '.npmignore',
  '.prettierrc', '.eslintrc', '.babelrc', '.browserslistrc', '.editorconfig',
  'tsconfig.json', 'jsconfig.json', 'package.json', 'composer.json', 'pubspec.yaml',
  'analysis_options.yaml', 'pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt',
  'Pipfile', 'Cargo.toml', 'go.mod', 'go.sum', 'build.gradle', 'settings.gradle', 'pom.xml',
  'CMakeLists.txt', 'meson.build', 'WORKSPACE', 'BUILD', 'BUILD.bazel',
]);

/** File extensions eligible for indexing (lower-cased, including the leading dot). */
export const ELIGIBLE_FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.pyw', '.pyi',
  '.java', '.kt', '.kts', '.scala', '.groovy',
  '.go',
  '.rs',
  '.c', '.cpp', '.cc', '.cxx', '.h', '.hpp', '.hxx',
  '.cs', '.fs', '.fsx',
  '.rb', '.rake', '.gemspec',
  '.php',
  '.swift', '.m', '.mm', '.dart', '.arb',
  '.vue', '.svelte', '.astro',
  '.html', '.htm',
  '.css', '.scss', '.sass', '.less', '.styl',
  '.json', '.yaml', '.yml', '.toml', '.xml', '.plist', '.gradle', '.properties',
  '.ini', '.cfg', '.conf', '.editorconfig',
  '.md', '.mdx', '.txt', '.rst',
  '.sql', '.prisma',
  '.graphql', '.gql', '.proto', '.thrift', '.avsc', '.avdl', '.capnp', '.openapi', '.swagger',
  '.sh', '.bash', '.zsh', '.fish', '.ps1', '.psm1', '.bat', '.cmd',
  '.dockerfile', '.tf', '.hcl', '.nix', '.bicep', '.rego', '.cue', '.jsonnet', '.libsonnet',
  '.http', '.rest',
  '.ex', '.exs', '.erl', '.hrl', '.hs', '.lhs', '.clj', '.cljs', '.cljc', '.ml', '.mli',
  '.r', '.jl',
  '.lua', '.pl', '.pm', '.pod', '.tcl',
  '.zig', '.nim', '.cr', '.v',
  '.cmake', '.mk', '.mak', '.bazel', '.bzl', '.ninja', '.sbt', '.podspec', '.sln',
  '.adoc', '.asciidoc', '.tex', '.latex', '.org', '.wiki',
  '.hbs', '.handlebars', '.ejs', '.pug', '.jade', '.jsp', '.erb', '.twig',
  '.kql', '.sol', '.sv', '.vh', '.vhd', '.vhdl', '.cob', '.cbl', '.cpy',
  '.f', '.f90', '.f95', '.f03', '.f08', '.pas', '.pp',
]);

/**
 * Multi-part suffixes checked with `endsWith` rather than `path.extname`,
 * since `path.extname` only returns the final segment (e.g. `.example` for
 * `.env.example`), which would never match a set keyed by the full suffix.
 */
export const ELIGIBLE_FILE_NAME_SUFFIXES: readonly string[] = [
  '.env.example', '.env.template', '.env.sample',
];

/**
 * True when a file's basename/extension is eligible for inclusion in the
 * canonical discovery manifest. This is purely a name/extension allowlist
 * check and is independent of ignore-rule evaluation (which decides
 * exclusion, not inclusion).
 */
export function isEligibleFileName(fileName: string): boolean {
  if (ELIGIBLE_FILE_NAMES.has(fileName)) {
    return true;
  }
  const lowerName = fileName.toLowerCase();
  if (ELIGIBLE_FILE_NAME_SUFFIXES.some((suffix) => lowerName.endsWith(suffix))) {
    return true;
  }
  const dotIndex = lowerName.lastIndexOf('.');
  if (dotIndex <= 0) {
    return false;
  }
  const extension = lowerName.slice(dotIndex);
  return ELIGIBLE_FILE_EXTENSIONS.has(extension);
}
