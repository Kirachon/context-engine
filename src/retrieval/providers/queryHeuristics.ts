export function isOperationalDocsQuery(query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  const docsIntent = /\b(how to|how do i|how do we|install|installation|setup|configure|configuration|quickstart|get started|getting started|client setup|add server|codex mcp|mcp add|mcp install|windows|linux|mac)\b/i;
  const codeIntent = /\b(function|class|interface|factory|provider|handler|module|implementation|code|test|benchmark|ranking|symbol|rerank|query|search)\b/i;

  return docsIntent.test(normalized) && !codeIntent.test(normalized);
}
