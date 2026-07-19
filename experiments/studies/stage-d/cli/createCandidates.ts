import { pathToFileURL } from "node:url";
import { materializeCandidates } from "../candidates";

function main(): void {
  try {
    const manifest = materializeCandidates();
    const counts = new Map<string, number>();
    for (const candidate of manifest.candidates) {
      counts.set(candidate.methodId, (counts.get(candidate.methodId) ?? 0) + 1);
    }
    console.log(`study:d:candidates materialized ${manifest.candidates.length} configs`);
    for (const [methodId, count] of counts) {
      console.log(`${methodId}: ${count}`);
    }
  } catch (error) {
    console.error(`study:d:candidates failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) main();
