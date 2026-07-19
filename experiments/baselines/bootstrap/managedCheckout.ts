import { existsSync, lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  REPOSITORY_ROOT,
  THIRD_PARTY_ROOT,
  command,
  gitHead,
} from "../common/thirdParty";

export interface ManagedCheckoutRestoration {
  source: string;
  expectedSource: string;
  lockedCommit: string;
}

/**
 * Restores only an explicitly identified checkout below experiments/third_party/src.
 * The destructive Git operations are unreachable until identity, containment,
 * symlink, repository, and pinned-HEAD checks have all succeeded.
 */
export function restoreLockedManagedCheckout({
  source,
  expectedSource,
  lockedCommit,
}: ManagedCheckoutRestoration): void {
  if (!/^[a-f0-9]{40}$/u.test(lockedCommit)) {
    throw new Error("Managed checkout restoration requires a full locked commit SHA");
  }

  const sourcePath = resolve(source);
  const expectedPath = resolve(expectedSource);
  const managedRoot = resolve(THIRD_PARTY_ROOT, "src");
  if (!samePath(sourcePath, expectedPath)) {
    throw new Error("Refusing to restore a checkout other than the expected locked source");
  }
  assertStrictDescendant(managedRoot, expectedPath, "managed third-party source root");
  assertNoSymlinkComponents(REPOSITORY_ROOT, expectedPath);
  if (!existsSync(resolve(expectedPath, ".git"))) {
    throw new Error(`Managed checkout has no .git metadata: ${expectedPath}`);
  }

  const realManagedRoot = realpathSync(managedRoot);
  const realSource = realpathSync(expectedPath);
  assertStrictDescendant(realManagedRoot, realSource, "real managed third-party source root");
  if (gitHead(realSource) !== lockedCommit) {
    throw new Error("Refusing to restore a managed checkout whose HEAD differs from the lock");
  }

  const gitArguments = gitArgumentsFor(realSource);
  command("git", [...gitArguments, "reset", "--hard", lockedCommit], { capture: true });
  command("git", [...gitArguments, "clean", "-fdx"], { capture: true });

  if (gitHead(realSource) !== lockedCommit) {
    throw new Error("Managed checkout HEAD changed during restoration");
  }
  assertLockedCheckoutClean(realSource);
}

export function assertLockedCheckoutClean(source: string): void {
  const sourcePath = realpathSync(source);
  const gitArguments = gitArgumentsFor(sourcePath);
  const status = command(
    "git",
    [...gitArguments, "status", "--porcelain", "--untracked-files=all"],
    { capture: true },
  );
  if (status !== "") {
    throw new Error(`Restored managed checkout is not clean: ${status}`);
  }
  const ignored = command(
    "git",
    [...gitArguments, "ls-files", "--others", "--ignored", "--exclude-standard"],
    { capture: true },
  );
  if (ignored !== "") {
    throw new Error(`Restored managed checkout contains ignored artifacts: ${ignored}`);
  }
}

function gitArgumentsFor(source: string): string[] {
  return ["-c", `safe.directory=${source.replaceAll("\\", "/")}`, "-C", source];
}

function assertStrictDescendant(parent: string, child: string, description: string): void {
  const relation = relative(parent, child);
  if (relation === "" || relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new Error(`Managed checkout must be a strict descendant of the ${description}`);
  }
}

function assertNoSymlinkComponents(parent: string, child: string): void {
  const relation = relative(parent, child);
  if (relation === "" || relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new Error("Managed checkout path is outside the repository");
  }
  let current = resolve(parent);
  if (lstatSync(current).isSymbolicLink()) {
    throw new Error(`Managed checkout path contains a symbolic link: ${current}`);
  }
  for (const component of relation.split(sep)) {
    current = resolve(current, component);
    if (lstatSync(current).isSymbolicLink()) {
      throw new Error(`Managed checkout path contains a symbolic link: ${current}`);
    }
  }
}

function samePath(first: string, second: string): boolean {
  return process.platform === "win32"
    ? first.toLowerCase() === second.toLowerCase()
    : first === second;
}
