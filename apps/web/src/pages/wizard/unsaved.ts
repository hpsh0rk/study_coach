import { useEffect } from "react";

export const UNSAVED_MESSAGE = "大纲有修改还没保存，离开会丢失这些修改。确定离开吗？· You have unsaved outline edits. Leave anyway?";

/**
 * While `dirty`: warns before closing or reloading the tab, and asks before following in-app links
 * (the capture listener runs before React Router's own click handling).
 */
export function useUnsavedGuard(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    const click = (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.("a[href]");
      if (!a || (a as HTMLAnchorElement).target === "_blank" || e.defaultPrevented) return;
      if (!window.confirm(UNSAVED_MESSAGE)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", click, true);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", click, true);
    };
  }, [dirty]);
}
