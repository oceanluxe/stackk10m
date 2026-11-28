import { Link, useLocation } from "wouter";
import { useState } from "react";
import { 
  LayoutDashboard, 
  Users, 
  Building2, 
  FileText, 
  FolderOpen,
  BookOpen,
  Settings, 
  PieChart, 
  LogOut,
  Calculator,
  Clock,
  Bell,
  ChevronLeft,
  ChevronRight,
  FlaskConical,
  UserCheck,
  Phone,
  PhoneCall,
  Send,
  Voicemail,
  Repeat,
  CheckSquare,
  CalendarDays,
  CalendarCheck2,
  Ticket,
  Zap,
  AlertTriangle,
  Webhook,
  ScrollText,
  FileSignature,
  PenLine,
  Shield,
  ActivitySquare,
  MoreHorizontal,
  MessageSquare,
  Briefcase,
  BarChart3,
  Wrench,
  UsersRound,
  Handshake,
  ListChecks,
  BadgeCheck,
  Inbox,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/contexts/AuthContext";
import { useSidebar } from "@/contexts/SidebarContext";
import { useQuery } from "@tanstack/react-query";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { motion, AnimatePresence } from "framer-motion";

const primaryNavigation = [
  { name: "Dashboard", href: "/", icon: LayoutDashboard },
  { name: "Intake", href: "/intake", icon: Inbox },
  { name: "Leads Pipeline", href: "/leads", icon: Users },
  { name: "Opportunities", href: "/opportunities", icon: Building2 },
  { name: "Buyers", href: "/buyers", icon: UserCheck },
  { name: "Investor Approvals", href: "/admin/investors", icon: UserCheck },
  { name: "Disposition", href: "/disposition", icon: Handshake },
  { name: "Contracts", href: "/contracts", icon: FileText },
];

const menuGroups = [
  {
    name: "Find Deals",
    icon: Briefcase,
    items: [
      { name: "Campaigns", href: "/campaigns", icon: Send },
      { name: "Contacts", href: "/contacts", icon: Users },
      { name: "Companies", href: "/companies", icon: Building2 },
    ],
  },
  {
    name: "Communication",
    icon: MessageSquare,
    items: [
      { name: "Phone", href: "/phone", icon: Phone },
      { name: "Dialer Workspace", href: "/dialer-workspace", icon: Phone },
      { name: "Messages", href: "/messages", icon: MessageSquare },
      { name: "SMS Inbox", href: "/sms-inbox", icon: MessageSquare },
      // TICKET-14: Follow-up sequences
      { name: "Sequences", href: "/sequences", icon: Repeat },
      { name: "Voicemail", href: "/voicemail", icon: Voicemail },
      { name: "Communication Hub", href: "/workspace/communications", icon: PhoneCall },
    ],
  },
  {
    name: "Closing",
    icon: FolderOpen,
    items: [
      { name: "LOIs", href: "/lois", icon: FileSignature },
      { name: "E-Sign", href: "/esign", icon: PenLine },
      { name: "Documents", href: "/documents", icon: FolderOpen },
      { name: "Documentation", href: "/docs", icon: BookOpen },
    ],
  },
  {
    name: "Team & Schedule",
    icon: CalendarDays,
    items: [
      { name: "Today", href: "/today", icon: CalendarCheck2 },
      { name: "Tasks", href: "/tasks", icon: CheckSquare },
      { name: "Calendar", href: "/calendar", icon: CalendarDays },
      { name: "Team", href: "/team", icon: UsersRound },
      { name: "Timesheet", href: "/timesheet", icon: Clock },
      { name: "XP Booking", href: "/xp", icon: Ticket },
    ],
  },
  {
    name: "Insights",
    icon: BarChart3,
    items: [
      { name: "Analytics", href: "/analytics", icon: PieChart },
      { name: "Automations", href: "/automations", icon: Zap },
      { name: "Scripts", href: "/scripts", icon: FileText },
      { name: "Call Audit", href: "/call-audit", icon: ScrollText },
      { name: "Buyer Qualification", href: "/buyers/qualify", icon: BadgeCheck },
    ],
  },
  {
    name: "System",
    icon: Wrench,
    items: [
      { name: "Settings", href: "/settings", icon: Settings },
      { name: "Notifications", href: "/notifications", icon: Bell },
      { name: "System Health", href: "/system-health", icon: ActivitySquare },
      // TICKET-09: Background job queue health dashboard.
      { name: "Job Queue", href: "/jobs", icon: ListChecks },
      { name: "Audit Log", href: "/audit-log", icon: ScrollText },
      { name: "Audit", href: "/audit", icon: Shield },
      { name: "Calculator", href: "/calculator", icon: Calculator },
      // SIGNALS-PHASE1: municipal distress-signal ingestion.
      { name: "Signals", href: "/signals", icon: AlertTriangle },
      // AUTOMATION-PHASE2: n8n bridge.
      { name: "n8n Bridge", href: "/settings/n8n-bridge", icon: Webhook },
      // Research lab for real-estate deal analysis (underwriting workspace).
      { name: "Research Lab", href: "/playground", icon: FlaskConical },
    ],
  },
];

export const navigation = primaryNavigation;
export { primaryNavigation, menuGroups };

export function Sidebar() {
  const [location, setLocation] = useLocation();
  const { user, logout } = useAuth();
  const { state, cycleState, isExpanded, isIconOnly } = useSidebar();

  const { data: userData } = useQuery<any>({
    queryKey: [`/api/users/${user?.id}`],
    enabled: !!user?.id,
  });

  const { data: versionInfo } = useQuery<any>({
    queryKey: ["/api/version"],
  });

  const { data: goals = [] } = useQuery<any[]>({
    queryKey: [`/api/users/${user?.id}/goals`],
    enabled: !!user?.id,
  });



  const [openGroups, setOpenGroups] = useState<string[]>([]);
  const toggleGroup = (name: string) =>
    setOpenGroups((prev) =>
      prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]
    );

  const activeGoal = goals.length > 0 ? goals[0] : null;
  const goalProgress = activeGoal && activeGoal.targetValue > 0
    ? Math.min(100, (activeGoal.currentValue / activeGoal.targetValue) * 100)
    : 0;

  const showLabels = isExpanded;
  const profileImage = userData?.hasProfilePicture
    ? `/api/users/${userData.id}/avatar?v=${encodeURIComponent(String(userData.updatedAt || ""))}`
    : userData?.avatarUrl;

  return (
    <TooltipProvider delayDuration={0}>
      <div 
        className={cn(
          "flex h-full flex-col bg-sidebar text-sidebar-foreground border-r border-sidebar-border shadow-xl z-40 transition-all duration-300 ease-in-out lg-sidebar",
          isExpanded ? "w-64" : "w-20"
        )}
      >
        <div className={cn(
          "flex h-16 items-center border-b border-sidebar-border bg-sidebar-accent/10 transition-all duration-300",
          isExpanded && "px-6",
          !isExpanded && "justify-center px-2"
        )}>
          <img 
            src="/luxe-logo.png" 
            alt="Luxe RM Logo" 
            className={cn(
              "object-contain transition-all duration-300",
              isExpanded ? "h-12 w-auto" : "h-10 w-10"
            )}
          />
        </div>

        <button
          onClick={cycleState}
          className="absolute -right-3 top-20 z-40 flex h-6 w-6 items-center justify-center rounded-full bg-yellow-500 text-white shadow-md hover:bg-yellow-600 transition-colors"
          data-testid="button-toggle-sidebar"
        >
          {isExpanded ? <ChevronLeft className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>
        
        <div className="flex-1 scroll-y-container py-6 transition-all duration-300">
          <nav className={cn("space-y-1.5", isExpanded ? "px-3" : "px-2")}>
            {primaryNavigation.map((item, idx) => {
              const isActive = location === item.href || (item.href !== '/' && location.startsWith(item.href));
              
              const navItem = (
                <Link key={item.name} href={item.href}>
                  <div
                    className={cn(
                      "group relative flex items-center rounded-md text-sm font-medium transition-all duration-200 ease-in-out cursor-pointer",
                      isExpanded ? "justify-start px-3 py-2.5" : "justify-center px-2 py-2.5",
                      isActive
                        ? "bg-primary text-primary-foreground shadow-md shadow-primary/20"
                        : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-white"
                    )}
                  >
                    <item.icon
                      className={cn(
                        "h-5 w-5 flex-shrink-0 transition-colors",
                        isExpanded && "mr-3",
                        isActive ? "text-primary-foreground" : "text-sidebar-foreground/50 group-hover:text-white"
                      )}
                    />
                    {isExpanded && (
                      <span className="transition-opacity duration-200">{item.name}</span>
                    )}
                    
                    {isActive && isExpanded && (
                      <div className="absolute right-2 h-1.5 w-1.5 rounded-full bg-white/30" />
                    )}
                  </div>
                </Link>
              );

              if (!isExpanded) {
                return (
                  <motion.div
                    key={item.name}
                    initial={{ opacity: 0, x: -8 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: idx * 0.04, duration: 0.22, ease: "easeOut" }}
                  >
                    <Tooltip>
                      <TooltipTrigger asChild>
                        {navItem}
                      </TooltipTrigger>
                      <TooltipContent side="right" className="bg-sidebar text-white border-sidebar-border">
                        {item.name}
                      </TooltipContent>
                    </Tooltip>
                  </motion.div>
                );
              }

              return (
                <motion.div
                  key={item.name}
                  initial={{ opacity: 0, y: -6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: idx * 0.04, duration: 0.25, ease: "easeOut" }}
                >
                  {navItem}
                </motion.div>
              );
            })}

            {isExpanded ? (
              <div className="pt-4 space-y-1">
                <p className="px-3 text-xs font-medium text-sidebar-foreground/50 uppercase tracking-wider mb-2">More</p>
{menuGroups.map((group) => {
                  const isOpen = openGroups.includes(group.name);
                  const groupActive = group.items.some(
                    (item) => location === item.href || (item.href !== "/" && location.startsWith(item.href))
                  );
                  return (
                    <div key={group.name} className="mb-1">
                      <button
                        type="button"
                        onClick={() => toggleGroup(group.name)}
                        className={cn(
                          "flex w-full items-center justify-between rounded-md px-3 py-2 text-sm font-medium transition-colors",
                          groupActive
                            ? "text-white"
                            : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-white"
                        )}
                        data-testid={`group-trigger-${group.name.toLowerCase()}`}
                      >
                        <div className="flex items-center gap-3">
                          <group.icon className="h-5 w-5 flex-shrink-0 text-sidebar-foreground/50" />
                          <span>{group.name}</span>
                        </div>
                        <motion.span
                          animate={{ rotate: isOpen ? 90 : 0 }}
                          transition={{ duration: 0.25, ease: "easeInOut" }}
                          className="text-sidebar-foreground/50"
                        >
                          <ChevronRight className="h-4 w-4" />
                        </motion.span>
                      </button>
                      <AnimatePresence initial={false}>
                        {isOpen && (
                          <motion.div
                            key="content"
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: "auto", opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            transition={{ height: { duration: 0.3, ease: "easeInOut" }, opacity: { duration: 0.2 } }}
                            className="overflow-hidden"
                          >
                            <div className="ml-4 mt-1 space-y-1 border-l border-sidebar-border pl-3">
                              {group.items.map((item, idx) => {
                                const isActive = location === item.href || (item.href !== '/' && location.startsWith(item.href));
                                return (
                                  <motion.div
                                    key={item.name}
                                    initial={{ opacity: 0, x: -10 }}
                                    animate={{ opacity: 1, x: 0 }}
                                    exit={{ opacity: 0, x: -6 }}
                                    transition={{ delay: isOpen ? idx * 0.05 : 0, duration: 0.22, ease: "easeOut" }}
                                  >
                                    <Link href={item.href}>
                                      <div
                                        className={cn(
                                          "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                                          isActive
                                            ? "bg-primary text-primary-foreground"
                                            : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-white"
                                        )}
                                      >
                                        <item.icon className="h-4 w-4 flex-shrink-0" />
                                        <span>{item.name}</span>
                                      </div>
                                    </Link>
                                  </motion.div>
                                );
                              })}
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="pt-4 space-y-1">
                {menuGroups.map((group) => (
                  <DropdownMenu key={group.name}>
                    <DropdownMenuTrigger asChild>
                      <button
                        className="flex w-full items-center justify-center rounded-md p-2.5 text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-white transition-colors"
                        data-testid={`dropdown-trigger-${group.name.toLowerCase()}`}
                      >
                        <group.icon className="h-5 w-5 flex-shrink-0 text-sidebar-foreground/50" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent side="right" className="bg-sidebar text-white border-sidebar-border w-48">
                      <DropdownMenuLabel className="text-sidebar-foreground/70">{group.name}</DropdownMenuLabel>
                      {group.items.map((item, idx) => (
                        <motion.div
                          key={item.name}
                          initial={{ opacity: 0, x: -8 }}
                          animate={{ opacity: 1, x: 0 }}
                          transition={{ delay: idx * 0.04, duration: 0.2, ease: "easeOut" }}
                        >
                          <DropdownMenuItem asChild>
                            <Link href={item.href} className="flex items-center gap-2 cursor-pointer">
                              <item.icon className="h-4 w-4" />
                              <span>{item.name}</span>
                            </Link>
                          </DropdownMenuItem>
                        </motion.div>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                ))}
              </div>
            )}
          </nav>
        </div>

        <div className={cn(
          "mt-auto border-t border-sidebar-border bg-sidebar-accent/5 transition-all duration-300",
          isExpanded ? "p-4" : "p-2"
        )}>
          {isExpanded ? (
            <>
              {user && (
                <div className="bg-sidebar-accent/50 rounded-lg p-3 mb-3">
                  <p className="text-xs font-medium text-sidebar-foreground/60 uppercase tracking-wider mb-1">
                    Logged in as
                  </p>
                  <p className="text-sm font-bold text-white truncate">
                    {user.firstName && user.lastName ? `${user.firstName} ${user.lastName}` : user.email}
                  </p>
                  {user.isSuperAdmin && (
                    <span className="inline-block mt-1 text-xs px-2 py-0.5 bg-primary/20 text-primary rounded">
                      Super Admin
                    </span>
                  )}
                </div>
              )}

              <div 
                className="bg-sidebar-accent/50 rounded-lg p-3 mb-4 cursor-pointer hover:bg-sidebar-accent/70 transition-colors"
                onClick={() => setLocation('/settings?tab=goals')}
              >
                <p className="text-xs font-medium text-sidebar-foreground/60 uppercase tracking-wider mb-1">Current Goal</p>
                {activeGoal ? (
                  <>
                    <div className="flex justify-between items-end mb-1">
                      <span className="text-sm font-bold text-white">
                        {activeGoal.currentValue}/{activeGoal.targetValue} {activeGoal.unit}
                      </span>
                      <span className="text-xs text-accent">{goalProgress.toFixed(0)}%</span>
                    </div>
                    <div className="h-1.5 w-full bg-sidebar-border rounded-full overflow-hidden">
                      <div 
                        className="h-full bg-accent rounded-full transition-all" 
                        style={{ width: `${Math.min(goalProgress, 100)}%` }}
                      />
                    </div>
                    <p className="text-xs text-sidebar-foreground/50 mt-1 truncate">{activeGoal.title}</p>
                  </>
                ) : (
                  <div className="text-xs text-sidebar-foreground/50">
                    No active goals. Click to create one!
                  </div>
                )}
              </div>

              <button 
                onClick={logout}
                className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-sidebar-foreground/70 hover:bg-destructive/10 hover:text-destructive transition-colors"
                data-testid="button-logout"
              >
                <LogOut className="h-5 w-5" />
                Sign Out
              </button>

              <div className="mt-3 text-[11px] text-sidebar-foreground/50 truncate">
                {versionInfo?.version
                  ? `v${String(versionInfo.version)}${versionInfo?.commitSha ? ` (${String(versionInfo.commitSha).slice(0, 7)})` : ""}`
                  : ""}
              </div>
            </>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="flex justify-center mb-3 cursor-pointer" onClick={() => setLocation('/settings?tab=goals')}>
                  <div className="relative h-10 w-10">
                    <svg className="h-10 w-10 -rotate-90" viewBox="0 0 36 36">
                      <circle
                        cx="18"
                        cy="18"
                        r="15"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="3"
                        className="text-sidebar-border"
                      />
                      <circle
                        cx="18"
                        cy="18"
                        r="15"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="3"
                        strokeDasharray={`${goalProgress} 100`}
                        className="text-accent"
                      />
                    </svg>
                    <span className="absolute inset-0 flex items-center justify-center text-xs font-bold text-white">
                      {goalProgress.toFixed(0)}%
                    </span>
                  </div>
                </div>
              </TooltipTrigger>
              <TooltipContent side="right" className="bg-sidebar text-white border-sidebar-border">
                <p className="font-medium">{activeGoal?.title || "No active goal"}</p>
                {activeGoal && (
                  <p className="text-xs text-sidebar-foreground/70">
                    {activeGoal.currentValue}/{activeGoal.targetValue} {activeGoal.unit}
                  </p>
                )}
              </TooltipContent>
            </Tooltip>
          )}

          {!isExpanded && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button 
                  onClick={logout}
                  className="flex w-full items-center justify-center rounded-md p-2 text-sidebar-foreground/70 hover:bg-destructive/10 hover:text-destructive transition-colors"
                  data-testid="button-logout"
                >
                  <LogOut className="h-5 w-5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right" className="bg-sidebar text-white border-sidebar-border">
                Sign Out
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>
    </TooltipProvider>
  );
}
