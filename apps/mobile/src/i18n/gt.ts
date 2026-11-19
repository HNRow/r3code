// 全 App 统一从 react-core 取 t/msg：它和 gt-react-native 的 provider 共用 I18nConfig、
// i18n cache 和 ConditionStore 单例（见 gtInit.ts），混用 gt-i18n 会读到另一个 store。
export { msg, t } from "@generaltranslation/react-core/pure";
