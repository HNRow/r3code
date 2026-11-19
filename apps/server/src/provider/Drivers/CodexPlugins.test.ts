import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { ProviderInstanceId } from "@t3tools/contracts";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import type * as CodexSchema from "effect-codex-app-server/schema";

import {
  codexPluginEntries,
  makeCodexPluginManagement,
  type CodexPluginRequest,
} from "./CodexPlugins.ts";

const instanceId = ProviderInstanceId.make("codex");
const cwd = "/repo";
const configHome = "/home/user/.codex";

const summary = (overrides: Record<string, unknown> = {}) => ({
  id: "documents@openai-primary-runtime",
  name: "documents",
  enabled: true,
  installed: true,
  installPolicy: "AVAILABLE" as const,
  source: "OFFICIAL" as const,
  ...overrides,
});

const installedResponse = (plugins: ReadonlyArray<Record<string, unknown>>) =>
  ({
    marketplaces: [{ name: "openai-primary-runtime", plugins }],
  }) as unknown as CodexSchema.V2PluginInstalledResponse;

describe("codexPluginEntries", () => {
  it("keeps only installed plugins", () => {
    const entries = codexPluginEntries(
      installedResponse([summary(), summary({ installed: false })]),
      {
        instanceId,
        cwd,
        configHome,
      },
    );

    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.pluginId, "documents@openai-primary-runtime");
    assert.equal(entries[0]?.name, "documents");
    assert.equal(entries[0]?.marketplace, "openai-primary-runtime");
    assert.equal(entries[0]?.scope, "user");
    assert.deepEqual(entries[0]?.actions, { canSetEnabled: true, canUninstall: true });
  });

  it("installed by default can disable but not uninstall", () => {
    const entries = codexPluginEntries(
      installedResponse([summary({ installPolicy: "INSTALLED_BY_DEFAULT" })]),
      { instanceId, cwd, configHome },
    );

    assert.isTrue(entries[0]?.actions.canSetEnabled);
    assert.isFalse(entries[0]?.actions.canUninstall);
    assert.isString(entries[0]?.actions.reason);
  });

  it("workspace setting is read-only", () => {
    const entries = codexPluginEntries(
      installedResponse([summary({ installPolicySource: "WORKSPACE_SETTING" })]),
      { instanceId, cwd, configHome },
    );

    assert.isFalse(entries[0]?.actions.canSetEnabled);
    assert.isFalse(entries[0]?.actions.canUninstall);
  });
});

describe("makeCodexPluginManagement", () => {
  const calls: Array<{ method: string; params: unknown }> = [];
  const request: CodexPluginRequest = (method, params) => {
    calls.push({ method, params });
    return Effect.succeed({} as never);
  };

  it.effect("setEnabled upserts the plugins table", () =>
    Effect.gen(function* () {
      calls.length = 0;
      const management = makeCodexPluginManagement({ configHome, request, instanceId });

      yield* management.setEnabled({
        cwd,
        pluginId: "documents@openai-primary-runtime",
        scope: "user",
        enabled: false,
      });

      assert.deepEqual(calls, [
        {
          method: "config/value/write",
          params: {
            keyPath: "plugins",
            mergeStrategy: "upsert",
            value: { "documents@openai-primary-runtime": { enabled: false } },
          },
        },
      ]);
    }),
  );

  it.effect("uninstall sends plugin id", () =>
    Effect.gen(function* () {
      calls.length = 0;
      const management = makeCodexPluginManagement({ configHome, request, instanceId });

      yield* management.uninstall({ cwd, pluginId: "x@m", scope: "user" });

      assert.deepEqual(calls, [{ method: "plugin/uninstall", params: { pluginId: "x@m" } }]);
    }),
  );
});

it.effect("times out a hung app-server", () =>
  Effect.gen(function* () {
    const management = makeCodexPluginManagement({
      configHome,
      instanceId,
      request: () => Effect.never,
    });
    const fiber = yield* Effect.result(management.list(cwd)).pipe(
      Effect.forkChild({ startImmediately: true }),
    );
    yield* Effect.yieldNow;
    yield* TestClock.adjust("21 seconds");
    const result = yield* Fiber.join(fiber);

    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") assert.instanceOf(result.failure, ProviderDriverError);
  }),
);
