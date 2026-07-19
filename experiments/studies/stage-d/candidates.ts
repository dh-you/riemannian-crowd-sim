import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { identifyMethod } from "../../protocol/methodIdentity";
import {
  parseMethodConfig,
  type MethodConfig,
  type OrcaMethodConfig,
  type RiemannianMethodConfig,
  type SocialForceMethodConfig,
} from "../../protocol/methodConfig";
import { sha256File } from "../../protocol/hash";
import {
  CANDIDATE_MANIFEST_PATH,
  CANDIDATE_SPACE_PATH,
  RESULTS_ROOT,
  currentGitHead,
  phaseManifestPath,
  planFileHashes,
  readJson,
  verifyPreregisteredPlan,
  writeJson,
} from "./studyPaths";

interface RiemannianDefinition {
  candidateId: string;
  alpha: number;
  sigma: number;
  rho: number;
  velocityTimeConstant: number;
}

interface CandidateSpace {
  candidateSpaceVersion: 1;
  methods: {
    conditioned_riemannian_metric_v1: {
      candidateCount: number;
      fixed: { lambdaT: number };
      candidates: RiemannianDefinition[];
    };
    orca_rvo2_v1: {
      candidateCount: number;
      grid: {
        neighborDist: number[];
        maxNeighbors: number[];
        timeHorizon: number[];
      };
    };
    social_force_pysocialforce_v1: {
      candidateCount: number;
      grid: {
        relaxationTime: number[];
        socialFactor: number[];
        obstacleFactor: number[];
      };
      fixed: Omit<SocialForceMethodConfig["parameters"], "relaxationTime" | "socialFactor" | "obstacleFactor">;
    };
  };
}

export interface CandidateManifestEntry {
  candidateId: string;
  methodId: MethodConfig["id"];
  methodKey: string;
  path: string;
  methodConfigCanonicalSha256: string;
  methodConfigSourceSha256: string;
}

export interface CandidateManifest {
  candidateManifestVersion: 1;
  repositoryCommit: string;
  planHashes: Record<string, string>;
  candidateSpaceSha256: string;
  candidates: CandidateManifestEntry[];
}

