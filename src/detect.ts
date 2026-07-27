import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { assertValidPort, formatCommand } from "./util";

export type PackageManager = "bun" | "pnpm" | "yarn" | "npm";
export type LifecycleScriptName = "dev" | "start";

export interface ProjectPackageJson {
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export interface LifecycleScript {
  name: LifecycleScriptName;
  command: string;
}

export interface LaunchCommand {
  argv: string[];
  display: string;
  packageManager: PackageManager | null;
  scriptName: LifecycleScriptName | null;
}

export class ProjectDetectionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProjectDetectionError";
  }
}

export function detectPackageManagerFromNames(
  fileNames: Iterable<string>,
): PackageManager {
  const names = new Set(fileNames);

  if (names.has("bun.lock") || names.has("bun.lockb")) {
    return "bun";
  }
  if (names.has("pnpm-lock.yaml")) {
    return "pnpm";
  }
  if (names.has("yarn.lock")) {
    return "yarn";
  }
  if (names.has("package-lock.json")) {
    return "npm";
  }
  return "bun";
}

export async function detectPackageManager(
  cwd: string,
): Promise<PackageManager> {
  return detectPackageManagerFromNames(await readdir(cwd));
}

export function selectLifecycleScript(
  packageJson: ProjectPackageJson,
): LifecycleScript | null {
  const dev = packageJson.scripts?.dev;
  if (typeof dev === "string") {
    return { name: "dev", command: dev };
  }

  const start = packageJson.scripts?.start;
  if (typeof start === "string") {
    return { name: "start", command: start };
  }

  return null;
}

export function isViteOrAstro(
  packageJson: ProjectPackageJson,
  scriptCommand: string,
): boolean {
  if (
    packageJson.devDependencies?.vite !== undefined ||
    packageJson.devDependencies?.astro !== undefined
  ) {
    return true;
  }

  return /(?:^|[\s;&|()])(?:[^\s;&|()]*\/)?(?:vite|astro)(?=$|[\s;&|()])/.test(
    scriptCommand,
  );
}

export function buildLifecycleArgv(
  packageManager: PackageManager,
  scriptName: LifecycleScriptName,
  port: number,
  passPortArgument: boolean,
): string[] {
  assertValidPort(port);

  const argv = [packageManager, "run", scriptName];
  if (!passPortArgument) {
    return argv;
  }

  if (packageManager === "bun") {
    return [...argv, "--port", String(port)];
  }

  return [...argv, "--", "--port", String(port)];
}

export async function readProjectPackageJson(
  cwd: string,
): Promise<ProjectPackageJson> {
  const packagePath = join(cwd, "package.json");
  let source: string;

  try {
    source = await Bun.file(packagePath).text();
  } catch (error) {
    throw new ProjectDetectionError(
      `Cannot read ${packagePath}; use "yado -- <cmd...>" or add package.json`,
      { cause: error },
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new ProjectDetectionError(`Invalid JSON in ${packagePath}`, {
      cause: error,
    });
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProjectDetectionError(`${packagePath} must contain a JSON object`);
  }

  return value as ProjectPackageJson;
}

export async function resolveLaunchCommand(
  cwd: string,
  explicitArgv: readonly string[] | null,
  port: number,
): Promise<LaunchCommand> {
  assertValidPort(port);

  if (explicitArgv !== null) {
    if (explicitArgv.length === 0) {
      throw new ProjectDetectionError(
        'No command follows "--"; provide a command to run',
      );
    }

    const argv = [...explicitArgv];
    return {
      argv,
      display: formatCommand(argv),
      packageManager: null,
      scriptName: null,
    };
  }

  const packageJson = await readProjectPackageJson(cwd);
  const lifecycleScript = selectLifecycleScript(packageJson);
  if (lifecycleScript === null) {
    throw new ProjectDetectionError(
      'package.json has neither a "dev" nor a "start" script',
    );
  }

  const packageManager = await detectPackageManager(cwd);
  const argv = buildLifecycleArgv(
    packageManager,
    lifecycleScript.name,
    port,
    isViteOrAstro(packageJson, lifecycleScript.command),
  );

  return {
    argv,
    display: formatCommand(argv),
    packageManager,
    scriptName: lifecycleScript.name,
  };
}
