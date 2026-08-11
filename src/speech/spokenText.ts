/**
 * The tutor writes for the eye: markdown emphasis, LaTeX delimiters,
 * superscripts, bare operators. Read aloud verbatim that becomes noise
 * ("backslash bracket a caret two"). This turns written maths into the
 * words a teacher would actually say.
 */

const SYMBOL_WORDS: [RegExp, string][] = [
  // No word boundary here: JS boundaries only see [A-Za-z0-9_], so "\bπ"
  // never matches after a space.
  [/π/g, ' pi '],
  [/√/g, ' the square root of '],
  [/≈/g, ' is approximately '],
  [/≠/g, ' is not equal to '],
  [/≤/g, ' is less than or equal to '],
  [/≥/g, ' is greater than or equal to '],
  [/×/g, ' times '],
  [/÷/g, ' divided by '],
  [/°/g, ' degrees '],
  [/\s=\s/g, ' equals '],
  [/\s\+\s/g, ' plus '],
  // Only a spaced hyphen is a minus sign. A hyphen inside a word is not.
  [/\s-\s/g, ' minus '],
];

const SUPERSCRIPTS: [RegExp, string][] = [
  [/[²]/g, ' squared '],
  [/[³]/g, ' cubed '],
  [/\^2\b/g, ' squared '],
  [/\^3\b/g, ' cubed '],
  [/\^(\d+)/g, ' to the power of $1 '],
];

export function toSpokenText(input: string): string {
  let text = input;

  // Strip LaTeX delimiters but keep what is inside them.
  text = text.replace(/\\\[|\\\]|\\\(|\\\)/g, ' ');
  text = text.replace(/\$\$?/g, ' ');

  // Common LaTeX commands that carry meaning when spoken.
  text = text.replace(/\\frac\s*\{([^}]*)\}\s*\{([^}]*)\}/g, ' $1 over $2 ');
  text = text.replace(/\\sqrt\s*\{([^}]*)\}/g, ' the square root of $1 ');
  text = text.replace(/\\times/g, ' times ');
  text = text.replace(/\\cdot/g, ' times ');
  text = text.replace(/\\pi/g, ' pi ');
  // Any remaining command is presentational, so drop the backslash name.
  text = text.replace(/\\[a-zA-Z]+/g, ' ');

  // Markdown emphasis, inline code, headings, list bullets, links.
  text = text.replace(/`{1,3}([^`]*)`{1,3}/g, '$1');
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1');
  text = text.replace(/\*([^*]+)\*/g, '$1');
  text = text.replace(/__([^_]+)__/g, '$1');
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  text = text.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  text = text.replace(/^\s*[-*+]\s+/gm, '');

  for (const [pattern, word] of SUPERSCRIPTS) text = text.replace(pattern, word);
  for (const [pattern, word] of SYMBOL_WORDS) text = text.replace(pattern, word);

  // Braces and stray underscores left over from maths markup.
  text = text.replace(/[{}]/g, ' ');
  text = text.replace(/_/g, ' ');

  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Rough spoken duration, used to pace the lesson when speech is muted or
 * unavailable so the rhythm still feels like a person talking.
 */
export function estimateSpeakingMs(text: string): number {
  const words = toSpokenText(text).split(/\s+/).filter(Boolean).length;
  // Around 165 words per minute, with a floor so short lines still land.
  return Math.max(700, Math.round((words / 165) * 60_000));
}
