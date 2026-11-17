import { msg, useMessages } from "gt-react";
import { type EnvironmentId, sessionGrantsScope } from "@t3tools/contracts";
import {
  AUTH_SCOPE_OPTIONS,
  sessionPermissionsUnavailableMessage,
} from "@t3tools/shared/authScopeOptions";
import { useEnvironmentSessionState } from "~/state/session";

const SCOPE_TITLES: Readonly<Record<string, string>> = {
  "View environment": msg("View environment"),
  "Operate tasks": msg("Operate tasks"),
  "Change environment settings": msg("Change environment settings"),
  "Manage providers": msg("Manage providers"),
  "Maintain environment": msg("Maintain environment"),
  "Control previews": msg("Control previews"),
  "View diagnostics and usage": msg("View diagnostics and usage"),
  "View terminals": msg("View terminals"),
  "Use terminals": msg("Use terminals"),
  "Change source control": msg("Change source control"),
  "Read files": msg("Read files"),
  "Write files": msg("Write files"),
  "View access": msg("View access"),
  "Manage access": msg("Manage access"),
  "View relay": msg("View relay"),
  "Manage relay": msg("Manage relay"),
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
