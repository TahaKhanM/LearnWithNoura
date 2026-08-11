import { describe, expect, it } from 'vitest';
import { NdjsonParser } from './ndjson';

describe('NdjsonParser', () => {
  it('parses whole lines in one chunk', () => {
    const p = new NdjsonParser();
    expect(p.push('{"a":1}\n{"a":2}\n')).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('holds a partial line until the rest arrives', () => {
    const p = new NdjsonParser();
    expect(p.push('{"a":')).toEqual([]);
    expect(p.push('1}\n')).toEqual([{ a: 1 }]);
  });

  it('handles a value split across three chunks', () => {
    const p = new NdjsonParser();
    expect(p.push('{"ty')).toEqual([]);
    expect(p.push('pe":"st')).toEqual([]);
    expect(p.push('ep"}\n')).toEqual([{ type: 'step' }]);
  });

  it('handles several values arriving in one chunk', () => {
    const p = new NdjsonParser();
    const out = p.push('{"n":1}\n{"n":2}\n{"n":3}\n');
    expect(out).toHaveLength(3);
  });

  it('flushes a trailing value with no final newline', () => {
    const p = new NdjsonParser();
    expect(p.push('{"a":1}')).toEqual([]);
    expect(p.flush()).toEqual([{ a: 1 }]);
  });

  it('skips blank lines', () => {
    const p = new NdjsonParser();
    expect(p.push('\n\n{"a":1}\n\n')).toEqual([{ a: 1 }]);
  });

  it('skips a malformed line without losing the good ones around it', () => {
    const p = new NdjsonParser();
    expect(p.push('{"a":1}\nNOT JSON\n{"a":2}\n')).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('returns nothing on flush when the buffer is empty', () => {
    expect(new NdjsonParser().flush()).toEqual([]);
  });
});
