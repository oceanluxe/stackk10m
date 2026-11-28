import { useCallback, useEffect, useState } from "react";

/**
 * Liquid glass preference.
 *
 * The choice is stored in localStorage and mirrored onto <html data-glass>,
 * which the pre-paint script in index.html also resolves so the first paint
 * already matches the saved preference (no flash of the wrong surface style).
 */
export const LIQUID_GLASS_KEY = "luxe-glass";

export function readLiquidGlass(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(LIQUID_GLASS_KEY) !== "off";
  } catch {
    return true;
  }
}

export function applyLiquidGlass(enabled: boolean): void {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-glass", enabled ? "on" : "off");
}

export function useLiquidGlass() {
  const [enabled, setEnabled] = useState<boolean>(() => readLiquidGlass());

  useEffect(() => {
    applyLiquidGlass(enabled);
  }, [enabled]);

  const setLiquidGlass = useCallback((next: boolean) => {
    setEnabled(next);
    applyLiquidGlass(next);
    try {
      window.localStorage.setItem(LIQUID_GLASS_KEY, next ? "on" : "off");
    } catch {
      /* private mode / storage disabled — the session still updates */
    }
  }, []);

  return [enabled, setLiquidGlass] as const;
}