export function materializeCandidates(): CandidateManifest {
  verifyPreregisteredPlan();
  if (existsSync(phaseManifestPath("screening"))) {
    throw new Error("Refusing to recreate candidates after screening has begun");
  }
  const space = readJson<CandidateSpace>(CANDIDATE_SPACE_PATH);
  if (space.candidateSpaceVersion !== 1) throw new Error("Unsupported candidate space");
  const definitions: Array<{ candidateId: string; config: MethodConfig }> = [];
  const riemannian = space.methods.conditioned_riemannian_metric_v1;
  for (const candidate of riemannian.candidates) {
    const config: RiemannianMethodConfig = {
      methodConfigVersion: 1,
      id: "conditioned_riemannian_metric_v1",
      velocityTimeConstant: candidate.velocityTimeConstant,
      parameters: {
        alpha: candidate.alpha,
        sigma: candidate.sigma,
        lambdaR: candidate.rho * riemannian.fixed.lambdaT,
        lambdaT: riemannian.fixed.lambdaT,
      },
    };
    definitions.push({ candidateId: candidate.candidateId, config: parseMethodConfig(config) });
  }
  const orca = space.methods.orca_rvo2_v1;
  for (const neighborDist of orca.grid.neighborDist) {
    for (const maxNeighbors of orca.grid.maxNeighbors) {
      for (const timeHorizon of orca.grid.timeHorizon) {
        const candidateId = `orca-n${neighborDist}-m${maxNeighbors}-h${timeHorizon}`;
        const config: OrcaMethodConfig = {
          methodConfigVersion: 2,
          id: "orca_rvo2_v1",
          engine: "orca_rvo2_engine_v1",
          parameters: { neighborDist, maxNeighbors, timeHorizon, timeHorizonObst: timeHorizon },
        };
        definitions.push({ candidateId, config: parseMethodConfig(config) });
      }
    }
  }
  const social = space.methods.social_force_pysocialforce_v1;
  for (const relaxationTime of social.grid.relaxationTime) {
    for (const socialFactor of social.grid.socialFactor) {
      for (const obstacleFactor of social.grid.obstacleFactor) {
        const candidateId = `sfm-r${relaxationTime}-s${socialFactor}-o${obstacleFactor}`;
        const config: SocialForceMethodConfig = {
          methodConfigVersion: 2,
          id: "social_force_pysocialforce_v1",
          engine: "pysocialforce_engine_v1",
          parameters: { ...social.fixed, relaxationTime, socialFactor, obstacleFactor },
        };
        definitions.push({ candidateId, config: parseMethodConfig(config) });
      }
    }
  }
  const expectedCounts = new Map<string, number>([
    ["conditioned_riemannian_metric_v1", riemannian.candidateCount],
    ["orca_rvo2_v1", orca.candidateCount],
    ["social_force_pysocialforce_v1", social.candidateCount],
  ]);
  for (const [methodId, expected] of expectedCounts) {
    const actual = definitions.filter(({ config }) => config.id === methodId).length;
    if (actual !== expected || actual > 18) {
      throw new Error(`Candidate count mismatch for ${methodId}: expected ${expected}, received ${actual}`);
    }
  }

  const root = resolve(RESULTS_ROOT, "candidates/configs");
  mkdirSync(root, { recursive: true });
  const entries = definitions.map(({ candidateId, config }): CandidateManifestEntry => {
    const path = resolve(root, config.id, `${candidateId}.json`);
    mkdirSync(resolve(root, config.id), { recursive: true });
    const source = `${JSON.stringify(config, null, 2)}\n`;
    if (existsSync(path) && readFileSync(path, "utf8") !== source) {
      throw new Error(`Existing candidate config differs from preregistration: ${path}`);
    }
    writeFileSync(path, source, "utf8");
    const identity = identifyMethod(config, source);
    return {
      candidateId,
      methodId: config.id,
      methodKey: identity.methodKey,
      path,
      methodConfigCanonicalSha256: identity.methodConfigCanonicalSha256,
      methodConfigSourceSha256: identity.methodConfigSourceSha256,
    };
  }).sort((first, second) =>
    first.methodId.localeCompare(second.methodId) || first.candidateId.localeCompare(second.candidateId));
  if (new Set(entries.map(({ methodKey }) => methodKey)).size !== entries.length) {
    throw new Error("Candidate materialization produced duplicate method keys");
  }
  const manifest: CandidateManifest = {
    candidateManifestVersion: 1,
    repositoryCommit: currentGitHead(),
    planHashes: planFileHashes(),
    candidateSpaceSha256: sha256File(CANDIDATE_SPACE_PATH),
    candidates: entries,
  };
  writeJson(CANDIDATE_MANIFEST_PATH, manifest);
  return manifest;
}

export function readCandidateManifest(): CandidateManifest {
  const manifest = readJson<CandidateManifest>(CANDIDATE_MANIFEST_PATH);
  if (manifest.candidateManifestVersion !== 1) throw new Error("Unsupported candidate manifest");
  if (manifest.candidateSpaceSha256 !== sha256File(CANDIDATE_SPACE_PATH)) {
    throw new Error("Candidate manifest no longer matches candidate-space.json");
  }
  for (const candidate of manifest.candidates) {
    const source = readFileSync(candidate.path, "utf8");
    const config = parseMethodConfig(JSON.parse(source) as unknown);
    const identity = identifyMethod(config, source);
    if (identity.methodKey !== candidate.methodKey
      || identity.methodConfigCanonicalSha256 !== candidate.methodConfigCanonicalSha256
      || identity.methodConfigSourceSha256 !== candidate.methodConfigSourceSha256) {
      throw new Error(`Candidate identity mismatch: ${candidate.candidateId}`);
    }
  }
  return manifest;
}
