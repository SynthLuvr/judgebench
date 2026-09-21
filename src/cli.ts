#!/usr/bin/env -S tsx
import { pathToFileURL } from "node:url";

import { main } from "./commands/index.ts";

const scriptPath = process.argv[1];

const invokedDirectly =
  scriptPath !== undefined &&
  import.meta.url === pathToFileURL(scriptPath).href;

if (invokedDirectly) {
  const code = await main(process.argv.slice(2));
  process.exitCode = code;
}
