// 小组件在独立 runtime 里求值，GT 从未初始化：文案由 App 翻好后经 props 传入。
// 单独成文件，避免只想用文案类型的调用方（timeline、测试）拉进 expo 组件。
export interface AgentActivityLabels {
  readonly approval: string;
  readonly input: string;
  readonly failed: string;
  readonly done: string;
  readonly outOfDate: string;
  readonly agentWorkFailed: string;
  readonly agentWorkCompleted: string;
  readonly agentStatusOutOfDate: string;
  readonly activeAgentOne: string;
  readonly activeAgentMany: string;
  readonly active: string;
  readonly needAttentionOne: string;
  readonly needAttentionMany: string;
  readonly needYouOne: string;
  readonly needYouMany: string;
  readonly loadActivity: string;
  readonly noActiveAgents: string;
  readonly subtitleSignedOut: string;
  readonly subtitleUnavailable: string;
  readonly subtitleLoading: string;
}

export const DEFAULT_AGENT_ACTIVITY_LABELS: AgentActivityLabels = {
  approval: "Approval",
  input: "Input",
  failed: "Failed",
  done: "Done",
  outOfDate: "Out of date",
  agentWorkFailed: "Agent work failed",
  agentWorkCompleted: "Agent work completed",
  agentStatusOutOfDate: "Agent status out of date",
  activeAgentOne: "%count% active agent",
  activeAgentMany: "%count% active agents",
  active: "%count% active",
  needAttentionOne: "%count% need attention",
  needAttentionMany: "%count% needs attention",
  needYouOne: "%count% need you",
  needYouMany: "%count% needs you",
  loadActivity: "Open R3 Code to load agent activity",
  noActiveAgents: "No active agents",
  subtitleSignedOut: "Sign in to R3 Connect to see agents",
  subtitleUnavailable: "Couldn't reach R3 Connect",
  subtitleLoading: "Loading agents…",
};

export function formatLabelCount(template: string, count: number): string {
  return template.replace("%count%", String(count));
}
