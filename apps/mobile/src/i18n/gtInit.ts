import { initializeGT } from "gt-react-native";
import { createConditionStoreSingleton, ReadonlyConditionStore } from "gt-i18n/internal";

import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from "./locales";
import de from "./translations/de.json";
import es from "./translations/es.json";
import fr from "./translations/fr.json";
import ja from "./translations/ja.json";
import ko from "./translations/ko.json";
import ptBR from "./translations/pt-BR.json";
import ru from "./translations/ru.json";
import zh from "./translations/zh.json";

type LocaleTranslations = Awaited<
  ReturnType<NonNullable<import("gt-react-native").InitializeGTParams["loadTranslations"]>>
>;

// Committed catalogs, so forks and offline installs never reach GT's CDN. English is the source.
const TRANSLATIONS: Readonly<Record<string, LocaleTranslations>> = {
  es,
  zh,
  "pt-BR": ptBR,
  fr,
  de,
  ja,
  ko,
  ru,
};

// 模块加载时就初始化 GT：许多路由/主题配置在模块作用域调用 t()，必须早于它们求值。
initializeGT({
  defaultLocale: DEFAULT_LOCALE,
  locales: [...SUPPORTED_LOCALES],
  loadTranslations: async (locale: string) => TRANSLATIONS[locale] ?? {},
});

// React Native 的 GTProvider 只把 locale 存进 React context，不注册全局 ConditionStore；
// 而 t() 在 provider 外（原生 header/footer、模块作用域）也要读 locale。这里补一个全局 store，
// 由 I18nProvider 在切换语言时调用 setGlobalLocale 同步。
const globalConditionStore = createConditionStoreSingleton<ReadonlyConditionStore>(
  "GT condition store not initialized.",
);
let activeConditionStore = new ReadonlyConditionStore({ locale: DEFAULT_LOCALE });
globalConditionStore.setConditionStore(activeConditionStore);

export function setGlobalLocale(locale: string): void {
  if (activeConditionStore.getLocale() === locale) return;
  activeConditionStore = new ReadonlyConditionStore({ locale });
  globalConditionStore.setConditionStore(activeConditionStore);
}
