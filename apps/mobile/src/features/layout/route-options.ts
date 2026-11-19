import { t } from "../../i18n/gt";
import { Platform } from "react-native";

import { GLASS_HEADER_OPTIONS, type AppScreenOptions } from "../../native/glass-header-options";
import { formSheetDetents } from "../../native/sheet-surface";

/**
 * Route presets for the root stack. A route says what it is (a page, a sheet, a modal); the
 * preset owns how each platform presents it, so screens never set presentation options.
 *
 * Android never shows the native stack header: every screen draws its bar in-tree with AppBar or
 * SheetHeader, and the Android navigators hide the native one from the first frame.
 */

type HeaderStyle = "glass" | "solid" | "none";

// 别名让 GT 抽取时不去分析这个动态调用：标题原文由调用方用 msg() 标记。
const translateTitle = t;

/**
 * 标题按读取时翻译：路由选项在模块加载时构建，此时 GT 还没切到用户语言，
 * 直接 t() 会永远是英文。用 getter 让导航在渲染时再取值。
 */
// 调用方常在模块加载期用 `get title() { return t(...) }`；保留 getter，推迟到渲染时求值。
function titleGetter(options: { readonly title?: string }): (() => string) | undefined {
  const getter = Object.getOwnPropertyDescriptor(options, "title")?.get;
  const plain = getter === undefined ? options.title : undefined;
  if (getter === undefined && plain === undefined) return undefined;
  return () =>
    translateTitle(getter === undefined ? (plain as string) : String(getter.call(options)));
}

function withTitle<T extends object>(result: T, options: { readonly title?: string }): T {
  const descriptor = Object.getOwnPropertyDescriptor(options, "title");
  // 有 getter 时保留惰性；纯字符串直接落值，方便调用方 spread 而不触发 GT。
  if (descriptor?.get !== undefined) {
    Object.defineProperty(result, "title", {
      enumerable: true,
      configurable: true,
      get: titleGetter(options),
    });
  } else if (options.title !== undefined) {
    Object.defineProperty(result, "title", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: options.title,
    });
  }
  return result;
}

const SOLID_HEADER_OPTIONS: AppScreenOptions = {
  headerBackButtonDisplayMode: "minimal",
  headerBackTitle: "",
  headerLargeTitle: false,
  headerShadowVisible: false,
  headerShown: true,
  headerTitleStyle: { fontSize: 18, fontWeight: "800" },
  headerTransparent: false,
};

function headerOptions(header: HeaderStyle, itemStyle: "editor" | "standard"): AppScreenOptions {
  if (header === "none") return { headerShown: false };
  if (header === "glass") {
    // The editor style needs liquid glass, which GLASS_HEADER_OPTIONS already gates it on.
    return itemStyle === "editor"
      ? GLASS_HEADER_OPTIONS
      : { ...GLASS_HEADER_OPTIONS, unstable_navigationItemStyle: undefined };
  }
  return {
    ...SOLID_HEADER_OPTIONS,
    unstable_navigationItemStyle:
      itemStyle === "editor" && Platform.OS === "ios" ? "editor" : undefined,
  };
}

export interface PageRouteOptions {
  readonly title?: string;
  /** Glass bars let content scroll under them. Defaults to glass. */
  readonly header?: HeaderStyle;
  /** iOS 26 groups a page's bar items like an editor; settings pages use the standard look. */
  readonly itemStyle?: "editor" | "standard";
  /**
   * How the Duo minimizes the bar while scrolling. "never" for lists that stutter against the
   * default on hardware; "onScrollUp" for conversations read backwards, like Messages.
   */
  readonly duoMinimize?: "never" | "onScrollUp";
  /** The page is the root of its column, so it never shows Back. */
  readonly root?: boolean;
}

/** A page in the workspace: pushed on compact windows, a column page on wide ones. */
export function pageRoute(options: PageRouteOptions = {}): AppScreenOptions {
  return withTitle(
    {
      ...headerOptions(options.header ?? "glass", options.itemStyle ?? "editor"),
      ...(options.duoMinimize
        ? { unstable_headerMinimizationBehavior: options.duoMinimize }
        : undefined),
      ...(options.root ? { headerBackVisible: false } : undefined),
    },
    options,
  );
}

