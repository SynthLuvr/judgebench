import { describe, expect, it, vi } from "vitest";
import { flagString } from "../commands/context";
import {
  emitJson,
  emitText,
  log,
  progress,
  progressDone,
  verboseLog,
} from "../io/output";

describe("output discipline", () => {
  it("writes --json payloads to stdout only", () => {
    const chunks: string[] = [];
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        chunks.push(String(chunk));
        return true;
      });
    emitJson({ ok: true });
    write.mockRestore();
    expect(chunks).toEqual([`${JSON.stringify({ ok: true }, null, 2)}\n`]);
  });

  it("terminates text output with a newline exactly once", () => {
    const chunks: string[] = [];
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        chunks.push(String(chunk));
        return true;
      });
    emitText("plain");
    emitText("already\n");
    write.mockRestore();
    expect(chunks).toEqual(["plain\n", "already\n"]);
  });

  it("logs diagnostics to stderr", () => {
    const lines: string[] = [];
    const error = vi
      .spyOn(console, "error")
      .mockImplementation((...parts: unknown[]) => {
        lines.push(parts.map(String).join(" "));
      });
    log("one", 2);
    verboseLog(true, "debug");
    verboseLog(false, "hidden");
    progress("halfway");
    progressDone();
    error.mockRestore();
    expect(lines).toContain("one 2");
    expect(lines).toContain("debug");
    expect(lines).not.toContain("hidden");
    expect(lines.some((line) => line.includes("halfway"))).toBe(true);
  });

  it("flagString coerces without object stringification", () => {
    expect(flagString("x")).toBe("x");
    expect(flagString(3)).toBe("3");
    expect(flagString({ object: true })).toBe('{"object":true}');
  });
});
