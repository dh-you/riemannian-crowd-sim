import { pathToFileURL } from "node:url";
import { runStudyPhase, type PhaseManifest } from "../phaseRunner";
import { phaseManifestPath, readJson } from "../studyPaths";

function requirePassingPhase(phase: string): PhaseManifest {
  const manifest = readJson<PhaseManifest>(phaseManifestPath(phase));
  if (manifest.status !== "PASS") throw new Error(`${phase} is not complete and passing`);
  return manifest;
}

function main(): void {
  try {
    const screening = requirePassingPhase("screening");
    const tuning = runStudyPhase("validation-tuning", screening.retainedCandidateIds);
    if (tuning.status !== "PASS") throw new Error("validation tuning did not pass");
    const holdout = runStudyPhase("validation-holdout", tuning.retainedCandidateIds);
    console.log(
      `study:d:validation ${holdout.status}: tuning ${tuning.completedRuns.length}/${tuning.expectedRunCount}, holdout ${holdout.completedRuns.length}/${holdout.expectedRunCount}`,
    );
  } catch (error) {
    console.error(`study:d:validation failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) main();
