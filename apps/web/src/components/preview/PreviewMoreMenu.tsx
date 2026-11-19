import type { DesktopPreviewColorScheme } from "@t3tools/contracts";
import { Minus, MoreVertical, Plus as PlusIcon, RotateCcw } from "lucide-react";

import { Button } from "~/components/ui/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuShortcut,
  MenuRadioGroup,
  MenuRadioItem,
  MenuGroup,
  MenuGroupLabel,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "~/components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useGT, T, Var, t } from "gt-react";

const COLOR_SCHEME_OPTIONS: ReadonlyArray<{
  value: DesktopPreviewColorScheme;
  label: string;
}> = [
  {
    value: "system",
    get label() {
      return t("System");
    },
  },
  {
    value: "light",
    get label() {
      return t("Light");
    },
  },
  {
    value: "dark",
    get label() {
      return t("Dark");
    },
  },
];

export interface PreviewMoreMenuActions {
  readonly hardReload: () => void;
  readonly setColorScheme: (colorScheme: DesktopPreviewColorScheme) => void;
  readonly zoomIn: () => void;
  readonly zoomOut: () => void;
  readonly resetZoom: () => void;
  readonly clearCookies: () => void;
  readonly clearCache: () => void;
  readonly openDevTools?: () => void;
  readonly toggleNativePictureInPicture?: () => void;
  readonly find?: () => void;
}

interface Props {
  enabled: boolean;
  actions: PreviewMoreMenuActions;
  zoomFactor: number;
  colorScheme: DesktopPreviewColorScheme;
  deviceToolbarVisible: boolean;
  onToggleDeviceToolbar: () => void;
  nativePictureInPicture: boolean;
  profileName: string | undefined;
  findShortcutLabel?: string | null;
  move?: { readonly label: string; readonly onMove: () => void };
}

const MenuTriggerButton = () => {
  const gt = useGT();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <MenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                type="button"
                aria-label={gt("Preview menu")}
              />
            }
          />
        }
      >
        <MoreVertical />
      </TooltipTrigger>
      <TooltipPopup>
        <T>More</T>
      </TooltipPopup>
    </Tooltip>
  );
};

export function PreviewMoreMenu({
  enabled,
  actions,
  zoomFactor,
  colorScheme,
  deviceToolbarVisible,
  onToggleDeviceToolbar,
  nativePictureInPicture,
  profileName,
  findShortcutLabel,
  move,
}: Props) {
  const gt = useGT();
  const zoomLabel = `${Math.round(zoomFactor * 100)}%`;
  const disabled = !enabled;
  return (
    <Menu>
      <MenuTriggerButton />
      <MenuPopup align="end" sideOffset={6}>
        {actions.find ? (
          <MenuItem onClick={actions.find} disabled={disabled}>
            <T>
              Find on page
              <Var>
                {findShortcutLabel ? <MenuShortcut>{findShortcutLabel}</MenuShortcut> : null}
              </Var>
            </T>
          </MenuItem>
        ) : null}
        <MenuItem onClick={actions.hardReload} disabled={disabled}>
          <T>Hard reload</T>
        </MenuItem>
        {actions.openDevTools ? (
          <MenuItem onClick={actions.openDevTools} disabled={disabled}>
            <T>Open DevTools</T>
          </MenuItem>
        ) : null}
        {actions.toggleNativePictureInPicture ? (
          <MenuItem onClick={actions.toggleNativePictureInPicture} disabled={disabled}>
            {nativePictureInPicture
              ? t("Close separate preview window")
              : t("Open separate preview window")}
          </MenuItem>
        ) : null}
        {move ? <MenuItem onClick={move.onMove}>{move.label}</MenuItem> : null}
        <MenuItem onClick={onToggleDeviceToolbar} disabled={disabled}>
          {deviceToolbarVisible ? t("Hide device toolbar") : t("Show device toolbar")}
        </MenuItem>
        <MenuSub>
          <MenuSubTrigger disabled={disabled}>
            <T>Appearance</T>
          </MenuSubTrigger>
          <MenuSubPopup>
            <MenuRadioGroup
              value={colorScheme}
              onValueChange={(value) => actions.setColorScheme(value as DesktopPreviewColorScheme)}
            >
              {COLOR_SCHEME_OPTIONS.map((option) => (
                <MenuRadioItem key={option.value} value={option.value}>
                  {option.label}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuSubPopup>
        </MenuSub>
        <MenuSeparator />
        <MenuItem
          closeOnClick={false}
          onClick={(event: React.MouseEvent) => event.preventDefault()}
          className="justify-between"
          disabled={disabled}
        >
          <span>
            <T>Zoom</T>
          </span>
          <span className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon-xs"
              type="button"
              onClick={actions.zoomOut}
              aria-label={gt("Zoom out")}
              disabled={disabled}
            >
              <Minus />
            </Button>
            <span className="min-w-12 text-center text-xs tabular-nums text-muted-foreground">
              {zoomLabel}
            </span>
            <Button
              variant="outline"
              size="icon-xs"
              type="button"
              onClick={actions.zoomIn}
              aria-label={gt("Zoom in")}
              disabled={disabled}
            >
              <PlusIcon />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              type="button"
              onClick={actions.resetZoom}
              aria-label={gt("Reset zoom")}
              disabled={disabled}
            >
              <RotateCcw />
            </Button>
          </span>
        </MenuItem>
        <MenuSeparator />
        <MenuGroup>
          {profileName ? (
            <MenuGroupLabel className="max-w-64">
              <span className="block truncate">
                <T>
                  Profile: <Var>{profileName}</Var>
                </T>
              </span>
            </MenuGroupLabel>
          ) : null}
          <MenuItem onClick={actions.clearCookies}>
            <T>Clear cookies</T>
          </MenuItem>
          <MenuItem onClick={actions.clearCache}>
            <T>Clear cache</T>
          </MenuItem>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}
