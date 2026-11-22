import { resolveLocaleSelection } from "@t3tools/client-runtime/locales";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { GTProvider, initializeGT, useLocale } from "gt-react-native";
import { createContext, use, useEffect, type ReactNode } from "react";
import { Platform, TurboModuleRegistry, View, type TurboModule } from "react-native";

import { mobilePreferencesAtom } from "../state/preferences";
import { setGlobalLocale } from "./gtInit";
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from "./locales";
import { setActiveLocale } from "./messages";

const FormattingLocaleContext = createContext(DEFAULT_LOCALE);

export function useFormattingLocale(): string {
  return use(FormattingLocaleContext);
}

// 随仓库提交的 catalog，离线安装不会去拉 GT 的 CDN。英文是源语言。
// Metro 会在启动时执行每个静态 import，所以按需 require，一次只用一种语言。
const CATALOGS: Readonly<Record<string, () => unknown>> = {
  es: () => require("./translations/es.json"),
  zh: () => require("./translations/zh.json"),
  "pt-BR": () => require("./translations/pt-BR.json"),
  fr: () => require("./translations/fr.json"),
  de: () => require("./translations/de.json"),
  ja: () => require("./translations/ja.json"),
  ko: () => require("./translations/ko.json"),
  ru: () => require("./translations/ru.json"),
  sv: () => require("./translations/sv.json"),
};

initializeGT({
  defaultLocale: DEFAULT_LOCALE,
  locales: [...SUPPORTED_LOCALES],
  loadTranslations: async (locale: string) => CATALOGS[locale]?.() ?? {},
  // 本地文件不会过期。GT 默认 60 秒过期只会把同一个文件再读一遍。
  cacheExpiryTime: null,
});

// 从 gt-react-native 自己的原生模块读设备语言。GT 的 getLocale() 记住的是上次
// 传给 GTProvider 的语言，表达不了“跟随系统”。
function readSystemLocales(): ReadonlyArray<string> {
  try {
    const locales =
      TurboModuleRegistry.get<{ getNativeLocales(): string[] } & TurboModule>(
        "GtReactNative",
      )?.getNativeLocales() ?? [];
    // iOS 第一项是 NSLocale.currentLocale，语言是包内本地化（只有英文），不是用户的偏好。
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

/** 按已保存的语言翻译应用；“system”跟随设备。在 App 里只挂一次。 */
export function I18nProvider(props: { readonly children: ReactNode }) {
  const preferences = useAtomValue(mobilePreferencesAtom);
  // 偏好是异步读的：先用最终语言挂载，否则会先以英文挂载，冷启动那次切换会停在英文。
  if (!AsyncResult.isSuccess(preferences)) {
    return <View className="flex-1 bg-screen" />;
  }
  const { catalogLocale, formattingLocale } = resolveLocaleSelection(
    preferences.value.language ?? DEFAULT_LOCALE,
    readSystemLocales(),
    SUPPORTED_LOCALES,
    DEFAULT_LOCALE,
  );
  // 本地 catalog，不用 useDeferredValue，否则刚选的语言要等下一次选择才显示。
  setGlobalLocale(catalogLocale);
  return (
    <GTProvider locale={catalogLocale} fallback={<View className="flex-1 bg-screen" />}>
      <ActiveLocale />
      <FormattingLocaleContext value={formattingLocale}>{props.children}</FormattingLocaleContext>
    </GTProvider>
  );
}

function ActiveLocale() {
  const locale = useLocale();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- 组件外的 m() 读的是 catalog 已经装好的语言
  useEffect(() => setActiveLocale(locale), [locale]);
  return null;
}
