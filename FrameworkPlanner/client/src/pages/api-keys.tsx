import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Layout } from "@/components/layout/Layout";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { Key, Plus, Trash2, Copy, Check, AlertTriangle } from "lucide-react";

interface ApiKey {
  id: number;
  name: string;
  keyPrefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export default function ApiKeysPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [newKeyName, setNewKeyName] = useState("");
  const [newKeyExpiry, setNewKeyExpiry] = useState("90");
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const { data, isLoading, isError } = useQuery<{ keys: ApiKey[] }>({
    queryKey: ["/api/api-keys"],
  });

  const createMutation = useMutation({
    mutationFn: (input: { name: string; expiresInDays?: number }) =>
      apiRequest("POST", "/api/api-keys", input),
    onSuccess: (data: any) => {
      setCreatedKey(data.key);
      setNewKeyName("");
      queryClient.invalidateQueries({ queryKey: ["/api/api-keys"] });
      toast({ title: "API key created", description: "Copy the key now — it won't be shown again." });
    },
    onError: (e: any) => {
      toast({ title: "Failed to create API key", description: e?.message, variant: "destructive" });
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/api-keys/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/api-keys"] });
      toast({ title: "API key revoked" });
    },
    onError: (e: any) => {
      toast({ title: "Failed to revoke API key", description: e?.message, variant: "destructive" });
    },
  });

  const handleCreate = () => {
    if (!newKeyName.trim()) {
      toast({ title: "Enter a name for the API key", variant: "destructive" });
      return;
    }
    const days = parseInt(newKeyExpiry);
    createMutation.mutate({
      name: newKeyName.trim(),
      expiresInDays: Number.isFinite(days) && days > 0 ? days : undefined,
    });
  };

  const copyKey = async () => {
    if (!createdKey) return;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(createdKey);
      } else {
        // Fallback for non-secure contexts / webviews where the async clipboard API is unavailable
        const ta = document.createElement("textarea");
        ta.value = createdKey;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.top = "0";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        ta.setSelectionRange(0, ta.value.length);
        const ok = document.execCommand("copy");
        document.body.removeChild(ta);
        if (!ok) throw new Error("execCommand copy failed");
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast({ title: "Could not copy to clipboard", description: "Select the key text manually and copy it.", variant: "destructive" });
    }
  };

  const keys = data?.keys ?? [];
  const activeKeys = keys.filter((k) => !k.revokedAt);

  return (
    <Layout>
      <div className="space-y-4 p-4 lg:p-6 max-w-4xl">
        <div>
          <h1 className="font-serif text-2xl font-semibold flex items-center gap-2">
            <Key className="h-6 w-6" />
            API Keys
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Create API keys for AI agents and integrations. Keys authenticate via{" "}
            <code className="text-xs bg-muted px-1 rounded">Authorization: Bearer lxrm_...</code>
          </p>
        </div>

        {isError && (
          <Card className="border-destructive/40">
            <CardContent className="p-6 text-center text-sm text-muted-foreground">
              <AlertTriangle className="h-8 w-8 mx-auto mb-2 text-destructive" />
              Couldn't load API keys. Only admins and team leads can manage API keys.
            </CardContent>
          </Card>
        )}

        {/* Newly created key — show once */}
        {createdKey && (
          <Card className="border-[#D4AF37]/40 bg-[#D4AF37]/5">
            <CardHeader>
              <CardTitle className="text-base">Your new API key</CardTitle>
              <CardDescription>
                Copy this now — it will never be shown again.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-2">
                <code className="flex-1 text-xs bg-background border rounded p-3 break-all font-mono select-all">
                  {createdKey}
                </code>
                <Button size="sm" onClick={copyKey}>
                  {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="mt-2"
                onClick={() => setCreatedKey(null)}
              >
                Dismiss
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Create new key */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Create new API key</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-medium">Name</label>
                <Input
                  placeholder="e.g. Merlow Agent"
                  value={newKeyName}
                  onChange={(e) => setNewKeyName(e.target.value)}
                  className="mt-1"
                />
              </div>
              <div>
                <label className="text-xs font-medium">Expires in (days)</label>
                <Input
                  type="number"
                  placeholder="90"
                  value={newKeyExpiry}
                  onChange={(e) => setNewKeyExpiry(e.target.value)}
                  className="mt-1"
                  min="1"
                />
                <p className="text-[11px] text-muted-foreground mt-1">
                  Leave empty for no expiration
                </p>
              </div>
            </div>
            <Button onClick={handleCreate} disabled={createMutation.isPending}>
              <Plus className="h-4 w-4 mr-2" />
              {createMutation.isPending ? "Creating…" : "Create API Key"}
            </Button>
          </CardContent>
        </Card>

        {/* Existing keys */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Active keys ({activeKeys.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-2">
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-16 w-full" />
              </div>
            ) : activeKeys.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-6">
                No API keys yet. Create one above to get started.
              </p>
            ) : (
              <div className="space-y-2">
                {activeKeys.map((key) => (
                  <div
                    key={key.id}
                    className="flex items-center justify-between border rounded-lg p-3"
                  >
                    <div className="min-w-0">
                      <div className="font-medium text-sm truncate">{key.name}</div>
                      <div className="text-xs text-muted-foreground font-mono">
                        {key.keyPrefix}…
                      </div>
                      <div className="flex items-center gap-2 mt-1">
                        <Badge variant="secondary" className="text-[10px]">
                          Created {new Date(key.createdAt).toLocaleDateString()}
                        </Badge>
                        {key.expiresAt && (
                          <Badge variant="outline" className="text-[10px]">
                            Expires {new Date(key.expiresAt).toLocaleDateString()}
                          </Badge>
                        )}
                        {key.lastUsedAt && (
                          <span className="text-[10px] text-muted-foreground">
                            Last used {new Date(key.lastUsedAt).toLocaleDateString()}
                          </span>
                        )}
                      </div>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        if (confirm(`Revoke "${key.name}"? This cannot be undone.`)) {
                          revokeMutation.mutate(key.id);
                        }
                      }}
                      disabled={revokeMutation.isPending}
                    >
                      <Trash2 className="h-4 w-4 mr-1" />
                      <span className="hidden sm:inline">Revoke</span>
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </Layout>
  );
}
