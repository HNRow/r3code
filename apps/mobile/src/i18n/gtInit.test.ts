import { createConditionStoreSingleton, initializeI18nConfig } from "gt-i18n/internal";
import { describe, expect, it } from "vite-plus/test";

// gtInit 在模块加载时注册全局 ConditionStore 单例；单例只能设置一次，之后必须原地改 locale。
describe("setGlobalLocale", () => {
  it("updates the global store on every language change", async () => {
    initializeI18nConfig({ defaultLocale: "en", locales: ["en", "es", "zh"] });
    const { setGlobalLocale } = await import("./gtInit");
    const store = createConditionStoreSingleton(
      "GT condition store not initialized.",
    ).getConditionStore();

    setGlobalLocale("zh");
    expect(store.getLocale()).toBe("zh");

    setGlobalLocale("es");
    expect(store.getLocale()).toBe("es");
  });
});