export interface SheetRouteOptions {
  readonly title?: string;
  /** Defaults to glass. "none" when the sheet draws no bar at all. */
  readonly header?: HeaderStyle;
  /** The initial detent, or "full" for a sheet that always covers the window. */
  readonly detent: number | "full";
  /** The largest detent. Defaults to the full window on iOS, where the Duo needs it. */
  readonly maxDetent?: number;
  /** Android's expanded detent when `maxDetent` is unset. */
  readonly androidMaxDetent?: number;
  /** Android sizes the sheet to its content instead of using detents. */
  readonly androidFit?: boolean;
  /**
   * Where an Android formSheet can't host the screen: "card" pushes it, "fullScreen" presents it
   * full screen (Android formSheets can't host a keyboard-driven composer).
   */
  readonly android?: "sheet" | "card" | "fullScreen";
  /** The sheet spans the Duo's rail, and its content insets itself. */
  readonly spansRail?: boolean;
  readonly itemStyle?: "editor" | "standard";
  readonly duoMinimize?: "never" | "onScrollUp";
}

function sheetDetents(options: SheetRouteOptions): number[] {
  if (options.detent === "full") return [1];
  if (options.maxDetent !== undefined) return [options.detent, options.maxDetent];
  return formSheetDetents(options.detent, options.androidMaxDetent);
}

/** A sheet over the workspace: a formSheet with a grabber that closes, never goes back. */
export function sheetRoute(options: SheetRouteOptions): AppScreenOptions {
  const header = headerOptions(options.header ?? "glass", options.itemStyle ?? "standard");
  const shared = {
    ...header,
    ...(options.duoMinimize
      ? { unstable_headerMinimizationBehavior: options.duoMinimize }
      : undefined),
    headerBackVisible: false,
    gestureEnabled: true,
  } satisfies AppScreenOptions;
  const finish = (extra: AppScreenOptions) => withTitle({ ...shared, ...extra }, options);
  if (Platform.OS === "android" && options.android === "card") {
    return finish({ presentation: "card" });
  }
  if (Platform.OS === "android" && options.android === "fullScreen") {
    return finish({ presentation: "fullScreenModal" });
  }
  return finish({
    presentation: "formSheet",
    sheetPrefersHorizontalBars: true,
    sheetGrabberVisible: true,
    sheetAllowedDetents:
      Platform.OS === "android" && options.androidFit ? "fitToContents" : sheetDetents(options),
    ...(Platform.OS === "android" ? { sheetCornerRadius: 28 } : undefined),
    ...(options.spansRail ? { nativeContentInsetHorizontally: false } : undefined),
  } as AppScreenOptions);
}

export interface ModalRouteOptions {
  readonly title?: string;
  /** Defaults to "none": the screen draws its own SheetHeader or has no bar. */
  readonly header?: HeaderStyle;
  readonly itemStyle?: "editor" | "standard";
  readonly duoMinimize?: "never" | "onScrollUp";
}

/** A full-screen modal over the workspace with a close button, not a back button. */
export function modalRoute(options: ModalRouteOptions = {}): AppScreenOptions {
  return withTitle(
    {
      ...headerOptions(options.header ?? "none", options.itemStyle ?? "standard"),
      ...(options.duoMinimize
        ? { unstable_headerMinimizationBehavior: options.duoMinimize }
        : undefined),
      headerBackVisible: false,
      presentation: "fullScreenModal",
    },
    options,
  );
}

/** Full-screen media (a device stream, a browser, an app) with no bar and no dismiss gesture. */
export function immersiveRoute(options: { readonly hideSystemBars?: boolean } = {}) {
  return {
    presentation: "fullScreenModal",
    headerShown: false,
    gestureEnabled: false,
    ...(options.hideSystemBars
      ? { autoHideHomeIndicator: true, navigationBarHidden: true }
      : undefined),
  } satisfies AppScreenOptions;
}
