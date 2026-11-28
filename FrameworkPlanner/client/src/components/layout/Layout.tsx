import { Sidebar } from "./Sidebar";
import { Header } from "./Header";
import { SidebarProvider, useSidebar } from "@/contexts/SidebarContext";
import { MobileBottomNav } from "./MobileBottomNav";
import { MobileNavDrawer } from "./MobileNavDrawer";
import { GlobalDialerWidget } from "@/components/dialer/GlobalDialerWidget";
import { OnboardingTour } from "@/components/onboarding/OnboardingTour";

interface LayoutProps {
  children: React.ReactNode;
}

function LayoutContent({ children }: LayoutProps) {
  const { mobileOpen, setMobileOpen } = useSidebar();

  return (
    <div className="relative flex h-dvh min-h-dvh w-full overflow-hidden bg-background lg-app">
      <div className="lg-bg" aria-hidden="true">
        <span className="lg-bg__blob lg-bg__blob--gold" />
        <span className="lg-bg__blob lg-bg__blob--amber" />
        <span className="lg-bg__blob lg-bg__blob--deep" />
      </div>

      <div className="hidden lg:flex">
        <Sidebar />
      </div>

      <div className="flex min-w-0 flex-1 flex-col w-full">
        <Header />
        <main className="flex-1 min-h-0 scroll-y-container bg-muted/20 lg-canvas p-4 pb-[calc(7rem+env(safe-area-inset-bottom))] md:p-6 lg:pb-0">
          <div className="mx-auto w-full max-w-7xl space-y-6 md:space-y-8">
            {children}
          </div>
        </main>
      </div>

      <MobileBottomNav onMore={() => setMobileOpen(true)} />
      <MobileNavDrawer open={mobileOpen} onOpenChange={setMobileOpen} />
      <GlobalDialerWidget />
      <OnboardingTour />
    </div>
  );
}

export function Layout({ children }: LayoutProps) {
  return (
    <SidebarProvider>
      <LayoutContent>{children}</LayoutContent>
    </SidebarProvider>
  );
}
