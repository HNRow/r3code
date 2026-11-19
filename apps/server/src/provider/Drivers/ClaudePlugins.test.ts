import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import type { SkillInventoryEntry } from "@t3tools/contracts";

import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import {
  claudePluginEntries,
  makeClaudePluginManagement,
  parseClaudePluginList,
} from "./ClaudePlugins.ts";

const instanceId = ProviderInstanceId.make("claude");
const cwd = "/repo";
const configHome = "/home/user/.claude";

const driverError = (detail: string) =>
  new ProviderDriverError({
    driver: ProviderDriverKind.make("claudeAgent"),
    instanceId,
    detail,
  });

const skill = (name: string, containerId: string): SkillInventoryEntry => ({
  instanceId: "claude",
  cwd,
  nativeId: `plugin:${containerId}/${name}`,
  name: `${containerId}:${name}`,
  source: {
    kind: "plugin",
    scope: "managed",
    path: `/plugins/${containerId}/${name}`,
    containerId,
  },
  state: "enabled",
  actions: { canSetEnabled: false, canUninstall: false },
});

const listed = (overrides: Record<string, unknown> = {}) => ({
  id: "superpowers@claude-plugins-official",
  version: "7.0.2",
  scope: "user" as const,
  enabled: true,
  installPath: "/home/user/.claude/plugins/cache/superpowers/7.0.2",
  ...overrides,
});

describe("parseClaudePluginList", () => {
  it("parses ids, notes and components", () => {
    const parsed = parseClaudePluginList(
      JSON.stringify([
        listed(),
        listed({
          id: "caveman@caveman",
          scope: "project",
          projectPath: "/repo",
          mcpServers: ["context7"],
          notes: ["Managed by policy"],
        }),
      ]),
    );

    assert.equal(parsed.length, 2);
    assert.deepEqual(parsed[0], {
      id: "superpowers@claude-plugins-official",
      version: "7.0.2",
      scope: "user",
      enabled: true,
      installPath: "/home/user/.claude/plugins/cache/superpowers/7.0.2",
    });
    assert.deepEqual(parsed[1], {
      id: "caveman@caveman",
      version: "7.0.2",
      scope: "project",
      enabled: true,
      installPath: "/home/user/.claude/plugins/cache/superpowers/7.0.2",
      projectPath: "/repo",
      mcpServers: ["context7"],
      notes: ["Managed by policy"],
    });
  });
});

describe("claudePluginEntries", () => {
  it("counts plugin skills by plugin name", () => {
    const entries = claudePluginEntries({
      listed: [listed()],
      pluginSkills: [skill("one", "superpowers"), skill("two", "superpowers")],
      instanceId,
      cwd,
      configHome,
    });

    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.pluginId, "superpowers@claude-plugins-official");
    assert.equal(entries[0]?.name, "superpowers");
    assert.equal(entries[0]?.marketplace, "claude-plugins-official");
    assert.equal(entries[0]?.version, "7.0.2");
    assert.equal(entries[0]?.scope, "user");
    assert.equal(entries[0]?.state, "enabled");
    assert.deepEqual(entries[0]?.components, { skills: 2 });
    assert.deepEqual(entries[0]?.actions, { canSetEnabled: true, canUninstall: true });
  });

  it("names mcp servers whether the CLI reports a record or a list", () => {
    const fromRecord = parseClaudePluginList(
      JSON.stringify([listed({ mcpServers: { context7: { type: "stdio" }, other: {} } })]),
    );
    const fromList = parseClaudePluginList(JSON.stringify([listed({ mcpServers: ["context7"] })]));

    assert.deepEqual(fromRecord[0]?.mcpServers, ["context7", "other"]);
    assert.deepEqual(fromList[0]?.mcpServers, ["context7"]);
  });

  it("passes mcp servers through as components", () => {
    const entries = claudePluginEntries({
      listed: [listed({ mcpServers: ["context7"] })],
      pluginSkills: [],
      instanceId,
      cwd,
      configHome,
    });

    assert.deepEqual(entries[0]?.components?.mcpServers, ["context7"]);
  });

  it("managed scope is read-only", () => {
    const entries = claudePluginEntries({
      listed: [listed({ scope: "managed" })],
      pluginSkills: [],
      instanceId,
      cwd,
      configHome,
    });

    assert.isFalse(entries[0]?.actions.canSetEnabled);
    assert.isFalse(entries[0]?.actions.canUninstall);
    assert.isString(entries[0]?.actions.reason);
  });

  it("plugin skills without a CLI entry become read-only entries", () => {
    const entries = claudePluginEntries({
      listed: [],
      pluginSkills: [skill("unlisted", "synced-tool")],
      instanceId,
      cwd,
      configHome,
    });

    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.pluginId, "synced-tool");
    assert.equal(entries[0]?.name, "synced-tool");
    assert.deepEqual(entries[0]?.actions, {
      canSetEnabled: false,
      canUninstall: false,
      reason: "Not managed by claude plugin; manage it at its source.",
    });
  });

  it("drops project installs of other workspaces", () => {
    const entries = claudePluginEntries({
      listed: [
        listed({ id: "here@m", scope: "project", projectPath: cwd }),
        listed({ id: "elsewhere@m", scope: "project", projectPath: "/other/repo" }),
      ],
      pluginSkills: [],
      instanceId,
      cwd,
      configHome,
    });

    assert.deepEqual(
      entries.map((entry) => entry.pluginId),
      ["here@m"],
    );
  });
});

