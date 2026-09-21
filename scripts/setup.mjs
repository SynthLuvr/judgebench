#!/usr/bin/env node
// Cross-platform project setup: verifies prerequisites, installs deps, and
// installs the `judgebench` launcher on the PATH (symlink on Unix, .cmd shim
// on Windows). Plain Node ESM — no tsx — so it runs on a fresh clone before
// dependencies are installed. Idempotent; safe to re-run.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIN_MJS = join(ROOT, "bin", "judgebench.mjs");
const IS_WIN = platform() === "win32";
const TTY = process.stdout.isTTY === true;

const codes = {
  bold: "\u001b[1m",
  green: "\u001b[32m",
  red: "\u001b[31m",
  yellow: "\u001b[33m",
  blue: "\u001b[34m",
  cyan: "\u001b[36m",
  reset: "\u001b[0m",
};

if (!TTY) {
  for (const key of Object.keys(codes)) codes[key] = "";
}

const info = (msg) => console.log(`${codes.blue}▶${codes.reset} ${msg}`);
const success = (msg) => console.log(`${codes.green}✔${codes.reset} ${msg}`);
const warn = (msg) => console.log(`${codes.yellow}⚠${codes.reset} ${msg}`);
const heading = (title) =>
  console.log(`\n${codes.bold}${codes.cyan}━━━ ${title} ━━━${codes.reset}`);

const die = (msg) => {
  console.error(`${codes.red}✘${codes.reset} ${msg}`);
  process.exit(1);
};

const majorOf = (version) => {
  const match = /^v?(\d+)/.exec(version);
  return match === null ? 0 : Number(match[1]);
};

// On Windows, pnpm resolves to a .cmd shim that spawnSync cannot execute
// without a shell (CreateProcess only finds .exe). Under `shell` Node
// concatenates args without escaping (DEP0190), so the command line is
// joined here instead — safe because every caller passes fixed, literal
// arguments.
const run = (cmd, args, opts = {}) =>
  IS_WIN
    ? spawnSync([cmd, ...args].join(" "), {
        encoding: "utf8",
        shell: true,
        ...opts,
      })
    : spawnSync(cmd, args, { encoding: "utf8", ...opts });

const checkPlatform = () => {
  heading("Platform Check");
  success(`Running on ${IS_WIN ? "Windows" : platform()}`);
};

const resolveRoot = () => {
  heading("Locate Project Root");
  if (!existsSync(join(ROOT, "package.json")) || !existsSync(BIN_MJS))
    die(
      `Cannot find 'package.json'/'bin/judgebench.mjs' relative to '${ROOT}'.`,
    );
  info(`Project root: ${ROOT}`);
};

const checkNode = () => {
  heading("Checking for Node.js");
  const version = process.versions.node;
  if (majorOf(version) < 24)
    die(`Node.js >= 24 is required (found v${version}).`);
  success(`Node.js found — v${version} (>= 24)`);
};

const checkPnpm = () => {
  heading("Checking for pnpm");
  const probe = run("pnpm", ["--version"]);
  if (probe.error !== undefined || probe.status !== 0)
    die("pnpm (>= 10) is required. Install: npm install -g pnpm@latest");
  const version = probe.stdout.trim();
  if (majorOf(version) < 10)
    die(`Please upgrade pnpm to >= 10 (found v${version}).`);
  success(`pnpm found — v${version} (>= 10)`);
};

const installDeps = () => {
  heading("Installing Node Dependencies (pnpm install)");
  info(`Working directory: ${ROOT}`);
  const frozen = run("pnpm", ["install", "--frozen-lockfile"], {
    cwd: ROOT,
    stdio: "inherit",
  });
  if (frozen.status === 0) {
    success("Dependencies installed");
    return;
  }
  info("Frozen lockfile unavailable — retrying pnpm install...");
  const retry = run("pnpm", ["install"], { cwd: ROOT, stdio: "inherit" });
  if (retry.status === 0) {
    success("Dependencies installed");
    return;
  }
  die("pnpm install failed. See output above.");
};

const binDir = () => join(homedir(), ".local", "bin");

const dirOnPath = (dir) => {
  const norm = (p) => (IS_WIN ? resolve(p).toLowerCase() : resolve(p));
  const target = norm(dir);
  return (process.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .some((p) => norm(p) === target);
};

const readlinkSafe = (target) => {
  if (!existsSync(target)) return undefined;
  try {
    return readlinkSync(target);
  } catch {
    return undefined;
  }
};

const installSymlink = (dir) => {
  const target = join(dir, "judgebench");
  if (readlinkSafe(target) === BIN_MJS) {
    success(`Symlink already correct — ${target} -> ${BIN_MJS}`);
    return;
  }
  if (existsSync(target)) {
    info("Updating existing launcher to point to this project...");
    rmSync(target, { force: true });
  }
  symlinkSync(BIN_MJS, target);
  success(`Symlink created — ${target} -> ${BIN_MJS}`);
};

const installShim = (dir) => {
  const target = join(dir, "judgebench.cmd");
  writeFileSync(target, `@echo off\r\nnode "${BIN_MJS}" %*\r\n`);
  success(`Shim written — ${target}`);
};

const installLauncher = () => {
  heading("Setting Up `judgebench` Command");
  const dir = binDir();
  mkdirSync(dir, { recursive: true });
  const installer = IS_WIN ? installShim : installSymlink;
  installer(dir);
  if (!dirOnPath(dir)) {
    warn(`${dir} is not on your PATH.`);
    info("Add it to your shell profile, then restart your terminal.");
  }
};

const printNextSteps = () => {
  const dir = binDir();
  heading("Setup Complete!");
  console.log(
    `\n${codes.bold}${codes.green}judgebench is ready to use!${codes.reset}\n`,
  );
  console.log("  Get started:\n");
  console.log("    judgebench fetch --dataset canaries");
  console.log("    judgebench validate");
  console.log(
    "    judgebench run --judge openai/gpt-4o-mini --limit 10 --max-cost 1\n",
  );
  if (!dirOnPath(dir)) {
    console.log(
      `  ${codes.yellow}Note:${codes.reset} ${dir} is not on your PATH.`,
    );
    console.log(
      "  Add it to your shell profile or invoke judgebench via its full path:\n",
    );
    console.log(`    ${join(dir, "judgebench")} fetch --dataset canaries\n`);
  }
};

const main = () => {
  checkPlatform();
  resolveRoot();
  checkNode();
  checkPnpm();
  installDeps();
  installLauncher();
  printNextSteps();
};

main();
