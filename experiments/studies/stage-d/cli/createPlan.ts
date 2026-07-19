import { pathToFileURL } from "node:url";
import { planFileHashes, verifyPreregisteredPlan } from "../studyPaths";

function main(): void {
  try {
    const plan = verifyPreregisteredPlan();
    console.log(`study:d:plan verified ${plan.studyId}`);
    console.log(JSON.stringify(planFileHashes()));
  } catch (error) {
    console.error(`study:d:plan failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) main();
