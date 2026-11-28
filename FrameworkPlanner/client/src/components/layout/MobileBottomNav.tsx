import { Building2, FlaskConical, Menu, Phone, Users } from "lucide-react";
import { useLocation, Link } from "wouter";
import { cn } from "@/lib/utils";

type MobileBottomNavProps = {
  onMore: () => void;
};

export function MobileBottomNav({ onMore }: MobileBottomNavProps) {
  const [location] = useLocation();

  const items = [
    { label: "Leads", href: "/leads", icon: Users },
    { label: "Opps", href: "/opportunities", icon: Building2 },
    { label: "Dial", href: "/dialer-workspace", icon: Phone },
    { label: "Lab", href: "/playground", icon: FlaskConical },
  ] as const;

  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-40 border-t bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/70 lg:hidden lg-bottomnav"
      aria-label="Primary navigation"
      data-testid="mobile-bottom-nav"
    >
      <div className="mx-auto flex h-16 w-full max-w-7xl items-stretch px-2 pb-[env(safe-area-inset-bottom)]">
        {items.map((item) => {
          const active = location === item.href || location.startsWith(`${item.href}/`);
          const Icon = item.icon;
          return (
            <Link key={item.href} href={item.href} className="flex flex-1 min-w-0">
              <div
                className={cn(
                  "flex flex-1 flex-col items-center justify-center gap-1 rounded-md px-1 text-[10px] font-medium",
                  active ? "text-primary" : "text-muted-foreground"
                )}
              >
                <Icon className="h-5 w-5" />
                <span className="leading-none">{item.label}</span>
              </div>
            </Link>
          );
        })}

        <button
          type="button"
          onClick={onMore}
          className="flex flex-1 flex-col items-center justify-center gap-1 rounded-md px-2 text-[10px] font-medium text-muted-foreground"
          aria-label="More"
          data-testid="mobile-bottom-nav-more"
        >
          <Menu className="h-5 w-5" />
          <span className="leading-none">More</span>
        </button>
      </div>
    </nav>
  );
}
