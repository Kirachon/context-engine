export function filterByThreshold<T>(items: T[], getScore: (item: T) => number, threshold: number): T[] {
  return items.filter(item => getScore(item) >= threshold);
}

export function filterByAllowedValues<T, V extends string>(
  items: T[],
  getValue: (item: T) => V,
  allowed?: readonly V[]
): T[] {
  if (!allowed || allowed.length === 0) return items;
  const set = new Set(allowed);
  return items.filter(item => set.has(getValue(item)));
}

export function excludeById<T>(items: T[], getId: (item: T) => string, excludeIds?: readonly string[]): T[] {
  const list = (excludeIds ?? []).filter(Boolean);
  if (list.length === 0) return items;
  const set = new Set(list);
  return items.filter(item => !set.has(getId(item)));
}

export function limitToMax<T>(items: T[], max: number): T[] {
  return items.slice(0, Math.max(0, max));
}

