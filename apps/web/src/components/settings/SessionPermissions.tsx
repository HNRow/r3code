import { useMessages, t } from "gt-react";
import { type EnvironmentId, sessionGrantsScope } from "@t3tools/contracts";
import {
  AUTH_SCOPE_OPTIONS,
  sessionPermissionsUnavailableMessage,
} from "@t3tools/shared/authScopeOptions";
import { useEnvironmentSessionState } from "~/state/session";

const SCOPE_TITLES: Readonly<Record<string, string>> = {
  get "View environment"() {
    return t("View environment");
  },
  get "Operate tasks"() {
    return t("Operate tasks");
  },
  get "Change environment settings"() {
    return t("Change environment settings");
  },
  get "Manage providers"() {
    return t("Manage providers");
  },
  get "Maintain environment"() {
    return t("Maintain environment");
  },
  get "Control previews"() {
    return t("Control previews");
  },
  get "View diagnostics and usage"() {
    return t("View diagnostics and usage");
  },
  get "View terminals"() {
    return t("View terminals");
  },
  get "Use terminals"() {
    return t("Use terminals");
  },
  get "Change source control"() {
    return t("Change source control");
  },
  get "Read files"() {
    return t("Read files");
  },
  get "Write files"() {
    return t("Write files");
  },
  get "View access"() {
    return t("View access");
  },
  get "Manage access"() {
    return t("Manage access");
  },
  get "View relay"() {
    return t("View relay");
  },
  get "Manage relay"() {
    return t("Manage relay");
  },
};

export function SessionPermissions({
  environmentId,
  connected,
  routeContext = false,
}: {
  readonly environmentId: EnvironmentId;
  readonly connected: boolean;
  readonly routeContext?: boolean;
}) {
  const m = useMessages();
  const session = useEnvironmentSessionState(environmentId);
  return connected && !session.hasError && !session.isPending && session.data?.authenticated ? (
    <div className="space-y-3 py-3 text-xs">
      <p className="text-muted-foreground">
        {routeContext
          ? m(
              "These permissions apply to your active route. Other routes may have different permissions.",
            )
          : m("These permissions apply to this client’s current connection.")}
      </p>
      <ul className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
        {AUTH_SCOPE_OPTIONS.map(({ scope, title }) => (
          <li key={scope} className="flex items-start justify-between gap-3">
            <span>{m(SCOPE_TITLES[title] ?? title)}</span>
            <span className="shrink-0 text-muted-foreground">
              {sessionGrantsScope(session.data!, scope) ? m("Allowed") : m("Not granted")}
            </span>
          </li>
        ))}
      </ul>
    </div>
  ) : (
    <p className="py-3 text-xs text-muted-foreground">
      {sessionPermissionsUnavailableMessage({
        connected,
        failed: session.hasError,
        rejected: !session.hasError && !session.isPending && session.data?.authenticated === false,
      })}
    </p>
  );
}
