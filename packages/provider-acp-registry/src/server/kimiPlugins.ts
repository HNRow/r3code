import * as Net from "@t3tools/shared/Net";
import { Effect, Fiber, Schema, Stream } from "effect";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Deferred from "effect/Deferred";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import type { PluginInventoryEntry, PluginScope, ProviderInstanceId } from "@t3tools/contracts";
import { ProviderDriverKind } from "@t3tools/contracts";
import type { ProviderPluginManagement } from "@t3tools/provider-core/server/driver";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";

const KIMI_DRIVER = ProviderDriverKind.make("acpRegistry");
const KIMI_PLUGIN_TIMEOUT = "30 seconds";

export type KimiPluginRequest = (input: {
  readonly method: "GET" | "POST";
  readonly path: string;
}) => Effect.Effect<unknown, ProviderDriverError>;

const KimiEnvelope = Schema.Struct({
  code: Schema.Number,
  msg: Schema.optionalKey(Schema.String),
  data: Schema.optionalKey(Schema.Unknown),
});

const KimiListedPluginSchema = Schema.Struct({
  id: Schema.String,
  displayName: Schema.optionalKey(Schema.String),
  version: Schema.optionalKey(Schema.String),
  enabled: Schema.Boolean,
  state: Schema.optionalKey(Schema.String),
  skillCount: Schema.optionalKey(Schema.Number),
  mcpServerCount: Schema.optionalKey(Schema.Number),
  hasErrors: Schema.optionalKey(Schema.Boolean),
  source: Schema.optionalKey(Schema.String),
  originalSource: Schema.optionalKey(Schema.String),
});
export type KimiListedPlugin = typeof KimiListedPluginSchema.Type;

const KimiPluginList = Schema.Struct({
  plugins: Schema.Array(KimiListedPluginSchema),
});
const KimiServerRecord = Schema.Struct({
  pid: Schema.Number,
  host: Schema.optionalKey(Schema.String),
  port: Schema.optionalKey(Schema.Number),
});

const decodeEnvelope = Schema.decodeUnknownSync(KimiEnvelope);
const decodePluginList = Schema.decodeUnknownSync(KimiPluginList);
const decodeServerRecord = Schema.decodeUnknownSync(KimiServerRecord);

function kimiError(instanceId: ProviderInstanceId, detail: string, cause?: unknown) {
  return new ProviderDriverError({
    driver: KIMI_DRIVER,
    instanceId,
    detail,
    ...(cause === undefined ? {} : { cause }),
  });
}

export function kimiPluginActionPath(
  pluginId: string,
  action: "enable" | "disable" | "remove",
): string {
  return `/plugins/${encodeURIComponent(pluginId)}:${action}`;
}

export function kimiWebArgs(
  acpArgs: ReadonlyArray<string>,
  port: number,
): ReadonlyArray<string> | undefined {
  // 只有原样以 `kimi acp` 启动时，同一个可执行文件才等价于 `kimi web`。
  if (acpArgs.length !== 1 || acpArgs[0] !== "acp") return undefined;
  return ["web", "--no-open", "--port", String(port), "--log-level", "silent"];
}

export function pickRunningKimiServer(
  records: ReadonlyArray<unknown>,
  isAlive: (pid: number) => boolean,
): string | undefined {
  for (const raw of records) {
    const record = decodeServerRecordSafely(raw);
    if (record === undefined) continue;
    if (record.port === undefined || !Number.isInteger(record.port) || record.port <= 0) continue;
    if (!isAlive(record.pid)) continue;
    const host = record.host ?? "127.0.0.1";
    if (host !== "127.0.0.1" && host !== "0.0.0.0" && host !== "localhost" && host !== "::1") {
      continue;
    }
    return `http://127.0.0.1:${record.port}`;
  }
  return undefined;
}

function decodeServerRecordSafely(
  raw: unknown,
): Schema.Schema.Type<typeof KimiServerRecord> | undefined {
  try {
    return decodeServerRecord(raw);
  } catch {
    return undefined;
  }
}

export function kimiPluginEntries(
  plugins: ReadonlyArray<KimiListedPlugin>,
  context: {
    readonly instanceId: ProviderInstanceId;
    readonly cwd: string;
    readonly configHome: string;
  },
): ReadonlyArray<PluginInventoryEntry> {
  return plugins.map((plugin) => {
    const broken = plugin.state === "error" || plugin.hasErrors === true;
    const skills = plugin.skillCount;
    return {
      instanceId: context.instanceId,
      cwd: context.cwd,
      configHome: context.configHome,
      pluginId: plugin.id,
      name: plugin.displayName ?? plugin.id,
      ...(plugin.version === undefined ? {} : { version: plugin.version }),
      scope: "user" as PluginScope,
      state: plugin.enabled ? "enabled" : "disabled",
      ...(skills === undefined || skills <= 0 ? {} : { components: { skills } }),
      notes: broken ? ["Kimi reports a problem with this plugin."] : [],
      actions: { canSetEnabled: true, canUninstall: true },
    } satisfies PluginInventoryEntry;
  });
}

