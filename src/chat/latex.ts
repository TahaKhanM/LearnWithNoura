/**
 * The tutor model writes LaTeX using \( \) and \[ \] delimiters, but
 * remark-math only recognizes $ $ and $$ $$. Convert before rendering.
 */
export function normalizeLatexDelimiters(text: string): string {
  return text
    .replace(/\\\[([\s\S]*?)\\\]/g, (_, expr: string) => `$$${expr}$$`)
    .replace(/\\\(([\s\S]*?)\\\)/g, (_, expr: string) => `$${expr}$`);
}
