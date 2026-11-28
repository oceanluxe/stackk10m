import { useState } from "react";
import { useLocation } from "wouter";
import { Phone, X, Delete, UserPlus, MessageSquare, Clock, PhoneCall, PhoneMissed, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { toast } from "sonner";

function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/**
 * GlobalDialerWidget — persistent floating dialer available on every page.
 * Tabs: Dialpad for quick-dial, Queue for recent calls + SMS threads.
 * Tapping Call navigates to /phone with the number prefilled.
 * Can also create a lead from the number or jump to SMS.
 */
export function GlobalDialerWidget() {
  const [open, setOpen] = useState(false);
  const [number, setNumber] = useState("");
  const [tab, setTab] = useState<"dialpad" | "queue">("dialpad");
  const [, navigate] = useLocation();

  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"];

  // Queue data — only fetched when the widget is open on the queue tab
  const callsQuery = useQuery<any[]>({
    queryKey: ["/api/telephony/history", "widget-queue"],
    enabled: open && tab === "queue",
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/telephony/history?limit=15");
      const json = await res.json();
      return Array.isArray(json) ? json : [];
    },
  });

  const threadsQuery = useQuery<any>({
    queryKey: ["/api/telephony/sms/threads", "widget-queue"],
    enabled: open && tab === "queue",
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/telephony/sms/threads?limit=15");
      const json = await res.json();
      return json?.threads || [];
    },
  });

  const handleCall = (to?: string) => {
    const target = (to || number).trim();
    if (!target) return;
    navigate(`/phone?number=${encodeURIComponent(target)}`);
    setOpen(false);
  };

  const handleAddLead = async () => {
    if (!number.trim()) return;
    try {
      const res = await fetch("/api/leads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ phone: number.trim(), source: "dialer-widget" }),
      });
      const json = await res.json().catch(() => ({}));
      if (res.status === 409 && json?.existingLeadId) {
        // Lead already exists for this number — take them to it
        toast.info("Lead already exists — opening it");
        navigate(`/leads/${json.existingLeadId}`);
        setOpen(false);
        return;
      }
      if (!res.ok) throw new Error(json?.message || "Failed to create lead");
      const lead = json;
      toast.success("Lead created");
      navigate(`/leads?highlight=${lead.id}`);
      setOpen(false);
    } catch (e: any) {
      toast.error(e.message || "Could not create lead");
    }
  };

  const handleSms = (to?: string) => {
    const target = (to || number).trim();
    if (!target) return;
    navigate(`/messages?to=${encodeURIComponent(target)}`);
    setOpen(false);
  };

  const handleFullDialer = () => {
    navigate("/dialer-workspace");
    setOpen(false);
  };

  const handleQueueCall = (phone: string) => {
    setNumber(phone);
    handleCall(phone);
  };

  return (
    <div className="fixed bottom-20 right-4 z-50 lg:bottom-6 lg:right-6 lg-fab">
      {open && (
        <Card className="mb-3 w-72 p-4 shadow-xl lg-panel">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-sm font-semibold">Phone</span>
            <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setOpen(false)}>
              <X className="h-4 w-4" />
            </Button>
          </div>

          <Tabs value={tab} onValueChange={(v) => setTab(v as "dialpad" | "queue")}>
            <TabsList className="w-full mb-3">
              <TabsTrigger value="dialpad" className="flex-1">
                <Phone className="w-3.5 h-3.5 mr-1" /> Dialpad
              </TabsTrigger>
              <TabsTrigger value="queue" className="flex-1">
                <Clock className="w-3.5 h-3.5 mr-1" /> Queue
              </TabsTrigger>
            </TabsList>

            <TabsContent value="dialpad" className="mt-0">
              <div className="mb-3 rounded-md bg-muted px-3 py-2 text-center text-lg font-mono tracking-wider">
                {number || <span className="text-muted-foreground">Enter number</span>}
              </div>
              <div className="mb-3 grid grid-cols-3 gap-2">
                {keys.map((k) => (
                  <Button
                    key={k}
                    variant="outline"
                    className="h-11 text-lg font-semibold"
                    onClick={() => setNumber((prev) => prev + k)}
                  >
                    {k}
                  </Button>
                ))}
                <Button
                  variant="outline"
                  className="col-span-3 h-10"
                  onClick={() => setNumber((prev) => prev.slice(0, -1))}
                >
                  <Delete className="h-4 w-4 mr-2" /> Backspace
                </Button>
              </div>
              <div className="flex gap-2">
                <Button className="flex-1" onClick={() => handleCall()} disabled={!number.trim()}>
                  <Phone className="h-4 w-4 mr-2" /> Call
                </Button>
                <Button variant="outline" className="flex-1" onClick={handleFullDialer}>
                  Full Dialer
                </Button>
              </div>
              <div className="mt-2 flex gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="flex-1"
                  onClick={handleAddLead}
                  disabled={!number.trim()}
                >
                  <UserPlus className="h-4 w-4 mr-2" /> Save as Lead
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="flex-1"
                  onClick={() => handleSms()}
                  disabled={!number.trim()}
                >
                  <MessageSquare className="h-4 w-4 mr-2" /> Text
                </Button>
              </div>
            </TabsContent>

            <TabsContent value="queue" className="mt-0">
              <ScrollArea className="h-64">
                <div className="space-y-3">
                  {/* Recent calls */}
                  <div>
                    <p className="text-xs font-medium text-muted-foreground uppercase mb-1.5 flex items-center gap-1">
                      <PhoneCall className="w-3 h-3" /> Recent calls
                    </p>
                    {callsQuery.isLoading && (
                      <p className="text-xs text-muted-foreground flex items-center gap-1">
                        <Loader2 className="w-3 h-3 animate-spin" /> Loading…
                      </p>
                    )}
                    {!callsQuery.isLoading && (callsQuery.data || []).length === 0 && (
                      <p className="text-xs text-muted-foreground">No recent calls.</p>
                    )}
                    <div className="space-y-1">
                      {(callsQuery.data || []).slice(0, 5).map((c: any) => (
                        <div key={c.id} className="flex items-center justify-between gap-2 rounded-md border px-2 py-1.5">
                          <div className="min-w-0 flex-1">
                            <div className="text-xs font-medium truncate flex items-center gap-1">
                              {c.status === "missed" || c.status === "no_answer" ? (
                                <PhoneMissed className="w-3 h-3 text-destructive shrink-0" />
                              ) : (
                                <PhoneCall className="w-3 h-3 text-muted-foreground shrink-0" />
                              )}
                              {c.number || "—"}
                            </div>
                            <div className="text-[10px] text-muted-foreground">
                              {c.direction} • {timeAgo(c.createdAt || c.startedAt)}
                            </div>
                          </div>
                          <Button size="sm" variant="ghost" className="h-7 w-7 p-0 shrink-0" onClick={() => handleQueueCall(String(c.number || ""))} disabled={!c.number}>
                            <Phone className="w-3.5 h-3.5" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* SMS threads */}
                  <div>
                    <p className="text-xs font-medium text-muted-foreground uppercase mb-1.5 flex items-center gap-1">
                      <MessageSquare className="w-3 h-3" /> SMS threads
                    </p>
                    {threadsQuery.isLoading && (
                      <p className="text-xs text-muted-foreground flex items-center gap-1">
                        <Loader2 className="w-3 h-3 animate-spin" /> Loading…
                      </p>
                    )}
                    {!threadsQuery.isLoading && (threadsQuery.data || []).length === 0 && (
                      <p className="text-xs text-muted-foreground">No SMS conversations.</p>
                    )}
                    <div className="space-y-1">
                      {(threadsQuery.data || []).slice(0, 5).map((t: any) => (
                        <div key={t.id || t.fromNumber} className="flex items-center justify-between gap-2 rounded-md border px-2 py-1.5">
                          <div className="min-w-0 flex-1">
                            <div className="text-xs font-medium truncate">{t.fromNumber || t.toNumber}</div>
                            <div className="text-[10px] text-muted-foreground truncate">{t.body || "…"}</div>
                          </div>
                          <Badge variant="secondary" className="text-[10px] shrink-0">{t.messageCount || 0}</Badge>
                        </div>
                      ))}
                    </div>
                  </div>

                  <Button variant="outline" size="sm" className="w-full" onClick={() => { navigate("/workspace/communications"); setOpen(false); }}>
                    Open Communications Hub
                  </Button>
                </div>
              </ScrollArea>
            </TabsContent>
          </Tabs>
        </Card>
      )}
      <Button
        size="icon"
        className="h-16 w-16 rounded-full shadow-2xl bg-[#D4AF37] hover:bg-[#D4AF37]/90 text-black ring-4 ring-[#D4AF37]/20 hover:ring-[#D4AF37]/40 transition-all hover:scale-105"
        onClick={() => setOpen(!open)}
        aria-label="Open phone"
      >
        {open ? <X className="h-7 w-7" /> : <Phone className="h-7 w-7" />}
      </Button>
    </div>
  );
}
