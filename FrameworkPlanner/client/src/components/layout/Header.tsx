import React from "react";
import { Bell, Search, Menu, PanelLeft, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useSidebar } from "@/contexts/SidebarContext";
import { useAuth } from "@/contexts/AuthContext";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useLocation } from "wouter";
import { ThemeToggle } from "@/components/system/ThemeToggle";

interface NotificationItem {
  id: number;
  type: string;
  title: string;
  body: string | null;
  description?: string | null;
  entity_type?: string | null;
  entityType?: string | null;
  entity_id?: number | null;
  entityId?: number | null;
  read?: boolean;
  is_read?: boolean;
  created_at?: string;
  createdAt?: string;
}

function notifRead(n: NotificationItem): boolean {
  return n.read ?? n.is_read ?? false;
}
function notifBody(n: NotificationItem): string | null {
  return n.body ?? n.description ?? null;
}
function notifTime(n: NotificationItem): string {
  return n.createdAt ?? n.created_at ?? new Date().toISOString();
}
function notifEntity(n: NotificationItem): { type: string | null; id: number | null } {
  return {
    type: n.entityType ?? n.entity_type ?? null,
    id: n.entityId ?? n.entity_id ?? null,
  };
}

function useCurrentDateTime() {
  const [now, setNow] = React.useState(() => new Date());
  React.useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);
  return now;
}

