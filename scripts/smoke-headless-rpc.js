#!/usr/bin/env bun
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const EXTENSION_PATH = resolve(import.meta.dir, "../pi-extension/index.js");

function resolveOmpBinary() {
  const pathEnv = process.env.PATH || "";
  for (const dir of pathEnv.split(":")) {
    if (!dir) continue;
    const candidate = join(dir, "omp");
    try {
      return realpathSync(candidate);
    } catch {}
  }
  throw new Error("Unable to resolve absolute realpath of 'omp' binary from PATH");
}

const OMP_BINARY = resolveOmpBinary();

const FORBIDDEN_AGENT_EVENT_TYPES = new Set([
  "agent_start",
  "agent_end",
  "message_start",
  "message_delta",
  "message_end",
  "tool_call",
  "tool_result",
  "model_request",
  "model_response",
]);

const activeTempDirs = new Set();
function cleanupAllTempDirs() {
  for (const dir of activeTempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      console.error(`Failed to clean up temp directory ${dir}:`, err);
    }
  }
  activeTempDirs.clear();
}

process.on("exit", cleanupAllTempDirs);
process.on("SIGINT", () => {
  cleanupAllTempDirs();
  process.exit(130);
});
process.on("SIGTERM", () => {
  cleanupAllTempDirs();
  process.exit(143);
});

function runOmpRpc({ noUi = false, messages = [] } = {}) {
  return new Promise((res, rej) => {
    const tempHome = mkdtempSync(join(tmpdir(), "omp-smoke-rpc-"));
    activeTempDirs.add(tempHome);

    // Create minimal hermetic model definition inside tempHome so OMP starts without host dependencies or API keys
    const agentDir = join(tempHome, ".omp/agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, "models.yml"),
      "providers:\n  dummy:\n    baseUrl: http://127.0.0.1:9999/v1\n    api: openai-completions\n    auth: none\n    models:\n      - id: dummy-model\n        name: Dummy\n"
    );

    const args = [
      "--model",
      "dummy/dummy-model",
      "--mode",
      "rpc",
    ];
    if (noUi) args.push("--no-ui");
    args.push(
      "--no-extensions",
      "-e",
      EXTENSION_PATH,
      "--no-session",
      "--no-tools",
      "--no-context-files",
      "--no-skills",
      "--no-rules",
      "--no-lsp"
    );

    // All XDG_* variables strictly rooted in tempHome; zero host paths or API keys
    const cleanEnv = {
      PATH: process.env.PATH || "/bin:/usr/bin",
      HOME: tempHome,
      XDG_CONFIG_HOME: join(tempHome, ".config"),
      XDG_DATA_HOME: join(tempHome, ".local/share"),
      XDG_STATE_HOME: join(tempHome, ".local/state"),
      XDG_CACHE_HOME: join(tempHome, ".cache"),
      USER: "nobody",
      LANG: "C.UTF-8",
      TERM: "dumb",
      TMPDIR: tempHome,
    };

    let stdout = "";
    let stderr = "";
    let lineBuffer = "";
    let proc;
    let settled = false;

    const cleanup = () => {
      activeTempDirs.delete(tempHome);
      rmSync(tempHome, { recursive: true, force: true });
    };

    // Hard 20s child watchdog cleanup
    const watchdog = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (proc) {
        try {
          proc.kill("SIGKILL");
        } catch {}
      }
      try {
        cleanup();
      } catch (err) {
        console.error("Cleanup error after watchdog:", err);
      }
      rej(new Error("OMP RPC child process timed out after 20 seconds"));
    }, 20_000);

    try {
      proc = spawn(OMP_BINARY, args, {
        cwd: tempHome,
        env: cleanEnv,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      clearTimeout(watchdog);
      cleanup();
      return rej(err);
    }

    const expectedPromptIds = new Set(messages.map(m => m.id));
    const seenPromptResults = new Set();

    proc.stdout.on("data", chunk => {
      const str = chunk.toString();
      stdout += str;
      lineBuffer += str;

      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop();

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const frame = JSON.parse(line);
          if (frame.type === "prompt_result" && expectedPromptIds.has(frame.id)) {
            seenPromptResults.add(frame.id);
            if (seenPromptResults.size === expectedPromptIds.size) {
              proc.stdin.end();
            }
          }
        } catch {}
      }
    });

    proc.stderr.on("data", chunk => {
      stderr += chunk.toString();
    });

    for (const msg of messages) {
      proc.stdin.write(`${JSON.stringify(msg)}\n`);
    }

    proc.on("error", err => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      try {
        cleanup();
      } catch (cleanErr) {
        console.error("Cleanup error on process error:", cleanErr);
      }
      rej(err);
    });

    proc.on("close", code => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      try {
        cleanup();
      } catch (cleanErr) {
        return rej(cleanErr);
      }
      res({ code, stdout, stderr });
    });
  });
}

