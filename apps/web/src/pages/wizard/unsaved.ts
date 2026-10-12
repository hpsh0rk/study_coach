import { useEffect } from "react";

export const UNSAVED_MESSAGE = "大纲有修改还没保存，离开会丢失这些修改。确定离开吗？· You have unsaved outline edits. Leave anyway?";

/**
 * While `dirty`: warns before closing or reloading the tab, asks before following in-app links
 * (the capture listener runs before React Router's own click handling), and asks on the browser's
 * back button: a copy of the current history entry absorbs the first Back press.
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
    const arm = () => window.history.pushState(window.history.state, "", window.location.href);
    const popstate = () => {
      if (window.confirm(UNSAVED_MESSAGE)) {
        window.removeEventListener("popstate", popstate);
        window.history.back();
      } else arm();
    };
    arm();
    window.addEventListener("beforeunload", beforeUnload);
    window.addEventListener("popstate", popstate);
    document.addEventListener("click", click, true);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      window.removeEventListener("popstate", popstate);
      document.removeEventListener("click", click, true);
    };
  }, [dirty]);
}
