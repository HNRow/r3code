import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import {
  kimiPluginActionPath,
  kimiPluginEntries,
  kimiWebArgs,
  makeKimiPluginManagement,
  pickRunningKimiServer,
  type KimiListedPlugin,
  type KimiPluginRequest,
} from "./kimiPlugins.ts";

const instanceId = ProviderInstanceId.make("acpRegistry_kimi_code");
const cwd = "/repo";
const configHome = "/home/user/.kimi-code";

const listed = {
  code: 0,
  msg: "success",
  data: {
    plugins: [
      {
        id: "kimi-datasource",
        displayName: "Kimi Datasource",
        version: "3.3.0",
        enabled: true,
        state: "ok",
        skillCount: 1,
        mcpServerCount: 1,
        hasErrors: false,
        source: "zip-url",
      },
      {
        id: "superpowers",
        displayName: "Superpowers",
        version: "6.1.1",
        enabled: false,
        state: "ok",
        skillCount: 14,
        mcpServerCount: 0,
        hasErrors: false,
        source: "github",
      },
    ],
  },
};

const listedPlugins: ReadonlyArray<KimiListedPlugin> = listed.data.plugins;

const driverError = (detail: string) =>
  new ProviderDriverError({ driver: "acpRegistry" as never, instanceId, detail });

describe("kimiPluginEntries", () => {
  it("maps Kimi plugins to inventory entries", () => {
    const entries = kimiPluginEntries(listedPlugins, { instanceId, cwd, configHome });

    assert.equal(entries.length, 2);
    assert.deepEqual(entries[1], {
      instanceId,
      cwd,
      configHome,
      pluginId: "superpowers",
      name: "Superpowers",
      version: "6.1.1",
      scope: "user",
      state: "disabled",
      components: { skills: 14 },
      notes: [],
      actions: { canSetEnabled: true, canUninstall: true },
    });
    assert.equal(entries[0]?.state, "enabled");
    assert.deepEqual(entries[0]?.components, { skills: 1 });
  });

  it("notes a plugin Kimi reports as broken", () => {
    const broken: ReadonlyArray<KimiListedPlugin> = [
      {
        id: "broken",
        enabled: true,
        state: "error",
        skillCount: 0,
        mcpServerCount: 0,
        hasErrors: true,
        source: "github",
      },
    ];
    const entries = kimiPluginEntries(broken, { instanceId, cwd, configHome });

    assert.deepEqual(entries[0]?.notes, ["Kimi reports a problem with this plugin."]);
  });
});

describe("makeKimiPluginManagement", () => {
  const calls: Array<{ method: "GET" | "POST"; path: string }> = [];
  const request: KimiPluginRequest = (input) => {
    calls.push(input);
    return Effect.succeed(listed);
  };

  it.effect("sends enable, disable and remove to the action route", () =>
    Effect.gen(function* () {
      calls.length = 0;
      const management = makeKimiPluginManagement({ configHome, instanceId, request });

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

      assert.deepEqual(calls, [
        { method: "POST", path: "/plugins/superpowers:enable" },
        { method: "POST", path: "/plugins/superpowers:disable" },
        { method: "POST", path: "/plugins/superpowers:remove" },
      ]);
      assert.equal(kimiPluginActionPath("a b", "disable"), "/plugins/a%20b:disable");
    }),
  );

  it.effect("fails with Kimi's message when the envelope code is not 0", () =>
    Effect.gen(function* () {
      const failing: KimiPluginRequest = () =>
        Effect.succeed({
          code: 40419,
          msg: 'Plugin "nope" is not installed',
          stack: "Error2: boom",
        });
      const management = makeKimiPluginManagement({ configHome, instanceId, request: failing });

      const error = yield* management
        .uninstall({ cwd, pluginId: "nope", scope: "user" })
        .pipe(Effect.flip);

      assert.equal(error.detail, 'Plugin "nope" is not installed');
      assert.notInclude(error.detail, "Error2");
    }),
  );

  it.effect("fails a mutation on a non-envelope body", () =>
    Effect.gen(function* () {
      const management = makeKimiPluginManagement({
        configHome,
        instanceId,
        request: () => Effect.succeed({ unexpected: true }),
      });

      const error = yield* management
        .setEnabled({ cwd, pluginId: "superpowers", scope: "user", enabled: false })
        .pipe(Effect.flip);

      assert.equal(error.detail, "Could not read Kimi's response.");
    }),
  );

  it.effect("rejects a malformed plugin list", () =>
    Effect.gen(function* () {
      const management = makeKimiPluginManagement({
        configHome,
        instanceId,
        request: () => Effect.succeed({ code: 0, data: {} }),
      });

      const error = yield* management.list(cwd).pipe(Effect.flip);

      assert.equal(error.detail, "Could not read Kimi's plugin list.");
    }),
  );

  it.effect("surfaces a transport failure as a list error", () =>
    Effect.gen(function* () {
      const failure = driverError("Kimi server refused the connection.");
      const management = makeKimiPluginManagement({
        configHome,
        instanceId,
        request: () => Effect.fail(failure),
      });

      const error = yield* management.list(cwd).pipe(Effect.flip);

      assert.equal(error, failure);
    }),
  );

  it.effect("times out a hung Kimi server", () =>
    Effect.gen(function* () {
      const management = makeKimiPluginManagement({
        configHome,
        instanceId,
        request: () => Effect.never,
      });
      const fiber = yield* Effect.result(management.list(cwd)).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Effect.yieldNow;
      yield* TestClock.adjust("31 seconds");
      const result = yield* Fiber.join(fiber);

      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(
          (result.failure as ProviderDriverError).detail,
          "Kimi plugin request timed out.",
        );
      }
    }),
  );
});

describe("kimiWebArgs", () => {
  it("builds web args only for a kimi acp launch", () => {
    assert.deepEqual(kimiWebArgs(["acp"], 4123), [
      "web",
      "--no-open",
      "--port",
      "4123",
      "--log-level",
      "silent",
    ]);
    assert.isUndefined(kimiWebArgs(["acp", "--x"], 1));
    assert.isUndefined(kimiWebArgs([], 1));
  });
});

describe("pickRunningKimiServer", () => {
  it("reuses only a live loopback Kimi server", () => {
    assert.equal(
      pickRunningKimiServer([{ pid: 1, host: "127.0.0.1", port: 58627 }], (pid) => pid === 1),
      "http://127.0.0.1:58627",
    );
    assert.equal(
      pickRunningKimiServer([{ pid: 2, host: "0.0.0.0", port: 4100 }], () => true),
      "http://127.0.0.1:4100",
    );
    assert.equal(
      pickRunningKimiServer([{ pid: 3, host: "localhost", port: 4100 }], () => true),
      "http://127.0.0.1:4100",
    );
    assert.isUndefined(
      pickRunningKimiServer([{ pid: 4, host: "127.0.0.1", port: 1 }], () => false),
    );
    assert.isUndefined(pickRunningKimiServer([{ pid: 5, host: "10.0.0.5", port: 1 }], () => true));
    assert.isUndefined(pickRunningKimiServer([{ pid: 6, host: "127.0.0.1" }], () => true));
  });
});
