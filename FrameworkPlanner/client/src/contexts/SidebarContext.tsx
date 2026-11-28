import { createContext, useContext, useState, useEffect, ReactNode } from "react";

export type SidebarState = "expanded" | "icon";

interface SidebarContextType {
  state: SidebarState;
  setState: (state: SidebarState) => void;
  cycleState: () => void;
  isExpanded: boolean;
  isIconOnly: boolean;
  mobileOpen: boolean;
  setMobileOpen: (open: boolean) => void;
  toggleMobile: () => void;
}

const SidebarContext = createContext<SidebarContextType | undefined>(undefined);

function migrateOldState(): SidebarState {
  const oldState = localStorage.getItem("sidebar-collapsed");
  if (oldState !== null) {
    localStorage.removeItem("sidebar-collapsed");
    return oldState === "true" ? "icon" : "expanded";
  }
  
  const savedState = localStorage.getItem("sidebar-state");
  if (savedState === "hidden") {
    localStorage.setItem("sidebar-state", "icon");
    return "icon";
  }
  if (savedState && ["expanded", "icon"].includes(savedState)) {
    return savedState as SidebarState;
  }

  // Default to expanded labels on desktop so the sidebar reads at first
  // glance; a saved choice (or the collapse toggle) still wins.
  return "expanded";
}

export function SidebarProvider({ children }: { children: ReactNode }) {
  const [state, setStateInternal] = useState<SidebarState>(migrateOldState);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    localStorage.setItem("sidebar-state", state);
  }, [state]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(min-width: 1024px)");
    const handle = () => {
      if (mq.matches) setMobileOpen(false);
    };
    handle();
    if (typeof mq.addEventListener === "function") {
      mq.addEventListener("change", handle);
      return () => mq.removeEventListener("change", handle);
    }
    mq.addListener(handle);
    return () => mq.removeListener(handle);
  }, []);

  const setState = (newState: SidebarState) => setStateInternal(newState);
  
  const cycleState = () => {
    setStateInternal((prev) => {
      if (prev === "expanded") return "icon";
      return "expanded";
    });
  };

  const isExpanded = state === "expanded";
  const isIconOnly = state === "icon";
  const toggleMobile = () => setMobileOpen((prev) => !prev);

  return (
    <SidebarContext.Provider value={{ state, setState, cycleState, isExpanded, isIconOnly, mobileOpen, setMobileOpen, toggleMobile }}>
      {children}
    </SidebarContext.Provider>
  );
}

export function useSidebar() {
  const context = useContext(SidebarContext);
  if (!context) {
    throw new Error("useSidebar must be used within a SidebarProvider");
  }
  return context;
}