export function Header() {
  const { state, setState, cycleState, isIconOnly, toggleMobile } = useSidebar();
  const { user, logout } = useAuth();
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const now = useCurrentDateTime();
  const searchInputRef = React.useRef<HTMLInputElement>(null);

  const { data: userData } = useQuery<any>({
    queryKey: [`/api/users/${user?.id}`],
    enabled: !!user?.id,
  });

  const getNextStateLabel = () => {
    if (typeof window !== "undefined" && !window.matchMedia("(min-width: 1024px)").matches) return "Open menu";
    if (state === "expanded") return "Collapse to icons";
    return "Expand sidebar";
  };

  const getInitials = () => {
    if (userData?.firstName && userData?.lastName) {
      return `${userData.firstName[0]}${userData.lastName[0]}`.toUpperCase();
    }
    return user?.email?.[0]?.toUpperCase() || "U";
  };

  const profileImage = userData?.hasProfilePicture
    ? `/api/users/${userData.id}/avatar?v=${encodeURIComponent(String(userData.updatedAt || ""))}`
    : userData?.avatarUrl;

  const [query, setQuery] = React.useState("");
  const [debounced, setDebounced] = React.useState("");
  const [open, setOpen] = React.useState(false);
  // Track whether the popover was opened by typing (vs. programmatic close).
  // This decouples the open state from keystrokes so Radix focus management
  // doesn't steal input focus on every character.
  const userTypingRef = React.useRef(false);
  React.useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);
  // Open the popover when the debounced query is searchable, but never
  // toggle it closed on keystrokes — only explicit dismiss closes it.
  React.useEffect(() => {
    if (userTypingRef.current && debounced.length >= 2) {
      setOpen(true);
    } else if (debounced.length < 2) {
      setOpen(false);
    }
  }, [debounced]);
  const { data: searchData, isFetching: searching } = useQuery<any>({
    queryKey: ["/api/search", debounced],
    queryFn: async () => {
      const res = await fetch(`/api/search?q=${encodeURIComponent(debounced)}`);
      return res.json();
    },
    enabled: debounced.length >= 2,
  });

  const onSelect = (item: any) => {
    setOpen(false);
    setQuery("");
    if (item.path) setLocation(item.path);
    // Restore focus to search input after selection
    requestAnimationFrame(() => searchInputRef.current?.focus());
  };

  const { data: notifData } = useQuery<{ items: NotificationItem[]; unreadCount: number }>({
    queryKey: ["/api/notifications"],
    enabled: !!user?.id,
    refetchInterval: 30000,
  });
  const notifications = notifData?.items || [];
  const unreadCount = notifData?.unreadCount ?? notifications.filter(n => !n.read).length;

  const markAllAsRead = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/notifications/read-all`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/notifications"] });
    },
  });

  const markOneRead = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/notifications/${id}/read`, { method: "POST", credentials: "include" });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/notifications"] }),
  });

  const openNotification = (n: NotificationItem) => {
    markOneRead.mutate(n.id);
    const { type, id } = notifEntity(n);
    if (type === "lead" && id) setLocation(`/leads?highlight=${id}`);
    else setLocation("/notifications");
  };

  const formatTime = (dateString: string) => {
    if (!dateString) return "";
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
  };

  const timeString = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const dateString = now.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });

  return (
    <header className="sticky top-0 z-30 flex h-16 w-full min-w-0 items-center border-b bg-background px-4 md:px-6 shadow-sm gap-4 lg-header">
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button 
              variant="ghost" 
              size="icon" 
              onClick={() => {
                const isDesktop = typeof window !== "undefined" && window.matchMedia("(min-width: 1024px)").matches;
                if (!isDesktop) {
                  toggleMobile();
                  return;
                }
                cycleState();
              }}
              className="text-muted-foreground hover:text-foreground shrink-0"
              data-testid="button-hamburger"
            >
              {isIconOnly ? (
                <Menu className="h-5 w-5" />
              ) : (
                <PanelLeft className="h-5 w-5" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {getNextStateLabel()}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      <div className="flex min-w-0 flex-1 items-center gap-4">
        {/* Date & Time */}
        <div className="hidden md:flex items-center gap-1.5 text-sm text-muted-foreground shrink-0 select-none">
          <Clock className="h-4 w-4" />
          <span className="font-bold text-yellow-400">{timeString}</span>
          <span className="text-xs">{dateString}</span>
        </div>

        {/* Search bar — Input is OUTSIDE PopoverTrigger to prevent focus loss */}
        <div className="relative w-full max-w-md min-w-0">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            ref={searchInputRef}
            type="search"
            placeholder="Search leads, properties, or contacts..."
            className="w-full min-w-0 bg-muted/50 pl-9 border-none focus-visible:ring-1"
            value={query}
            onChange={(e) => {
              const v = e.target.value;
              userTypingRef.current = true;
              setQuery(v);
            }}
            onFocus={() => {
              userTypingRef.current = true;
              if (query.trim().length >= 2) setOpen(true);
            }}
            onBlur={() => {
              // Delay so click selection still works; only close if not selecting
              setTimeout(() => {
                userTypingRef.current = false;
              }, 200);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setOpen(false);
                userTypingRef.current = false;
                searchInputRef.current?.blur();
              }
            }}
            data-testid="input-global-search"
          />
          {/* Popover anchored to a hidden span — does NOT wrap the Input.
              modal={false} prevents Radix from stealing input focus. */}
          <Popover open={open} onOpenChange={(v) => {
            // Only allow closing via explicit dismiss (selection, Escape, outside click).
            // Never auto-close on keystrokes while the user is typing.
            if (!v) {
              userTypingRef.current = false;
              setOpen(false);
            } else {
              setOpen(true);
            }
          }} modal={false}>
            <PopoverTrigger asChild>
              <span className="absolute inset-0 -z-10" tabIndex={-1} aria-hidden="true" />
            </PopoverTrigger>
            <PopoverContent align="start" className="w-[--radix-popover-trigger-width] p-0" onOpenAutoFocus={(e) => e.preventDefault()}>
              <div className="bg-background border rounded-md shadow-lg max-h-80 overflow-auto">
                <div className="flex items-center justify-between px-3 py-2 text-xs text-muted-foreground">
                  <span>Results</span>
                  {searching && <span>Searching…</span>}
                </div>
                {(searchData?.results || []).length === 0 ? (
                  <div className="px-3 py-3 text-sm text-muted-foreground">No matches</div>
                ) : (
                  (searchData?.results || []).map((item: any) => (
                    <button
                      key={`${item.type}-${item.id}`}
                      className="w-full text-left px-3 py-2 hover:bg-muted/50 text-sm"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => onSelect(item)}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <span className="font-medium truncate">{item.title}</span>
                        <span className="text-xs text-muted-foreground shrink-0">{item.type}</span>
                      </div>
                      {item.subtitle && (
                        <div className="text-xs text-muted-foreground truncate">{item.subtitle}</div>
                      )}
                    </button>
                  ))
                )}
                {searchData?.counts?.total > (searchData?.results?.length || 0) && (
                  <button
                    className="w-full text-left px-3 py-2 hover:bg-muted/50 text-sm border-t"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      setOpen(false);
                      setLocation(`/search?q=${encodeURIComponent(query.trim())}`);
                    }}
                  >
                    View all results ({searchData?.counts?.total})
                  </button>
                )}
              </div>
            </PopoverContent>
          </Popover>
        </div>
      </div>
      
      <div className="flex items-center gap-4">
        <ThemeToggle className="text-muted-foreground hover:text-foreground shrink-0" />
        <Popover>
          <PopoverTrigger asChild>
            <Button 
              variant="ghost" 
              size="icon" 
              className="relative text-muted-foreground hover:text-foreground"
              aria-label="Notifications"
            >
              <Bell className="h-5 w-5" />
              {unreadCount > 0 && (
                <span className="absolute top-2 right-2 h-2 w-2 rounded-full bg-accent ring-2 ring-background" />
              )}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-96 p-0">
            <div className="flex items-center justify-between px-4 py-3 border-b">
              <div className="font-semibold">Notifications</div>
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={unreadCount === 0 || markAllAsRead.isPending}
                  onClick={() => markAllAsRead.mutate()}
                >
                  Mark all read
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setLocation("/notifications")}>
                  View all
                </Button>
              </div>
            </div>
            <div className="max-h-96 overflow-auto">
              {notifications.length === 0 ? (
                <div className="px-4 py-8 text-sm text-muted-foreground">No notifications</div>
              ) : (
                notifications.slice(0, 10).map((n) => (
                  <button
                    key={n.id}
                    className={`w-full text-left px-4 py-3 border-b hover:bg-muted/40 ${notifRead(n) ? "" : "bg-primary/5"}`}
                    onClick={() => openNotification(n)}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-sm font-medium truncate">{n.title}</div>
                        {notifBody(n) && <div className="text-xs text-muted-foreground truncate mt-0.5">{notifBody(n)}</div>}
                        <div className="text-xs text-muted-foreground mt-1">{formatTime(notifTime(n))}</div>
                      </div>
                      {!notifRead(n) && <div className="mt-1 h-2 w-2 rounded-full bg-primary" />}
                    </div>
                  </button>
                ))
              )}
            </div>
          </PopoverContent>
        </Popover>
        
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className="relative h-9 w-9 rounded-full">
              <Avatar className="h-9 w-9 border border-border">
                {profileImage && <AvatarImage src={profileImage} alt="User" />}
                <AvatarFallback className="bg-primary/10 text-primary font-semibold">
                  {getInitials()}
                </AvatarFallback>
              </Avatar>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>
              {userData?.firstName && userData?.lastName 
                ? `${userData.firstName} ${userData.lastName}` 
                : user?.email}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => setLocation('/settings')}>
              Profile
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setLocation('/settings')}>
              Settings
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-destructive" onClick={logout}>
              Log out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
