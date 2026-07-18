import { closeSync, openSync, readSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

export const JSONL_READ_BUFFER_BYTES = 64 * 1024;

/**
 * Reads JSONL-compatible text without retaining the complete file. Memory is
 * bounded by one input line plus the fixed read buffer.
 */
export function forEachJsonLineSync(
  path: string,
  consume: (line: string, index: number) => void,
): number {
  const descriptor = openSync(path, "r");
  const buffer = Buffer.allocUnsafe(JSONL_READ_BUFFER_BYTES);
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let lineCount = 0;
  try {
    while (true) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      pending += decoder.write(buffer.subarray(0, bytesRead));
      let newlineIndex = pending.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = stripCarriageReturn(pending.slice(0, newlineIndex));
        pending = pending.slice(newlineIndex + 1);
        if (line.length > 0) {
          consume(line, lineCount);
          lineCount += 1;
        }
        newlineIndex = pending.indexOf("\n");
      }
    }
    pending += decoder.end();
    const finalLine = stripCarriageReturn(pending);
    if (finalLine.length > 0) {
      consume(finalLine, lineCount);
      lineCount += 1;
    }
    return lineCount;
  } finally {
    closeSync(descriptor);
  }
}

function stripCarriageReturn(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}
