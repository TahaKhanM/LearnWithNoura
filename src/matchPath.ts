/** Matches a path with one or more `:param` segments. */
export function matchPath(pattern: string, path: string): Record<string, string> | null {
  const patternParts = pattern.split('/').filter(Boolean);
  const pathParts = path.split('/').filter(Boolean);
  if (patternParts.length !== pathParts.length) return null;
  const params: Record<string, string> = {};
  for (let index = 0; index < patternParts.length; index += 1) {
    if (patternParts[index].startsWith(':')) params[patternParts[index].slice(1)] = decodeURIComponent(pathParts[index]);
    else if (patternParts[index] !== pathParts[index]) return null;
  }
  return params;
}
