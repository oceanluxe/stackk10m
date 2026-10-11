import { Layout } from "@/components/layout/Layout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Shield, Users, Bell, Target, FileText, User, Loader2, Clock, ImageIcon, Camera, Upload, X, Trash2, Server, Database, Phone, Bot, Plus, Pencil, Save, ArrowUp, ArrowDown, Eye, EyeOff, HardDrive, Key } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAuth } from "@/contexts/AuthContext";
import { resolveBannerConfig, type BannerConfig } from "@/components/dashboard/bannerConfig";
import { useLocation, useSearch } from "wouter";
import { AutomationsContent } from "@/pages/automations";
import { AuditLogContent } from "@/pages/audit-log";
import { CallAuditContent } from "@/components/telecom/CallAuditContent";
import { StorageSettings } from "@/components/settings/StorageSettings";
import { apiRequest } from "@/lib/queryClient";
import { TelnyxOnboardingWizard } from "@/components/telnyx/TelnyxOnboardingWizard";

function SettingsContent() {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState("account");
  const [showCreateGoal, setShowCreateGoal] = useState(false);
  const [phone, setPhone] = useState("");
  const [passwordData, setPasswordData] = useState({
    current: "",
    new: "",
    confirm: "",
  });
  const [createTeamName, setCreateTeamName] = useState("");
  const [joinInviteCode, setJoinInviteCode] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("member");
  const [editingQuoteIndex, setEditingQuoteIndex] = useState<number | null>(null);
  const [newQuoteText, setNewQuoteText] = useState("");
  const [newQuoteAuthor, setNewQuoteAuthor] = useState("");
  const [twoFactorQr, setTwoFactorQr] = useState<string | null>(null);
  const [twoFactorSecret, setTwoFactorSecret] = useState<string | null>(null);
  const [twoFactorCode, setTwoFactorCode] = useState("");
  const [generatedBackupCodes, setGeneratedBackupCodes] = useState<string[]>([]);

  const [location, setLocation] = useLocation();
  const search = useSearch();
  const tabFromUrl = useMemo(() => {
    const raw = typeof search === "string" ? search.replace(/^\?/, "") : "";
    return new URLSearchParams(raw).get("tab");
  }, [search]);
  const { user } = useAuth();

  useEffect(() => {
    const allowed = new Set(["account", "security", "notifications", "team", "goals", "pipeline", "appearance", "system", "automation", "audit", "callaudit"]);
    if (tabFromUrl && allowed.has(tabFromUrl) && tabFromUrl !== activeTab) {
      setActiveTab(tabFromUrl);
    }
  }, [tabFromUrl, activeTab]);

  // Fetch user data
  const { data: userData, isLoading: userLoading } = useQuery<any>({
    queryKey: [`/api/users/${user!.id}`],
  });

  // Banner payloads come from the dedicated endpoint (multi-MB safe).
  const { data: bannerData } = useQuery<any>({
    queryKey: [`/api/users/${user!.id}/banner`],
  });

  const bannerConfig = useMemo(
    () => resolveBannerConfig(bannerData?.bannerConfig as BannerConfig | undefined, bannerData?.customBannerImages),
    [bannerData?.bannerConfig, bannerData?.customBannerImages],
  );

  useEffect(() => {
    setPhone(userData?.phone || "");
  }, [userData?.phone]);

  // Fetch 2FA status
  const { data: twoFactorData } = useQuery<any>({
    queryKey: [`/api/users/${user!.id}/2fa`],
  });

  // Fetch notification preferences
  const { data: notificationPrefs, isLoading: notifsLoading } = useQuery<any>({
    queryKey: [`/api/users/${user!.id}/notification-preferences`],
  });

  const { data: myTeams = [], isLoading: myTeamsLoading } = useQuery<any[]>({
    queryKey: ["/api/teams/my"],
    enabled: !!user?.id,
  });

  const { data: activeTeamResp, isLoading: activeTeamLoading } = useQuery<any>({
    queryKey: ["/api/teams/active"],
    enabled: !!user?.id,
  });

  const activeTeamId = typeof activeTeamResp?.teamId === "number" ? activeTeamResp.teamId : null;

  const { data: teamMembers = [], isLoading: teamMembersLoading } = useQuery<any[]>({
    queryKey: ["/api/teams", activeTeamId, "members"],
    enabled: !!activeTeamId,
  });

  const { data: teamActivity = [], isLoading: teamActivityLoading } = useQuery<any[]>({
    queryKey: ["/api/teams", activeTeamId, "activity"],
    enabled: !!activeTeamId,
  });

  const teamLoading = myTeamsLoading || activeTeamLoading || teamMembersLoading || teamActivityLoading;

  // Fetch goals
  const { data: goals = [], isLoading: goalsLoading } = useQuery<any[]>({
    queryKey: [`/api/users/${user!.id}/goals`],
  });


  const { data: leadPipelineConfig } = useQuery<any>({
    queryKey: ["/api/pipeline-config", "lead"],
    queryFn: async () => {
      const res = await fetch(`/api/pipeline-config?entityType=lead`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch lead pipeline config");
      return res.json();
    },
  });

  const { data: opportunityPipelineConfig } = useQuery<any>({
    queryKey: ["/api/pipeline-config", "opportunity"],
    queryFn: async () => {
      const res = await fetch(`/api/pipeline-config?entityType=opportunity`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch opportunity pipeline config");
      return res.json();
    },
  });

  const [didInitPipeline, setDidInitPipeline] = useState(false);
  const [leadPipelineColumns, setLeadPipelineColumns] = useState<Array<{ value: string; label: string }>>([]);
  const [opportunityPipelineColumns, setOpportunityPipelineColumns] = useState<Array<{ value: string; label: string }>>([]);

  useEffect(() => {
    if (didInitPipeline) return;
    const leadCols = Array.isArray(leadPipelineConfig?.columns) ? leadPipelineConfig.columns : null;
    const oppCols = Array.isArray(opportunityPipelineConfig?.columns) ? opportunityPipelineConfig.columns : null;
    if (leadCols) setLeadPipelineColumns(leadCols.map((c: any) => ({ value: String(c.value || ""), label: String(c.label || "") })));
    if (oppCols) setOpportunityPipelineColumns(oppCols.map((c: any) => ({ value: String(c.value || ""), label: String(c.label || "") })));
    if (leadCols || oppCols) setDidInitPipeline(true);
  }, [didInitPipeline, leadPipelineConfig?.columns, opportunityPipelineConfig?.columns]);

  const saveLeadPipelineMutation = useMutation({
    mutationFn: async (columns: Array<{ value: string; label: string }>) => {
      const res = await fetch(`/api/pipeline-config?entityType=lead`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ columns }),
      });
      if (!res.ok) throw new Error("Failed to save lead pipeline");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/pipeline-config", "lead"] });
      toast.success("Lead pipeline updated");
    },
    onError: () => toast.error("Failed to update lead pipeline"),
  });

  const saveOpportunityPipelineMutation = useMutation({
    mutationFn: async (columns: Array<{ value: string; label: string }>) => {
      const res = await fetch(`/api/pipeline-config?entityType=opportunity`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ columns }),
      });
      if (!res.ok) throw new Error("Failed to save opportunity pipeline");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/pipeline-config", "opportunity"] });
      toast.success("Opportunity pipeline updated");
    },
    onError: () => toast.error("Failed to update opportunity pipeline"),
  });

  // System health checks
  const { data: coreHealth, refetch: refetchCore, isFetching: coreFetching } = useQuery<any>({
    queryKey: ["/api/health"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/health");
      return await res.json();
    },
  });

  const { data: telephonyHealth, refetch: refetchTelephony, isFetching: telephonyFetching } = useQuery<any>({
    queryKey: ["/api/telephony/health"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/telephony/health");
      return await res.json();
    },
  });

  const [showTelnyxWizard, setShowTelnyxWizard] = useState(false);
  const [telnyxDiagOpen, setTelnyxDiagOpen] = useState(false);
  const [telnyxDiagBusy, setTelnyxDiagBusy] = useState(false);
  const runTelnyxDiagnostic = async () => {
    setTelnyxDiagOpen(true);
    setTelnyxDiagBusy(true);
    try {
      await refetchTelephony();
    } finally {
      setTelnyxDiagBusy(false);
    }
  };

  const { data: aiConfig, refetch: refetchAi, isFetching: aiFetching } = useQuery<any>({
    queryKey: ["/api/ai/config"],
    queryFn: async () => {
      const res = await fetch("/api/ai/config", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch AI config");
      return res.json();
    },
  });

  const { data: skipTraceConfig, refetch: refetchSkipTraceConfig, isFetching: skipTraceFetching } = useQuery<any>({
    queryKey: ["/api/skip-trace/config"],
    queryFn: async () => {
      const res = await fetch("/api/skip-trace/config", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch skip trace config");
      return res.json();
    },
  });

  const { data: providerReadiness, refetch: refetchReadiness, isFetching: readinessFetching } = useQuery<any>({
    queryKey: ["/api/system/provider-readiness"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/system/provider-readiness");
      return await res.json();
    },
    refetchInterval: 60000,
  });

  // Editable AI assistant config (DB override for env vars)
  const [aiAssistantIdInput, setAiAssistantIdInput] = useState("");
  const [aiFeatureEnabledInput, setAiFeatureEnabledInput] = useState<boolean | null>(null);
  const { data: aiSettingsData, refetch: refetchAiSettings } = useQuery<any>({
    queryKey: ["/api/settings/telecom/ai-assistant"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/settings/telecom/ai-assistant");
      return await res.json();
    },
  });
  useEffect(() => {
    if (aiSettingsData) {
      setAiAssistantIdInput(aiSettingsData.assistantId || "");
      setAiFeatureEnabledInput(Boolean(aiSettingsData.enabled));
    }
  }, [aiSettingsData]);
  const saveAiAssistantMutation = useMutation({
    mutationFn: async (data: { assistantId: string; enabled: boolean }) => {
      const res = await apiRequest("PUT", "/api/settings/telecom/ai-assistant", data);
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || "Failed to save AI assistant config");
      return json;
    },
    onSuccess: () => {
      toast.success("AI Screener config saved");
      refetchAiSettings();
      refetchReadiness();
    },
    onError: (e: any) => toast.error(e?.message || "Failed to save AI assistant config"),
  });

  // Call recording master switch (Settings → System, admin-only).
  const { data: recordingSettings } = useQuery({
    queryKey: ["/api/settings/telecom/call-recording"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/settings/telecom/call-recording");
      return await res.json();
    },
  });
  const toggleRecordingMutation = useMutation({
    mutationFn: async (enabled: boolean) => {
      const res = await apiRequest("PUT", "/api/settings/telecom/call-recording", { enabled });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || "Failed to save recording setting");
      return json;
    },
    onSuccess: (json: any) => {
      toast.success(json?.enabled ? "Call recording enabled" : "Call recording disabled");
      queryClient.invalidateQueries({ queryKey: ["/api/settings/telecom/call-recording"] });
    },
    onError: (e: any) => toast.error(e?.message || "Failed to save recording setting"),
  });

  // Update user mutation
  const updateUserMutation = useMutation({
    mutationFn: async (data: any) => {
      const res = await fetch(`/api/users/${user!.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
        credentials: 'include',
      });
      if (!res.ok) throw new Error('Failed to update profile');
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/users/${user!.id}`] });
      queryClient.invalidateQueries({ queryKey: [`/api/users/${user!.id}/banner`] });
      toast.success('Profile updated successfully');
    },
    onError: () => {
      toast.error('Failed to update profile');
    },
  });

  // Update notifications mutation
  const updateNotificationsMutation = useMutation({
    mutationFn: async (data: any) => {
      const res = await fetch(`/api/users/${user!.id}/notification-preferences`, {
        method: notificationPrefs ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
        credentials: 'include',
      });
      if (!res.ok) throw new Error('Failed to update notifications');
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/users/${user!.id}/notification-preferences`] });
      toast.success('Notification preferences updated');
    },
    onError: () => {
      toast.error('Failed to update notification preferences');
    },
  });

  // Create goal mutation
  const createGoalMutation = useMutation({
    mutationFn: async (data: any) => {
      const res = await fetch(`/api/users/${user!.id}/goals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
        credentials: 'include',
      });
      if (!res.ok) throw new Error('Failed to create goal');
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/users/${user!.id}/goals`] });
      toast.success('Goal created successfully');
      setShowCreateGoal(false);
    },
    onError: () => {
      toast.error('Failed to create goal');
    },
  });

  // Change password mutation
  const changePasswordMutation = useMutation({
    mutationFn: async (data: { currentPassword: string; newPassword: string }) => {
      const res = await fetch(`/api/users/${user!.id}/password`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
        credentials: 'include',
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.message || 'Failed to change password');
      }
      return res.json();
    },
    onSuccess: () => {
      toast.success('Password updated successfully');
      setPasswordData({ current: "", new: "", confirm: "" });
    },
    onError: (error: any) => {
      toast.error(error.message || 'Failed to update password');
    },
  });

  const myMembership = (teamMembers || []).find((m: any) => Number(m?.user?.id || m?.userId || 0) === Number(user?.id || 0));
  const myTeamRole = String(myMembership?.role || "").toLowerCase();
  const canManageTeam = Boolean(user?.isSuperAdmin) || myTeamRole === "owner" || myTeamRole === "admin";

  const setActiveTeamMutation = useMutation({
    mutationFn: async (teamId: number) => {
      const res = await fetch(`/api/teams/active`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ teamId }),
      });
      if (!res.ok) throw new Error("Failed to set active team");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/teams/active"] });
      queryClient.invalidateQueries({ queryKey: ["/api/teams/my"] });
      toast.success("Active team updated");
    },
    onError: (e: any) => {
      toast.error(e?.message || "Failed to update active team");
    },
  });

  const createTeamMutation = useMutation({
    mutationFn: async (data: { name: string; description?: string }) => {
      const res = await fetch(`/api/teams`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.message || "Failed to create team");
      }
      return res.json();
    },
    onSuccess: () => {
      setCreateTeamName("");
      queryClient.invalidateQueries({ queryKey: ["/api/teams/my"] });
      queryClient.invalidateQueries({ queryKey: ["/api/teams/active"] });
      toast.success("Team created");
    },
    onError: (e: any) => {
      toast.error(e?.message || "Failed to create team");
    },
  });

  const joinTeamMutation = useMutation({
    mutationFn: async (inviteCode: string) => {
      const res = await fetch(`/api/teams/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ inviteCode }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.message || "Failed to join team");
      }
      return res.json();
    },
    onSuccess: () => {
      setJoinInviteCode("");
      queryClient.invalidateQueries({ queryKey: ["/api/teams/my"] });
      queryClient.invalidateQueries({ queryKey: ["/api/teams/active"] });
      toast.success("Joined team");
    },
    onError: (e: any) => {
      toast.error(e?.message || "Failed to join team");
    },
  });

  const inviteMemberMutation = useMutation({
    mutationFn: async (data: { teamId: number; email: string; role: string }) => {
      const res = await fetch(`/api/teams/${data.teamId}/invite`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email: data.email, role: data.role }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.message || "Failed to invite member");
      }
      return res.json();
    },
    onSuccess: () => {
      setInviteEmail("");
      setInviteRole("member");
      if (activeTeamId) queryClient.invalidateQueries({ queryKey: ["/api/teams", activeTeamId, "members"] });
      toast.success("Member invited");
    },
    onError: (e: any) => {
      toast.error(e?.message || "Failed to invite member");
    },
  });

  const updateMemberMutation = useMutation({
    mutationFn: async (data: { id: number; patch: any }) => {
      const res = await fetch(`/api/team-members/${data.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(data.patch),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.message || "Failed to update member");
      }
      return res.json();
    },
    onSuccess: () => {
      if (activeTeamId) queryClient.invalidateQueries({ queryKey: ["/api/teams", activeTeamId, "members"] });
      toast.success("Member updated");
    },
    onError: (e: any) => {
      toast.error(e?.message || "Failed to update member");
    },
  });

  const removeMemberMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/team-members/${id}`, { method: "DELETE", credentials: "include" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.message || "Failed to remove member");
      }
      return res.json();
    },
    onSuccess: () => {
      if (activeTeamId) queryClient.invalidateQueries({ queryKey: ["/api/teams", activeTeamId, "members"] });
      toast.success("Member removed");
    },
    onError: (e: any) => {
      toast.error(e?.message || "Failed to remove member");
    },
  });

  const handlePasswordChange = (e: React.FormEvent) => {
    e.preventDefault();
    if (passwordData.new !== passwordData.confirm) {
      toast.error("New passwords don't match");
      return;
    }
    if (passwordData.new.length < 8) {
      toast.error("Password must be at least 8 characters");
      return;
    }
    changePasswordMutation.mutate({
      currentPassword: passwordData.current,
      newPassword: passwordData.new,
    });
  };

  // Toggle 2FA mutation
  const toggle2FAMutation = useMutation({
    mutationFn: async (enable: boolean) => {
      if (enable) {
        const res = await fetch(`/api/users/${user!.id}/2fa`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ method: 'totp' }),
          credentials: 'include',
        });
        if (!res.ok) throw new Error('Failed to enable 2FA');
        return res.json();
      } else {
        const res = await fetch(`/api/users/${user!.id}/2fa`, {
          method: 'DELETE',
          credentials: 'include',
        });
        if (!res.ok) throw new Error('Failed to disable 2FA');
        return null;
      }
    },
    onSuccess: (data) => {
      if (data?.qrCode) {
        setTwoFactorQr(data.qrCode);
        setTwoFactorSecret(data.secret || null);
      }
      queryClient.invalidateQueries({ queryKey: [`/api/users/${user!.id}/2fa`] });
      toast.success(data?.qrCode ? 'Scan the QR code and enter the verification code' : '2FA disabled successfully');
    },
    onError: () => {
      toast.error('Failed to toggle 2FA');
    },
  });

  const verify2FAMutation = useMutation({
    mutationFn: async (code: string) => {
      const res = await fetch(`/api/users/${user!.id}/2fa/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
        credentials: 'include',
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: 'Verification failed' }));
        throw new Error(err.message || 'Verification failed');
      }
      return res.json();
    },
    onSuccess: () => {
      setTwoFactorQr(null);
      setTwoFactorSecret(null);
      setTwoFactorCode('');
      queryClient.invalidateQueries({ queryKey: [`/api/users/${user!.id}/2fa`] });
      toast.success('2FA enabled and verified successfully');
    },
    onError: (e: any) => {
      toast.error(e?.message || 'Invalid verification code');
    },
  });

  const generateBackupCodesMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/users/${user!.id}/backup-codes/generate`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: 'Failed to generate backup codes' }));
        throw new Error(err.message || 'Failed to generate backup codes');
      }
      return res.json() as Promise<{ codes: string[] }>;
    },
    onSuccess: (data) => {
      setGeneratedBackupCodes(data.codes);
      toast.success('Backup codes generated. Save these somewhere safe.');
    },
    onError: (e: any) => {
      toast.error(e?.message || 'Failed to generate backup codes');
    },
  });

  // Handle profile form submission
  const handleProfileSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    updateUserMutation.mutate({
      firstName: formData.get('firstName'),
      lastName: formData.get('lastName'),
      email: formData.get('email'),
      phone: formData.get('phone'),
      companyName: formData.get('companyName'),
      licenseNumber: formData.get('licenseNumber'),
    });
  };

  if (userLoading) {
    return (
      <Layout>
        <div className="flex items-center justify-center h-96">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
      </Layout>
    );
  }

  return (
    <Layout>
      <div className="space-y-1 mb-6">
        <h1 className="text-3xl font-bold tracking-tight" data-testid="page-title">Settings</h1>
        <p className="text-muted-foreground">Manage your account and application preferences.</p>
      </div>

      <Tabs
        value={activeTab}
        onValueChange={(value) => {
          if (value === "api-keys") {
            setLocation("/settings/api-keys");
            return;
          }
          setActiveTab(value);
          setLocation(`/settings?tab=${encodeURIComponent(value)}`);
        }}
        className="w-full"
      >
        <TabsList className="border-b rounded-none bg-transparent p-0 h-auto flex-wrap overflow-x-auto min-w-0">
          <TabsTrigger value="account" className="shrink-0 rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-4 py-2">
            <User className="w-4 h-4 mr-2" />
            Account
          </TabsTrigger>
          <TabsTrigger value="security" className="shrink-0 rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-4 py-2">
            <Shield className="w-4 h-4 mr-2" />
            Security
          </TabsTrigger>
          <TabsTrigger value="notifications" className="shrink-0 rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-4 py-2">
            <Bell className="w-4 h-4 mr-2" />
            Notifications
          </TabsTrigger>
          <TabsTrigger value="team" className="shrink-0 rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-4 py-2">
            <Users className="w-4 h-4 mr-2" />
            Team
          </TabsTrigger>
          <TabsTrigger value="goals" className="shrink-0 rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-4 py-2">
            <Target className="w-4 h-4 mr-2" />
            Goals
          </TabsTrigger>
          <TabsTrigger value="pipeline" className="shrink-0 rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-4 py-2">
            <Database className="w-4 h-4 mr-2" />
            Pipeline
          </TabsTrigger>
          <TabsTrigger value="appearance" className="shrink-0 rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-4 py-2">
            <ImageIcon className="w-4 h-4 mr-2" />
            Appearance
          </TabsTrigger>
          <TabsTrigger value="system" className="shrink-0 rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-4 py-2">
            <Server className="w-4 h-4 mr-2" />
            System
          </TabsTrigger>
          <TabsTrigger value="automation" className="shrink-0 rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-4 py-2">
            <Bot className="w-4 h-4 mr-2" />
            Automation
          </TabsTrigger>
          <TabsTrigger value="api-keys" className="shrink-0 rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-4 py-2">
            <Key className="w-4 h-4 mr-2" />
            API Keys
          </TabsTrigger>
          <TabsTrigger value="audit" className="shrink-0 rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-4 py-2">
            <Clock className="w-4 h-4 mr-2" />
            Audit Logs
          </TabsTrigger>
          <TabsTrigger value="callaudit" className="shrink-0 rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-4 py-2">
            <Phone className="w-4 h-4 mr-2" />
            Call Audit
          </TabsTrigger>
          <TabsTrigger value="storage" className="shrink-0 rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-4 py-2">
            <HardDrive className="w-4 h-4 mr-2" />
            Storage
          </TabsTrigger>
        </TabsList>

        {/* ACCOUNT TAB */}
        <TabsContent value="account" className="mt-6 space-y-6">
          <form onSubmit={handleProfileSubmit}>
            <Card>
              <CardHeader>
                <CardTitle>Profile Information</CardTitle>
                <CardDescription>Update your personal details and contact information.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="firstName">First Name</Label>
                    <Input 
                      id="firstName" 
                      name="firstName"
                      placeholder="First Name" 
                      defaultValue={userData?.firstName || ''} 
                      data-testid="input-first-name"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="lastName">Last Name</Label>
                    <Input 
                      id="lastName" 
                      name="lastName"
                      placeholder="Last Name" 
                      defaultValue={userData?.lastName || ''} 
                      data-testid="input-last-name"
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="email">Email Address</Label>
                  <Input 
                    id="email" 
                    name="email"
                    type="email" 
                    placeholder="email@example.com" 
                    defaultValue={userData?.email || ''} 
                    data-testid="input-email"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="phone">Phone Number</Label>
                  <Input 
                    id="phone" 
                    name="phone"
                    placeholder="(555) 123-4567" 
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    data-testid="input-phone"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="companyName">Company Name</Label>
                  <Input 
                    id="companyName" 
                    name="companyName"
                    placeholder="Company Name" 
                    defaultValue={userData?.companyName || ''} 
                    data-testid="input-company"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="licenseNumber">License Number</Label>
                  <Input 
                    id="licenseNumber" 
                    name="licenseNumber"
                    placeholder="FL-123456" 
                    defaultValue={userData?.licenseNumber || ''} 
                    data-testid="input-license"
                  />
                </div>
                <Button 
                  type="submit" 
                  className="bg-primary hover:bg-primary/90 text-white"
                  disabled={updateUserMutation.isPending}
                  data-testid="button-save-profile"
                >
                  {updateUserMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                  Save Changes
                </Button>
              </CardContent>
            </Card>
          </form>
        </TabsContent>

        {/* SECURITY TAB */}
        <TabsContent value="security" className="mt-6 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Password</CardTitle>
              <CardDescription>Change your password to keep your account secure.</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handlePasswordChange} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="current">Current Password</Label>
                  <Input 
                    id="current" 
                    type="password" 
                    placeholder="••••••••" 
                    value={passwordData.current}
                    onChange={(e) => setPasswordData({ ...passwordData, current: e.target.value })}
                    required
                    data-testid="input-current-password" 
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="new">New Password</Label>
                  <Input 
                    id="new" 
                    type="password" 
                    placeholder="••••••••" 
                    value={passwordData.new}
                    onChange={(e) => setPasswordData({ ...passwordData, new: e.target.value })}
                    required
                    minLength={8}
                    data-testid="input-new-password" 
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="confirm">Confirm Password</Label>
                  <Input 
                    id="confirm" 
                    type="password" 
                    placeholder="••••••••" 
                    value={passwordData.confirm}
                    onChange={(e) => setPasswordData({ ...passwordData, confirm: e.target.value })}
                    required
                    minLength={8}
                    data-testid="input-confirm-password" 
                  />
                </div>
                <Button 
                  type="submit"
                  className="bg-primary hover:bg-primary/90 text-white" 
                  disabled={changePasswordMutation.isPending}
                  data-testid="button-update-password"
                >
                  {changePasswordMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                  Update Password
                </Button>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Two-Factor Authentication (2FA)</CardTitle>
              <CardDescription>Add an extra layer of security using time-based one-time passwords (TOTP).</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {twoFactorQr && !twoFactorData?.isEnabled ? (
                <div className="space-y-4 border rounded-lg p-4">
                  <div className="text-center">
                    <h4 className="font-medium mb-2">Scan QR Code</h4>
                    <p className="text-sm text-muted-foreground mb-4">
                      Use Google Authenticator, Authy, or any TOTP app
                    </p>
                    <img src={twoFactorQr} alt="2FA QR Code" className="mx-auto w-48 h-48 border rounded-lg" />
                  </div>
                  {twoFactorSecret && (
                    <div className="text-center">
                      <p className="text-xs text-muted-foreground mb-1">Can't scan? Enter this secret manually:</p>
                      <code className="text-xs bg-muted px-2 py-1 rounded">{twoFactorSecret}</code>
                    </div>
                  )}
                  <div className="space-y-2">
                    <Label htmlFor="twoFactorVerifyCode">Verification Code</Label>
                    <Input
                      id="twoFactorVerifyCode"
                      type="text"
                      inputMode="numeric"
                      maxLength={6}
                      placeholder="000000"
                      value={twoFactorCode}
                      onChange={(e) => setTwoFactorCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    />
                    <Button
                      className="w-full"
                      onClick={() => verify2FAMutation.mutate(twoFactorCode)}
                      disabled={twoFactorCode.length !== 6 || verify2FAMutation.isPending}
                    >
                      {verify2FAMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                      Verify & Enable
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      className="w-full"
                      onClick={() => {
                        setTwoFactorQr(null);
                        setTwoFactorSecret(null);
                        setTwoFactorCode('');
                      }}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-between p-4 border rounded-lg">
                  <div>
                    <p className="font-medium">
                      Status: {twoFactorData?.isEnabled ? 
                        <span className="text-green-600">Enabled</span> : 
                        <span className="text-muted-foreground">Disabled</span>
                      }
                    </p>
                    <p className="text-sm text-muted-foreground mt-1">
                      {twoFactorData?.isEnabled ? 
                        'Your account is protected with 2FA' : 
                        'Enhance your account security with 2FA'
                      }
                    </p>
                    {twoFactorData?.isEnabled && (
                      <p className="text-xs text-muted-foreground mt-1">
                        Method: {twoFactorData.method === 'totp' ? 'Authenticator App' : 'SMS'}
                      </p>
                    )}
                  </div>
                  <Button 
                    onClick={() => {
                      setTwoFactorQr(null);
                      setTwoFactorCode('');
                      toggle2FAMutation.mutate(!twoFactorData?.isEnabled);
                    }}
                    variant={twoFactorData?.isEnabled ? "destructive" : "default"}
                    className={!twoFactorData?.isEnabled ? "bg-primary hover:bg-primary/90 text-white" : ""}
                    disabled={toggle2FAMutation.isPending}
                    data-testid="button-toggle-2fa"
                  >
                    {toggle2FAMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                    {twoFactorData?.isEnabled ? 'Disable 2FA' : 'Enable 2FA'}
                  </Button>
                </div>
              )}

              {twoFactorData?.isEnabled && (
                <div className="border-t pt-4 space-y-4">
                  <div>
                    <h4 className="font-medium mb-2">Backup Codes</h4>
                    <p className="text-sm text-muted-foreground mb-3">
                      Generate backup codes to use if you lose access to your authenticator app
                    </p>
                    {generatedBackupCodes.length > 0 ? (
                      <div className="space-y-3">
                        <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-3">
                          <p className="text-sm font-medium text-yellow-800 dark:text-yellow-200 mb-2">
                            Save these codes now. They will not be shown again.
                          </p>
                          <div className="grid grid-cols-2 gap-2">
                            {generatedBackupCodes.map((code, idx) => (
                              <code key={idx} className="text-sm bg-white dark:bg-gray-800 px-2 py-1 rounded border font-mono">
                                {code}
                              </code>
                            ))}
                          </div>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="mt-3"
                            onClick={() => {
                              navigator.clipboard.writeText(generatedBackupCodes.join('\n'));
                              toast.success('Backup codes copied to clipboard');
                            }}
                          >
                            Copy All Codes
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <Button 
                        variant="outline" 
                        size="sm" 
                        data-testid="button-generate-backup-codes"
                        onClick={() => generateBackupCodesMutation.mutate()}
                        disabled={generateBackupCodesMutation.isPending}
                      >
                        {generateBackupCodesMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                        Generate Backup Codes
                      </Button>
                    )}
                  </div>
                  
                  <div>
                    <h4 className="font-medium mb-2">Fallback Options</h4>
                    <div className="space-y-2">
                      <div className="flex items-center justify-between text-sm">
                        <span>SMS Backup</span>
                        <Switch data-testid="switch-sms-backup" />
                      </div>
                      <div className="flex items-center justify-between text-sm">
                        <span>Email Backup</span>
                        <Switch data-testid="switch-email-backup" />
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* NOTIFICATIONS TAB */}
        <TabsContent value="notifications" className="mt-6 space-y-6">
          {notifsLoading ? (
            <Card>
              <CardContent className="flex items-center justify-center p-8">
                <Loader2 className="w-6 h-6 animate-spin text-primary" />
              </CardContent>
            </Card>
          ) : (
            <>
              <Card>
                <CardHeader>
                  <CardTitle>Notification Channels</CardTitle>
                  <CardDescription>Choose how you want to receive notifications.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  {[
                    { key: 'emailEnabled', label: 'Email Notifications', desc: 'Receive notifications via email' },
                    { key: 'pushEnabled', label: 'Push Notifications', desc: 'Browser push notifications' },
                    { key: 'inAppEnabled', label: 'In-App Notifications', desc: 'Notifications within the application' },
                  ].map((channel) => (
                    <div key={channel.key} className="flex items-center justify-between py-2">
                      <div>
                        <p className="font-medium">{channel.label}</p>
                        <p className="text-sm text-muted-foreground">{channel.desc}</p>
                      </div>
                      <Switch 
                        checked={notificationPrefs?.[channel.key] ?? true}
                        onCheckedChange={(checked) => {
                          updateNotificationsMutation.mutate({ [channel.key]: checked });
                        }}
                        data-testid={`switch-${channel.key}`}
                      />
                    </div>
                  ))}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Notification Types</CardTitle>
                  <CardDescription>Control which events trigger notifications.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  {[
                    { key: 'newLeads', label: 'New Leads', desc: 'Get notified when new leads are added' },
                    { key: 'dealUpdates', label: 'Deal Updates', desc: 'Updates on deals in progress' },
                    { key: 'contractAlerts', label: 'Contract Alerts', desc: 'Important contract updates' },
                    { key: 'weeklySummary', label: 'Weekly Summary', desc: 'Weekly performance summary' },
                  ].map((type) => (
                    <div key={type.key} className="flex items-center justify-between py-2">
                      <div>
                        <p className="font-medium">{type.label}</p>
                        <p className="text-sm text-muted-foreground">{type.desc}</p>
                      </div>
                      <Switch 
                        checked={notificationPrefs?.[type.key] ?? true}
                        onCheckedChange={(checked) => {
                          updateNotificationsMutation.mutate({ [type.key]: checked });
                        }}
                        data-testid={`switch-${type.key}`}
                      />
                    </div>
                  ))}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Event Categories</CardTitle>
                  <CardDescription>Fine-grained control over which event types notify you in-app.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  {[
                    { key: "task_assigned", label: "Task Assigned", desc: "A task is assigned to you" },
                    { key: "task_due", label: "Task Due Soon", desc: "A task is approaching its due date" },
                    { key: "task_overdue", label: "Task Overdue", desc: "A task is overdue" },
                    { key: "opportunity_stage_changed", label: "Opportunity Stage Changed", desc: "A deal moves to a new pipeline stage" },
                    { key: "opportunity_assigned", label: "Opportunity Assigned", desc: "An opportunity is assigned to you" },
                    { key: "offer_received", label: "Offer Received", desc: "A buyer submits an offer" },
                    { key: "offer_accepted", label: "Offer Accepted", desc: "An offer is accepted" },
                    { key: "inquiry_received", label: "Buyer Inquiry", desc: "A public listing inquiry arrives" },
                    { key: "listing_expired", label: "Listing Expired", desc: "A public listing expires" },
                    { key: "contract_sent", label: "Contract Sent", desc: "A contract is sent for signature" },
                    { key: "contract_viewed", label: "Contract Viewed", desc: "A recipient views a contract" },
                    { key: "contract_signed", label: "Contract Signed", desc: "A contract is signed" },
                    { key: "contract_declined", label: "Contract Declined", desc: "A contract is declined" },
                    { key: "contract_expired", label: "Contract Expired", desc: "A signing link expires" },
                    { key: "missed_call", label: "Missed Call", desc: "You miss an inbound call" },
                    { key: "inbound_sms", label: "Inbound SMS", desc: "A contact replies by SMS" },
                    { key: "internal_message", label: "Internal Message", desc: "A team member messages you" },
                    { key: "voicemail", label: "Voicemail", desc: "A voicemail is left" },
                    { key: "meeting_invite", label: "Meeting Invitation", desc: "You are invited to a meeting" },
                  ].map((cat) => (
                    <div key={cat.key} className="flex items-center justify-between py-2">
                      <div>
                        <p className="font-medium">{cat.label}</p>
                        <p className="text-sm text-muted-foreground">{cat.desc}</p>
                      </div>
                      <Switch
                        checked={notificationPrefs?.categories?.[cat.key] ?? true}
                        onCheckedChange={(checked) => {
                          const next = { ...(notificationPrefs?.categories || {}) };
                          next[cat.key] = checked;
                          updateNotificationsMutation.mutate({ categories: next });
                        }}
                        data-testid={`switch-cat-${cat.key}`}
                      />
                    </div>
                  ))}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Notification Frequency</CardTitle>
                  <CardDescription>Control how often you receive notifications.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="frequency">Delivery Frequency</Label>
                    <Select 
                      value={notificationPrefs?.frequency || 'instant'}
                      onValueChange={(value) => {
                        updateNotificationsMutation.mutate({ frequency: value });
                      }}
                    >
                      <SelectTrigger data-testid="select-frequency">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="instant">Instant</SelectItem>
                        <SelectItem value="hourly">Hourly Digest</SelectItem>
                        <SelectItem value="daily">Daily Digest</SelectItem>
                        <SelectItem value="weekly">Weekly Digest</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Do Not Disturb Schedule</CardTitle>
                  <CardDescription>Set quiet hours when you don't want to receive notifications.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-medium">Enable Do Not Disturb</p>
                      <p className="text-sm text-muted-foreground">Mute notifications during specified hours</p>
                    </div>
                    <Switch 
                      checked={notificationPrefs?.dndEnabled ?? false}
                      onCheckedChange={(checked) => {
                        updateNotificationsMutation.mutate({ dndEnabled: checked });
                      }}
                      data-testid="switch-dnd-enabled"
                    />
                  </div>

                  {notificationPrefs?.dndEnabled && (
                    <div className="grid grid-cols-2 gap-4 pt-4 border-t">
                      <div className="space-y-2">
                        <Label htmlFor="dndStart">Start Time</Label>
                        <Input 
                          id="dndStart" 
                          type="time" 
                          defaultValue={notificationPrefs?.dndStartTime || '22:00'}
                          onChange={(e) => {
                            updateNotificationsMutation.mutate({ dndStartTime: e.target.value });
                          }}
                          data-testid="input-dnd-start"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="dndEnd">End Time</Label>
                        <Input 
                          id="dndEnd" 
                          type="time" 
                          defaultValue={notificationPrefs?.dndEndTime || '08:00'}
                          onChange={(e) => {
                            updateNotificationsMutation.mutate({ dndEndTime: e.target.value });
                          }}
                          data-testid="input-dnd-end"
                        />
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            </>
          )}
        </TabsContent>

        {/* TEAM TAB */}
        <TabsContent value="team" className="mt-6 space-y-6">
          {teamLoading ? (
            <Card>
              <CardContent className="flex items-center justify-center p-8">
                <Loader2 className="w-6 h-6 animate-spin text-primary" />
              </CardContent>
            </Card>
          ) : (
            <>
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Users className="w-5 h-5" /> Lead Assignment & Routing
                  </CardTitle>
                  <CardDescription>
                    Ordered routing rules automatically assign new leads to agents. Manage rules, test them, and set agent capacity.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <Button onClick={() => setLocation("/settings/assignment")}>
                    Open assignment settings
                  </Button>
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>Teams</CardTitle>
                  <CardDescription>Join teams, switch active team, and manage membership.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="space-y-2">
                      <Label>Active team</Label>
                      <Select
                        value={activeTeamId ? String(activeTeamId) : ""}
                        onValueChange={(v) => {
                          const id = parseInt(v, 10);
                          if (Number.isFinite(id)) setActiveTeamMutation.mutate(id);
                        }}
                      >
                        <SelectTrigger data-testid="select-active-team">
                          <SelectValue placeholder="Select a team" />
                        </SelectTrigger>
                        <SelectContent>
                          {myTeams.map((t: any) => (
                            <SelectItem key={t.id} value={String(t.id)}>
                              {t.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {activeTeamResp?.team?.inviteCode ? (
                        <div className="text-xs text-muted-foreground break-words">
                          Invite code: <span className="font-medium">{String(activeTeamResp.team.inviteCode)}</span>
                        </div>
                      ) : null}
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="joinInviteCode">Join by invite code</Label>
                      <div className="flex items-center gap-2">
                        <Input
                          id="joinInviteCode"
                          value={joinInviteCode}
                          onChange={(e) => setJoinInviteCode(e.target.value)}
                          placeholder="e.g. a1b2c3d4e5f6"
                          data-testid="input-join-invite-code"
                        />
                        <Button
                          variant="outline"
                          onClick={() => joinTeamMutation.mutate(joinInviteCode.trim())}
                          disabled={!joinInviteCode.trim() || joinTeamMutation.isPending}
                          data-testid="button-join-team"
                        >
                          Join
                        </Button>
                      </div>
                    </div>
                  </div>
                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="createTeamName">Create team</Label>
                      <div className="flex items-center gap-2">
                        <Input
                          id="createTeamName"
                          value={createTeamName}
                          onChange={(e) => setCreateTeamName(e.target.value)}
                          placeholder="Team name"
                          data-testid="input-create-team-name"
                        />
                        <Button
                          onClick={() => createTeamMutation.mutate({ name: createTeamName.trim() })}
                          disabled={!createTeamName.trim() || createTeamMutation.isPending}
                          data-testid="button-create-team"
                        >
                          Create
                        </Button>
                      </div>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="inviteEmail">Invite member (active team)</Label>
                      <div className="flex items-center gap-2">
                        <Input
                          id="inviteEmail"
                          value={inviteEmail}
                          onChange={(e) => setInviteEmail(e.target.value)}
                          placeholder="member@company.com"
                          data-testid="input-invite-email"
                        />
                        <Select value={inviteRole} onValueChange={setInviteRole}>
                          <SelectTrigger className="w-[140px]" data-testid="select-invite-role">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="viewer">Viewer</SelectItem>
                            <SelectItem value="member">Member</SelectItem>
                            <SelectItem value="admin">Admin</SelectItem>
                          </SelectContent>
                        </Select>
                        <Button
                          variant="outline"
                          onClick={() => {
                            if (!activeTeamId) return;
                            inviteMemberMutation.mutate({ teamId: activeTeamId, email: inviteEmail.trim(), role: inviteRole });
                          }}
                          disabled={!activeTeamId || !inviteEmail.trim() || inviteMemberMutation.isPending || !canManageTeam}
                          data-testid="button-invite-member"
                        >
                          Invite
                        </Button>
                      </div>
                      {!canManageTeam ? (
                        <div className="text-xs text-muted-foreground">Only team admins can invite members.</div>
                      ) : null}
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Team Members</CardTitle>
                  <CardDescription>Manage your team and their permissions.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  {teamMembers.length === 0 ? (
                    <div className="text-center py-8 text-muted-foreground">
                      <Users className="w-12 h-12 mx-auto mb-3 opacity-50" />
                      <p>No team members yet</p>
                      <p className="text-sm mt-1">Start by inviting your first team member</p>
                    </div>
                  ) : (
                    teamMembers.map((member: any, index: number) => {
                      const u = member?.user || {};
                      const name = u.firstName || u.lastName ? `${u.firstName || ""} ${u.lastName || ""}`.trim() : u.email;
                      const isSelf = Number(u.id || 0) === Number(user?.id || 0);
                      return (
                        <div key={member.id} className="flex items-center justify-between border rounded p-3 gap-3" data-testid={`team-member-${index}`}>
                          <div className="min-w-0">
                            <p className="font-medium truncate">{name}</p>
                            <p className="text-sm text-muted-foreground truncate">{u.email}</p>
                          </div>
                          <div className="flex items-center gap-2">
                            <Select
                              value={String(member.role || "member")}
                              onValueChange={(value) => updateMemberMutation.mutate({ id: member.id, patch: { role: value } })}
                              disabled={!canManageTeam || isSelf}
                            >
                              <SelectTrigger className="w-[130px]" data-testid={`select-member-role-${index}`}>
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="viewer">Viewer</SelectItem>
                                <SelectItem value="member">Member</SelectItem>
                                <SelectItem value="admin">Admin</SelectItem>
                                <SelectItem value="owner">Owner</SelectItem>
                              </SelectContent>
                            </Select>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => removeMemberMutation.mutate(member.id)}
                              disabled={!canManageTeam || isSelf || removeMemberMutation.isPending}
                              data-testid={`button-remove-member-${index}`}
                            >
                              Remove
                            </Button>
                          </div>
                        </div>
                      );
                    })
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Team Activity</CardTitle>
                  <CardDescription>Recent team activity and changes.</CardDescription>
                </CardHeader>
                <CardContent>
                  {teamActivity.length ? (
                    <div className="space-y-3">
                      {teamActivity.slice(0, 20).map((a: any) => (
                        <div key={a.id} className="border rounded p-3">
                          <div className="text-sm font-medium">{String(a.action || "")}</div>
                          <div className="text-sm text-muted-foreground break-words">{String(a.description || "")}</div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <p className="text-sm text-muted-foreground">No recent activity</p>
                    </div>
                  )}
                </CardContent>
              </Card>
            </>
          )}
        </TabsContent>

        {/* GOALS TAB */}
        <TabsContent value="goals" className="mt-6 space-y-6">
          {goalsLoading ? (
            <Card>
              <CardContent className="flex items-center justify-center p-8">
                <Loader2 className="w-6 h-6 animate-spin text-primary" />
              </CardContent>
            </Card>
          ) : (
            <>
              <Card>
                <CardHeader>
                  <CardTitle>Current Goals</CardTitle>
                  <CardDescription>Track your progress towards sales and performance goals.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  {goals.length === 0 ? (
                    <div className="text-center py-8 text-muted-foreground">
                      <Target className="w-12 h-12 mx-auto mb-3 opacity-50" />
                      <p>No goals set yet</p>
                      <p className="text-sm mt-1">Create your first goal to start tracking progress</p>
                    </div>
                  ) : (
                    goals.map((goal, index) => {
                      const progress = goal.targetValue > 0 ? (goal.currentValue / goal.targetValue) * 100 : 0;
                      return (
                        <div key={goal.id} className="space-y-3" data-testid={`goal-${index}`}>
                          <div className="flex items-start justify-between">
                            <div>
                              <h4 className="font-medium">{goal.title}</h4>
                              <p className="text-sm text-muted-foreground">{goal.description}</p>
                            </div>
                            <span className="text-sm font-medium">
                              {goal.currentValue}/{goal.targetValue} {goal.unit}
                            </span>
                          </div>
                          <div>
                            <div className="flex items-center justify-between mb-1">
                              <span className="text-xs text-muted-foreground">{progress.toFixed(0)}% Complete</span>
                              <span className="text-xs text-muted-foreground">{goal.period}</span>
                            </div>
                            <Progress value={progress} className="h-2" />
                          </div>
                        </div>
                      );
                    })
                  )}
                  <Dialog open={showCreateGoal} onOpenChange={setShowCreateGoal}>
                    <DialogContent className="sm:max-w-xl">
                      <DialogHeader>
                        <DialogTitle>Create New Goal</DialogTitle>
                      </DialogHeader>
                      <GoalCreator onClose={() => setShowCreateGoal(false)} onSubmit={createGoalMutation} />
                    </DialogContent>
                  </Dialog>

                  <Button
                    className="w-full bg-primary hover:bg-primary/90 text-white"
                    data-testid="button-add-goal"
                    onClick={() => setShowCreateGoal(true)}
                  >
                    Create New Goal
                  </Button>
                </CardContent>
              </Card>
            </>
          )}
        </TabsContent>

        {/* OFFERS TAB */}
        <TabsContent value="automation" className="mt-6 space-y-6">
          <AutomationsContent />
        </TabsContent>

        <TabsContent value="audit" className="mt-6 space-y-6">
          <AuditLogContent />
        </TabsContent>

        <TabsContent value="callaudit" className="mt-6 space-y-6">
          <CallAuditContent />
        </TabsContent>

        <TabsContent value="storage" className="mt-6 space-y-6">
          <StorageSettings />
        </TabsContent>

        <TabsContent value="pipeline" className="mt-6 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Lead Pipeline Columns</CardTitle>
              <CardDescription>Configure the columns used in the Leads pipeline and status pickers.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-3">
                {leadPipelineColumns.map((col, idx) => (
                  <div key={`${col.value}-${idx}`} className="grid grid-cols-12 gap-2 items-center">
                    <div className="col-span-5">
                      <Label className="sr-only">Label</Label>
                      <Input value={col.label} onChange={(e) => {
                        const next = [...leadPipelineColumns];
                        next[idx] = { ...next[idx], label: e.target.value };
                        setLeadPipelineColumns(next);
                      }} placeholder="Label" />
                    </div>
                    <div className="col-span-5">
                      <Label className="sr-only">Value</Label>
                      <Input value={col.value} onChange={(e) => {
                        const next = [...leadPipelineColumns];
                        next[idx] = { ...next[idx], value: e.target.value };
                        setLeadPipelineColumns(next);
                      }} placeholder="value_slug" />
                    </div>
                    <div className="col-span-2 flex justify-end gap-2">
                      <Button type="button" variant="outline" size="sm" disabled={idx === 0} onClick={() => {
                        const next = [...leadPipelineColumns];
                        const tmp = next[idx - 1];
                        next[idx - 1] = next[idx];
                        next[idx] = tmp;
                        setLeadPipelineColumns(next);
                      }}>Up</Button>
                      <Button type="button" variant="outline" size="sm" disabled={idx === leadPipelineColumns.length - 1} onClick={() => {
                        const next = [...leadPipelineColumns];
                        const tmp = next[idx + 1];
                        next[idx + 1] = next[idx];
                        next[idx] = tmp;
                        setLeadPipelineColumns(next);
                      }}>Down</Button>
                      <Button type="button" variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => {
                        setLeadPipelineColumns(leadPipelineColumns.filter((_, i) => i !== idx));
                      }}>Remove</Button>
                    </div>
                  </div>
                ))}
              </div>
              <div className="flex flex-wrap gap-2 justify-between">
                <Button type="button" variant="secondary" onClick={() => setLeadPipelineColumns([...leadPipelineColumns, { value: "", label: "" }])}>
                  Add Column
                </Button>
                <Button type="button" className="bg-primary hover:bg-primary/90 text-white" onClick={() => {
                  const cleaned = leadPipelineColumns
                    .map((c) => ({ value: String(c.value || "").trim(), label: String(c.label || "").trim() }))
                    .filter((c) => c.value && c.label);
                  saveLeadPipelineMutation.mutate(cleaned);
                }} disabled={saveLeadPipelineMutation.isPending}>
                  Save
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Opportunity Pipeline Columns</CardTitle>
              <CardDescription>Configure the columns used in the Opportunities pipeline and status pickers.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-3">
                {opportunityPipelineColumns.map((col, idx) => (
                  <div key={`${col.value}-${idx}`} className="grid grid-cols-1 sm:grid-cols-12 gap-2 sm:items-center border rounded-lg p-3 sm:border-0 sm:p-0">
                    <div className="sm:col-span-5">
                      <Label className="sm:sr-only text-xs font-medium mb-1 block sm:mb-0">Label</Label>
                      <Input value={col.label} onChange={(e) => {
                        const next = [...opportunityPipelineColumns];
                        next[idx] = { ...next[idx], label: e.target.value };
                        setOpportunityPipelineColumns(next);
                      }} placeholder="Label" />
                    </div>
                    <div className="sm:col-span-5">
                      <Label className="sm:sr-only text-xs font-medium mb-1 block sm:mb-0">Value</Label>
                      <Input value={col.value} onChange={(e) => {
                        const next = [...opportunityPipelineColumns];
                        next[idx] = { ...next[idx], value: e.target.value };
                        setOpportunityPipelineColumns(next);
                      }} placeholder="value_slug" />
                    </div>
                    <div className="sm:col-span-2 flex justify-start sm:justify-end gap-2">
                      <Button type="button" variant="outline" size="sm" disabled={idx === 0} onClick={() => {
                        const next = [...opportunityPipelineColumns];
                        const tmp = next[idx - 1];
                        next[idx - 1] = next[idx];
                        next[idx] = tmp;
                        setOpportunityPipelineColumns(next);
                      }}>Up</Button>
                      <Button type="button" variant="outline" size="sm" disabled={idx === opportunityPipelineColumns.length - 1} onClick={() => {
                        const next = [...opportunityPipelineColumns];
                        const tmp = next[idx + 1];
                        next[idx + 1] = next[idx];
                        next[idx] = tmp;
                        setOpportunityPipelineColumns(next);
                      }}>Down</Button>
                      <Button type="button" variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => {
                        setOpportunityPipelineColumns(opportunityPipelineColumns.filter((_, i) => i !== idx));
                      }}>Remove</Button>
                    </div>
                  </div>
                ))}
              </div>
              <div className="flex flex-wrap gap-2 justify-between">
                <Button type="button" variant="secondary" onClick={() => setOpportunityPipelineColumns([...opportunityPipelineColumns, { value: "", label: "" }])}>
                  Add Column
                </Button>
                <Button type="button" className="bg-primary hover:bg-primary/90 text-white" onClick={() => {
                  const cleaned = opportunityPipelineColumns
                    .map((c) => ({ value: String(c.value || "").trim(), label: String(c.label || "").trim() }))
                    .filter((c) => c.value && c.label);
                  saveOpportunityPipelineMutation.mutate(cleaned);
                }} disabled={saveOpportunityPipelineMutation.isPending}>
                  Save
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* APPEARANCE TAB */}
        <TabsContent value="appearance" className="mt-6 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Camera className="w-5 h-5" />
                Profile Picture
              </CardTitle>
              <CardDescription>Upload a profile picture that will be displayed in the app.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-6">
                <div className="relative">
                  <div className="w-24 h-24 rounded-full overflow-hidden bg-muted flex items-center justify-center border-2 border-border">
                    {userData?.hasProfilePicture ? (
                      <img 
                        src={`/api/users/${userData.id}/avatar?v=${encodeURIComponent(String(userData.updatedAt || ""))}`} 
                        alt="Profile" 
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <User className="w-10 h-10 text-muted-foreground" />
                    )}
                  </div>
                </div>
                <div className="space-y-3">
                  <div className="flex gap-2">
                    <label className="cursor-pointer">
                      <input
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) {
                            const reader = new FileReader();
                            reader.onload = (event) => {
                              const base64 = event.target?.result as string;
                              updateUserMutation.mutate({ profilePicture: base64 });
                            };
                            reader.readAsDataURL(file);
                          }
                        }}
                        data-testid="input-profile-picture"
                      />
                      <Button type="button" variant="outline" asChild>
                        <span>
                          <Upload className="w-4 h-4 mr-2" />
                          Upload Photo
                        </span>
                      </Button>
                    </label>
                    {userData?.hasProfilePicture && (
                      <Button
                        type="button"
                        variant="ghost"
                        className="text-destructive hover:text-destructive"
                        onClick={() => updateUserMutation.mutate({ profilePicture: null })}
                        data-testid="button-remove-profile-picture"
                      >
                        <Trash2 className="w-4 h-4 mr-2" />
                        Remove
                      </Button>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Recommended: Square image, at least 200x200 pixels
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <ImageIcon className="w-5 h-5" />
                Motivational Banner
              </CardTitle>
              <CardDescription>Customize the motivational banner on your dashboard.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="flex items-center justify-between">
                <div className="space-y-1">
                  <Label>Show Motivational Quotes</Label>
                  <p className="text-sm text-muted-foreground">Display inspiring quotes above the banner images</p>
                </div>
                <Switch
                  checked={userData?.showBannerQuotes !== false}
                  onCheckedChange={(checked) => updateUserMutation.mutate({ showBannerQuotes: checked })}
                  data-testid="switch-show-quotes"
                />
              </div>

              <div className="flex items-center justify-between">
                <div className="space-y-1">
                  <Label>Show Dashboard Banner</Label>
                  <p className="text-sm text-muted-foreground">Hide or show the banner on your dashboard</p>
                </div>
                <Switch
                  checked={bannerConfig.enabled}
                  onCheckedChange={(checked) =>
                    updateUserMutation.mutate({ bannerConfig: { ...bannerConfig, enabled: checked } })
                  }
                  data-testid="switch-show-banner"
                />
              </div>

              <div className="space-y-3">
                <Label>Banner Images</Label>
                <p className="text-sm text-muted-foreground">
                  Manage every banner image — including the defaults. Remove, reorder, or turn images on/off.
                </p>

                <div className="space-y-2">
                  {bannerConfig.images.map((img, index) => (
                    <div key={img.key} className="flex items-center gap-3 p-2 border rounded-lg">
                      <img
                        src={img.url}
                        alt={img.key}
                        className="w-20 h-12 object-cover rounded border shrink-0"
                      />
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium truncate">{img.key}</p>
                        <p className="text-xs text-muted-foreground">{img.active ? "Visible" : "Hidden"}</p>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        disabled={index === 0}
                        onClick={() => {
                          const images = [...bannerConfig.images];
                          [images[index - 1], images[index]] = [images[index], images[index - 1]];
                          updateUserMutation.mutate({ bannerConfig: { ...bannerConfig, images } });
                        }}
                        aria-label={`Move ${img.key} up`}
                        data-testid={`button-banner-up-${index}`}
                      >
                        <ArrowUp className="h-4 w-4" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        disabled={index === bannerConfig.images.length - 1}
                        onClick={() => {
                          const images = [...bannerConfig.images];
                          [images[index + 1], images[index]] = [images[index], images[index + 1]];
                          updateUserMutation.mutate({ bannerConfig: { ...bannerConfig, images } });
                        }}
                        aria-label={`Move ${img.key} down`}
                        data-testid={`button-banner-down-${index}`}
                      >
                        <ArrowDown className="h-4 w-4" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => {
                          const images = bannerConfig.images.map((i, idx) =>
                            idx === index ? { ...i, active: !i.active } : i,
                          );
                          updateUserMutation.mutate({ bannerConfig: { ...bannerConfig, images } });
                        }}
                        aria-label={img.active ? `Hide ${img.key}` : `Show ${img.key}`}
                        data-testid={`button-banner-toggle-${index}`}
                      >
                        {img.active ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="text-destructive hover:text-destructive"
                        onClick={() => {
                          const images = bannerConfig.images.filter((_, idx) => idx !== index);
                          updateUserMutation.mutate({ bannerConfig: { ...bannerConfig, images } });
                        }}
                        aria-label={`Remove ${img.key}`}
                        data-testid={`button-banner-remove-${index}`}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                  {bannerConfig.images.length === 0 && (
                    <p className="text-sm text-muted-foreground">No banner images. Add one below.</p>
                  )}
                </div>

                <label className="cursor-pointer">
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) {
                        const reader = new FileReader();
                        reader.onload = (event) => {
                          const base64 = event.target?.result as string;
                          const images = [
                            ...bannerConfig.images,
                            { key: `custom-${Date.now()}`, url: base64, active: true },
                          ];
                          updateUserMutation.mutate({ bannerConfig: { ...bannerConfig, images } });
                        };
                        reader.readAsDataURL(file);
                      }
                    }}
                    data-testid="input-banner-image"
                  />
                  <div className="w-full h-20 border-2 border-dashed border-muted-foreground/30 rounded-lg flex flex-col items-center justify-center gap-1 hover:border-primary hover:bg-accent/10 transition-colors">
                    <Upload className="w-5 h-5 text-muted-foreground" />
                    <span className="text-xs text-muted-foreground">Add Image</span>
                  </div>
                </label>
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <Label>Custom Quotes</Label>
                    <p className="text-sm text-muted-foreground">Add your own motivational quotes to the banner carousel</p>
                  </div>
                </div>
                
                <div className="space-y-2">
                  {(userData?.customBannerQuotes || []).map((q: any, index: number) => (
                    <div key={index} className="flex items-start gap-2 p-3 border rounded-lg">
                      {editingQuoteIndex === index ? (
                        <div className="flex-1 space-y-2">
                          <Input
                            value={q.quote}
                            onChange={(e) => {
                              const quotes = [...(userData?.customBannerQuotes || [])];
                              quotes[index] = { ...quotes[index], quote: e.target.value };
                              updateUserMutation.mutate({ customBannerQuotes: quotes });
                            }}
                            placeholder="Quote text"
                            data-testid={`input-edit-quote-${index}`}
                          />
                          <Input
                            value={q.author}
                            onChange={(e) => {
                              const quotes = [...(userData?.customBannerQuotes || [])];
                              quotes[index] = { ...quotes[index], author: e.target.value };
                              updateUserMutation.mutate({ customBannerQuotes: quotes });
                            }}
                            placeholder="Author"
                            data-testid={`input-edit-author-${index}`}
                          />
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => setEditingQuoteIndex(null)}
                            data-testid={`button-done-edit-quote-${index}`}
                          >
                            <Save className="w-4 h-4 mr-1" />
                            Done
                          </Button>
                        </div>
                      ) : (
                        <>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium truncate">"{q.quote}"</p>
                            <p className="text-xs text-muted-foreground">— {q.author}</p>
                          </div>
                          <div className="flex items-center gap-1 shrink-0">
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              onClick={() => setEditingQuoteIndex(index)}
                              data-testid={`button-edit-quote-${index}`}
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="text-destructive hover:text-destructive"
                              onClick={() => {
                                const quotes = (userData?.customBannerQuotes || []).filter((_: any, i: number) => i !== index);
                                updateUserMutation.mutate({ customBannerQuotes: quotes });
                              }}
                              data-testid={`button-remove-quote-${index}`}
                            >
                              <X className="h-4 w-4" />
                            </Button>
                          </div>
                        </>
                      )}
                    </div>
                  ))}
                  
                  <div className="flex items-center gap-2 pt-2">
                    <Input
                      value={newQuoteText}
                      onChange={(e) => setNewQuoteText(e.target.value)}
                      placeholder="Enter a new quote..."
                      className="flex-1"
                      data-testid="input-new-quote"
                    />
                    <Input
                      value={newQuoteAuthor}
                      onChange={(e) => setNewQuoteAuthor(e.target.value)}
                      placeholder="Author"
                      className="w-40"
                      data-testid="input-new-quote-author"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      onClick={() => {
                        if (!newQuoteText.trim()) return;
                        const quotes = [...(userData?.customBannerQuotes || []), { quote: newQuoteText.trim(), author: newQuoteAuthor.trim() || "Custom" }];
                        updateUserMutation.mutate({ customBannerQuotes: quotes });
                        setNewQuoteText("");
                        setNewQuoteAuthor("");
                      }}
                      disabled={!newQuoteText.trim()}
                      data-testid="button-add-quote"
                    >
                      <Plus className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* SYSTEM TAB */}
        <TabsContent value="system" className="mt-6 space-y-6">
          {/* Provider Readiness Header */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Server className="w-5 h-5" />
                Communications Provider Status
              </CardTitle>
              <CardDescription>Unified readiness dashboard for all communication channels.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center gap-3 flex-wrap">
                <Button
                  className="bg-primary text-white hover:bg-primary/90"
                  onClick={() => refetchReadiness()}
                  disabled={readinessFetching}
                  data-testid="button-refresh-readiness"
                >
                  {readinessFetching && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                  Re-check All Providers
                </Button>
                <Button
                  variant="outline"
                  onClick={() => window.location.assign('/system-health')}
                  data-testid="button-system-health"
                >
                  System Health
                </Button>
                <Button
                  variant="outline"
                  onClick={() => window.location.assign('/settings/email')}
                  data-testid="button-email-settings"
                >
                  Email Delivery
                </Button>
                <Button
                  variant="outline"
                  onClick={() => window.location.assign('/settings/email-provisioning')}
                  data-testid="button-email-provisioning"
                >
                  Email Provisioning
                </Button>
                <Button
                  variant="outline"
                  onClick={() => { refetchTelephony(); refetchCore(); }}
                  disabled={telephonyFetching || coreFetching}
                  data-testid="button-refresh-all"
                >
                  Refresh All
                </Button>
              </div>
              {providerReadiness?.checkedAt && (
                <p className="text-xs text-muted-foreground">Last checked: {new Date(providerReadiness.checkedAt).toLocaleString()}</p>
              )}
            </CardContent>
          </Card>

          {/* Setup Wizard Toggle */}
          <Card className="border-dashed border-primary/30">
            <CardContent className="py-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium text-sm">New to Telnyx? Use the Setup Wizard</p>
                  <p className="text-xs text-muted-foreground">Walk through API key, connection ID, messaging profile, and webhook setup with live validation at each step.</p>
                </div>
                <Button variant="outline" onClick={() => setShowTelnyxWizard(!showTelnyxWizard)} data-testid="button-toggle-telnyx-wizard">
                  {showTelnyxWizard ? "Hide Wizard" : "Open Setup Wizard"}
                </Button>
              </div>
              {showTelnyxWizard && (
                <div className="mt-4">
                  <TelnyxOnboardingWizard onComplete={() => { setShowTelnyxWizard(false); refetchReadiness(); refetchTelephony(); toast.success("Setup complete! Provider status refreshed."); }} />
                </div>
              )}
            </CardContent>
          </Card>

          {/* Channel Status Cards */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {/* Voice */}
            <Card className={providerReadiness?.voice?.blocker ? 'border-red-200' : providerReadiness?.voice?.configured ? 'border-green-200' : ''}>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Phone className="h-4 w-4" /> Voice
                  <span className={`ml-auto text-xs font-semibold px-2 py-0.5 rounded-full ${
                    providerReadiness?.voice?.reachable ? 'bg-green-100 text-green-700' :
                    providerReadiness?.voice?.configured ? 'bg-yellow-100 text-yellow-700' :
                    'bg-gray-100 text-gray-500'
                  }`}>{providerReadiness?.voice?.reachable ? 'Ready' : providerReadiness?.voice?.configured ? 'Issues' : 'Not configured'}</span>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div className="flex justify-between"><span className="text-muted-foreground">Configured</span><span>{providerReadiness?.voice?.configured ? '✓' : '✗'}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Connection type</span><span className="font-mono text-xs">{providerReadiness?.voice?.connectionType || '—'}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Connection active</span><span>{providerReadiness?.voice?.connectionActive ? '✓' : '✗'}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Default from</span><span className="font-mono text-xs">{providerReadiness?.voice?.defaultFromNumber || '—'}</span></div>
                {providerReadiness?.voice?.fromNumbers?.length > 0 && (
                  <div><span className="text-muted-foreground text-xs">Available numbers</span><div className="flex flex-wrap gap-1 mt-1">{providerReadiness.voice.fromNumbers.map((n: string) => <code key={n} className="text-xs bg-muted px-1 rounded">{n}</code>)}</div></div>
                )}
                {providerReadiness?.voice?.connectionType === 'sip_credential' && (
                  <div className="rounded-md bg-red-50 border border-red-200 p-2 text-xs text-red-700 mt-2">
                    ⚠ TELNYX_CONNECTION_ID appears to be a SIP Credential, not a Call Control Application. Update it in Telnyx portal.
                  </div>
                )}
                {providerReadiness?.voice?.blocker && providerReadiness.voice.connectionType !== 'sip_credential' && (
                  <p className="text-xs text-red-600 mt-2">{providerReadiness.voice.blocker}</p>
                )}
              </CardContent>
            </Card>

            {/* SMS */}
            <Card className={providerReadiness?.sms?.blocker ? 'border-red-200' : providerReadiness?.sms?.configured ? 'border-green-200' : ''}>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Phone className="h-4 w-4" /> SMS
                  <span className={`ml-auto text-xs font-semibold px-2 py-0.5 rounded-full ${
                    providerReadiness?.sms?.configured ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
                  }`}>{providerReadiness?.sms?.configured ? 'Ready' : 'Not configured'}</span>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div className="flex justify-between"><span className="text-muted-foreground">Configured</span><span>{providerReadiness?.sms?.configured ? '✓' : '✗'}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Messaging profile</span><span>{providerReadiness?.sms?.messagingProfilePresent ? '✓' : '✗'}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Default from</span><span className="font-mono text-xs">{providerReadiness?.sms?.defaultFromNumber || '—'}</span></div>
                {providerReadiness?.sms?.blocker && <p className="text-xs text-red-600 mt-2">{providerReadiness.sms.blocker}</p>}
              </CardContent>
            </Card>

            {/* Video */}
            <Card className={providerReadiness?.video?.blocker ? 'border-yellow-200' : providerReadiness?.video?.configured ? 'border-green-200' : ''}>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Phone className="h-4 w-4" /> Video Meetings
                  <span className={`ml-auto text-xs font-semibold px-2 py-0.5 rounded-full ${
                    providerReadiness?.video?.roomsApiAvailable ? 'bg-green-100 text-green-700' :
                    providerReadiness?.video?.configured ? 'bg-yellow-100 text-yellow-700' :
                    'bg-gray-100 text-gray-500'
                  }`}>{providerReadiness?.video?.roomsApiAvailable ? 'Ready' : providerReadiness?.video?.configured ? 'Degraded' : 'Not enabled'}</span>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div className="flex justify-between"><span className="text-muted-foreground">Configured</span><span>{providerReadiness?.video?.configured ? '✓' : '✗'}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Rooms API</span><span>{providerReadiness?.video?.roomsApiAvailable ? '✓' : '✗'}</span></div>
                {providerReadiness?.video?.blocker && <p className="text-xs text-amber-600 mt-2">{providerReadiness.video.blocker}</p>}
              </CardContent>
            </Card>

            {/* Email */}
            <Card className={providerReadiness?.email?.blocker ? 'border-yellow-200' : providerReadiness?.email?.configured ? 'border-green-200' : ''}>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Bot className="h-4 w-4" /> Email
                  <span className={`ml-auto text-xs font-semibold px-2 py-0.5 rounded-full ${
                    providerReadiness?.email?.configured ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
                  }`}>{providerReadiness?.email?.configured ? `Active (${providerReadiness.email.activeProvider})` : 'Not configured'}</span>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div className="flex justify-between"><span className="text-muted-foreground">Provider</span><span>{providerReadiness?.email?.activeProvider || '—'}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">From address</span><span className="font-mono text-xs">{providerReadiness?.email?.fromAddress || '—'}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Telnyx Email</span><span>{providerReadiness?.email?.telnyxEssionEnabled ? 'enabled' : 'disabled'}</span></div>
                {providerReadiness?.email?.blocker && <p className="text-xs text-amber-600 mt-2">{providerReadiness.email.blocker}</p>}
              </CardContent>
            </Card>

            {/* Document Storage */}
            <Card className={providerReadiness?.documentStorage?.configured ? 'border-green-200' : ''}>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Database className="h-4 w-4" /> Document Storage
                  <span className={`ml-auto text-xs font-semibold px-2 py-0.5 rounded-full ${
                    providerReadiness?.documentStorage?.configured ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
                  }`}>{providerReadiness?.documentStorage?.configured ? 'Ready' : 'Not configured'}</span>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div className="flex justify-between"><span className="text-muted-foreground">Configured</span><span>{providerReadiness?.documentStorage?.configured ? '✓' : '✗'}</span></div>
                {providerReadiness?.documentStorage?.blocker && <p className="text-xs text-amber-600 mt-2">{providerReadiness.documentStorage.blocker}</p>}
              </CardContent>
            </Card>

            {/* Webhook */}
            <Card className={providerReadiness?.webhook?.configured ? 'border-green-200' : 'border-yellow-200'}>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Server className="h-4 w-4" /> Webhook
                  <span className={`ml-auto text-xs font-semibold px-2 py-0.5 rounded-full ${
                    providerReadiness?.webhook?.configured ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'
                  }`}>{providerReadiness?.webhook?.configured ? 'Configured' : 'Not set'}</span>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div className="flex justify-between"><span className="text-muted-foreground">URL present</span><span>{providerReadiness?.webhook?.publicUrlPresent ? '✓' : '✗'}</span></div>
                {providerReadiness?.webhook?.configured && (
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground text-xs">URL:</span>
                    <code className="text-xs bg-muted px-1 rounded truncate max-w-[200px]" title={providerReadiness.webhook.publicUrlPresent ? '' : ''}>{providerReadiness.webhook.publicUrlPresent ? ('').replace(/^https?:\/\/[^/]+/, '***') : '—'}</code>
                  </div>
                )}
                {providerReadiness?.webhook?.blocker && <p className="text-xs text-amber-600 mt-2">{providerReadiness.webhook.blocker}</p>}
              </CardContent>
            </Card>

            {/* AI Assistant */}
            <Card className={providerReadiness?.aiAssistant?.blocker ? 'border-yellow-200' : providerReadiness?.aiAssistant?.configured ? 'border-green-200' : ''}>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Bot className="h-4 w-4" /> AI Assistant
                  <span className={`ml-auto text-xs font-semibold px-2 py-0.5 rounded-full ${
                    providerReadiness?.aiAssistant?.configured && providerReadiness.aiAssistant.assistantIdPresent ? 'bg-green-100 text-green-700' :
                    providerReadiness?.aiAssistant?.configured ? 'bg-yellow-100 text-yellow-700' :
                    'bg-gray-100 text-gray-500'
                  }`}>{providerReadiness?.aiAssistant?.configured && providerReadiness.aiAssistant.assistantIdPresent ? 'Ready' : providerReadiness?.aiAssistant?.configured ? 'ID missing' : 'Disabled'}</span>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Enable AI Screener</span>
                  <Switch
                    checked={aiFeatureEnabledInput === true}
                    onCheckedChange={(v) => setAiFeatureEnabledInput(v)}
                    aria-label="Enable AI Screener"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="ai-assistant-id" className="text-xs text-muted-foreground">Assistant ID</Label>
                  <Input
                    id="ai-assistant-id"
                    value={aiAssistantIdInput}
                    onChange={(e) => setAiAssistantIdInput(e.target.value)}
                    placeholder="Paste the Telnyx Assistant ID (High-Intent Lead Screener)"
                    className="font-mono text-xs"
                  />
                  <p className="text-xs text-muted-foreground">
                    Saved to app settings — overrides the TELNYX_AI_ASSISTANT_ID / FEATURE_AI_ASSISTANT env vars.
                    Source: <span className="font-mono">{aiSettingsData?.source || '—'}</span>
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    onClick={() =>
                      saveAiAssistantMutation.mutate({
                        assistantId: aiAssistantIdInput.trim(),
                        enabled: aiFeatureEnabledInput === true,
                      })
                    }
                    disabled={saveAiAssistantMutation.isPending}
                  >
                    {saveAiAssistantMutation.isPending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Save className="w-3 h-3 mr-1" />}
                    Save
                  </Button>
                  {providerReadiness?.aiAssistant?.blocker && <span className="text-xs text-amber-600">{providerReadiness.aiAssistant.blocker}</span>}
                </div>
              </CardContent>
            </Card>

            {/* Call Recording */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Bot className="h-4 w-4" /> Call Recording
                  <span className={`ml-auto text-xs font-semibold px-2 py-0.5 rounded-full ${recordingSettings?.enabled ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                    {recordingSettings?.enabled ? 'Enabled' : 'Disabled'}
                  </span>
                </CardTitle>
                <CardDescription>Two-leg dialer calls only. A consent beep plays when recording starts.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Enable call recording</span>
                  <Switch
                    checked={recordingSettings?.enabled === true}
                    onCheckedChange={(v) => toggleRecordingMutation.mutate(v)}
                    disabled={toggleRecordingMutation.isPending}
                    aria-label="Enable call recording"
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  Agents choose per call in the dialer. Recordings appear on the call panel after the call ends.
                  Check your jurisdiction's two-party consent requirements before enabling.
                </p>
              </CardContent>
            </Card>
          </div>

          {/* Feature Flags */}
          {providerReadiness?.featureFlags && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Feature Flags</CardTitle>
                <CardDescription>Current feature flag state for your environment.</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  {Object.entries(providerReadiness.featureFlags).map(([key, enabled]) => (
                    <div key={key} className="flex items-center gap-2">
                      <span className={`w-2 h-2 rounded-full ${enabled ? 'bg-green-500' : 'bg-gray-300'}`} />
                      <span className="text-sm capitalize">{key.replace(/_/g, ' ')}</span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Portal Setup Guide (collapsed) */}
          <details className="group">
            <summary className="cursor-pointer text-sm font-medium text-muted-foreground hover:text-foreground flex items-center gap-2">
              <span className="group-open:rotate-90 transition-transform">▶</span>
              Telnyx Portal Setup Guide
            </summary>
            <div className="mt-4 space-y-4 text-sm">
              <div className="rounded-md border p-3 space-y-2">
                <p className="font-medium">Voice Setup</p>
                <ol className="list-decimal list-inside space-y-1 text-xs text-muted-foreground">
                  <li>Create or confirm a Call Control Application in Telnyx portal</li>
                  <li>Set webhook URL to: <code className="bg-muted px-1 rounded">{'https://your-domain.com/api/v1/telecom/webhooks/telnyx'}</code></li>
                  <li>Assign at least one voice-capable DID to the app</li>
                  <li>Copy the Call Control Application ID into TELNYX_CONNECTION_ID</li>
                  <li>Confirm it is NOT a SIP Credential connection</li>
                </ol>
              </div>
              <div className="rounded-md border p-3 space-y-2">
                <p className="font-medium">SMS Setup</p>
                <ol className="list-decimal list-inside space-y-1 text-xs text-muted-foreground">
                  <li>Create or confirm Messaging Profile in Telnyx portal</li>
                  <li>Assign DID to messaging profile</li>
                  <li>Copy profile ID into TELNYX_MESSAGING_PROFILE_ID</li>
                </ol>
              </div>
              <div className="rounded-md border p-3 space-y-2">
                <p className="font-medium">Video Setup</p>
                <ol className="list-decimal list-inside space-y-1 text-xs text-muted-foreground">
                  <li>Confirm Video API / rooms capability is enabled on your account</li>
                  <li>Set TELNYX_VIDEO_ENABLED=true</li>
                  <li>Rooms are created server-side; clients join with short-lived tokens</li>
                </ol>
              </div>
              <div className="rounded-md border p-3 space-y-2">
                <p className="font-medium">Email Setup</p>
                <ol className="list-decimal list-inside space-y-1 text-xs text-muted-foreground">
                  <li>For Resend: set RESEND_API_KEY + RESEND_FROM</li>
                  <li>For Telnyx Email: confirm beta access, verify sending domain, set TELNYX_EMAIL_ENABLED=true</li>
                  <li>Publish required DNS records (SPF, DKIM, MX, DMARC)</li>
                </ol>
              </div>
              <div className="rounded-md border p-3 space-y-2">
                <p className="font-medium">AI Assistant Setup</p>
                <ol className="list-decimal list-inside space-y-1 text-xs text-muted-foreground">
                  <li>Create the assistant in Telnyx portal → AI Assistants (e.g. High-Intent Lead Screener)</li>
                  <li>Copy its Assistant ID into TELNYX_AI_ASSISTANT_ID</li>
                  <li>Set FEATURE_AI_ASSISTANT=true</li>
                  <li>Start it from the dialer on an active call, or enable auto-start in Power Dialer</li>
                  <li>Transcripts arrive via ai_assistant.message_history_updated webhooks</li>
                </ol>
              </div>
            </div>
          </details>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Target className="w-5 h-5" />
                Skip Trace
              </CardTitle>
              <CardDescription>Set your default workflow for provider and public research.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {skipTraceConfig?.enabled === false ? (
                <div className="text-sm text-muted-foreground">Skip Trace is disabled for your account.</div>
              ) : (
                <>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div className="space-y-1">
                      <div className="text-xs text-muted-foreground">Provider</div>
                      <div className="text-sm font-medium">{skipTraceConfig?.providerName || "—"}</div>
                    </div>
                    <div className="space-y-1">
                      <div className="text-xs text-muted-foreground">Public research</div>
                      <div className="text-sm font-medium">{skipTraceConfig?.publicResearchEnabled ? "enabled" : "disabled"}</div>
                    </div>
                    <div className="space-y-1">
                      <div className="text-xs text-muted-foreground">Status</div>
                      <div className="text-sm font-medium">{skipTraceFetching ? "checking…" : "ready"}</div>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label>Default mode</Label>
                    <Select
                      value={String(userData?.skipTraceDefaultMode || "both")}
                      onValueChange={(value) => updateUserMutation.mutate({ skipTraceDefaultMode: value })}
                      disabled={updateUserMutation.isPending || skipTraceFetching}
                    >
                      <SelectTrigger data-testid="select-skip-trace-default-mode">
                        <SelectValue placeholder="Select default mode" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="provider" disabled={Array.isArray(skipTraceConfig?.allowedModes) && !skipTraceConfig.allowedModes.includes("provider")}>Provider</SelectItem>
                        <SelectItem value="public_research" disabled={Array.isArray(skipTraceConfig?.allowedModes) && !skipTraceConfig.allowedModes.includes("public_research")}>Public</SelectItem>
                        <SelectItem value="both" disabled={Array.isArray(skipTraceConfig?.allowedModes) && !skipTraceConfig.allowedModes.includes("both")}>Both</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          {/* Legacy System Health Cards */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Database className="w-5 h-5" /> Database
                </CardTitle>
                <CardDescription>Connectivity and query health.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm">Status</span>
                  <span className={`text-sm font-medium ${coreHealth?.db === "connected" ? "text-green-600" : "text-red-600"}`}>{coreHealth?.db || "unknown"}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm">Last check</span>
                  <span className="text-xs text-muted-foreground">{coreHealth?.timestamp ? new Date(coreHealth.timestamp).toLocaleString() : "-"}</span>
                </div>
                <Button variant="outline" size="sm" onClick={() => refetchCore()} disabled={coreFetching}>
                  {coreFetching && <Loader2 className="w-4 h-4 mr-2 animate-spin" />} Refresh
                </Button>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Bot className="w-5 h-5" /> AI SMS
                </CardTitle>
                <CardDescription>Credentials readiness for SMS automation.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm">Configured</span>
                  <span className={`text-sm font-medium ${aiConfig?.ready ? "text-green-600" : "text-red-600"}`}>{aiConfig?.ready ? "yes" : "no"}</span>
                </div>
                {!aiConfig?.ready && Array.isArray(aiConfig?.missing) && aiConfig.missing.length > 0 && (
                  <div>
                    <p className="text-xs text-muted-foreground">Missing:</p>
                    <p className="text-xs">{aiConfig.missing.join(", ")}</p>
                  </div>
                )}
                <Button variant="outline" size="sm" onClick={() => refetchAi()} disabled={aiFetching}>
                  {aiFetching && <Loader2 className="w-4 h-4 mr-2 animate-spin" />} Refresh
                </Button>
              </CardContent>
            </Card>
          </div>


        </TabsContent>
      </Tabs>
    </Layout>
  );
}

// Goal Creator Component
function GoalCreator({ onClose, onSubmit }: { onClose: () => void, onSubmit: any }) {
  const [formData, setFormData] = useState({
    title: "",
    description: "",
    targetValue: "",
    currentValue: "",
    unit: "deals",
    period: "month",
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit.mutate({
      ...formData,
      targetValue: parseFloat(formData.targetValue),
      currentValue: parseFloat(formData.currentValue) || 0,
    });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4 p-4 bg-accent/5 rounded-lg mb-4">
      <h3 className="font-semibold text-lg">Create New Goal</h3>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="goal-title">Goal Title</Label>
          <Input
            id="goal-title"
            data-testid="input-goal-title"
            value={formData.title}
            onChange={(e) => setFormData({ ...formData, title: e.target.value })}
            placeholder="e.g., Close 12 deals"
            required
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="goal-period">Period</Label>
          <Select value={formData.period} onValueChange={(value) => setFormData({ ...formData, period: value })}>
            <SelectTrigger data-testid="select-goal-period">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="week">Week</SelectItem>
              <SelectItem value="month">Month</SelectItem>
              <SelectItem value="quarter">Quarter</SelectItem>
              <SelectItem value="year">Year</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor="goal-description">Description</Label>
        <Input
          id="goal-description"
          data-testid="input-goal-description"
          value={formData.description}
          onChange={(e) => setFormData({ ...formData, description: e.target.value })}
          placeholder="Brief description of your goal"
        />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="space-y-2">
          <Label htmlFor="goal-target">Target Value</Label>
          <Input
            id="goal-target"
            data-testid="input-goal-target"
            type="number"
            value={formData.targetValue}
            onChange={(e) => setFormData({ ...formData, targetValue: e.target.value })}
            placeholder="12"
            required
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="goal-current">Current Value</Label>
          <Input
            id="goal-current"
            data-testid="input-goal-current"
            type="number"
            value={formData.currentValue}
            onChange={(e) => setFormData({ ...formData, currentValue: e.target.value })}
            placeholder="0"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="goal-unit">Unit</Label>
          <Select value={formData.unit} onValueChange={(value) => setFormData({ ...formData, unit: value })}>
            <SelectTrigger data-testid="select-goal-unit">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="deals">Deals</SelectItem>
              <SelectItem value="dollars">Dollars</SelectItem>
              <SelectItem value="leads">Leads</SelectItem>
              <SelectItem value="contracts">Contracts</SelectItem>
              <SelectItem value="properties">Properties</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="flex gap-3">
        <Button type="submit" data-testid="button-save-goal" disabled={onSubmit.isPending}>
          {onSubmit.isPending ? "Creating..." : "Create Goal"}
        </Button>
        <Button type="button" variant="outline" onClick={onClose} data-testid="button-cancel-goal">
          Cancel
        </Button>
      </div>
    </form>
  );
}

export default function Settings() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <Layout>
        <div className="flex items-center justify-center h-96">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
      </Layout>
    );
  }

  if (!user) {
    return (
      <Layout>
        <div className="flex items-center justify-center h-96">
          <p className="text-muted-foreground">Please log in to access settings.</p>
        </div>
      </Layout>
    );
  }

  return <SettingsContent />;
}