export function makeKimiPluginManagement(input: {
  readonly configHome: string;
  readonly instanceId: ProviderInstanceId;
  readonly request: KimiPluginRequest;
}): ProviderPluginManagement {
  const request = (method: "GET" | "POST", path: string) =>
    input
      .request({ method, path })
      .pipe(
        Effect.timeoutOption(KIMI_PLUGIN_TIMEOUT),
        Effect.flatMap(
          Effect.fromOption(() => kimiError(input.instanceId, "Kimi plugin request timed out.")),
        ),
      );

  const decodeEnvelopeOrFail = (
    body: unknown,
  ): Effect.Effect<Schema.Schema.Type<typeof KimiEnvelope>, ProviderDriverError> =>
    Effect.try({
      try: () => decodeEnvelope(body),
      catch: () => kimiError(input.instanceId, "Could not read Kimi's response."),
    });

  const action = (method: "GET" | "POST", path: string): Effect.Effect<void, ProviderDriverError> =>
    request(method, path).pipe(
      Effect.flatMap(decodeEnvelopeOrFail),
      Effect.flatMap((envelope) =>
        envelope.code === 0
          ? Effect.void
          : Effect.fail(kimiError(input.instanceId, envelope.msg ?? "Kimi rejected the request.")),
      ),
    );

  return {
    configHome: input.configHome,
    list: (cwd) =>
      request("GET", "/plugins").pipe(
        Effect.flatMap(decodeEnvelopeOrFail),
        Effect.flatMap((envelope) => {
          if (envelope.code !== 0) {
            return Effect.fail(
              kimiError(input.instanceId, envelope.msg ?? "Kimi rejected the request."),
            );
          }
          try {
            const decoded = decodePluginList(envelope.data);
            return Effect.succeed({
              entries: kimiPluginEntries(decoded.plugins, {
                instanceId: input.instanceId,
                cwd,
                configHome: input.configHome,
              }),
              diagnostics: [],
            });
          } catch {
            return Effect.fail(kimiError(input.instanceId, "Could not read Kimi's plugin list."));
          }
        }),
      ),
    // Kimi 的插件没有范围，scope 与 cwd 只用于契约形状。
    setEnabled: (mutation) =>
      action(
        "POST",
        kimiPluginActionPath(mutation.pluginId, mutation.enabled ? "enable" : "disable"),
      ),
    uninstall: (mutation) => action("POST", kimiPluginActionPath(mutation.pluginId, "remove")),
  };
}

const KIMI_READY_LINE = "Kimi server ready";
const KIMI_LOOPBACK = "127.0.0.1";

// 只连 loopback 的 Kimi server，不需要 Effect HttpClient 的中间件。
// @effect-diagnostics globalFetchInEffect:off

const JsonFile = Schema.fromJsonString(Schema.Unknown);
const decodeJsonFile = Schema.decodeEffect(JsonFile);

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "EPERM";
  }
}

const readInstanceRecords = Effect.fn("KimiPluginManagement.readInstances")(function* (
  instancesDirectory: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries = yield* fileSystem
    .readDirectory(instancesDirectory)
    .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
  const records: Array<unknown> = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const contents = yield* fileSystem
      .readFileString(path.join(instancesDirectory, entry))
      .pipe(Effect.orElseSucceed(() => undefined));
    if (contents === undefined) continue;
    // 崩溃的 server 可能留下半个文件。
    const parsed = yield* decodeJsonFile(contents).pipe(Effect.orElseSucceed(() => undefined));
    if (parsed !== undefined) records.push(parsed);
  }
  return records;
});

const readToken = Effect.fn("KimiPluginManagement.readToken")(function* (tokenPath: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.readFileString(tokenPath).pipe(
    Effect.map((value) => value.trim()),
    Effect.orElseSucceed(() => ""),
  );
});

const fetchEnvelope = (
  baseUrl: string,
  token: string,
  input: { readonly method: "GET" | "POST"; readonly path: string },
): Effect.Effect<unknown, "transport" | "server"> =>
  Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(`${baseUrl}/api/v1${input.path}`, {
        method: input.method,
        headers: { Authorization: `Bearer ${token}` },
        signal,
      });
      return (await response.json()) as unknown;
    },
    catch: (cause) => (cause instanceof TypeError ? "transport" : "server"),
  });

