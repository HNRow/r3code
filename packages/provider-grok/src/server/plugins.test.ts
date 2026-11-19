import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import {
  grokPluginEntries,
  makeGrokPluginManagement,
  type GrokInstalledPlugin,
  type GrokInspectedPlugin,
  type GrokPluginRun,
} from "./plugins.ts";

const instanceId = ProviderInstanceId.make("grok");
const cwd = "/repo";
const configHome = "/home/user/.grok";

const inspected: ReadonlyArray<GrokInspectedPlugin> = [
  {
    name: "superpowers",
    scope: "user",
    path: `${configHome}/installed-plugins/superpowers/`,
    enabled: false,
    trusted: true,
    provides: { skills: 7, agents: 2, hooks: true, mcpServers: 1 },
  },
  {
    name: "pstack",
    scope: "user",
    path: `${configHome}/installed-plugins/pstack`,
    enabled: true,
    trusted: true,
    provides: { skills: 0, agents: 0, hooks: false, mcpServers: 0 },
  },
  {
    name: "caveman",
    scope: "user",
    path: "/home/user/.claude/plugins/marketplaces/caveman/plugins/caveman",
    enabled: true,
    trusted: true,
    provides: { skills: 6, agents: 3, hooks: false, mcpServers: 0 },
  },
];

const installed: ReadonlyArray<GrokInstalledPlugin> = [
  {
    status: "installed",
    name: "superpowers",
    repo_key: "superpowers-21e2a56d",
    version: "6.4.2",
    path: `${configHome}/installed-plugins/superpowers/`,
    source: "xai",
    marketplace: "xAI Official",
  },
  {
    status: "installed",
    name: "pstack",
    repo_key: "plugins-git-pstack-87940968",
    version: null,
    path: `${configHome}/installed-plugins/pstack`,
    source: "git",
    marketplace: null,
  },
];

const entriesFor = (extraInstalled: ReadonlyArray<GrokInstalledPlugin> = []) =>
  grokPluginEntries({
    inspected,
    installed: [...installed, ...extraInstalled],
    instanceId,
    cwd,
    configHome,
  });

describe("grokPluginEntries", () => {
  it("maps Grok plugins to inventory entries", () => {
    const entries = entriesFor();
    const superpowers = entries.find((entry) => entry.pluginId === "superpowers");

    assert.isDefined(superpowers);
    assert.equal(superpowers?.version, "6.4.2");
    assert.equal(superpowers?.marketplace, "xAI Official");
    assert.equal(superpowers?.scope, "user");
    assert.deepEqual(superpowers?.components, { skills: 7 });
    assert.deepEqual(superpowers?.actions, { canSetEnabled: true, canUninstall: true });
    assert.isUndefined(entries.find((entry) => entry.pluginId === "pstack")?.version);
  });

  it("takes the enabled state from inspect", () => {
    const entries = entriesFor();

    assert.equal(entries.find((entry) => entry.pluginId === "superpowers")?.state, "disabled");
    assert.equal(entries.find((entry) => entry.pluginId === "pstack")?.state, "enabled");
  });

  it("keeps Claude-sourced plugins read-only", () => {
    const caveman = entriesFor().find((entry) => entry.pluginId === "caveman");

    assert.deepEqual(caveman?.actions, {
      canSetEnabled: false,
      canUninstall: false,
      reason: "Loaded from Claude Code; manage it in Claude Code.",
    });
    assert.deepEqual(caveman?.components, { skills: 6 });
  });

  it("blocks uninstall for plugins sharing a repo", () => {
    const entries = entriesFor([
      {
        status: "installed",
        name: "other",
        repo_key: "plugins-git-pstack-87940968",
        version: null,
        path: `${configHome}/installed-plugins/other`,
        source: "git",
        marketplace: null,
      },
    ]);
    const pstack = entries.find((entry) => entry.pluginId === "pstack");

    assert.isTrue(pstack?.actions.canSetEnabled);
    assert.isFalse(pstack?.actions.canUninstall);
    assert.equal(
      pstack?.actions.reason,
      "Installed together with other plugins; uninstall it with `grok plugin uninstall`.",
    );
  });
});

describe("makeGrokPluginManagement", () => {
  const calls: Array<{ args: ReadonlyArray<string>; cwd: string }> = [];
  const outputs = (args: ReadonlyArray<string>) =>
    args[0] === "inspect" ? JSON.stringify({ plugins: inspected }) : JSON.stringify(installed);
  const run: GrokPluginRun = (args, runCwd) => {
    calls.push({ args, cwd: runCwd });
    return Effect.succeed({ stdout: outputs(args), stderr: "", exitCode: 0 });
  };

  it.effect("runs grok plugin commands with array args", () =>
    Effect.gen(function* () {
      calls.length = 0;
      const management = makeGrokPluginManagement({ configHome, instanceId, run });

      yield* management.setEnabled({
        cwd,
        pluginId: "superpowers",
        scope: "user",
        enabled: true,
      });
      yield* management.setEnabled({
        cwd,
        pluginId: "superpowers",
        scope: "user",
        enabled: false,
      });
      yield* management.uninstall({ cwd, pluginId: "superpowers", scope: "user" });
      yield* management.list(cwd);

      assert.deepEqual(
        calls.map((call) => call.args),
        [
          ["plugin", "enable", "superpowers"],
          ["plugin", "disable", "superpowers"],
          ["plugin", "uninstall", "superpowers", "--keep-data"],
          ["inspect", "--json"],
          ["plugin", "list", "--json"],
        ],
      );
      assert.isTrue(calls.every((call) => call.cwd === cwd));
    }),
  );

  it.effect("reports Grok's error line", () =>
    Effect.gen(function* () {
      const failing: GrokPluginRun = () =>
        Effect.succeed({
          stdout: "",
          stderr:
            'Error: Plugin "nope" not found.\nRun `grok plugin list` to see installed plugins.',
          exitCode: 1,
        });
      const management = makeGrokPluginManagement({ configHome, instanceId, run: failing });

      const error = yield* management
        .uninstall({ cwd, pluginId: "nope", scope: "user" })
        .pipe(Effect.flip);

      assert.equal(error.detail, 'Plugin "nope" not found.');
    }),
  );

  it.effect("fails the list when a grok command fails", () =>
    Effect.gen(function* () {
      const failing: GrokPluginRun = (args) =>
        args[0] === "inspect"
          ? Effect.succeed({ stdout: "not json", stderr: "", exitCode: 0 })
          : Effect.succeed({ stdout: "[]", stderr: "", exitCode: 0 });
      const management = makeGrokPluginManagement({ configHome, instanceId, run: failing });

      const error = yield* management.list(cwd).pipe(Effect.flip);

      assert.isTrue(error._tag === "ProviderDriverError");
    }),
  );

  it.effect("times out a hung grok command", () =>
    Effect.gen(function* () {
      const management = makeGrokPluginManagement({
        configHome,
        instanceId,
        run: () => Effect.never,
      });
      const fiber = yield* Effect.result(management.list(cwd)).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Effect.yieldNow;
      yield* TestClock.adjust("31 seconds");
      const result = yield* Fiber.join(fiber);

      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.include((result.failure as ProviderDriverError).detail, "timed out");
      }
    }),
  );
});
