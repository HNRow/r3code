import type { NativeStackNavigationOptions } from "@react-navigation/native-stack";
import { Platform } from "react-native";

import { brandTitleOffset, CompactBrandTitle } from "../../../components/CompactBrandTitle";
import { WorkspaceConnectionTitle } from "../../home/WorkspaceConnectionTitle";

import { msg } from "../../../i18n/gt";

function renderCompactBrandTitle() {
  return <CompactBrandTitle allowFontScaling={Platform.OS === "ios"} />;
}

export function getCompactBrandHeaderOptions(
  fallbackTitleStyle?: NativeStackNavigationOptions["headerTitleStyle"],
): NativeStackNavigationOptions {
  return {
    headerTitle: renderCompactBrandTitle,
    headerTitleStyle: fallbackTitleStyle,
    // 这份 options 在模块加载时构建，早于 GT 初始化；标题用编译期 msg。
    title: msg("Threads"),
    unstable_headerLeftItems: undefined,
  };
}

export function getConnectionAwareBrandHeaderOptions(opts: {
  readonly headerWidth: number;
  readonly trailingItemCount?: number;
  readonly onOpenEnvironments: () => void;
  readonly fallbackTitleStyle?: NativeStackNavigationOptions["headerTitleStyle"];
}): NativeStackNavigationOptions {
  const maxWidth = Math.max(0, opts.headerWidth - 64 - 44 * (opts.trailingItemCount ?? 1));

  return {
    ...getCompactBrandHeaderOptions(opts.fallbackTitleStyle),
    headerTitle: () => (
      <WorkspaceConnectionTitle
        brand={<CompactBrandTitle />}
        maxWidth={maxWidth}
        onPress={opts.onOpenEnvironments}
        statusOffset={brandTitleOffset()}
      />
    ),
  };
}
