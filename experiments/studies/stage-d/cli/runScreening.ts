import { pathToFileURL } from "node:url";
import { runStudyPhase } from "../phaseRunner";

function main(): void {
  try {
    const manifest = runStudyPhase("screening");
    console.log(
      `study:d:screen ${manifest.status}: ${manifest.completedRuns.length}/${manifest.expectedRunCount} runs; retained ${manifest.retainedCandidateIds.length}`,
    );
  } catch (error) {
    console.error(`study:d:screen failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) main();
