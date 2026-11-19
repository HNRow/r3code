import { requireOptionalNativeModule } from "expo";

import type { AgentActivityLabels } from "./agentActivityLabels";
import {
  agentActivityWidgetTimeline,
  type AgentActivityWidgetSource,
} from "./agentActivityWidgetTimeline";

export async function publishAgentActivityWidget(
  source: AgentActivityWidgetSource,
  labels?: AgentActivityLabels,
) {
  if (!requireOptionalNativeModule("ExpoWidgets")) return;
  const { default: widget } = await import("./AgentActivityWidget");
  widget.updateTimeline(agentActivityWidgetTimeline(source, Date.now(), labels));
}
