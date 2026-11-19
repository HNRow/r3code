// Context tags are runtime singletons; drivers need multiple instances.
import type {
  ProviderConsumeResetCreditOutcome,
  AcpRegistryListSessionsResult,
  AcpRegistryListProvidersResult,
  AcpRegistryOperationError,
  AcpRegistrySetProviderInput,
  ProviderDriverKind,
  ResolvedProviderInstanceEnvironment,
  PluginInventoryEntry,
  PluginScope,
  ProviderInstanceId,
  ServerProvider,
  ServerProviderWorkspaceSnapshot,
  SkillInventory,
} from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";

import type * as ProviderAdapter from "./ProviderAdapter.ts";
import type { ProviderAuthController } from "./auth.ts";
import type { ProviderDriverError } from "./errors.ts";
import type { ManagedServerProvider } from "./snapshot.ts";
import type { ProviderTextGeneration } from "./textGeneration.ts";
import type { ProviderUsageReader } from "./usage.ts";

export interface ProviderPluginManagement {
  /** Instances sharing a config directory see each other's changes. */
  readonly configHome: string;
  readonly list: (cwd: string) => Effect.Effect<
    {
      readonly entries: ReadonlyArray<PluginInventoryEntry>;
      readonly diagnostics: ReadonlyArray<string>;
    },
    ProviderDriverError
  >;
  readonly setEnabled: (input: {
    readonly cwd: string;
    readonly pluginId: string;
    readonly scope: PluginScope;
    readonly enabled: boolean;
  }) => Effect.Effect<void, ProviderDriverError>;
  readonly uninstall: (input: {
    readonly cwd: string;
    readonly pluginId: string;
    readonly scope: PluginScope;
  }) => Effect.Effect<void, ProviderDriverError>;
}

export interface ProviderDriverMetadata {
  readonly displayName: string;
  /** Defaults to true; false rejects multiple instances of a global resource. */
  readonly supportsMultipleInstances?: boolean;
  readonly hasDefaultInstance?: boolean;
}

export type ProviderWorkspaceSnapshot = ServerProvider &
  Pick<ServerProviderWorkspaceSnapshot, "slashCommandsPending" | "optionDescriptors"> & {
    /** Set only when the directory's catalog differs from the machine snapshot's. */
    readonly workspaceModels?: ServerProviderWorkspaceSnapshot["models"];
    /** The directory's catalog could not be read, so keep the models found before. */
    readonly workspaceModelsPending?: boolean;
  };

export interface ProviderSkillManagementTarget {
  readonly root: string;
  readonly directory: string;
  readonly quarantineRoot: string;
  readonly name: string;
}

export interface ProviderSkillSyncRoots {
  readonly configRoot: string;
  readonly skillsRoot: string;
  readonly backupRoot: string;
  readonly rollbackRoot: string;
}

