// 最早执行：GT 在模块加载期就会被路由/主题配置调用，而且它用 Intl 校验 locale（Hermes 缺失）。
import "./src/i18n/intl-polyfills";
import "./src/i18n/gtInit";
// Must stay first: the render counter and behavior probe wrap the DevTools hook before any React commit.
import "./src/features/development/render-counter-entry";
import "./src/features/development/behavior-probe-entry";
// Crash reporting loads preferences, which can load GT and capture Hermes's Intl constructors.
import "./src/i18n/intl-polyfills";
// Record errors thrown while the rest of the app loads.
import "./src/features/observability/observe";
import { registerRootComponent } from "expo";
import { jsx } from "react/jsx-runtime";
import "react-native-gesture-handler";
import { LogBox } from "react-native";
import { featureFlags } from "react-native-screens";
import { GTProvider } from "gt-react-native";

import App from "./src/App";

// 根级 GTProvider：原生 header/footer 等渲染路径并非都落在 I18nProvider 之下，
// 但 t() 要求 ConditionStore 已由某个 GTProvider 建立。
function Root() {
  return jsx(GTProvider, { children: jsx(App, {}) });
}

// Enables iOS FormSheet sizing for nested native stacks in non-fitToContents sheets.
featureFlags.experiment.synchronousScreenUpdatesEnabled = true;

if (process.env.EXPO_PUBLIC_SHOWCASE === "1") {
  LogBox.ignoreAllLogs();
}

registerRootComponent(Root);
