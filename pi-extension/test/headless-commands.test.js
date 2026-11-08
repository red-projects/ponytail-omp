import assert from "node:assert/strict";
import test from "node:test";

import ponytailExtension from "../index.js";

function createPiHarness() {
  const events = new Map();
  const commands = new Map();
  const appendedEntries = [];
  const sentUserMessages = [];

  const pi = {
    on(eventName, handler) {
      events.set(eventName, handler);
    },
    registerCommand(name, options) {
      commands.set(name, options);
    },
    appendEntry(customType, data) {
      appendedEntries.push({ customType, data });
    },
    sendUserMessage(text, options) {
      sentUserMessages.push({ text, options });
    },
  };

  ponytailExtension(pi);
  return { events, commands, appendedEntries, sentUserMessages };
}

test("/ponytail status: interactive vs no UI", async () => {
  const { commands } = createPiHarness();
  const statusCommand = commands.get("ponytail");
  assert.ok(statusCommand, "ponytail command must be registered");

  // Interactive UI (hasUI: true): notifies successfully, does not throw
  const notified = [];
  const interactiveCtx = {
    hasUI: true,
    ui: {
      notify(msg, level) {
        notified.push({ msg, level });
      },
    },
  };
  await assert.doesNotReject(async () => {
    await statusCommand.handler("status", interactiveCtx);
  });
  assert.equal(notified.length, 1);
  assert.match(notified[0].msg, /^Ponytail: current/);

  // Default test context (hasUI omitted, notify present): notifies, does not throw
  await assert.doesNotReject(async () => {
    await statusCommand.handler("status", { ui: { notify() {} } });
  });

  // Main agent explicitly tagged with UI: notifies, does not throw
  await assert.doesNotReject(async () => {
    await statusCommand.handler("status", { agent: { kind: "main" }, hasUI: true, ui: { notify() {} } });
  });

  // Headless / no UI (hasUI: false): throws clear unsupported error
  const headlessCtx = {
    hasUI: false,
    ui: {
      notify() {
        assert.fail("notify should not be called in headless mode");
      },
    },
  };
  await assert.rejects(
    async () => {
      await statusCommand.handler("status", headlessCtx);
    },
    {
      name: "Error",
      message: /Ponytail: \/ponytail status requires an interactive UI; headless\/no-UI mode has no supported command output path/,
    }
  );

  // Missing notify function: throws clear unsupported error
  await assert.rejects(
    async () => {
      await statusCommand.handler("status", { ui: {} });
    },
    {
      name: "Error",
      message: /Ponytail: \/ponytail status requires an interactive UI/,
    }
  );

  // Empty or undefined context: throws clear unsupported error
  await assert.rejects(
    async () => {
      await statusCommand.handler("status", {});
    },
    {
      name: "Error",
      message: /Ponytail: \/ponytail status requires an interactive UI/,
    }
  );
  await assert.rejects(
    async () => {
      await statusCommand.handler("status", undefined);
    },
    {
      name: "Error",
      message: /Ponytail: \/ponytail status requires an interactive UI/,
    }
  );
});

test("/ponytail-help: interactive vs no UI", async () => {
  const { commands, sentUserMessages } = createPiHarness();
  const helpCommand = commands.get("ponytail-help");
  assert.ok(helpCommand, "ponytail-help command must be registered");

  // Interactive UI: delegates to sendUserMessage, does not throw
  const interactiveCtx = {
    hasUI: true,
    isIdle: () => true,
    ui: { notify() {} },
  };
  await assert.doesNotReject(async () => {
    await helpCommand.handler("", interactiveCtx);
  });
  assert.deepEqual(sentUserMessages.at(-1), {
    text: "/skill:ponytail-help",
    options: { expandPromptTemplates: true },
  });

  // Default test context (hasUI omitted, notify present): delegates, does not throw
  await assert.doesNotReject(async () => {
    await helpCommand.handler("", { isIdle: () => true, ui: { notify() {} } });
  });

  // Headless / no UI (hasUI: false): throws clear unsupported error
  const headlessCtx = {
    hasUI: false,
    isIdle: () => true,
    ui: { notify() {} },
  };
  await assert.rejects(
    async () => {
      await helpCommand.handler("", headlessCtx);
    },
    {
      name: "Error",
      message: /Ponytail: \/ponytail-help requires an interactive UI; headless\/no-UI mode has no supported command output path/,
    }
  );

  // Missing notify function: throws clear unsupported error
  await assert.rejects(
    async () => {
      await helpCommand.handler("", { isIdle: () => true, ui: {} });
    },
    {
      name: "Error",
      message: /Ponytail: \/ponytail-help requires an interactive UI/,
    }
  );
});

