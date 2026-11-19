import type { RelayAgentActivityAggregateState } from "@t3tools/contracts/relay";

import type { AgentActivityProps } from "./AgentActivity";
import { DEFAULT_AGENT_ACTIVITY_LABELS, type AgentActivityLabels } from "./agentActivityLabels";

// The widget only refreshes while the app is open, so after this long it stops
// claiming an agent is still working. Matches the Live Activity's stale date.
export const AGENT_ACTIVITY_WIDGET_STALE_AFTER_MS = 10 * 60_000;

export type AgentActivityWidgetSource =
  | { readonly kind: "signed-out" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "loading" }
  | { readonly kind: "snapshot"; readonly aggregate: RelayAgentActivityAggregateState | null };

export function agentActivityWidgetTimeline(
  source: AgentActivityWidgetSource,
  now: number,
  labels: AgentActivityLabels = DEFAULT_AGENT_ACTIVITY_LABELS,
) {
  const updatedAt = new Date(now).toISOString();
  if (source.kind !== "snapshot" || !source.aggregate) {
    const props: AgentActivityProps = {
      title: "R3 Code",
      subtitle:
        source.kind === "signed-out"
          ? labels.subtitleSignedOut
          : source.kind === "unavailable"
            ? labels.subtitleUnavailable
            : source.kind === "loading"
              ? labels.subtitleLoading
              : labels.noActiveAgents,
      activeCount: 0,
      updatedAt,
      activities: [],
      labels,
    };
    return [{ date: new Date(now), props }];
  }

  const { aggregate } = source;
  const props: AgentActivityProps = {
    title: aggregate.title,
    subtitle: aggregate.subtitle,
    activeCount: aggregate.activeCount,
    updatedAt: aggregate.updatedAt,
    activities: aggregate.activities,
    labels,
  };
  const hasInFlightRows = props.activities.some(
    (row) => row.phase !== "completed" && row.phase !== "failed",
  );
  if (!hasInFlightRows) {
    return [{ date: new Date(now), props }];
  }
  const staleProps: AgentActivityProps = {
    ...props,
    activities: props.activities.map((row) =>
      row.phase === "completed" || row.phase === "failed"
        ? row
        : { ...row, phase: "stale", status: labels.outOfDate },
    ),
  };
  return [
    { date: new Date(now), props },
    { date: new Date(now + AGENT_ACTIVITY_WIDGET_STALE_AFTER_MS), props: staleProps },
  ];
}
