/**
 * A tiny, safe expression evaluator for plotted functions of x.
 * Recursive descent, no eval, no ambient scope. Supports numbers, x, pi, e,
 * + - * / ^, parentheses, implicit multiplication (2x, 2(x+1), x sin(x)),
 * and a fixed set of math functions.
 */

type Fn = (v: number) => number;

const FUNCTIONS: Record<string, Fn> = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  sqrt: Math.sqrt,
  abs: Math.abs,
  ln: Math.log,
  log: Math.log10,
  exp: Math.exp,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
};

const CONSTANTS: Record<string, number> = {
  pi: Math.PI,
  e: Math.E,
};

type Token =
  | { type: 'num'; value: number }
  | { type: 'ident'; name: string }
  | { type: 'op'; value: string };

function tokenize(source: string): Token[] | null {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9.]/.test(source[j])) j++;
      const value = Number(source.slice(i, j));
      if (!Number.isFinite(value)) return null;
      tokens.push({ type: 'num', value });
      i = j;
      continue;
    }
    if (/[a-zA-Z]/.test(ch)) {
      let j = i;
      while (j < source.length && /[a-zA-Z]/.test(source[j])) j++;
      tokens.push({ type: 'ident', name: source.slice(i, j).toLowerCase() });
      i = j;
      continue;
    }
    if ('+-*/^(),'.includes(ch)) {
      tokens.push({ type: 'op', value: ch });
      i++;
      continue;
    }
    return null;
  }
  return tokens;
}

type Node =
  | { type: 'num'; value: number }
  | { type: 'x' }
  | { type: 'const'; value: number }
  | { type: 'neg'; arg: Node }
  | { type: 'bin'; op: string; left: Node; right: Node }
  | { type: 'call'; fn: Fn; arg: Node };

class Parser {
  private pos = 0;
  private tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private takeOp(value: string): boolean {
    const t = this.peek();
    if (t?.type === 'op' && t.value === value) {
      this.pos++;
      return true;
    }
    return false;
  }

  parse(): Node | null {
    const node = this.expr();
    return node && this.pos === this.tokens.length ? node : null;
  }

  private expr(): Node | null {
    let left = this.term();
    if (!left) return null;
    for (;;) {
      if (this.takeOp('+')) {
        const right = this.term();
        if (!right) return null;
        left = { type: 'bin', op: '+', left, right };
      } else if (this.takeOp('-')) {
        const right = this.term();
        if (!right) return null;
        left = { type: 'bin', op: '-', left, right };
      } else return left;
    }
  }

  private term(): Node | null {
    let left = this.unary();
    if (!left) return null;
    for (;;) {
      if (this.takeOp('*')) {
        const right = this.unary();
        if (!right) return null;
        left = { type: 'bin', op: '*', left, right };
      } else if (this.takeOp('/')) {
        const right = this.unary();
        if (!right) return null;
        left = { type: 'bin', op: '/', left, right };
      } else {
        // Implicit multiplication: a number/paren/ident directly followed
        // by an ident, number, or open paren.
        const t = this.peek();
        if (t && (t.type === 'num' || t.type === 'ident' || (t.type === 'op' && t.value === '('))) {
          const right = this.unary();
          if (!right) return null;
          left = { type: 'bin', op: '*', left, right };
        } else return left;
      }
    }
  }

  private unary(): Node | null {
    if (this.takeOp('-')) {
      const arg = this.unary();
      return arg ? { type: 'neg', arg } : null;
    }
    if (this.takeOp('+')) return this.unary();
    return this.power();
  }

  private power(): Node | null {
    const base = this.atom();
    if (!base) return null;
    if (this.takeOp('^')) {
      // Right associative: 2^3^2 = 2^(3^2).
      const exponent = this.unary();
      if (!exponent) return null;
      return { type: 'bin', op: '^', left: base, right: exponent };
    }
    return base;
  }

  private atom(): Node | null {
    const t = this.peek();
    if (!t) return null;
    if (t.type === 'num') {
      this.pos++;
      return { type: 'num', value: t.value };
    }
    if (t.type === 'ident') {
      this.pos++;
      if (t.name === 'x') return { type: 'x' };
      if (t.name in CONSTANTS) return { type: 'const', value: CONSTANTS[t.name] };
      if (t.name in FUNCTIONS) {
        const fn = FUNCTIONS[t.name];
        if (!this.takeOp('(')) return null;
        const arg = this.expr();
        if (!arg || !this.takeOp(')')) return null;
        return { type: 'call', fn, arg };
      }
      return null;
    }
    if (t.type === 'op' && t.value === '(') {
      this.pos++;
      const inner = this.expr();
      if (!inner || !this.takeOp(')')) return null;
      return inner;
    }
    return null;
  }
}

function evaluate(node: Node, x: number): number {
  switch (node.type) {
    case 'num':
    case 'const':
      return node.value;
    case 'x':
      return x;
    case 'neg':
      return -evaluate(node.arg, x);
    case 'call':
      return node.fn(evaluate(node.arg, x));
    case 'bin': {
      const l = evaluate(node.left, x);
      const r = evaluate(node.right, x);
      switch (node.op) {
        case '+':
          return l + r;
        case '-':
          return l - r;
        case '*':
          return l * r;
        case '/':
          return l / r;
        case '^':
          return Math.pow(l, r);
        default:
          return NaN;
      }
    }
  }
}

/**
 * Compiles an expression in x into an evaluator, or null if the expression
 * is not valid. `y =` / `f(x) =` prefixes are tolerated since models often
 * include them.
 */
export function compileExpression(source: string): ((x: number) => number) | null {
  const cleaned = source
    .replace(/^\s*(y|f\s*\(\s*x\s*\))\s*=\s*/i, '')
    .trim();
  if (!cleaned || cleaned.length > 200) return null;
  const tokens = tokenize(cleaned);
  if (!tokens || tokens.length === 0) return null;
  const ast = new Parser(tokens).parse();
  if (!ast) return null;
  return (x: number) => evaluate(ast, x);
}
