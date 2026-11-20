import { resolveLocale } from "@t3tools/client-runtime/locales";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { GTProvider, useLocale } from "gt-react-native";
import type { ReactNode } from "react";
import { Platform, TurboModuleRegistry, View, type TurboModule } from "react-native";

import { mobilePreferencesAtom } from "../state/preferences";
import { setGlobalLocale } from "./gtInit";
import { setActiveLocale } from "./messages";
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from "./locales";

// Read the device languages from gt-react-native's own native module: GT's getLocale() prefers
// the last locale passed to GTProvider, which it persists, so it can't express "system".
function readSystemLocales(): ReadonlyArray<string> {
  try {
    const locales =
      TurboModuleRegistry.get<{ getNativeLocales(): string[] } & TurboModule>(
        "GtReactNative",
      )?.getNativeLocales() ?? [];
    // On iOS the first entry is NSLocale.currentLocale, whose language is the app's bundle
    // localization (English only), not the user's; preferredLanguages follow it.
    return Platform.OS === "ios" ? locales.slice(1) : locales;
  } catch {
    return [];
  }
}

export function useLanguagePreference(): string {
  const preferences = useAtomValue(mobilePreferencesAtom);
  return AsyncResult.isSuccess(preferences)
    ? (preferences.value.language ?? DEFAULT_LOCALE)
    : DEFAULT_LOCALE;
}

/** Translates the screens inside it into the saved language; "system" follows the device. */
export function I18nProvider(props: { readonly children: ReactNode }) {
  const preferences = useAtomValue(mobilePreferencesAtom);
  // 偏好是异步读的：先用最终语言挂载 GTProvider，否则会先以英文挂载、再切换，
  // 而 useGT() 子树在冷启动那次切换里会停在英文。
  if (!AsyncResult.isSuccess(preferences)) {
    return <View className="flex-1 bg-screen" />;
  }
  // 不能包 useDeferredValue：GTProvider 为加载 catalog 挂起后，延迟值会停在上一个语言，
  // 选完语言界面要等下一次选择才更新。catalog 是本地 JSON，直接切换即可。
  const locale = resolveLocale(
    preferences.value.language ?? DEFAULT_LOCALE,
    readSystemLocales(),
    SUPPORTED_LOCALES,
    DEFAULT_LOCALE,
  );
  // 渲染期同步全局 store：provider 之外（原生 header/footer）的 t() 读的就是它。
  setGlobalLocale(locale);
  setActiveLocale(locale);
  return (
    <GTProvider locale={locale} fallback={<View className="flex-1 bg-screen" />}>
      {props.children}
    </GTProvider>
  );
}

/** 与 GTProvider 同源的当前 locale，供日期/数字格式化使用。 */
export function useFormattingLocale(): string {
  return useLocale();
}