describe("makeClaudePluginManagement", () => {
  const management = (run: Parameters<typeof makeClaudePluginManagement>[0]["run"]) =>
    makeClaudePluginManagement({
      configHome,
      instanceId,
      run,
      listSkills: () => Effect.succeed([]),
    });

  it.effect("setEnabled passes explicit scope", () =>
    Effect.gen(function* () {
      const calls: Array<{ args: ReadonlyArray<string>; cwd: string }> = [];
      const handler = management((args, runCwd) => {
        calls.push({ args, cwd: runCwd });
        return Effect.succeed({ stdout: "{}", stderr: "", exitCode: 0 });
      });

      yield* handler.setEnabled({ cwd, pluginId: "x@m", scope: "project", enabled: false });

      assert.deepEqual(calls, [
        { args: ["plugin", "disable", "x@m", "--scope", "project", "--json"], cwd },
      ]);
    }),
  );

  it.effect("uninstall keeps data without pruning", () =>
    Effect.gen(function* () {
      const calls: Array<ReadonlyArray<string>> = [];
      const handler = management((args) => {
        calls.push(args);
        return Effect.succeed({ stdout: "{}", stderr: "", exitCode: 0 });
      });

      yield* handler.uninstall({ cwd, pluginId: "x@m", scope: "user" });

      assert.deepEqual(calls, [
        ["plugin", "uninstall", "x@m", "--scope", "user", "--keep-data", "--json"],
      ]);
    }),
  );

  it.effect("keeps the plugin list when the skill scan fails", () =>
    Effect.gen(function* () {
      const handler = makeClaudePluginManagement({
        configHome,
        instanceId,
        run: () =>
          Effect.succeed({
            stdout: JSON.stringify([listed()]),
            stderr: "",
            exitCode: 0,
          }),
        listSkills: () =>
          Effect.fail(
            new ProviderDriverError({
              driver: ProviderDriverKind.make("claudeAgent"),
              instanceId,
              detail: "skill scan exploded",
            }),
          ),
      });

      const result = yield* handler.list(cwd);

      assert.equal(result.entries.length, 1);
      assert.isUndefined(result.entries[0]?.components);
      assert.isTrue(result.diagnostics.some((line) => line.includes("skill scan exploded")));
    }),
  );

  it.effect("non-zero exit fails with the last stderr line", () =>
    Effect.gen(function* () {
      const handler = management(() =>
        Effect.succeed({
          stdout: "",
          stderr: "warning: no marketplace\nerror: unknown command 'list'",
          exitCode: 1,
        }),
      );

      const error = yield* handler.list(cwd).pipe(Effect.flip);

      assert.equal(error._tag, "ProviderDriverError");
      assert.include((error as ProviderDriverError).detail, "error: unknown command 'list'");
    }),
  );
});

describe("provider driver error", () => {
  it("carries the driver name for the adapter", () => {
    assert.equal(driverError("boom").detail, "boom");
  });
});