const waitForReady = Effect.fn("KimiPluginManagement.waitForReady")(function* (
  stdout: Stream.Stream<Uint8Array, unknown>,
) {
  const ready = yield* Deferred.make<void>();
  const seen = yield* Ref.make("");
  yield* stdout.pipe(
    Stream.decodeText(),
    Stream.runForEach((chunk) =>
      Ref.updateAndGet(seen, (text) => text + chunk).pipe(
        Effect.flatMap((text) =>
          text.includes(KIMI_READY_LINE) ? Deferred.succeed(ready, undefined) : Effect.void,
        ),
        Effect.asVoid,
      ),
    ),
    Effect.forkScoped,
  );
  return ready;
});

export function makeKimiServerRequest(input: {
  readonly configHome: string;
  readonly spawn: AcpSessionRuntime.AcpSpawnInput;
  readonly instanceId: ProviderInstanceId;
}): KimiPluginRequest {
  const handle = Effect.fn("KimiPluginManagement.request")(function* (
    request: Parameters<KimiPluginRequest>[0],
  ) {
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const net = yield* Net.NetService;
    const tokenPath = path.join(input.configHome, "server.token");
    const token = yield* readToken(tokenPath);

    const running = pickRunningKimiServer(
      yield* readInstanceRecords(path.join(input.configHome, "server", "instances")),
      isProcessAlive,
    );
    if (running !== undefined && token.length > 0) {
      const reused = yield* fetchEnvelope(running, token, request).pipe(Effect.result);
      if (reused._tag === "Success") return reused.success;
      // 连接被拒说明记录已过期，改起临时 server；收到响应就按响应处理。
      if (reused.failure === "server") {
        return yield* kimiError(input.instanceId, "Kimi server rejected the request.");
      }
    }

    const port = yield* net
      .reserveLoopbackPort(KIMI_LOOPBACK)
      .pipe(
        Effect.mapError((cause) =>
          kimiError(input.instanceId, "Could not reserve a loopback port.", cause),
        ),
      );
    const args = kimiWebArgs(input.spawn.args, port);
    if (args === undefined) {
      return yield* kimiError(
        input.instanceId,
        "Plugin management needs Kimi launched as `kimi acp`.",
      );
    }
    const child = yield* spawner
      .spawn(
        ChildProcess.make(input.spawn.command, [...args], {
          env: {
            ...input.spawn.env,
            KIMI_CODE_HOME: input.configHome,
            KIMI_DISABLE_TELEMETRY: "1",
          },
          extendEnv: false,
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          kimiError(input.instanceId, "Could not start the Kimi server.", cause),
        ),
      );
    // 临时 server 必须随 scope 关闭；forceKillAfter 防止忽略 SIGTERM 时 scope 卡住、超时失效。
    yield* Effect.addFinalizer(() =>
      child.kill({ killSignal: "SIGTERM", forceKillAfter: "3 seconds" }).pipe(Effect.ignore),
    );
    const stderrText = yield* Ref.make("");
    yield* child.stderr.pipe(
      Stream.decodeText(),
      Stream.runForEach((chunk) => Ref.update(stderrText, (text) => text + chunk)),
      Effect.forkScoped,
    );
    const ready = yield* waitForReady(child.stdout);
    const exitFiber = yield* child.exitCode.pipe(Effect.forkScoped);
    const outcome = yield* Effect.raceFirst(
      Deferred.await(ready).pipe(Effect.as("ready" as const)),
      Fiber.join(exitFiber).pipe(Effect.as("exited" as const)),
    );
    if (outcome === "exited") {
      const stderr = (yield* Ref.get(stderrText)).trim().split("\n").at(-1) ?? "";
      return yield* kimiError(
        input.instanceId,
        stderr.length === 0
          ? "The Kimi server exited before it was ready."
          : `The Kimi server exited before it was ready: ${stderr}`,
      );
    }

    const freshToken = yield* readToken(tokenPath);
    if (freshToken.length === 0) {
      return yield* kimiError(input.instanceId, "Kimi server token is missing.");
    }
    return yield* fetchEnvelope(`http://${KIMI_LOOPBACK}:${port}`, freshToken, request).pipe(
      Effect.mapError(() => kimiError(input.instanceId, "Kimi server request failed.")),
    );
  });

  return ((request) =>
    handle(request).pipe(
      Effect.provide(Net.layer),
      Effect.scoped,
      Effect.timeoutOption(KIMI_PLUGIN_TIMEOUT),
      Effect.flatMap(
        Effect.fromOption(() => kimiError(input.instanceId, "Kimi plugin request timed out.")),
      ),
    )) as KimiPluginRequest;
}
