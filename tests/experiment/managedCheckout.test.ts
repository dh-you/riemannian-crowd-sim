import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { restoreLockedManagedCheckout } from "../../experiments/baselines/bootstrap/managedCheckout";
import { THIRD_PARTY_ROOT } from "../../experiments/baselines/common/thirdParty";

const managedSourceRoot = resolve(THIRD_PARTY_ROOT, "src");
const temporaryCheckouts: string[] = [];

afterEach(() => {
  while (temporaryCheckouts.length > 0) {
    const path = temporaryCheckouts.pop();
    if (path === undefined || !existsSync(path)) continue;
    const realRoot = realpathSync(managedSourceRoot);
    const realTarget = realpathSync(path);
    const relation = relative(realRoot, realTarget);
    if (relation === "" || relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
      throw new Error(`Unsafe managed-checkout test cleanup target: ${realTarget}`);
    }
    rmSync(realTarget, { recursive: true, force: true });
  }
});

describe("managed third-party checkout restoration", () => {
  it("restores tracked content and removes untracked and ignored test artifacts", () => {
    mkdirSync(managedSourceRoot, { recursive: true });
    const checkout = mkdtempSync(resolve(managedSourceRoot, "restore-test-"));
    temporaryCheckouts.push(checkout);
    git(checkout, ["init"]);
    git(checkout, ["config", "user.name", "Stage C.2 Test"]);
    git(checkout, ["config", "user.email", "stage-c2@example.invalid"]);
    writeFileSync(resolve(checkout, ".gitignore"), "ignored/\n", "utf8");
    writeFileSync(resolve(checkout, "tracked.txt"), "locked\n", "utf8");
    git(checkout, ["add", ".gitignore", "tracked.txt"]);
    git(checkout, ["commit", "--no-gpg-sign", "-m", "locked fixture"]);
    const lockedCommit = git(checkout, ["rev-parse", "HEAD"]);

    writeFileSync(resolve(checkout, "tracked.txt"), "rewritten by tests\n", "utf8");
    writeFileSync(resolve(checkout, "untracked.txt"), "generated\n", "utf8");
    mkdirSync(resolve(checkout, "ignored"));
    writeFileSync(resolve(checkout, "ignored", "image.png"), "generated\n", "utf8");

    restoreLockedManagedCheckout({
      source: checkout,
      expectedSource: checkout,
      lockedCommit,
    });

    expect(git(checkout, ["rev-parse", "HEAD"])).toBe(lockedCommit);
    expect(readFileSync(resolve(checkout, "tracked.txt"), "utf8").replaceAll("\r\n", "\n")).toBe("locked\n");
    expect(existsSync(resolve(checkout, "untracked.txt"))).toBe(false);
    expect(existsSync(resolve(checkout, "ignored"))).toBe(false);
    expect(git(checkout, ["status", "--porcelain", "--untracked-files=all"])).toBe("");
  });

  it("rejects a target outside the managed third-party source root", () => {
    expect(() => restoreLockedManagedCheckout({
      source: resolve("."),
      expectedSource: resolve("."),
      lockedCommit: "0".repeat(40),
    })).toThrow(/strict descendant/u);
  });
});

function git(cwd: string, arguments_: readonly string[]): string {
  return execFileSync("git", arguments_, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