export interface ProviderInstance {
  readonly instanceId: ProviderInstanceId;
  readonly driverKind: ProviderDriverKind;
  readonly continuationIdentity: ProviderContinuationIdentity;
  readonly displayName: string | undefined;
  readonly accentColor?: string | undefined;
  readonly enabled: boolean;
  readonly snapshot: ManagedServerProvider;
  readonly snapshotForCwd?: (
    cwd: string,
  ) => Effect.Effect<ProviderWorkspaceSnapshot, ProviderDriverError>;
  readonly skillInventory?: {
    readonly list: (
      cwd: string,
    ) => Effect.Effect<Pick<SkillInventory, "entries" | "diagnostics">, ProviderDriverError>;
  };
  readonly skillManagement?: {
    readonly listDiscoveryRoots: (
      cwd: string,
    ) => Effect.Effect<ReadonlyArray<string>, ProviderDriverError>;
    readonly resolveTarget: (input: {
      readonly cwd: string;
      readonly nativeId: string;
    }) => Effect.Effect<ProviderSkillManagementTarget, ProviderDriverError>;
    readonly resolveSyncRoots: (
      cwd: string,
    ) => Effect.Effect<ProviderSkillSyncRoots, ProviderDriverError>;
    readonly validate: (input: {
      readonly directory: string;
    }) => Effect.Effect<void, ProviderDriverError>;
    readonly setEnabled: (input: {
      readonly cwd: string;
      readonly nativeId: string;
      readonly enabled: boolean;
    }) => Effect.Effect<void, ProviderDriverError>;
  };
  /** Absent for providers whose plugins R3 cannot manage. */
  readonly pluginManagement?: ProviderPluginManagement;
  /**
   * Cwds whose workspace skills may have changed. The registry rescans only cwds already
   * requested. The stream must end when the instance is torn down.
   */
  readonly workspaceRescans?: Stream.Stream<string>;
  readonly refreshModels?: () => Effect.Effect<void, ProviderDriverError>;
  readonly invalidateCaches?: Effect.Effect<void>;
  /** Moves a long-lived service onto a newly updated binary before its version is read back. */
  readonly afterUpdate?: Effect.Effect<void, ProviderDriverError>;
  readonly consumeResetCredit?: (
    creditId: string | undefined,
  ) => Effect.Effect<ProviderConsumeResetCreditOutcome, ProviderDriverError>;
  readonly orchestrationAdapter: ProviderAdapter.ProviderAdapterV2["Service"];
  readonly textGeneration: ProviderTextGeneration;
  readonly auth?: ProviderAuthController;
  readonly acpSessionManagement?: {
    readonly listSessions: (input: {
      readonly cwd: string;
      readonly cursor?: string;
    }) => Effect.Effect<AcpRegistryListSessionsResult, AcpRegistryOperationError>;
    readonly logout: (cwd: string) => Effect.Effect<void, AcpRegistryOperationError>;
    readonly deleteSession: (input: {
      readonly cwd: string;
      readonly sessionId: string;
    }) => Effect.Effect<void, AcpRegistryOperationError>;
    readonly listProviders: (
      cwd: string,
    ) => Effect.Effect<AcpRegistryListProvidersResult, AcpRegistryOperationError>;
    readonly setProvider: (
      input: Omit<AcpRegistrySetProviderInput, "instanceId" | "projectId"> & {
        readonly cwd: string;
      },
    ) => Effect.Effect<void, AcpRegistryOperationError>;
    readonly disableProvider: (input: {
      readonly cwd: string;
      readonly providerId: string;
    }) => Effect.Effect<void, AcpRegistryOperationError>;
  };
}

export interface ProviderContinuationIdentity {
  readonly driverKind: ProviderDriverKind;
  readonly continuationKey: string;
}

export function defaultProviderContinuationIdentity(input: {
  readonly driverKind: ProviderDriverKind;
  readonly instanceId: ProviderInstanceId;
}): ProviderContinuationIdentity {
  return {
    driverKind: input.driverKind,
    continuationKey: `${input.driverKind}:instance:${input.instanceId}`,
  };
}

export interface ProviderDriverCreateInput<Config> {
  readonly instanceId: ProviderInstanceId;
  readonly displayName: string | undefined;
  readonly accentColor?: string | undefined;
  readonly environment: ResolvedProviderInstanceEnvironment;
  readonly enabled: boolean;
  readonly config: Config;
}

/** create calls with different instanceId/config must share no mutable state. */
export interface ProviderDriver<Config, R = never, UsageR = never> {
  readonly driverKind: ProviderDriverKind;
  readonly metadata: ProviderDriverMetadata;
  // Codec keeps DecodingServices = never; Schema would widen it through AnyProviderDriver.
  readonly configSchema: Schema.Codec<Config, unknown>;
  readonly defaultConfig: () => Config;
  /** Failures become unavailable snapshots; never throw defects. */
  readonly create: (
    input: ProviderDriverCreateInput<Config>,
  ) => Effect.Effect<ProviderInstance, ProviderDriverError, R | Scope.Scope>;
  readonly usage?: ProviderUsageReader<Config, UsageR>;
}

export type AnyProviderDriver<R = never, UsageR = unknown> = ProviderDriver<any, R, UsageR>;

export type ProviderUsageReaderEnv<Driver> =
  Driver extends ProviderDriver<any, any, infer UsageR> ? UsageR : never;
