import type { MenuAction } from "@react-native-menu/menu";

type Translate = (text: string) => string;

/** Native menus take titles as strings, so the catalog resolves here, submenus included. */
export function translateMenuActions(actions: readonly MenuAction[], m: Translate): MenuAction[] {
  return actions.map((action) => ({
    ...action,
    ...(action.title === undefined ? {} : { title: m(action.title) }),
    ...(action.subactions === undefined
      ? {}
      : { subactions: translateMenuActions(action.subactions, m) }),
  }));
}