function parseFrames(stdout) {
  const lines = stdout.trim().split("\n").filter(Boolean);
  const nonJson = [];
  const frames = [];

  for (const line of lines) {
    try {
      frames.push(JSON.parse(line));
    } catch {
      nonJson.push(line);
    }
  }

  return { lines, nonJson, frames };
}

function assertNoAgentOrModelEvents(frames) {
  for (const frame of frames) {
    assert.ok(
      !FORBIDDEN_AGENT_EVENT_TYPES.has(frame.type),
      `Forbidden agent or model event observed: ${frame.type}`
    );
  }
}

async function main() {
  console.log("Running hermetic opt-in OMP RPC integration smoke tests...");
  console.log(`Using resolved OMP binary: ${OMP_BINARY}`);

  // Scenario 1: Headless / No-UI RPC mode
  console.log("1. Checking --mode rpc --no-ui with /ponytail status and /ponytail-help...");
  const headlessResult = await runOmpRpc({
    noUi: true,
    messages: [
      { id: "s1", type: "prompt", message: "/ponytail status" },
      { id: "s2", type: "prompt", message: "/ponytail-help" },
    ],
  });

  assert.equal(headlessResult.code, 0, "OMP RPC process must exit 0");
  const headless = parseFrames(headlessResult.stdout);
  assert.equal(headless.nonJson.length, 0, "RPC stdout must contain 0 non-JSON lines (no stream corruption)");
  assertNoAgentOrModelEvents(headless.frames);

  const statusErrors = headless.frames.filter(
    f => f.type === "extension_error" && f.extensionPath === "command:ponytail"
  );
  assert.equal(statusErrors.length, 1, "Must emit 1 extension_error for /ponytail status");
  assert.match(
    statusErrors[0].error,
    /Ponytail: \/ponytail status requires an interactive UI; headless\/no-UI mode has no supported command output path/
  );

  const helpErrors = headless.frames.filter(
    f => f.type === "extension_error" && f.extensionPath === "command:ponytail-help"
  );
  assert.equal(helpErrors.length, 1, "Must emit 1 extension_error for /ponytail-help");
  assert.match(
    helpErrors[0].error,
    /Ponytail: \/ponytail-help requires an interactive UI; headless\/no-UI mode has no supported command output path/
  );

  const uiRequestsInNoUi = headless.frames.filter(f => f.type === "extension_ui_request");
  assert.equal(uiRequestsInNoUi.length, 0, "No extension_ui_request frames in --no-ui mode");

  const s1Result = headless.frames.find(f => f.type === "prompt_result" && f.id === "s1");
  assert.ok(s1Result, "Prompt s1 must emit prompt_result frame");
  assert.equal(s1Result.agentInvoked, false, "Prompt s1 must have agentInvoked: false");
  assert.equal(s1Result.status, "completed", "Prompt s1 status must be completed");

  const s2Result = headless.frames.find(f => f.type === "prompt_result" && f.id === "s2");
  assert.ok(s2Result, "Prompt s2 must emit prompt_result frame");
  assert.equal(s2Result.agentInvoked, false, "Prompt s2 must have agentInvoked: false");
  assert.equal(s2Result.status, "completed", "Prompt s2 status must be completed");

  console.log("   ✓ Headless no-UI correctly emits extension_error frames and agentInvoked: false");

  // Scenario 2: Interactive RPC mode (UI available)
  console.log("2. Checking interactive --mode rpc with /ponytail status...");
  const interactiveResult = await runOmpRpc({
    noUi: false,
    messages: [{ id: "i1", type: "prompt", message: "/ponytail status" }],
  });

  assert.equal(interactiveResult.code, 0, "OMP RPC process must exit 0");
  const interactive = parseFrames(interactiveResult.stdout);
  assert.equal(interactive.nonJson.length, 0, "Interactive RPC stdout must contain 0 non-JSON lines");
  assertNoAgentOrModelEvents(interactive.frames);

  const interactiveErrors = interactive.frames.filter(f => f.type === "extension_error");
  assert.equal(interactiveErrors.length, 0, "Interactive mode must emit 0 extension_error frames");

  const notifyFrames = interactive.frames.filter(
    f => f.type === "extension_ui_request" && f.method === "notify" && /Ponytail: current/.test(f.message || "")
  );
  assert.ok(notifyFrames.length >= 1, "Interactive mode must emit extension_ui_request notify frame for status");

  const i1Result = interactive.frames.find(f => f.type === "prompt_result" && f.id === "i1");
  assert.ok(i1Result, "Prompt i1 must emit prompt_result frame");
  assert.equal(i1Result.agentInvoked, false, "Prompt i1 must have agentInvoked: false");
  assert.equal(i1Result.status, "completed", "Prompt i1 status must be completed");

  console.log("   ✓ Interactive RPC correctly emits extension_ui_request notify intact and agentInvoked: false");

  console.log("\nAll OMP RPC integration smoke checks passed successfully!");
}

main().catch(err => {
  console.error("OMP RPC smoke test failed:", err);
  process.exit(1);
});
