import { readdirSync, statSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { sha256File } from "../protocol/hash";

export function writeAuditInventory(auditRootSource: string): {
  fileCount: number;
  csvPath: string;
  jsonPath: string;
} {
  const auditRoot = resolve(auditRootSource);
  const csvPath = resolve(auditRoot, "inventory.csv");
  const jsonPath = resolve(auditRoot, "inventory.json");
  const files = findAllFiles(auditRoot)
    .filter((path) => path !== csvPath && path !== jsonPath)
    .map((path) => ({
      path: relative(auditRoot, path).replaceAll("\\", "/"),
      bytes: statSync(path).size,
      sha256: sha256File(path),
    }));
  const csv = [
    "path,bytes,sha256",
    ...files.map((entry) => `${csvCell(entry.path)},${entry.bytes},${entry.sha256}`),
  ].join("\n") + "\n";
  writeFileSync(csvPath, csv, "utf8");
  writeFileSync(jsonPath, `${JSON.stringify({ inventoryVersion: 1, files }, null, 2)}\n`, "utf8");
  return { fileCount: files.length, csvPath, jsonPath };
}

function findAllFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? findAllFiles(path) : [path];
  }).sort();
}

function csvCell(value: string): string {
  return /[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}
