/**
 * Chunks off the network do not respect line boundaries, so a decoder has
 * to hold the tail of a partial line until the rest of it arrives.
 */
export class NdjsonParser {
  private buffer = '';

  /** Returns the complete JSON values contained in this chunk. */
  push(chunk: string): unknown[] {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    // The final entry is whatever came after the last newline, which may
    // be an incomplete line. Keep it for the next chunk.
    this.buffer = lines.pop() ?? '';
    return this.parseAll(lines);
  }

  /** Flushes any trailing value left without a newline at end of stream. */
  flush(): unknown[] {
    const remaining = this.buffer;
    this.buffer = '';
    return this.parseAll([remaining]);
  }

  private parseAll(lines: string[]): unknown[] {
    const values: unknown[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        values.push(JSON.parse(trimmed));
      } catch {
        // A malformed line should not kill the rest of the lesson.
      }
    }
    return values;
  }
}