test("main vs sub: command execution and unsupported error enforcement", async () => {
  const { commands } = createPiHarness();
  const statusCommand = commands.get("ponytail");
  const helpCommand = commands.get("ponytail-help");

  // Main agent with UI: succeeds
  const mainInteractiveCtx = {
    agent: { kind: "main" },
    hasUI: true,
    isIdle: () => true,
    ui: { notify() {} },
  };
  await assert.doesNotReject(async () => {
    await statusCommand.handler("status", mainInteractiveCtx);
  });
  await assert.doesNotReject(async () => {
    await helpCommand.handler("", mainInteractiveCtx);
  });

  // Main agent without UI: throws
  const mainHeadlessCtx = {
    agent: { kind: "main" },
    hasUI: false,
    isIdle: () => true,
    ui: { notify() {} },
  };
  await assert.rejects(async () => {
    await statusCommand.handler("status", mainHeadlessCtx);
  }, /requires an interactive UI/);
  await assert.rejects(async () => {
    await helpCommand.handler("", mainHeadlessCtx);
  }, /requires an interactive UI/);

  // Subagent: always throws unsupported error regardless of UI mock
  const subagentCtx = {
    agent: { kind: "sub" },
    hasUI: true,
    isIdle: () => true,
    ui: { notify() {} },
  };
  await assert.rejects(async () => {
    await statusCommand.handler("status", subagentCtx);
  }, /requires an interactive UI/);
  await assert.rejects(async () => {
    await helpCommand.handler("", subagentCtx);
  }, /requires an interactive UI/);

  // Subagent without UI: throws unsupported error
  const subagentHeadlessCtx = {
    agent: { kind: "sub" },
    hasUI: false,
    isIdle: () => true,
  };
  await assert.rejects(async () => {
    await statusCommand.handler("status", subagentHeadlessCtx);
  }, /requires an interactive UI/);
  await assert.rejects(async () => {
    await helpCommand.handler("", subagentHeadlessCtx);
  }, /requires an interactive UI/);
});

test("main vs sub: before_agent_start with array and string prompts", async () => {
  const { events } = createPiHarness();
  const beforeAgentStart = events.get("before_agent_start");
  assert.ok(beforeAgentStart, "before_agent_start must be registered");

  const mainCtx = { agent: { kind: "main" }, hasUI: true };
  const subCtx = { agent: { kind: "sub" }, hasUI: false };

  // Main agent: string prompt receives ruleset injection
  const mainStringResult = await beforeAgentStart({ systemPrompt: "BASE_PROMPT" }, mainCtx);
  assert.ok(mainStringResult?.systemPrompt, "main agent string prompt must return systemPrompt");
  assert.ok(typeof mainStringResult.systemPrompt === "string");
  assert.ok(mainStringResult.systemPrompt.startsWith("BASE_PROMPT\n\n"));
  assert.match(mainStringResult.systemPrompt, /PONYTAIL MODE ACTIVE/);

  // Main agent: array prompt receives ruleset as appended part
  const mainArrayResult = await beforeAgentStart({ systemPrompt: ["PART_A", "PART_B"] }, mainCtx);
  assert.ok(Array.isArray(mainArrayResult?.systemPrompt), "main agent array prompt must return array");
  assert.equal(mainArrayResult.systemPrompt.length, 3);
  assert.equal(mainArrayResult.systemPrompt[0], "PART_A");
  assert.equal(mainArrayResult.systemPrompt[1], "PART_B");
  assert.match(mainArrayResult.systemPrompt[2], /PONYTAIL MODE ACTIVE/);

  // Subagent: string prompt is untouched (returns undefined)
  const subStringResult = await beforeAgentStart({ systemPrompt: "BASE_PROMPT" }, subCtx);
  assert.equal(subStringResult, undefined, "subagent string prompt must not be modified");

  // Subagent: array prompt is untouched (returns undefined)
  const subArrayResult = await beforeAgentStart({ systemPrompt: ["PART_A", "PART_B"] }, subCtx);
  assert.equal(subArrayResult, undefined, "subagent array prompt must not be modified");
});
