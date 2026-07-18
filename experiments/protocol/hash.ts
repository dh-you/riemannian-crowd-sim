import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export function sha256Bytes(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function sha256File(path: string): string {
  return sha256Bytes(readFileSync(path));
}
