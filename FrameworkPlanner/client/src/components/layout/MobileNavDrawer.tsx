import { Sheet, SheetContent } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { useAuth } from "@/contexts/AuthContext";
import { Link, useLocation } from "wouter";
import { LogOut } from "lucide-react";
import { primaryNavigation, menuGroups } from "./Sidebar";

type MobileNavDrawerProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function MobileNavDrawer({ open, onOpenChange }: MobileNavDrawerProps) {
  const [location] = useLocation();
  const { user, logout } = useAuth();

  const renderNavItem = (item: { name: string; href: string; icon: any }) => {
    const active = location === item.href || (item.href !== "/" && location.startsWith(item.href));
    const Icon = item.icon;
    return (
      <Link key={item.href} href={item.href}>
        <div
          className={cn(
            "flex items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium",
            active ? "bg-primary text-primary-foreground" : "text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-white"
          )}
          onClick={() => onOpenChange(false)}
        >
          <Icon className="h-5 w-5 shrink-0" />
          <span className="min-w-0 truncate">{item.name}</span>
        </div>
      </Link>
    );
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="left" className="w-[min(20rem,85vw)] p-0 lg-panel lg-sheet">
        <div className="flex h-dvh min-h-dvh flex-col bg-sidebar text-sidebar-foreground lg-drawer-inner" data-testid="mobile-nav-drawer">
          <div className="flex h-16 items-center gap-3 border-b border-sidebar-border bg-sidebar-accent/10 px-4">
            <img src="/luxe-logo.png" alt="Luxe RM Logo" className="h-10 w-auto object-contain" />
            <div className="min-w-0">
              <div className="text-sm font-semibold truncate">Menu</div>
              {user?.email ? <div className="text-xs text-sidebar-foreground/70 truncate">{user.email}</div> : null}
            </div>
          </div>

          <div className="flex-1 scroll-y-container px-2 py-3">
            <div className="space-y-1">
              {primaryNavigation.map(renderNavItem)}
              
              <div className="pt-4 mt-2">
                <p className="px-3 text-xs font-medium text-sidebar-foreground/50 uppercase tracking-wider mb-2">More</p>
                {menuGroups.map((group) => (
                  <div key={group.name} className="mb-2">
                    <p className="px-3 text-xs font-medium text-sidebar-foreground/40 uppercase tracking-wider mt-3 mb-1">{group.name}</p>
                    {group.items.map(renderNavItem)}
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="border-t border-sidebar-border p-2">
            <button
              type="button"
              onClick={() => {
                onOpenChange(false);
                logout();
              }}
              className="flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium text-sidebar-foreground/80 hover:bg-destructive/10 hover:text-destructive"
              data-testid="mobile-drawer-logout"
            >
              <LogOut className="h-5 w-5 shrink-0" />
              Sign Out
            </button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
