import type { Express } from "express";
import { createServer, type Server } from "http";
import bcrypt from "bcryptjs";
import { SignJWT, jwtVerify } from "jose";
import multer from "multer";
import { createRequire } from "node:module";
import { storage } from "./storage.js";
import { seedDocsForTeam, docsSlugify } from "./docs-seed.js";
import { computeManualTimeEntry, MAX_TIME_ENTRY_HOURS } from "./lib/time-entry-math.js";
import { db, pool } from "./db.js";
import { and, desc, eq, gte, inArray, lte, sql, lt, isNull, isNotNull, ne, or, notInArray } from "drizzle-orm";
import { initTelephonyWs, emitTelephonyEventToAll } from "./telephony/ws.js";
import { publishTelephonyEvent } from "./telephony/pubsub.js";
import { getTelephonyMediaSignedUrl, uploadTelephonyMediaFromUrl } from "./telephony/objectStorage.js";
import { getSchemaReadiness, schemaFixInstructions } from "./schema-readiness.js";
import {
  createExportJob,
  createImportJob,
  computeLeadDedupeKey,
  computeOpportunityDedupeKey,
  detectFormat,
  getCrmFieldDefs,
  getExportJob,
  getImportJob,
  listImportJobErrors,
  parseUpload,
  processExportJob,
  processImportJob,
  renewExportToken,
  suggestMapping,
  verifyExportToken,
} from "./crm/import-export.js";
import { canApproveImports, computeImportSignature, evaluateImportGate } from "./crm/import-approval.js";
import { QUARANTINE_ENTITY_TYPES, canRestoreQuarantine } from "./crm/quarantine.js";
import { listQuarantinedRecords, restoreQuarantinedRecord, scanAndFlagEntity } from "./crm/quarantine-service.js";
import { setImportApproval } from "./crm/import-export.js";
import { 
  insertLeadSchema,
  type InsertLead, 
  insertPropertySchema, 
  insertContactSchema, 
  insertContractSchema,
  insertContractTemplateSchema,
  insertContractDocumentSchema,
  insertContractEnvelopeSchema,
  insertContractSignerSchema,
  insertContractEventSchema,
  insertContractFieldSchema,
  insertDocumentVersionSchema,
  insertLoiSchema,
  insertUserSchema,
  insertTwoFactorAuthSchema,
  insertBackupCodeSchema,
  twoFactorAuth,
  backupCodes,
  insertTeamSchema,
  insertTeamMemberSchema,
  teamMembers,
  insertTeamActivityLogSchema,
  insertNotificationPreferenceSchema,
  insertUserNotificationSchema,
  insertUserGoalSchema,
  insertOfferSchema,
  insertWorkCategorySchema,
  insertTimesheetEntrySchema,
  insertWorkerProfileSchema,
  insertCategoryRateOverrideSchema,
  insertBuyerSchema,
  insertBuyerCommunicationSchema,
  insertDealAssignmentSchema,
  insertDealParticipantSchema,
  insertPlaygroundPropertySessionSchema,
  insertUnderwritingTemplateSchema,
  insertTaskSchema,
  insertCompanySchema,
  insertCompanyPersonSchema,
  insertCompanyLinkSchema,
  insertDocumentSchema,
  insertDocumentLinkSchema,
  insertVaultDocumentVersionSchema,
  insertAutomationSchema,
  insertAutomationTriggerSchema,
  insertAutomationConditionSchema,
  insertAutomationActionSchema,
  insertAutomationRunSchema,
  crmExportFiles,
  crmImportJobs,
  auditEvents,
  users,
  insertOpportunityPartySchema,
  insertPublicListingSchema,
  insertPropertyUnitSchema,
  insertBuyerInquirySchema,
  insertOpportunityEventSchema,
  globalActivityLogs,
  opportunityParties, publicListings, buyerInquiries, opportunityEvents,
  defaultNotificationCategories, insertInternalMessageSchema, insertCalendarEventSchema,
  tasks, taskSlaRules, taskAudit, quarantinedRecords, insertTaskSlaRuleSchema
} from "./shared-schema.js";
import { z } from "zod";
import { computeArvFromComps, computeCommissionMath, computeDealMath, computeRepairTotal, commissionSnapshotInputSchema, underwritingSchemaV1, underwritingTemplateConfigSchema } from "../shared/underwriting.js";
import {
  OPPORTUNITY_STAGES,
  OPPORTUNITY_STAGE_CONFIG,
  isValidStage,
  canTransitionOpportunityStage as canTransitionStage,
  DEFAULT_PIPELINE_COLUMNS,
  validatePipelineColumns,
} from "../shared/pipeline-stages.js";
import type { OpportunityStage } from "../shared/pipeline-stages.js";
import { settingsFromRow as agentPhoneSettingsFromRow, validateAgentPhoneSettings } from "./dialer/user-settings.js";
import { validateWidgetLayout } from "./dialer/widget-layouts.js";
import { createSkipTraceJob, isHttpError, runProviderSkipTraceForEntity, runSkipTraceJob } from "./services/skipTrace/orchestrator.js";
import { hydrateSkipTraceResultForApi, mergeSkipTraceResult } from "./services/skipTrace/merge.js";
import { recomputeBuyerMatchesForOpportunity } from "./services/buyerMatch/recompute.js";
import { validateManualCompInput } from "./services/comps/manual.js";
import { getSkipTraceProvider } from "./services/skipTrace/provider.js";
import { telnyx, TelnyxConfigError, createTelnyxWebhookRouter } from "./services/telecom/telnyx-client.js";
import { sendEmail } from "./services/messaging/email-router.js";
import { emailProviderReadiness } from "./email/provider.js";
import { sendCrmEmail } from "./email/sender.js";
import { isSuppressed, addSuppression, removeSuppression, listSuppressions } from "./email/suppression.js";
import { verifyWebhookSecret, ingestWebhookBatch } from "./email/webhooks.js";
import { getAuthStatusSnapshot, getEmailProviderMissing } from "./auth/config.js";
import { isEmailNotConfiguredError, sendAuthError } from "./auth/errors.js";
import { completeTaskWithRecurrence, createTask, onContractSigned, onLeadCreated, onLeadStatusChanged } from "./services/tasks/task-service.js";
import { getRvmProvider } from "./services/rvm/provider.js";
import crypto from "node:crypto";
import { createIsFeatureEnabled, isFeatureBypassUser, requireFeature } from "./featureFlags.js";
import { getProviderReadiness } from "./services/telecom/provider-readiness.js";
import { getWebRtcReadiness, getWebRtcClientConfig } from "./services/telecom/webrtc-config.js";
import { getAiAssistantConfig } from "./services/telecom/ai-config.js";
import * as callSessions from "./services/telecom/call-sessions.js";
import { writeAuditEvent } from "./services/audit/writeAuditEvent.js";
import { dispatchAutomationEvent, dryRunAutomation } from "./services/automations/engine.js";
const require = createRequire(import.meta.url);
const packageJson: any = (() => {
  try {
    return require("../package.json");
  } catch {
    return {};
  }
})();
import { mergeTemplate } from "./services/esign/merge.js";
import { generateSignedPdfBase64 } from "./services/esign/pdf.js";
import { buildMergeData, applyTemplateToContract, validateContractForSend } from "./services/contracts/contract-service.js";
import { sendContractSigningEmail, sendContractReminderEmail } from "./services/contracts/email.js";
import { startContractReminderWorker } from "./cron/contract-reminders.js";
import { getPropertyPhotoSignedUrl, getPropertyPhotoContent, uploadPropertyPhoto, isPropertyPhotoStorageConfigured } from "./media/propertyPhotos.js";
import Stripe from "stripe";
import { getDocumentContent, getDocumentSignedUrl, isDocumentVaultConfigured, makeDocumentStorageKey, sha256Hex, uploadDocumentObject } from "./media/documentVault.js";
import { registerMediaRoutes } from "./media/media-routes.js";
import { detectMimeFromMagic, maxMediaUploadBytes, maxImageUploadBytes, maxVideoUploadBytes, probeImageDimensions, validateMediaFile } from "./media/mime-guard.js";
import { getMediaAssetById, assertMediaTeam, attachMedia, setMediaDeliveryMode, listMediaByAttachments } from "./media/mediaVault.js";
import { planMessageDelivery, linkFallbackText } from "./media/mms-plan.js";
import { makeMediaShareUrl } from "./media/share-token.js";
import speakeasy from "speakeasy";
import QRCode from "qrcode";
function authJwtSecret() {
  const secret = process.env.AUTH_JWT_SECRET || process.env.SESSION_SECRET;
  if (!secret || !String(secret).trim()) return null;
  return new TextEncoder().encode(String(secret));
}
function isDbConnectivityError(error: any): boolean {
  const code = error?.code;
  if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "ETIMEDOUT") return true;
  if (code === "57P01" || code === "57P02" || code === "57P03") return true;
  if (code === "08006" || code === "08001" || code === "08004") return true;
  if (code === "DEPTH_ZERO_SELF_SIGNED_CERT" || code === "SELF_SIGNED_CERT_IN_CHAIN") return true;
  if (code === "ERR_TLS_CERT_ALTNAME_INVALID" || code === "CERT_HAS_EXPIRED") return true;
  const nested = error?.errors;
  if (Array.isArray(nested)) return nested.some(isDbConnectivityError);
  const message = String(error?.message || "");
  if (message.includes("DATABASE_URL")) return true;
  // Neon serverless driver (WebSocket) surfaces DNS/connect failures as a message with a null code.
  if (/network error|non-101|socket hang up|connect econn|getaddrinfo|econnrefused|enotfound|etimedout/i.test(message)) return true;
  const cause = error?.cause;
  if (cause && cause !== error) return isDbConnectivityError(cause);
  return false;
}
// C6: startup diagnostics — record every registered API route so the health
// endpoint can prove the route bootstrap completed and detect any failure.
const routeRegistry: Array<{ method: string; path: string }> = [];
export function getRouteRegistry() {
  return routeRegistry;
}
function reg(method: string, path: string) {
  routeRegistry.push({ method: String(method).toUpperCase(), path });
  return true;
}

const BOOT_TIME = new Date();
// C6: minimum number of API routes this build registers. If /api/system/routes
// reports fewer, the route bootstrap partially failed (the 09-11 outage mode).
// Item 9 (2026-09-16 audit): this build registers 474 routes statically (470
// at runtime); the floor must sit below runtime counts so healthy boots don't
// warn with "470/450".
const EXPECTED_ROUTE_COUNT = 465;

function parseLimitOffset(query: any): { limit: number; offset: number } {
  const DEFAULT_LIMIT = 50;
  const MAX_LIMIT = process.env.NODE_ENV === "production" ? 100 : 500;
  let limit: number = DEFAULT_LIMIT;
  const limitRaw = query?.limit;
  if (typeof limitRaw === "string" && limitRaw.trim() !== "") {
    const parsed = Number.parseInt(limitRaw, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      limit = Math.min(parsed, MAX_LIMIT);
    }
  }
  let offset = 0;
  const offsetRaw = query?.offset;
  if (typeof offsetRaw === "string" && offsetRaw.trim() !== "") {
    const parsed = Number.parseInt(offsetRaw, 10);
    if (Number.isFinite(parsed) && parsed >= 0) {
      offset = parsed;
    }
  }
  return { limit, offset };
}
async function issueAuthToken(payload: { sub: string; email?: string }) {
  const secret = authJwtSecret();
  if (!secret) return null;
  return await new SignJWT({ email: payload.email })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(payload.sub)
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(secret);
}
function isManagerUser(user: any) {
  const role = String(user?.role || "").toLowerCase();
  return !!user?.isSuperAdmin || role === "admin" || role === "manager" || role === "owner";
}
/**
 * Extended manager check that also honors team-level admin/owner roles.
 * The Settings → Team role dropdown edits team_members.role (not users.role),
 * so a user promoted to admin there must also pass manager-gated endpoints
 * like API key management. Falls back gracefully on DB errors.
 */
async function isManagerUserWithTeams(user: any): Promise<boolean> {
  if (isManagerUser(user)) return true;
  try {
    const memberships = await db
      .select({ role: teamMembers.role, status: teamMembers.status })
      .from(teamMembers)
      .where(and(eq(teamMembers.userId, user.id), eq(teamMembers.status, "active")));
    return memberships.some((m: any) => {
      const r = String(m.role || "").toLowerCase();
      return r === "admin" || r === "owner";
    });
  } catch {
    return false;
  }
}
// P0 fix (audit IDOR): ownership check for by-ID endpoints. Managers/admins
// see everything; everyone else must own the record (assignedTo / ownerUserId
// / userId / createdBy — whichever the table uses). Returns true if allowed.
function canAccessOwnedRecord(actor: any, record: any): boolean {
  if (!actor || !record) return false;
  if (isManagerUser(actor)) return true;
  const actorId = Number(actor.id);
  const ownerIds = [
    (record as any).assignedTo,
    (record as any).ownerUserId,
    (record as any).owner_id,
    (record as any).userId,
    (record as any).user_id,
    (record as any).createdBy,
    (record as any).created_by,
    (record as any).assignedToUserId,
  ].map(Number).filter(Number.isFinite);
  return ownerIds.includes(actorId);
}
function isAdminUser(user: any) {
  return isManagerUser(user);
}
function isSameUserOrAdmin(user: any, targetUserId: number): boolean {
  return Number(user?.id) === Number(targetUserId) || isManagerUser(user);
}
// Simple in-memory rate limiter for 2FA verification attempts (per user + IP).
const twoFactorAttempts = new Map<string, { count: number; resetAt: number }>();
function checkTwoFactorRateLimit(key: string, max: number = 5, windowMs: number = 15 * 60 * 1000): boolean {
  const now = Date.now();
  const entry = twoFactorAttempts.get(key);
  if (!entry || entry.resetAt < now) {
    twoFactorAttempts.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (entry.count >= max) return false;
  entry.count += 1;
  return true;
}
// Idempotent, preference-aware notification creation. Dedupes via event_key;
// respects the user's granular category + global in-app toggle.
async function notifyUser(opts: {
  userId: number;
  category: string;
  title: string;
  description?: string | null;
  relatedType?: string | null;
  relatedId?: number | null;
  eventKey?: string | null;
}): Promise<boolean> {
  try {
    const prefs = await storage.getNotificationPreferencesByUserId(opts.userId);
    if (prefs && prefs.inAppEnabled === false) return false;
    const base = defaultNotificationCategories();
    const stored = prefs?.categories && typeof prefs.categories === "object" ? prefs.categories : {};
    const cats = { ...base, ...stored };
    if (cats[opts.category] === false) return false;
    const created = await storage.createUserNotificationDedup({
      userId: opts.userId,
      type: opts.category,
      title: opts.title,
      description: opts.description ?? null,
      read: false,
      relatedId: opts.relatedId ?? null,
      relatedType: opts.relatedType ?? null,
      eventKey: opts.eventKey ?? null,
    } as any);
    return Boolean(created);
  } catch (error) {
    console.error("[notifyUser] failed:", error);
    return false;
  }
}
// Resolve the assigned owner of an opportunity and notify them (preference-aware, deduped).
async function notifyOpportunityOwner(opts: {
  propertyId: number;
  category: string;
  title: string;
  description?: string | null;
  eventKey: string;
  actorUserId?: number | null;
  relatedType?: string;
}): Promise<void> {
  try {
    const property = await storage.getPropertyById(opts.propertyId);
    const ownerId = Number((property as any)?.assignedTo);
    if (!ownerId) return;
    if (opts.actorUserId && Number(opts.actorUserId) === ownerId) return;
    await notifyUser({
      userId: ownerId,
      category: opts.category,
      title: opts.title,
      description: opts.description ?? null,
      relatedType: opts.relatedType ?? "opportunity",
      relatedId: opts.propertyId,
      eventKey: opts.eventKey,
    });
  } catch (error) {
    console.error("[notifyOpportunityOwner] failed:", error);
  }
}
function userDisplayName(user: any): string {
  const first = String(user?.firstName || "").trim();
  const last = String(user?.lastName || "").trim();
  const name = [first, last].filter(Boolean).join(" ");
  return name || String(user?.email || "team member");
}
function isoDateOnly(input: unknown) {
  if (!input) return null;
  const d = input instanceof Date ? input : new Date(String(input));
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}
function parseMoney(input: unknown) {
  const n = Number.parseFloat(String(input ?? ""));
  if (!Number.isFinite(n)) return null;
  return n;
}
async function ensureCommissionLedgerForEvent(event: any) {
  const sourceType = String(event?.sourceType || "");
  const sourceId = Number(event?.sourceId);
  if (!sourceType || !Number.isFinite(sourceId)) return;
  let participants = await storage.listDealParticipants({ sourceType, sourceId });
  if (!participants.length) {
    let derivedUserId: number | null = null;
    if (sourceType === "contract") {
      const contract = await storage.getContractById(sourceId);
      const propertyId = contract?.propertyId ? Number(contract.propertyId) : null;
      if (propertyId) {
        const property = await storage.getPropertyById(propertyId);
        if (property?.assignedTo) derivedUserId = Number(property.assignedTo);
      }
    } else if (sourceType === "deal_assignment") {
      const assignment = await storage.getDealAssignmentById(sourceId);
      const propertyId = assignment?.propertyId ? Number(assignment.propertyId) : null;
      if (propertyId) {
        const property = await storage.getPropertyById(propertyId);
        if (property?.assignedTo) derivedUserId = Number(property.assignedTo);
      }
    }
    if (derivedUserId) {
      await storage.upsertDealParticipant({ sourceType, sourceId, userId: derivedUserId, role: "primary" } as any);
      participants = await storage.listDealParticipants({ sourceType, sourceId });
    }
  }
  if (!participants.length) return;
  const gross = parseMoney(event?.grossAmount);
  for (const p of participants) {
    const pct = parseMoney((p as any).splitPct);
    const amount = gross !== null && pct !== null ? gross * (pct / 100) : 0;
    await storage.upsertCommissionLedgerEntry({
      eventId: event.id,
      userId: p.userId,
      amount: amount.toFixed(2) as any,
      status: "draft" as any,
      ruleSnapshot: { grossAmount: gross, splitPct: pct, method: pct !== null ? "pct_of_gross" : "manual" } as any,
    } as any);
  }
}
async function syncCommissionEventsForContract(contract: any) {
  const contractId = Number(contract?.id);
  if (!Number.isFinite(contractId)) return;
  const signDate = isoDateOnly(contract?.signDate);
  const closeDate = isoDateOnly(contract?.closeDate);
  const grossAmount = parseMoney(contract?.amount);
  if (signDate) {
    const ev = await storage.upsertCommissionEvent({
      sourceType: "contract",
      sourceId: contractId,
      milestone: "contract_signed",
      eventDate: signDate as any,
      grossAmount: grossAmount === null ? null : (grossAmount.toFixed(2) as any),
      metadata: { contractId } as any,
    } as any);
    await ensureCommissionLedgerForEvent(ev);
  }
  if (closeDate) {
    const ev = await storage.upsertCommissionEvent({
      sourceType: "contract",
      sourceId: contractId,
      milestone: "contract_closed",
      eventDate: closeDate as any,
      grossAmount: grossAmount === null ? null : (grossAmount.toFixed(2) as any),
      metadata: { contractId } as any,
    } as any);
    await ensureCommissionLedgerForEvent(ev);
  }
}
async function syncCommissionEventsForDealAssignment(assignment: any) {
  const id = Number(assignment?.id);
  if (!Number.isFinite(id)) return;
  const payoutReceived = Boolean((assignment as any).payoutReceived);
  const payoutAmount = parseMoney((assignment as any).payoutAmount);
  const closingDate = isoDateOnly((assignment as any).closingDate) || isoDateOnly(new Date());
  if (payoutReceived) {
    const ev = await storage.upsertCommissionEvent({
      sourceType: "deal_assignment",
      sourceId: id,
      milestone: "assignment_payout_received",
      eventDate: closingDate as any,
      grossAmount: payoutAmount === null ? null : (payoutAmount.toFixed(2) as any),
      metadata: { dealAssignmentId: id } as any,
    } as any);
    await ensureCommissionLedgerForEvent(ev);
  }
}
function isConciergeUser(user: any) {
  const role = String(user?.role || "").trim().toLowerCase();
  return role === "concierge";
}
function isXpOpsUser(user: any) {
  return isAdminUser(user) || isConciergeUser(user);
}
async function requireAuth(req: any, res: any) {
  // API key auth (0104): check for Bearer token first.
  const authHeader = req.headers?.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7).trim();
    if (token.startsWith("lxrm_")) {
      try {
        const { validateApiKey } = await import("./services/api-keys.js");
        const result = await validateApiKey(token);
        if (result) {
          const user = await storage.getUserByIdWithoutProfilePicture(result.userId);
          if (user) {
            // Attach API key context for scope checking.
            (req as any).apiKey = { keyId: result.keyId, scopes: result.scopes };
            return user;
          }
        }
      } catch (e) {
        console.error("API key validation failed:", e);
      }
      res.status(401).json({ message: "Invalid API key" });
      return null;
    }
  }

  // Session auth (existing).
  const userId = req.session?.userId;
  if (!userId) {
    res.status(401).json({ message: "Unauthorized" });
    return null;
  }
  // Skip profile_picture (can be a multi-MB base64 blob) on the hot auth path.
  const user = await storage.getUserByIdWithoutProfilePicture(userId);
  if (!user) {
    res.status(401).json({ message: "Unauthorized" });
    return null;
  }
  return user;
}
function teamRoleRank(role: unknown) {
  const r = String(role || "").trim().toLowerCase();
  if (r === "owner") return 4;
  if (r === "admin") return 3;
  if (r === "member") return 2;
  if (r === "viewer") return 1;
  return 0;
}
async function requireTeamMembership(req: any, res: any, input: { teamId: number; minRole?: "viewer" | "member" | "admin" | "owner" }) {
  const user = await requireAuth(req, res);
  if (!user) return null;
  if (user.isSuperAdmin) return { user, membership: { role: "owner" } as any };
  const membership = await storage.getTeamMemberByTeamAndUser(input.teamId, user.id);
  if (!membership || String(membership.status || "").toLowerCase() !== "active") {
    res.status(403).json({ message: "Forbidden" });
    return null;
  }
  const min = input.minRole ? teamRoleRank(input.minRole) : 1;
  if (teamRoleRank(membership.role) < min) {
    res.status(403).json({ message: "Forbidden" });
    return null;
  }
  return { user, membership };
}
async function getOrInitActiveTeamId(req: any, userId: number): Promise<number | null> {
  try {
    const active = typeof req.session?.activeTeamId === "number" ? req.session.activeTeamId : null;
    if (active) {
      const m = await storage.getTeamMemberByTeamAndUser(active, userId);
      if (m && String(m.status || "").toLowerCase() === "active") return active;
    }
    const teams = await storage.getTeamsForUser(userId);
    const first = teams?.[0]?.id ? Number(teams[0].id) : null;
    if (first) req.session.activeTeamId = first;
    return first;
  } catch {
    return null;
  }
}
async function requireActiveTeam(req: any, res: any, input?: { minRole?: "viewer" | "member" | "admin" | "owner" }) {
  const user = await requireAuth(req, res);
  if (!user) return null;
  const teamId = await getOrInitActiveTeamId(req, user.id);
  if (!teamId) {
    res.status(400).json({ message: "No active team selected" });
    return null;
  }
  if (user.isSuperAdmin) return { user, membership: { role: "owner" } as any, teamId };
  const membership = await storage.getTeamMemberByTeamAndUser(teamId, user.id);
  if (!membership || String(membership.status || "").toLowerCase() !== "active") {
    res.status(403).json({ message: "Forbidden" });
    return null;
  }
  const min = input?.minRole ? teamRoleRank(input.minRole) : 1;
  if (teamRoleRank(membership.role) < min) {
    res.status(403).json({ message: "Forbidden" });
    return null;
  }
  return { user, membership, teamId };
}
function makeInviteCode() {
  return crypto.randomBytes(6).toString("hex");
}
async function requireAssigneeInActiveTeam(req: any, res: any, user: any, assigneeUserId: number) {
  const teamId = await getOrInitActiveTeamId(req, user.id);
  if (!teamId) {
    if (assigneeUserId === user.id) return true;
    res.status(400).json({ message: "No active team selected" });
    return false;
  }
  if (user.isSuperAdmin) return true;
  const m = await storage.getTeamMemberByTeamAndUser(teamId, assigneeUserId);
  if (!m || String(m.status || "").toLowerCase() !== "active") {
    res.status(400).json({ message: "Assignee is not in your active team" });
    return false;
  }
  return true;
}
const isFeatureEnabled = createIsFeatureEnabled(storage.getUserFeatureFlag.bind(storage));
function isImportExportEntityType(entityType: string) {
  return entityType === "lead" || entityType === "opportunity" || entityType === "contact" || entityType === "buyer";
}
async function writeAuthAuditLog(input: {
  action: string;
  outcome: string;
  userId?: number | null;
  email?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown> | null;
}) {
  try {
    const metadataText = input.metadata ? JSON.stringify(input.metadata) : null;
    await db.execute(sql`
      INSERT INTO auth_audit_logs (action, outcome, user_id, email, ip, user_agent, metadata)
      VALUES (
        ${input.action},
        ${input.outcome},
        ${input.userId ?? null},
        ${input.email ?? null},
        ${input.ip ?? null},
        ${input.userAgent ?? null},
        ${metadataText}
      )
    `);
  } catch {}
}
function isLoopbackIp(ip: string | undefined) {
  if (!ip) return false;
  const v = ip.trim();
  return v === "127.0.0.1" || v === "::1" || v === "::ffff:127.0.0.1";
}
function isDevEmployeeBypassEnabled() {
  if (process.env.NODE_ENV === "production") return false;
  const v = String(process.env.DEV_AUTH_BYPASS_ENABLED || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}
function toAddressKey(address: string) {
  return address.trim().toLowerCase();
}
function skipTraceCacheKey(input: { ownerName: string; address: string; city: string; state: string; zipCode: string }) {
  return `${input.ownerName}|${input.address}|${input.city}|${input.state}|${input.zipCode}`.trim().toLowerCase();
}
function parseJsonArrayText(v: any): string[] {
  if (!v) return [];
  if (Array.isArray(v)) return v.map((x) => String(x)).filter(Boolean);
  try {
    const parsed = JSON.parse(String(v));
    if (Array.isArray(parsed)) return parsed.map((x) => String(x)).filter(Boolean);
    return [];
  } catch {
    return [];
  }
}
function resolvePropertyImageSrc(v: unknown): string | null {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) return null;
  if (s.startsWith("property-photo:")) {
    const key = s.slice("property-photo:".length);
    return `/api/property-photos/${encodeURIComponent(key)}`;
  }
  return s;
}
function resolvePropertyImages(images: unknown): string[] {
  if (!Array.isArray(images)) return [];
  return images.map(resolvePropertyImageSrc).filter((x): x is string => !!x);
}
function toNumberOrNull(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}
function haversineMiles(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 3958.7613;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.sin(dLng / 2) * Math.sin(dLng / 2) * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.sqrt(h));
}
// ===== OPPORTUNITY STAGE WORKFLOW CONSTANTS =====
// Ticket 7: the canonical taxonomy lives in shared/pipeline-stages.ts and is
// re-exported here for existing importers, so there is exactly one vocabulary
// across the server, client, and automations.
export { OPPORTUNITY_STAGES, OPPORTUNITY_STAGE_CONFIG, isValidStage, canTransitionStage };
export type { OpportunityStage };
export const OPPORTUNITY_TYPE_OPTIONS = [
  "acquisition",
  "disposition",
  "assignment",
  "buy_and_hold",
  "flip",
  "other",
] as const;
export type OpportunityType = (typeof OPPORTUNITY_TYPE_OPTIONS)[number];
export const OPPORTUNITY_STATUS_OPTIONS = [
  "active",
  "pending",
  "on_hold",
  "delayed",
  "archived",
] as const;
export type OpportunityStatus = (typeof OPPORTUNITY_STATUS_OPTIONS)[number];
export function generateSlug(title: string): string {
  const base = String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  const rand = crypto.randomBytes(4).toString("hex");
  return `${base || "listing"}-${rand}`;
}
export function generateListingToken(): string {
  return crypto.randomBytes(24).toString("hex");
}
export async function logOpportunityEvent(
  opportunityId: number,
  eventType: string,
  title: string,
  description?: string,
  actorUserId?: number,
  actorType: string = "user",
  metadata?: Record<string, unknown>,
): Promise<void> {
  try {
    await storage.createOpportunityEvent({
      opportunityId,
      eventType,
      title,
      description: description || null,
      actorType: actorType as any,
      actorUserId: actorUserId || null,
      metadataJson: metadata ? JSON.stringify(metadata) : null,
    } as any);
  } catch {}
}
// Create an opportunity-linked task only if one with the same title does not
// already exist (idempotency guard for stage-triggered automations).
export async function ensureOpportunityTask(
  propertyId: number,
  userId: number,
  def: { title: string; description?: string; type: string; priority: string; dueAt: Date },
): Promise<boolean> {
  try {
    const existing = await storage.getTasksByRelatedEntity("opportunity", propertyId);
    const key = String(def.title || "").trim();
    if (existing.some((t: any) => String(t.title || "").trim() === key)) return false;
    await createTask({
      relatedEntityType: "opportunity",
      relatedEntityId: propertyId,
      assignedToUserId: userId,
      title: def.title,
      description: def.description ?? null,
      type: def.type,
      priority: def.priority,
      dueAt: def.dueAt,
      createdBy: userId,
    } as any);
    return true;
  } catch {
    return false;
  }
}
export async function transitionOpportunityStage(
  propertyId: number,
  newStage: string,
  user: { id: number },
  ip?: string,
): Promise<void> {
  const property = await storage.getPropertyById(propertyId);
  if (!property) return;
  const oldStage = (property as any).stage || "lead";
  if (!isValidStage(newStage)) {
    newStage = "lead";
  }
  const valid = canTransitionStage(oldStage as OpportunityStage, newStage as OpportunityStage);
  if (!valid && oldStage !== newStage) return;
  const now = new Date();
  await storage.updateProperty(propertyId, {
    stage: newStage,
    stageChangedAt: now,
    lastActivityAt: now,
  });
  await logOpportunityEvent(
    propertyId,
    "stage_changed",
    `Stage changed to ${OPPORTUNITY_STAGE_CONFIG[newStage as OpportunityStage]?.label || newStage}`,
    `Moved from '${oldStage}' to '${newStage}'`,
    user.id,
    "user",
    { oldStage, newStage, ip },
  );
  try {
    const teamId = await getOrInitActiveTeamId({ session: { userId: user.id } } as any, user.id);
    if (teamId) {
      await dispatchAutomationEvent({
        eventType: "opportunity.stage_changed",
        teamId,
        actorUserId: user.id,
        entity: { type: "opportunity", id: propertyId },
        payload: { oldStage, newStage, propertyId },
      });
    }
  } catch {}
}
const inquiryRateLimiter = new Map<string, number[]>();
function checkInquiryRateLimit(ip: string): boolean {
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  const maxRequests = 5;
  const timestamps = inquiryRateLimiter.get(ip) || [];
  const valid = timestamps.filter((t) => now - t < windowMs);
  if (valid.length >= maxRequests) {
    inquiryRateLimiter.set(ip, valid);
    return false;
  }
  valid.push(now);
  inquiryRateLimiter.set(ip, valid);
  return true;
}
export async function registerRoutes(
  app: Express,
  opts?: { mode?: "server" | "serverless" },
): Promise<Server | null> {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      const allowed = new Set([
        "application/pdf",
        "application/msword",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.ms-excel",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/vnd.ms-powerpoint",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "text/plain",
        "text/csv",
        "image/jpeg",
        "image/png",
        "image/gif",
        "image/webp",
      ]);
      if (allowed.has(file.mimetype)) {
        cb(null, true);
      } else {
        cb(new Error(`Unsupported file type: ${file.mimetype}`));
      }
    },
  });
  const mode = opts?.mode ?? "server";
  app.use("/api", async (req, _res, next) => {
    try {
      if (req.session?.userId) return next();
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith("Bearer ")) return next();
      const secret = authJwtSecret();
      if (!secret) return next();
      const token = authHeader.slice("Bearer ".length);
      const { payload } = await jwtVerify(token, secret);
      const sub = payload.sub ? parseInt(String(payload.sub), 10) : NaN;
      if (!Number.isFinite(sub)) return next();
      req.session.userId = sub;
      if (typeof payload.email === "string") req.session.email = payload.email;
      next();
    } catch {
      next();
    }
  });
  app.use("/api/v1/telecom/webhooks/telnyx", createTelnyxWebhookRouter());
  reg("get", "/api/crm/fields"); app.get("/api/crm/fields", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    const entityType = String(req.query.entityType || "");
    if (!isImportExportEntityType(entityType)) {
      return res.status(400).json({ message: "Invalid entityType" });
    }
    return res.json({ entityType, fields: getCrmFieldDefs(entityType as any) });
  });
  reg("post", "/api/crm/import/preview"); app.post("/api/crm/import/preview", upload.single("file"), async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    const entityType = String(req.body.entityType || "");
    if (!isImportExportEntityType(entityType)) {
      return res.status(400).json({ message: "Invalid entityType" });
    }
    const file = (req as any).file as Express.Multer.File | undefined;
    if (!file) return res.status(400).json({ message: "file is required" });
    const format = detectFormat(file.originalname, file.mimetype);
    if (!format) return res.status(400).json({ message: "Unsupported file type" });
    const parsed = await parseUpload(file.buffer, format);
    const headers = parsed.headers;
    const samples = parsed.rows.slice(0, 5);
    const suggested = suggestMapping(entityType as any, headers);
    return res.json({
      entityType,
      format,
      headers,
      sampleRows: samples,
      suggestedMapping: suggested,
      totalRows: parsed.rows.length,
    });
  });
  reg("post", "/api/crm/import/jobs"); app.post("/api/crm/import/jobs", upload.single("file"), async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    const entityType = String(req.body.entityType || "");
    if (!isImportExportEntityType(entityType)) {
      return res.status(400).json({ message: "Invalid entityType" });
    }
    const file = (req as any).file as Express.Multer.File | undefined;
    if (!file) return res.status(400).json({ message: "file is required" });
    const mapping = req.body.mapping ? JSON.parse(String(req.body.mapping)) : {};
    const options = req.body.options ? JSON.parse(String(req.body.options)) : { onDuplicate: "merge" };
    const format = detectFormat(file.originalname, file.mimetype);
    if (!format) return res.status(400).json({ message: "Unsupported file type" });
    const fileBase64 = file.buffer.toString("base64");
    // Ticket 01: every bulk import is gated behind explicit approval. Machine
    // integrations must identify themselves with a known `source`.
    const gate = evaluateImportGate({ source: req.body.source, actor: user as any });
    if (gate.approvalStatus === "rejected") {
      return res.status(400).json({ message: gate.reason, code: "IMPORT_SOURCE_UNKNOWN" });
    }
    const importSignature = computeImportSignature({ entityType, fileBase64, mapping, options });
    const job = await createImportJob({
      entityType: entityType as any,
      createdBy: user.id,
      fileBase64,
      originalFilename: file.originalname,
      fileMimeType: file.mimetype,
      mapping,
      options,
      source: gate.source,
      approvalStatus: gate.approvalStatus,
      approvedBy: gate.allowed && gate.approvalStatus === "approved" ? user.id : null,
      approvedAt: gate.allowed && gate.approvalStatus === "approved" ? new Date() : null,
      importSignature,
      status: gate.allowed ? "queued" : "blocked_pending_approval",
    });
    if (!gate.allowed) {
      return res.status(202).json({
        jobId: job.id,
        approvalRequired: true,
        approvalStatus: gate.approvalStatus,
        message: gate.reason,
      });
    }
    if (mode === "server") {
      setImmediate(() => {
        processImportJob(job.id).catch((e: any) => {
          console.error(JSON.stringify({
            ts: new Date().toISOString(),
            event: "crm_import",
            kind: "process_failed",
            jobId: job.id,
            message: String(e?.message || e),
            code: e?.code ? String(e.code) : null,
          }));
        });
      });
    } else {
      await processImportJob(job.id, { maxRows: 100, maxBatches: 1, resume: true });
    }
    return res.status(201).json({ jobId: job.id });
  });
  reg("post", "/api/crm/import/jobs/:id/run"); app.post("/api/crm/import/jobs/:id/run", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    const jobId = parseInt(req.params.id, 10);
    if (!Number.isFinite(jobId)) return res.status(400).json({ message: "Invalid job id" });
    const job = await getImportJob(jobId);
    if (!job) return res.status(404).json({ message: "Not found" });
    if (job.createdBy !== user.id && !canApproveImports(user as any)) return res.status(403).json({ message: "Forbidden" });
    try {
      await processImportJob(jobId, { maxRows: 100, maxBatches: 1, resume: true });
    } catch (e: any) {
      if (e?.code === "IMPORT_NOT_APPROVED") {
        return res.status(403).json({ message: e.message, code: e.code, approvalStatus: (job as any).approvalStatus ?? "pending" });
      }
      throw e;
    }
    const nextJob = await getImportJob(jobId);
    const errors = await listImportJobErrors(jobId, 50);
    return res.json({ job: nextJob, errors });
  });
  reg("post", "/api/crm/import/jobs/:id/approve"); app.post("/api/crm/import/jobs/:id/approve", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    if (!canApproveImports(user as any)) return res.status(403).json({ message: "Not permitted to approve imports" });
    const jobId = parseInt(req.params.id, 10);
    if (!Number.isFinite(jobId)) return res.status(400).json({ message: "Invalid job id" });
    const job = await getImportJob(jobId);
    if (!job) return res.status(404).json({ message: "Not found" });
    if ((job as any).approvalStatus !== "approved") {
      await setImportApproval(jobId, { approvalStatus: "approved", approvedBy: user.id });
    }
    if (mode === "server") {
      setImmediate(() => {
        processImportJob(jobId).catch((e: any) => {
          console.error(JSON.stringify({ ts: new Date().toISOString(), event: "crm_import", kind: "approved_process_failed", jobId, message: String(e?.message || e) }));
        });
      });
    } else {
      try {
        await processImportJob(jobId, { maxRows: 100, maxBatches: 1, resume: true });
      } catch (e: any) {
        if (e?.code !== "IMPORT_NOT_APPROVED") throw e;
      }
    }
    const updated = await getImportJob(jobId);
    return res.json({ job: updated });
  });
  reg("post", "/api/crm/import/jobs/:id/reject"); app.post("/api/crm/import/jobs/:id/reject", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    if (!canApproveImports(user as any)) return res.status(403).json({ message: "Not permitted to review imports" });
    const jobId = parseInt(req.params.id, 10);
    if (!Number.isFinite(jobId)) return res.status(400).json({ message: "Invalid job id" });
    const job = await getImportJob(jobId);
    if (!job) return res.status(404).json({ message: "Not found" });
    const reason = String(req.body?.reason || "").slice(0, 500) || null;
    await setImportApproval(jobId, { approvalStatus: "rejected", approvedBy: null, rejectionReason: reason });
    const updated = await getImportJob(jobId);
    return res.json({ job: updated });
  });
  // Ticket 02 — quarantine view / scan / restore (reversible; nothing deleted).
  reg("get", "/api/crm/quarantine"); app.get("/api/crm/quarantine", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    const records = await listQuarantinedRecords({
      entityType: String(req.query.entityType || "").trim() || undefined,
      status: String(req.query.status || "").trim() || undefined,
      limit: req.query.limit ? parseInt(String(req.query.limit), 10) : 200,
    });
    return res.json({ records });
  });
  reg("post", "/api/crm/quarantine/scan"); app.post("/api/crm/quarantine/scan", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    if (!canRestoreQuarantine(user as any)) return res.status(403).json({ message: "Not permitted to run quarantine scans" });
    const entityType = String(req.body?.entityType || "lead").trim();
    if (!(QUARANTINE_ENTITY_TYPES as readonly string[]).includes(entityType)) {
      return res.status(400).json({ message: "Invalid entityType" });
    }
    const result = await scanAndFlagEntity(entityType as any, user.id);
    return res.json(result);
  });
  reg("post", "/api/crm/quarantine/:id/restore"); app.post("/api/crm/quarantine/:id/restore", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    if (!canRestoreQuarantine(user as any)) return res.status(403).json({ message: "Not permitted to restore quarantined records" });
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ message: "Invalid id" });
    const notes = String(req.body?.notes || "").slice(0, 500) || null;
    const restored = await restoreQuarantinedRecord(id, user.id, notes);
    if (!restored) return res.status(404).json({ message: "Not found" });
    return res.json({ record: restored });
  });
  reg("get", "/api/crm/import/jobs"); app.get("/api/crm/import/jobs", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    // Ticket 01: import-batch history is filterable by source/status/approval/date.
    // Approvers can review all batches; ordinary users only see their own.
    const conditions: any[] = [];
    if (!canApproveImports(user as any)) conditions.push(eq(crmImportJobs.createdBy, user.id));
    const sourceFilter = String(req.query.source || "").trim();
    if (sourceFilter) conditions.push(eq(crmImportJobs.source, sourceFilter));
    const statusFilter = String(req.query.status || "").trim();
    if (statusFilter) conditions.push(eq(crmImportJobs.status, statusFilter));
    const approvalFilter = String(req.query.approvalStatus || "").trim();
    if (approvalFilter) conditions.push(eq(crmImportJobs.approvalStatus, approvalFilter));
    const fromFilter = String(req.query.from || "").trim();
    if (fromFilter) conditions.push(gte(crmImportJobs.createdAt, new Date(fromFilter)));
    const toFilter = String(req.query.to || "").trim();
    if (toFilter) conditions.push(lte(crmImportJobs.createdAt, new Date(toFilter)));
    const importListWhere = conditions.length ? and(...conditions) : undefined;
    const rows = await db
      .select()
      .from(crmImportJobs)
      .where(importListWhere)
      .orderBy(desc(crmImportJobs.updatedAt))
      .limit(50);
    return res.json({ jobs: rows });
  });
  reg("get", "/api/crm/import/jobs/:id"); app.get("/api/crm/import/jobs/:id", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    const jobId = parseInt(req.params.id, 10);
    if (!Number.isFinite(jobId)) return res.status(400).json({ message: "Invalid job id" });
    const job = await getImportJob(jobId);
    if (!job) return res.status(404).json({ message: "Not found" });
    if (job.createdBy !== user.id) return res.status(403).json({ message: "Forbidden" });
    const errors = await listImportJobErrors(jobId, 50);
    return res.json({ job, errors });
  });
  reg("get", "/api/crm/import/jobs/:id/errors.csv"); app.get("/api/crm/import/jobs/:id/errors.csv", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    const jobId = parseInt(req.params.id, 10);
    if (!Number.isFinite(jobId)) return res.status(400).json({ message: "Invalid job id" });
    const job = await getImportJob(jobId);
    if (!job) return res.status(404).json({ message: "Not found" });
    if (job.createdBy !== user.id) return res.status(403).json({ message: "Forbidden" });
    const errors = await listImportJobErrors(jobId, 10000);
    const esc = (v: any) => {
      const s = String(v ?? "");
      if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
      return s;
    };
    const lines = ["rowNumber,errors,rawRow"];
    for (const e of errors) lines.push([e.rowNumber, e.errors, e.rawRow || ""].map(esc).join(","));
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="import-errors-${jobId}.csv"`);
    return res.send(lines.join("\n"));
  });
  reg("post", "/api/crm/export/jobs"); app.post("/api/crm/export/jobs", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    const entityType = String(req.body.entityType || "");
    if (!isImportExportEntityType(entityType)) {
      return res.status(400).json({ message: "Invalid entityType" });
    }
    const format = String(req.body.format || "csv");
    if (format !== "csv" && format !== "xlsx") return res.status(400).json({ message: "Invalid format" });
    const filters = req.body.filters || {};
    const columns = Array.isArray(req.body.columns) ? req.body.columns : [];
    const { job, token } = await createExportJob({
      entityType: entityType as any,
      createdBy: user.id,
      format: format as any,
      filters,
      columns,
    });
    if (mode === "server") {
      setImmediate(() => {
        processExportJob(job.id).catch((e: any) => {
          console.error(JSON.stringify({
            ts: new Date().toISOString(),
            event: "crm_export",
            kind: "process_failed",
            jobId: job.id,
            message: String(e?.message || e),
            code: e?.code ? String(e.code) : null,
          }));
        });
      });
    } else {
      await processExportJob(job.id, { resume: true });
    }
    const downloadUrl = `/api/crm/export/files/${job.id}/download?token=${encodeURIComponent(token)}`;
    return res.status(201).json({ jobId: job.id, downloadUrl });
  });
  reg("post", "/api/crm/export/jobs/:id/run"); app.post("/api/crm/export/jobs/:id/run", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    const exportId = parseInt(req.params.id, 10);
    if (!Number.isFinite(exportId)) return res.status(400).json({ message: "Invalid export id" });
    const job = await getExportJob(exportId);
    if (!job) return res.status(404).json({ message: "Not found" });
    if (job.createdBy !== user.id) return res.status(403).json({ message: "Forbidden" });
    await processExportJob(exportId, { resume: true });
    const nextJob = await getExportJob(exportId);
    return res.json({ job: nextJob });
  });
  reg("get", "/api/crm/export/jobs"); app.get("/api/crm/export/jobs", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    const rows = await db
      .select()
      .from(crmExportFiles)
      .where(eq(crmExportFiles.createdBy, user.id))
      .orderBy(desc(crmExportFiles.updatedAt))
      .limit(20);
    return res.json({ jobs: rows });
  });
  reg("get", "/api/crm/export/jobs/:id"); app.get("/api/crm/export/jobs/:id", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    const exportId = parseInt(req.params.id, 10);
    if (!Number.isFinite(exportId)) return res.status(400).json({ message: "Invalid export id" });
    const job = await getExportJob(exportId);
    if (!job) return res.status(404).json({ message: "Not found" });
    if (job.createdBy !== user.id) return res.status(403).json({ message: "Forbidden" });
    return res.json({ job });
  });
  reg("post", "/api/crm/export/jobs/:id/renew-download"); app.post("/api/crm/export/jobs/:id/renew-download", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    const exportId = parseInt(req.params.id, 10);
    if (!Number.isFinite(exportId)) return res.status(400).json({ message: "Invalid export id" });
    const job = await getExportJob(exportId);
    if (!job) return res.status(404).json({ message: "Not found" });
    if (job.createdBy !== user.id) return res.status(403).json({ message: "Forbidden" });
    if (job.status !== "completed") return res.status(409).json({ message: "Export not ready" });
    const { token } = await renewExportToken(exportId);
    const downloadUrl = `/api/crm/export/files/${exportId}/download?token=${encodeURIComponent(token)}`;
    return res.json({ downloadUrl });
  });
  reg("get", "/api/crm/export/files/:id/download"); app.get("/api/crm/export/files/:id/download", async (req, res) => {
    const exportId = parseInt(req.params.id, 10);
    if (!Number.isFinite(exportId)) return res.status(400).json({ message: "Invalid export id" });
    const token = String(req.query.token || "");
    if (!token) return res.status(401).json({ message: "Missing token" });
    const job = await getExportJob(exportId);
    if (!job) return res.status(404).json({ message: "Not found" });
    if (job.status !== "completed") return res.status(409).json({ message: "Export not ready" });
    if (!verifyExportToken(job as any, token)) return res.status(403).json({ message: "Invalid token" });
    if (!job.contentBase64 || !job.mimeType) return res.status(500).json({ message: "Export content missing" });
    const buf = Buffer.from(String(job.contentBase64), "base64");
    res.setHeader("Content-Type", job.mimeType);
    res.setHeader("Content-Disposition", `attachment; filename="${job.filename || `export-${exportId}`}"`);
    return res.send(buf);
  });
  // HEALTH CHECK
  reg("get", "/api/health"); app.get("/api/health", async (req, res) => {
    try {
      // Perform a simple query to verify DB connectivity
      await storage.getUserByEmail("test@example.com");
      res.json({ status: "ok", db: "connected", timestamp: new Date().toISOString() });
    } catch (error: any) {
      console.error("Health check failed:", error);
      res.status(500).json({ status: "error", db: "disconnected", message: error.message });
    }
  });
  reg("get", "/api/version"); app.get("/api/version", async (_req, res) => {
    const version = String(process.env.APP_VERSION || packageJson?.version || "0.0.0");
    const commitSha =
      String(
        process.env.VERCEL_GIT_COMMIT_SHA ||
          process.env.COMMIT_SHA ||
          process.env.GITHUB_SHA ||
          process.env.RENDER_GIT_COMMIT ||
          "",
      ) || null;
    const buildId = String(process.env.VERCEL_BUILD_ID || process.env.BUILD_ID || "") || null;
    res.json({ version, commitSha, buildId, nodeEnv: process.env.NODE_ENV || null });
  });
  const stripeApiVersion = "2026-04-22.dahlia";
  function xpNormalizeSlug(input: string): string {
    return String(input || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+/, "")
      .replace(/-+$/, "");
  }
  function xpParseDate(input: unknown): Date | null {
    if (input instanceof Date) return Number.isFinite(input.getTime()) ? input : null;
    const s = String(input || "").trim();
    if (!s) return null;
    const d = new Date(s);
    return Number.isFinite(d.getTime()) ? d : null;
  }
  function xpMoneyToCents(input: unknown): number {
    const n = typeof input === "number" ? input : parseFloat(String(input || "0"));
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.round(n * 100);
  }
  const xpPaymentModeSchema = z.enum(["deposit", "full"]);
  const xpItinerarySchema = z
    .object({
      sections: z
        .array(
          z.object({
            title: z.string().trim().min(1),
            bullets: z.array(z.string().trim().min(1)).default([]),
          }),
        )
        .default([]),
    })
    .strict();
  function xpStringList(input: unknown): string[] | null {
    if (!input) return null;
    if (Array.isArray(input)) {
      const items = input.map((v) => String(v || "").trim()).filter(Boolean);
      return items.length ? items : null;
    }
    const raw = String(input || "").trim();
    if (!raw) return null;
    const items = raw
      .split(",")
      .map((v) => String(v || "").trim())
      .filter(Boolean);
    return items.length ? items : null;
  }
  async function xpPickAdminUser(): Promise<any | null> {
    try {
      const users = await storage.getUsers(200, 0);
      const su = users.find((u: any) => !!u?.isSuperAdmin);
      if (su) return su;
      const admin = users.find((u: any) => String(u?.role || "").toLowerCase() === "admin");
      if (admin) return admin;
      return users[0] || null;
    } catch {
      return null;
    }
  }
  reg("get", "/api/xp/experiences"); app.get("/api/xp/experiences", async (_req, res) => {
    const items = await storage.listXpExperiences({ activeOnly: true });
    return res.json({ items });
  });
  reg("get", "/api/xp/experiences/:slug"); app.get("/api/xp/experiences/:slug", async (req, res) => {
    const slug = String(req.params.slug || "").trim();
    const experience = await storage.getXpExperienceBySlug(slug);
    if (!experience || !(experience as any).active) return res.status(404).json({ message: "Not found" });
    return res.json({ experience });
  });
  reg("get", "/api/xp/experiences/:slug/availability"); app.get("/api/xp/experiences/:slug/availability", async (req, res) => {
    const slug = String(req.params.slug || "").trim();
    const experience = await storage.getXpExperienceBySlug(slug);
    if (!experience || !(experience as any).active) return res.status(404).json({ message: "Not found" });
    const from = xpParseDate(req.query.from);
    const to = xpParseDate(req.query.to);
    if (!from || !to) return res.status(400).json({ message: "from and to are required" });
    if (to.getTime() <= from.getTime()) return res.status(400).json({ message: "Invalid range" });
    const mode = String((experience as any).mode || "time_slot");
    const out: any = { experienceId: (experience as any).id, mode };
    if (mode === "time_slot" || mode === "both") {
      const slots = await storage.listXpTimeSlots((experience as any).id, { from, to, activeOnly: true });
      const items = [];
      for (const s of slots) {
        const used = await storage.countXpActiveBookingsOverlapping({ experienceId: (experience as any).id, kind: "time_slot", startAt: (s as any).startAt, endAt: (s as any).endAt });
        const cap = Number((s as any).capacity || 1);
        items.push({
          id: (s as any).id,
          startAt: (s as any).startAt,
          endAt: (s as any).endAt,
          capacity: cap,
          remaining: Math.max(0, cap - used),
        });
      }
      out.timeSlots = items;
    }
    if (mode === "date_range" || mode === "both") {
      const blackouts = await storage.listXpBlackouts((experience as any).id, { from, to });
      const bookings = (await storage.listXpBookings({ experienceId: (experience as any).id, from, to, limit: 500, offset: 0 })).items;
      out.blackouts = (blackouts || []).map((b: any) => ({ startAt: b.startAt, endAt: b.endAt }));
      out.booked = (bookings || [])
        .filter((b: any) => b.kind === "date_range" && (b.status === "pending_payment" || b.status === "confirmed"))
        .map((b: any) => ({ startAt: b.startAt, endAt: b.endAt }));
      out.capacity = Number((experience as any).capacity || 1);
    }
    return res.json(out);
  });
  reg("post", "/api/xp/bookings/checkout"); app.post("/api/xp/bookings/checkout", async (req, res) => {
    const body = req.body || {};
    const experienceSlug = String(body.experienceSlug || "").trim();
    const experience = await storage.getXpExperienceBySlug(experienceSlug);
    if (!experience || !(experience as any).active) return res.status(404).json({ message: "Not found" });
    const mode = String((experience as any).mode || "time_slot");
    const kindRaw = String(body.kind || "").trim();
    const kind = kindRaw === "date_range" ? "date_range" : "time_slot";
    if (mode !== "both" && mode !== kind) return res.status(400).json({ message: "Invalid kind for experience" });
    const customerName = String(body.customerName || "").trim();
    const customerEmail = String(body.customerEmail || "").trim();
    const customerPhone = String(body.customerPhone || "").trim() || null;
    if (!customerName || !customerEmail) return res.status(400).json({ message: "Missing customer fields" });
    const startAt = xpParseDate(body.startAt);
    const endAt = xpParseDate(body.endAt);
    if (!startAt || !endAt) return res.status(400).json({ message: "Missing startAt/endAt" });
    if (endAt.getTime() <= startAt.getTime()) return res.status(400).json({ message: "Invalid window" });
    const experienceId = Number((experience as any).id);
    if (await storage.hasXpBlackoutOverlap({ experienceId, startAt, endAt })) {
      return res.status(409).json({ message: "Unavailable" });
    }
    if (kind === "time_slot") {
      const slots = await storage.listXpTimeSlots(experienceId, { from: startAt, to: startAt, activeOnly: true });
      const slot = slots.find((s: any) => new Date(s.startAt).getTime() === startAt.getTime() && new Date(s.endAt).getTime() === endAt.getTime());
      if (!slot) return res.status(404).json({ message: "Time slot not found" });
      const used = await storage.countXpActiveBookingsOverlapping({ experienceId, kind, startAt, endAt });
      const cap = Number((slot as any).capacity || 1);
      if (used >= cap) return res.status(409).json({ message: "Unavailable" });
    } else {
      const used = await storage.countXpActiveBookingsOverlapping({ experienceId, kind, startAt, endAt });
      const cap = Number((experience as any).capacity || 1);
      if (used >= cap) return res.status(409).json({ message: "Unavailable" });
    }
    const paymentModeRaw = String((experience as any).paymentMode || "deposit").trim().toLowerCase();
    const paymentMode = xpPaymentModeSchema.safeParse(paymentModeRaw);
    if (!paymentMode.success) return res.status(400).json({ message: "Invalid payment mode" });
    const dueNowAmount = paymentMode.data === "full" ? (experience as any).priceTotal : (experience as any).depositAmount;
    const cents = xpMoneyToCents(dueNowAmount);
    if (!cents) return res.status(400).json({ message: "Invalid amount" });
    const stripeKey = String(process.env.STRIPE_SECRET_KEY || "").trim();
    if (!stripeKey) return res.status(500).json({ message: "Stripe is not configured" });
    const booking = await storage.createXpBookingPending({
      // P0 #5: reference code is generated in storage if not supplied.
      experienceId,
      kind,
      customerName,
      customerEmail,
      customerPhone,
      startAt,
      endAt,
      status: "pending_payment",
      currency: String((experience as any).currency || "USD"),
      depositAmount: dueNowAmount,
      stripeCheckoutSessionId: null,
      stripePaymentIntentId: null,
      stripeCustomerId: null,
    } as any);
    const bookingReference = String((booking as any).referenceCode || "").trim();
    const stripe = new Stripe(stripeKey, { apiVersion: stripeApiVersion });
    const origin = `${req.protocol}://${req.get("host")}`;
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      success_url: `${origin}/xp/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/xp/checkout/cancel`,
      customer_email: customerEmail,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: String((experience as any).currency || "USD").trim().toLowerCase() || "usd",
            unit_amount: cents,
            product_data: {
              name:
                paymentMode.data === "full"
                  ? String((experience as any).title || "Experience")
                  : `${String((experience as any).title || "Experience")} (Deposit)`,
            },
          },
        },
      ],
      metadata: {
        bookingId: String((booking as any).id),
        bookingReference: bookingReference,
        experienceId: String(experienceId),
        kind,
        paymentMode: paymentMode.data,
      },
    });
    await storage.updateXpBookingStripeSession((booking as any).id, session.id);
    // P0 #6: the customer's checkout session must carry the booking reference
    // so the confirmation page can show it even before the webhook confirms.
    return res.status(201).json({ checkoutUrl: session.url, bookingReference });
  });
  reg("get", "/api/xp/bookings/session/:sessionId"); app.get("/api/xp/bookings/session/:sessionId", async (req, res) => {
    const sessionId = String(req.params.sessionId || "").trim();
    if (!sessionId) return res.status(400).json({ message: "Missing sessionId" });
    const booking = await storage.getXpBookingByStripeSessionId(sessionId);
    if (!booking) return res.status(404).json({ message: "Not found" });
    const experience = await storage.getXpExperienceById(Number((booking as any).experienceId));
    return res.json({
      booking: {
        id: (booking as any).id,
        referenceCode: (booking as any).referenceCode || null,
        kind: (booking as any).kind,
        status: (booking as any).status,
        customerName: (booking as any).customerName,
        customerEmail: (booking as any).customerEmail,
        startAt: (booking as any).startAt,
        endAt: (booking as any).endAt,
        amountDueNow: (booking as any).depositAmount,
        currency: (booking as any).currency,
      },
      experience: experience
        ? {
            id: (experience as any).id,
            slug: (experience as any).slug,
            title: (experience as any).title,
            paymentMode: (experience as any).paymentMode || "deposit",
            priceTotal: (experience as any).priceTotal ?? null,
          }
        : null,
    });
  });
  reg("post", "/api/stripe/webhook"); app.post("/api/stripe/webhook", async (req, res) => {
    const stripeKey = String(process.env.STRIPE_SECRET_KEY || "").trim();
    const webhookSecret = String(process.env.STRIPE_WEBHOOK_SECRET || "").trim();
    if (!stripeKey || !webhookSecret) return res.status(500).json({ message: "Stripe is not configured" });
    const sig = String(req.headers["stripe-signature"] || "").trim();
    if (!sig) return res.status(400).json({ message: "Missing stripe-signature" });
    const stripe = new Stripe(stripeKey, { apiVersion: stripeApiVersion });
    const raw = Buffer.isBuffer((req as any).rawBody)
      ? ((req as any).rawBody as Buffer)
      : Buffer.from(JSON.stringify(req.body || {}));
    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(raw, sig, webhookSecret);
    } catch (e: any) {
      return res.status(400).json({ message: String(e?.message || e) });
    }
    if (await storage.hasStripeEvent(event.id)) return res.json({ received: true });
    await storage.recordStripeEvent({ eventId: event.id, type: event.type, payload: { id: event.id, type: event.type, created: event.created } } as any);
    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;
      const sessionId = String(session.id || "").trim();
      const paymentIntentId = typeof session.payment_intent === "string" ? session.payment_intent : null;
      const stripeCustomerId = typeof session.customer === "string" ? session.customer : null;
      const booking = await storage.getXpBookingByStripeSessionId(sessionId);
      if (booking && String((booking as any).status) !== "confirmed") {
        const confirmed = await storage.confirmXpBookingByStripeSessionId({ sessionId, paymentIntentId, stripeCustomerId });
        if (confirmed) {
          // P0 #6: booking confirmation email + in-app notification. Email is
          // best-effort: when RESEND_API_KEY is not configured the customer
          // still gets the on-screen reference and the ops side (task) below.
          const xpRef = String((confirmed as any).referenceCode || "").trim();
          // Best-effort lookup: the confirmation flow must never fail because
          // the experience row is unreadable (or in tests, mocked out).
          let xpExperience: any = null;
          try {
            xpExperience = await storage.getXpExperienceById(Number((confirmed as any).experienceId));
          } catch {}
          const xpWhen = `${new Date((confirmed as any).startAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}`;
          try {
            await sendEmail({
              to: String((confirmed as any).customerEmail || ""),
              subject: `Your Ocean Luxe Experiences booking is confirmed${xpRef ? ` — ${xpRef}` : ""}`,
              text: [
                `Thank you, ${String((confirmed as any).customerName || "there")}!`,
                ``,
                xpExperience ? `Experience: ${String((xpExperience as any).title || "")}` : null,
                `When: ${xpWhen}`,
                xpRef ? `Booking reference: ${xpRef}` : null,
                `Amount paid now: ${String((confirmed as any).currency || "USD")} ${String((confirmed as any).depositAmount || "")}`,
                ``,
                `Our concierge team will reach out before your experience. Keep this reference for any questions.`,
              ].filter((l): l is string => l !== null).join("\n"),
            });
          } catch (e: any) {
            console.error("[XP] booking confirmation email failed:", e?.message);
          }
          const admin = await xpPickAdminUser();
          if (admin) {
            try {
              await notifyUser({
                userId: admin.id,
                category: "xp_booking_confirmed",
                title: `XP booking confirmed${xpRef ? ` (${xpRef})` : ""}`,
                description: `${String((confirmed as any).customerName || "Customer")} — ${xpExperience ? String((xpExperience as any).title || "") + " — " : ""}${xpWhen}`,
                relatedType: "xp_booking",
                relatedId: (confirmed as any).id,
                eventKey: `xp_booking_confirmed:${(confirmed as any).id}`,
              });
            } catch (e: any) {
              console.error("[XP] booking confirmation notification failed:", e?.message);
            }
            await createTask({
              title: `XP booking confirmed: ${String((confirmed as any).customerName || "")}`.trim(),
              description: JSON.stringify({
                bookingId: (confirmed as any).id,
                experienceId: (confirmed as any).experienceId,
                kind: (confirmed as any).kind,
                startAt: (confirmed as any).startAt,
                endAt: (confirmed as any).endAt,
                customerEmail: (confirmed as any).customerEmail,
                customerPhone: (confirmed as any).customerPhone,
              }),
              type: "xp_booking",
              relatedEntityType: "xp_booking",
              relatedEntityId: (confirmed as any).id,
              dueAt: (confirmed as any).startAt,
              priority: "high",
              status: "open",
              assignedToUserId: admin.id,
              isRecurring: false,
              recurrenceRule: null,
              isPrivate: false,
              createdBy: admin.id,
            });
          }
        }
      }
    }
    return res.json({ received: true });
  });
  reg("get", "/api/xp/admin/experiences"); app.get("/api/xp/admin/experiences", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    if (!isAdminUser(user)) return res.status(403).json({ message: "Forbidden" });
    const items = await storage.listXpExperiences({ activeOnly: false });
    return res.json({ items });
  });
  reg("post", "/api/xp/admin/experiences"); app.post("/api/xp/admin/experiences", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    if (!isAdminUser(user)) return res.status(403).json({ message: "Forbidden" });
    const schema = z
      .object({
        slug: z.string().trim().min(1),
        title: z.string().trim().min(1),
        description: z.string().optional(),
        mode: z.enum(["time_slot", "date_range", "both"]).default("time_slot"),
        paymentMode: xpPaymentModeSchema.default("deposit"),
        currency: z.string().trim().min(1).default("USD"),
        priceTotal: z.union([z.string(), z.number()]).optional().nullable(),
        depositAmount: z.union([z.string(), z.number()]).optional().nullable(),
        capacity: z.number().int().positive().default(1),
        active: z.boolean().default(true),
        images: z.array(z.string()).optional().nullable(),
        location: z.string().optional().nullable(),
        durationMinutes: z.number().int().positive().optional().nullable(),
        highlights: z.any().optional().nullable(),
        inclusions: z.any().optional().nullable(),
        cancellationPolicy: z.string().optional().nullable(),
        itinerary: z.any().optional().nullable(),
      })
      .strict();
    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ message: "Invalid payload" });
    const body = parsed.data;
    const slug = xpNormalizeSlug(body.slug);
    const title = body.title;
    if (!slug || !title) return res.status(400).json({ message: "Missing fields" });
    const priceTotalCents = body.priceTotal != null ? xpMoneyToCents(body.priceTotal) : 0;
    const depositCents = xpMoneyToCents(body.depositAmount);
    if (body.paymentMode === "full") {
      if (!priceTotalCents) return res.status(400).json({ message: "priceTotal is required for full payment" });
    } else {
      if (!depositCents) return res.status(400).json({ message: "depositAmount is required" });
    }
    const itineraryParsed = body.itinerary ? xpItinerarySchema.safeParse(body.itinerary) : null;
    if (body.itinerary && !itineraryParsed?.success) return res.status(400).json({ message: "Invalid itinerary" });
    const row = await storage.createXpExperience({
      slug,
      title,
      description: String(body.description || "").trim() || null,
      mode: body.mode,
      paymentMode: body.paymentMode,
      currency: body.currency,
      priceTotal: body.priceTotal ?? null,
      depositAmount: body.paymentMode === "full" ? body.priceTotal : body.depositAmount,
      capacity: body.capacity,
      active: body.active !== false,
      images: Array.isArray(body.images) ? body.images.map((x) => String(x || "").trim()).filter(Boolean) : null,
      location: body.location ? String(body.location).trim() : null,
      durationMinutes: typeof body.durationMinutes === "number" ? body.durationMinutes : null,
      highlights: xpStringList(body.highlights),
      inclusions: xpStringList(body.inclusions),
      cancellationPolicy: body.cancellationPolicy ? String(body.cancellationPolicy).trim() : null,
      itinerary: itineraryParsed?.success ? itineraryParsed.data : null,
    } as any);
    return res.status(201).json({ experience: row });
  });
  reg("patch", "/api/xp/admin/experiences/:id"); app.patch("/api/xp/admin/experiences/:id", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    if (!isAdminUser(user)) return res.status(403).json({ message: "Forbidden" });
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ message: "Invalid id" });
    const body = req.body || {};
    const patch: any = {};
    if (Object.prototype.hasOwnProperty.call(body, "slug")) patch.slug = xpNormalizeSlug(body.slug);
    if (Object.prototype.hasOwnProperty.call(body, "title")) patch.title = String(body.title || "").trim();
    if (Object.prototype.hasOwnProperty.call(body, "description")) patch.description = String(body.description || "").trim() || null;
    if (Object.prototype.hasOwnProperty.call(body, "mode")) patch.mode = String(body.mode || "").trim();
    if (Object.prototype.hasOwnProperty.call(body, "paymentMode")) {
      const pm = xpPaymentModeSchema.safeParse(String(body.paymentMode || "").trim().toLowerCase());
      if (!pm.success) return res.status(400).json({ message: "Invalid paymentMode" });
      patch.paymentMode = pm.data;
    }
    if (Object.prototype.hasOwnProperty.call(body, "currency")) patch.currency = String(body.currency || "").trim() || "USD";
    if (Object.prototype.hasOwnProperty.call(body, "priceTotal")) patch.priceTotal = body.priceTotal ?? null;
    if (Object.prototype.hasOwnProperty.call(body, "depositAmount")) {
      if (!xpMoneyToCents(body.depositAmount)) return res.status(400).json({ message: "Invalid depositAmount" });
      patch.depositAmount = body.depositAmount;
    }
    if (Object.prototype.hasOwnProperty.call(body, "capacity")) patch.capacity = typeof body.capacity === "number" ? body.capacity : 1;
    if (Object.prototype.hasOwnProperty.call(body, "active")) patch.active = !!body.active;
    if (Object.prototype.hasOwnProperty.call(body, "images")) {
      patch.images = Array.isArray(body.images) ? body.images.map((x: any) => String(x || "").trim()).filter(Boolean) : null;
    }
    if (Object.prototype.hasOwnProperty.call(body, "location")) patch.location = body.location ? String(body.location).trim() : null;
    if (Object.prototype.hasOwnProperty.call(body, "durationMinutes")) {
      patch.durationMinutes = typeof body.durationMinutes === "number" ? body.durationMinutes : null;
    }
    if (Object.prototype.hasOwnProperty.call(body, "highlights")) patch.highlights = xpStringList(body.highlights);
    if (Object.prototype.hasOwnProperty.call(body, "inclusions")) patch.inclusions = xpStringList(body.inclusions);
    if (Object.prototype.hasOwnProperty.call(body, "cancellationPolicy")) patch.cancellationPolicy = body.cancellationPolicy ? String(body.cancellationPolicy).trim() : null;
    if (Object.prototype.hasOwnProperty.call(body, "itinerary")) {
      if (body.itinerary == null) patch.itinerary = null;
      else {
        const itin = xpItinerarySchema.safeParse(body.itinerary);
        if (!itin.success) return res.status(400).json({ message: "Invalid itinerary" });
        patch.itinerary = itin.data;
      }
    }
    const nextPaymentMode = String(patch.paymentMode || "").trim();
    const paymentMode = nextPaymentMode ? xpPaymentModeSchema.safeParse(nextPaymentMode) : null;
    const current = await storage.getXpExperienceById(id);
    if (!current) return res.status(404).json({ message: "Not found" });
    const effectivePaymentMode = paymentMode?.success ? paymentMode.data : String((current as any).paymentMode || "deposit");
    if (effectivePaymentMode === "full") {
      const effectivePriceTotal = Object.prototype.hasOwnProperty.call(patch, "priceTotal") ? patch.priceTotal : (current as any).priceTotal;
      if (!xpMoneyToCents(effectivePriceTotal)) return res.status(400).json({ message: "priceTotal is required for full payment" });
      patch.depositAmount = effectivePriceTotal;
    } else {
      const effectiveDeposit = Object.prototype.hasOwnProperty.call(patch, "depositAmount") ? patch.depositAmount : (current as any).depositAmount;
      if (!xpMoneyToCents(effectiveDeposit)) return res.status(400).json({ message: "depositAmount is required" });
    }
    const row = await storage.updateXpExperience(id, patch);
    return res.json({ experience: row });
  });
  reg("delete", "/api/xp/admin/experiences/:id"); app.delete("/api/xp/admin/experiences/:id", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    if (!isAdminUser(user)) return res.status(403).json({ message: "Forbidden" });
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ message: "Invalid id" });
    const row = await storage.deactivateXpExperience(id);
    return res.json({ experience: row });
  });
  reg("get", "/api/xp/admin/experiences/:id/time-slots"); app.get("/api/xp/admin/experiences/:id/time-slots", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    if (!isAdminUser(user)) return res.status(403).json({ message: "Forbidden" });
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ message: "Invalid id" });
    const from = req.query.from ? xpParseDate(req.query.from) || undefined : undefined;
    const to = req.query.to ? xpParseDate(req.query.to) || undefined : undefined;
    const items = await storage.listXpTimeSlots(id, { from, to, activeOnly: false });
    return res.json({ items });
  });
  reg("post", "/api/xp/admin/experiences/:id/time-slots"); app.post("/api/xp/admin/experiences/:id/time-slots", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    if (!isAdminUser(user)) return res.status(403).json({ message: "Forbidden" });
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ message: "Invalid id" });
    const startAt = xpParseDate(req.body?.startAt);
    const endAt = xpParseDate(req.body?.endAt);
    if (!startAt || !endAt) return res.status(400).json({ message: "Missing startAt/endAt" });
    if (endAt.getTime() <= startAt.getTime()) return res.status(400).json({ message: "Invalid window" });
    const capacity = typeof req.body?.capacity === "number" ? req.body.capacity : 1;
    const row = await storage.createXpTimeSlot({ experienceId: id, startAt, endAt, capacity, active: req.body?.active !== false } as any);
    return res.status(201).json({ timeSlot: row });
  });
  reg("delete", "/api/xp/admin/time-slots/:slotId"); app.delete("/api/xp/admin/time-slots/:slotId", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    if (!isAdminUser(user)) return res.status(403).json({ message: "Forbidden" });
    const slotId = parseInt(req.params.slotId, 10);
    if (!Number.isFinite(slotId)) return res.status(400).json({ message: "Invalid id" });
    await storage.deleteXpTimeSlot(slotId);
    return res.json({ ok: true });
  });
  reg("get", "/api/xp/admin/experiences/:id/blackouts"); app.get("/api/xp/admin/experiences/:id/blackouts", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    if (!isAdminUser(user)) return res.status(403).json({ message: "Forbidden" });
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ message: "Invalid id" });
    const from = req.query.from ? xpParseDate(req.query.from) || undefined : undefined;
    const to = req.query.to ? xpParseDate(req.query.to) || undefined : undefined;
    const items = await storage.listXpBlackouts(id, { from, to });
    return res.json({ items });
  });
  reg("post", "/api/xp/admin/experiences/:id/blackouts"); app.post("/api/xp/admin/experiences/:id/blackouts", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    if (!isAdminUser(user)) return res.status(403).json({ message: "Forbidden" });
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ message: "Invalid id" });
    const startAt = xpParseDate(req.body?.startAt);
    const endAt = xpParseDate(req.body?.endAt);
    if (!startAt || !endAt) return res.status(400).json({ message: "Missing startAt/endAt" });
    if (endAt.getTime() <= startAt.getTime()) return res.status(400).json({ message: "Invalid window" });
    const row = await storage.createXpBlackout({ experienceId: id, startAt, endAt, reason: String(req.body?.reason || "").trim() || null } as any);
    return res.status(201).json({ blackout: row });
  });
  reg("delete", "/api/xp/admin/blackouts/:id"); app.delete("/api/xp/admin/blackouts/:id", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    if (!isAdminUser(user)) return res.status(403).json({ message: "Forbidden" });
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ message: "Invalid id" });
    await storage.deleteXpBlackout(id);
    return res.json({ ok: true });
  });
  reg("get", "/api/xp/admin/bookings"); app.get("/api/xp/admin/bookings", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    if (!isXpOpsUser(user)) return res.status(403).json({ message: "Forbidden" });
    const experienceIdRaw = req.query.experienceId;
    const experienceId = typeof experienceIdRaw === "string" && experienceIdRaw.trim() ? parseInt(experienceIdRaw, 10) : undefined;
    const status = typeof req.query.status === "string" && req.query.status.trim() ? String(req.query.status).trim() : undefined;
    const kind = typeof req.query.kind === "string" && req.query.kind.trim() ? String(req.query.kind).trim() : undefined;
    const locationId = typeof req.query.locationId === "string" && String(req.query.locationId).trim() ? parseInt(String(req.query.locationId), 10) : undefined;
    const vehicleId = typeof req.query.vehicleId === "string" && String(req.query.vehicleId).trim() ? parseInt(String(req.query.vehicleId), 10) : undefined;
    const conciergeUserIdQuery = typeof req.query.conciergeUserId === "string" && String(req.query.conciergeUserId).trim() ? parseInt(String(req.query.conciergeUserId), 10) : undefined;
    const from = req.query.from ? xpParseDate(req.query.from) || undefined : undefined;
    const to = req.query.to ? xpParseDate(req.query.to) || undefined : undefined;
    const limit = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : undefined;
    const offset = typeof req.query.offset === "string" ? parseInt(req.query.offset, 10) : undefined;
    const out = await storage.listXpBookings({
      experienceId: typeof experienceId === "number" && Number.isFinite(experienceId) ? experienceId : undefined,
      status,
      kind,
      from: from || undefined,
      to: to || undefined,
      conciergeUserId: isConciergeUser(user)
        ? Number(user.id)
        : typeof conciergeUserIdQuery === "number" && Number.isFinite(conciergeUserIdQuery)
          ? conciergeUserIdQuery
          : undefined,
      locationId: typeof locationId === "number" && Number.isFinite(locationId) ? locationId : undefined,
      vehicleId: typeof vehicleId === "number" && Number.isFinite(vehicleId) ? vehicleId : undefined,
      limit: Number.isFinite(limit as any) ? (limit as any) : undefined,
      offset: Number.isFinite(offset as any) ? (offset as any) : undefined,
    });
    return res.json(out);
  });
  reg("get", "/api/xp/admin/bookings/:id"); app.get("/api/xp/admin/bookings/:id", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    if (!isXpOpsUser(user)) return res.status(403).json({ message: "Forbidden" });
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ message: "Invalid id" });
    const booking = await storage.getXpBookingById(id);
    if (!booking) return res.status(404).json({ message: "Not found" });
    if (isConciergeUser(user) && Number(booking.assignment?.conciergeUserId || 0) !== Number(user.id)) {
      return res.status(404).json({ message: "Not found" });
    }
    const experience = await storage.getXpExperienceById(Number((booking as any).experienceId));
    return res.json({ booking, experience: experience || null });
  });
  reg("post", "/api/xp/admin/bookings/:id/cancel"); app.post("/api/xp/admin/bookings/:id/cancel", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    if (!isAdminUser(user)) return res.status(403).json({ message: "Forbidden" });
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ message: "Invalid id" });
    const row = await storage.cancelXpBooking(id);
    if (!row) return res.status(404).json({ message: "Not found" });
    return res.json({ booking: row });
  });
  function parseNullableInt(v: any): number | null {
    if (v === undefined || v === null || v === "") return null;
    const n = typeof v === "number" ? v : parseInt(String(v), 10);
    return Number.isFinite(n) ? n : null;
  }
  reg("get", "/api/xp/admin/locations"); app.get("/api/xp/admin/locations", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    if (!isXpOpsUser(user)) return res.status(403).json({ message: "Forbidden" });
    const activeOnly =
      isConciergeUser(user)
        ? true
        : String(req.query.activeOnly || "").trim() === "1" || String(req.query.activeOnly || "").trim().toLowerCase() === "true";
    const items = await storage.listXpLocations({ activeOnly });
    return res.json({ items });
  });
  reg("post", "/api/xp/admin/locations"); app.post("/api/xp/admin/locations", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    if (!isAdminUser(user)) return res.status(403).json({ message: "Forbidden" });
    const name = String(req.body?.name || "").trim();
    if (!name) return res.status(400).json({ message: "Missing name" });
    const locType = String(req.body?.type || "resort").trim() || "resort";
    if (!XP_LOCATION_TYPES.has(locType)) return res.status(400).json({ message: `Invalid location type "${locType}"` });
    const row = await storage.createXpLocation({
      name,
      type: locType,
      address1: String(req.body?.address1 || "").trim() || null,
      address2: String(req.body?.address2 || "").trim() || null,
      city: String(req.body?.city || "").trim() || null,
      state: String(req.body?.state || "").trim() || null,
      zip: String(req.body?.zip || "").trim() || null,
      active: true,
    } as any);
    return res.status(201).json({ location: row });
  });
  reg("patch", "/api/xp/admin/locations/:id"); app.patch("/api/xp/admin/locations/:id", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    if (!isAdminUser(user)) return res.status(403).json({ message: "Forbidden" });
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ message: "Invalid id" });
    const patch: any = {};
    if (req.body?.name !== undefined) patch.name = String(req.body?.name || "").trim();
    if (req.body?.type !== undefined) {
      const locType = String(req.body?.type || "").trim() || "resort";
      if (!XP_LOCATION_TYPES.has(locType)) return res.status(400).json({ message: `Invalid location type "${locType}"` });
      patch.type = locType;
    }
    if (req.body?.address1 !== undefined) patch.address1 = String(req.body?.address1 || "").trim() || null;
    if (req.body?.address2 !== undefined) patch.address2 = String(req.body?.address2 || "").trim() || null;
    if (req.body?.city !== undefined) patch.city = String(req.body?.city || "").trim() || null;
    if (req.body?.state !== undefined) patch.state = String(req.body?.state || "").trim() || null;
    if (req.body?.zip !== undefined) patch.zip = String(req.body?.zip || "").trim() || null;
    if (req.body?.active !== undefined) patch.active = Boolean(req.body?.active);
    const row = await storage.updateXpLocation(id, patch);
    return res.json({ location: row });
  });
  reg("delete", "/api/xp/admin/locations/:id"); app.delete("/api/xp/admin/locations/:id", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    if (!isAdminUser(user)) return res.status(403).json({ message: "Forbidden" });
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ message: "Invalid id" });
    const row = await storage.deactivateXpLocation(id);
    return res.json({ location: row });
  });
  reg("get", "/api/xp/admin/vehicles"); app.get("/api/xp/admin/vehicles", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    if (!isXpOpsUser(user)) return res.status(403).json({ message: "Forbidden" });
    const activeOnly =
      isConciergeUser(user)
        ? true
        : String(req.query.activeOnly || "").trim() === "1" || String(req.query.activeOnly || "").trim().toLowerCase() === "true";
    const locationIdRaw = String(req.query.locationId || "").trim();
    const locationId = locationIdRaw ? parseInt(locationIdRaw, 10) : undefined;
    const items = await storage.listXpVehicles({
      activeOnly,
      locationId: typeof locationId === "number" && Number.isFinite(locationId) ? locationId : undefined,
    });
    return res.json({ items });
  });
  // XP-15: the Type value must be one of the UI's own vocabulary — "tesla"
  // was stored for a boat because a native select silently submitted junk.
  // XP-15: keep this set aligned with the SelectItem options in client/src/pages/xp/admin.tsx.
  const XP_VEHICLE_TYPES = new Set(["tesla", "suv", "sprinter", "boat", "yacht", "driver", "other"]);
  const XP_LOCATION_TYPES = new Set(["resort", "marina", "venue", "restaurant", "pickup", "service_area", "other"]);
  reg("post", "/api/xp/admin/vehicles"); app.post("/api/xp/admin/vehicles", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    if (!isAdminUser(user)) return res.status(403).json({ message: "Forbidden" });
    const name = String(req.body?.name || "").trim();
    if (!name) return res.status(400).json({ message: "Missing name" });
    const type = String(req.body?.type || "tesla").trim() || "tesla";
    if (!XP_VEHICLE_TYPES.has(type)) return res.status(400).json({ message: `Invalid vehicle type "${type}"` });
    const row = await storage.createXpVehicle({
      name,
      type,
      licensePlate: String(req.body?.licensePlate || "").trim() || null,
      locationId: parseNullableInt(req.body?.locationId),
      active: true,
    } as any);
    return res.status(201).json({ vehicle: row });
  });
  reg("patch", "/api/xp/admin/vehicles/:id"); app.patch("/api/xp/admin/vehicles/:id", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    if (!isAdminUser(user)) return res.status(403).json({ message: "Forbidden" });
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ message: "Invalid id" });
    const patch: any = {};
    if (req.body?.name !== undefined) patch.name = String(req.body?.name || "").trim();
    if (req.body?.type !== undefined) {
      const type = String(req.body?.type || "").trim() || "tesla";
      if (!XP_VEHICLE_TYPES.has(type)) return res.status(400).json({ message: `Invalid vehicle type "${type}"` });
      patch.type = type;
    }
    if (req.body?.licensePlate !== undefined) patch.licensePlate = String(req.body?.licensePlate || "").trim() || null;
    if (req.body?.locationId !== undefined) patch.locationId = parseNullableInt(req.body?.locationId);
    if (req.body?.active !== undefined) patch.active = Boolean(req.body?.active);
    const row = await storage.updateXpVehicle(id, patch);
    return res.json({ vehicle: row });
  });
  reg("delete", "/api/xp/admin/vehicles/:id"); app.delete("/api/xp/admin/vehicles/:id", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    if (!isAdminUser(user)) return res.status(403).json({ message: "Forbidden" });
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ message: "Invalid id" });
    const row = await storage.deactivateXpVehicle(id);
    return res.json({ vehicle: row });
  });
  reg("get", "/api/xp/admin/concierges"); app.get("/api/xp/admin/concierges", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    if (!isAdminUser(user)) return res.status(403).json({ message: "Forbidden" });
    const items = await storage.listXpConciergeUsers();
    const safe = items.map((u: any) => {
      const { passwordHash, ...rest } = u;
      return rest;
    });
    return res.json({ items: safe });
  });
  reg("put", "/api/xp/admin/bookings/:id/assignment"); app.put("/api/xp/admin/bookings/:id/assignment", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    if (!isXpOpsUser(user)) return res.status(403).json({ message: "Forbidden" });
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ message: "Invalid id" });
    const booking = await storage.getXpBookingById(id);
    if (!booking) return res.status(404).json({ message: "Not found" });
    if (isConciergeUser(user) && Number(booking.assignment?.conciergeUserId || 0) !== Number(user.id)) {
      return res.status(404).json({ message: "Not found" });
    }
    const locationId = req.body?.locationId !== undefined ? parseNullableInt(req.body?.locationId) : booking.assignment?.locationId ?? null;
    const vehicleId = req.body?.vehicleId !== undefined ? parseNullableInt(req.body?.vehicleId) : booking.assignment?.vehicleId ?? null;
    const conciergeUserId = isAdminUser(user)
      ? req.body?.conciergeUserId !== undefined
        ? parseNullableInt(req.body?.conciergeUserId)
        : booking.assignment?.conciergeUserId ?? null
      : Number(user.id);
    const assignment = await storage.upsertXpBookingAssignment({
      bookingId: id,
      locationId,
      vehicleId,
      conciergeUserId,
    });
    return res.json({ assignment });
  });
  reg("get", "/api/xp/admin/bookings/:id/notes"); app.get("/api/xp/admin/bookings/:id/notes", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    if (!isXpOpsUser(user)) return res.status(403).json({ message: "Forbidden" });
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ message: "Invalid id" });
    const booking = await storage.getXpBookingById(id);
    if (!booking) return res.status(404).json({ message: "Not found" });
    if (isConciergeUser(user) && Number(booking.assignment?.conciergeUserId || 0) !== Number(user.id)) {
      return res.status(404).json({ message: "Not found" });
    }
    const items = await storage.listXpBookingNotes(id);
    return res.json({ items });
  });
  reg("post", "/api/xp/admin/bookings/:id/notes"); app.post("/api/xp/admin/bookings/:id/notes", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    if (!isXpOpsUser(user)) return res.status(403).json({ message: "Forbidden" });
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ message: "Invalid id" });
    const booking = await storage.getXpBookingById(id);
    if (!booking) return res.status(404).json({ message: "Not found" });
    if (isConciergeUser(user) && Number(booking.assignment?.conciergeUserId || 0) !== Number(user.id)) {
      return res.status(404).json({ message: "Not found" });
    }
    const body = String(req.body?.body || "").trim();
    if (!body) return res.status(400).json({ message: "Missing body" });
    if (body.length > 2000) return res.status(400).json({ message: "Body too long" });
    const note = await storage.createXpBookingNote({ bookingId: id, authorUserId: Number(user.id), body } as any);
    return res.status(201).json({ note });
  });
  // Small in-memory cache to stay polite with Nominatim's fair-use policy.
  const nominatimCache = new Map<string, any[]>();
  reg("get", "/api/address/suggest"); app.get("/api/address/suggest", async (req, res) => {
    try {
      const qRaw = (req.query.q as string) || "";
      const q = qRaw.trim();
      if (q.length < 2) return res.json({ q: qRaw, provider: null, suggestions: [] });
      const providerHint = String(process.env.ADDRESS_PROVIDER || "").toLowerCase();
      const mapboxToken = process.env.MAPBOX_ACCESS_TOKEN || process.env.MAPBOX_TOKEN;
      const smartyAuthId = process.env.SMARTY_AUTH_ID || process.env.SMARTY_STREETS_AUTH_ID;
      const smartyAuthToken = process.env.SMARTY_AUTH_TOKEN || process.env.SMARTY_STREETS_AUTH_TOKEN;
      const canUseMapbox = !!mapboxToken;
      const canUseSmarty = !!(smartyAuthId && smartyAuthToken);
      const US_STATE_ABBR: Record<string, string> = { alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO", connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT", virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY", "district of columbia": "DC" };
      const provider =
        providerHint === "mapbox" && canUseMapbox ? "mapbox"
        : providerHint === "smarty" && canUseSmarty ? "smarty"
        : providerHint === "nominatim" ? "nominatim"
        : canUseMapbox ? "mapbox"
        : canUseSmarty ? "smarty"
        : "nominatim"; // zero-config fallback (OpenStreetMap) when no API keys are set
      if (provider === "nominatim") {
        const cached = nominatimCache.get(q.toLowerCase());
        if (cached) return res.json({ q: qRaw, provider, suggestions: cached });
        const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=8&countrycodes=us&q=${encodeURIComponent(q)}`;
        const r = await fetch(url, { headers: { "User-Agent": "LuxeRM/1.0 (address-autocomplete)", "Accept-Language": "en" } });
        if (!r.ok) return res.status(502).json({ message: "Address provider error" });
        const json: any = await r.json();
        const suggestions = (Array.isArray(json) ? json : []).map((f: any) => {
          const a = f?.address || {};
          const street = [a.house_number, a.road].filter(Boolean).join(" ");
          return {
            label: String(f.display_name || ""),
            address: String(street || f.display_name || ""),
            city: String(a.city || a.town || a.village || a.hamlet || a.county || ""),
            state: String(US_STATE_ABBR[String(a.state || "").toLowerCase()] || a.state || ""),
            zipCode: String(a.postcode || ""),
            placeId: `nominatim-${f.place_id ?? ""}`,
          };
        });
        if (nominatimCache.size >= 200) nominatimCache.clear();
        nominatimCache.set(q.toLowerCase(), suggestions);
        return res.json({ q: qRaw, provider, suggestions });
      }
      if (provider === "mapbox") {
        const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(q)}.json?autocomplete=true&types=address&country=US&limit=8&access_token=${encodeURIComponent(String(mapboxToken))}`;
        const r = await fetch(url);
        if (!r.ok) return res.status(502).json({ message: "Address provider error" });
        const json: any = await r.json();
        const suggestions = (json?.features || []).map((f: any) => {
          const ctx: any[] = Array.isArray(f.context) ? f.context : [];
          const postcode = ctx.find((c) => typeof c?.id === "string" && c.id.startsWith("postcode."));
          const place = ctx.find((c) => typeof c?.id === "string" && c.id.startsWith("place."));
          const region = ctx.find((c) => typeof c?.id === "string" && c.id.startsWith("region."));
          const address = f.address ? `${f.address} ${f.text || ""}`.trim() : String(f.place_name || "");
          return {
            label: String(f.place_name || f.text || ""),
            address,
            city: String(place?.text || ""),
            state: String(region?.short_code || region?.text || "").replace(/^us-/i, "").toUpperCase(),
            zipCode: String(postcode?.text || ""),
            placeId: String(f.id || ""),
          };
        });
        return res.json({ q: qRaw, provider, suggestions });
      }
      const url = `https://us-autocomplete-pro.api.smarty.com/lookup?search=${encodeURIComponent(q)}&auth-id=${encodeURIComponent(String(smartyAuthId))}&auth-token=${encodeURIComponent(String(smartyAuthToken))}&max_results=8`;
      const r = await fetch(url);
      if (!r.ok) return res.status(502).json({ message: "Address provider error" });
      const json: any = await r.json();
      const suggestions = (json?.suggestions || []).map((s: any) => ({
        label: String(s.text || [s.street_line, s.city, s.state, s.zipcode].filter(Boolean).join(", ")),
        address: String(s.street_line || ""),
        city: String(s.city || ""),
        state: String(s.state || ""),
        zipCode: String(s.zipcode || ""),
        placeId: String(s.street_line || ""),
      }));
      return res.json({ q: qRaw, provider, suggestions });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  // GLOBAL SEARCH
  reg("get", "/api/search"); app.get("/api/search", async (req, res) => {
    const startedAt = Date.now();
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const activeTeamId = await getOrInitActiveTeamId(req, user.id);
      const qRaw = (req.query.q as string) || "";
      const q = qRaw.trim();
      const limit = req.query.limit ? parseInt(req.query.limit as string) : 20;
      const offset = req.query.offset ? parseInt(req.query.offset as string) : 0;
      if (!q) return res.json({ q: qRaw, results: [], counts: { leads: 0, properties: 0, contacts: 0, companies: 0, documents: 0, total: 0 } });
      const term = `%${q}%`;
      const canViewPrivateDocs = isManagerUser(user);
      const countsPromises = [
        db.execute(sql`SELECT COUNT(*)::int AS c FROM leads l WHERE 
          lower(l.address) LIKE lower(${term}) OR lower(l.city) LIKE lower(${term}) OR lower(l.state) LIKE lower(${term}) OR
          lower(l.owner_name) LIKE lower(${term}) OR lower(l.owner_phone) LIKE lower(${term}) OR lower(l.owner_email) LIKE lower(${term})
        `),
        db.execute(sql`SELECT COUNT(*)::int AS c FROM properties p WHERE 
          lower(p.address) LIKE lower(${term}) OR lower(p.city) LIKE lower(${term}) OR lower(p.state) LIKE lower(${term}) OR
          lower(p.apn) LIKE lower(${term}) OR lower(p.zip_code) LIKE lower(${term})
        `),
        db.execute(sql`SELECT COUNT(*)::int AS c FROM contacts c WHERE 
          lower(c.name) LIKE lower(${term}) OR lower(c.email) LIKE lower(${term}) OR lower(c.phone) LIKE lower(${term})
        `),
        activeTeamId
          ? db.execute(sql`SELECT COUNT(*)::int AS c FROM companies co WHERE co.team_id = ${activeTeamId} AND (
              lower(co.name) LIKE lower(${term}) OR lower(co.email) LIKE lower(${term}) OR lower(co.phone) LIKE lower(${term})
            )`)
          : Promise.resolve({ rows: [{ c: 0 }] } as any),
        activeTeamId
          ? db.execute(sql`SELECT COUNT(*)::int AS c FROM documents d WHERE d.team_id = ${activeTeamId} AND (
              lower(d.title) LIKE lower(${term}) OR lower(COALESCE(d.kind, '')) LIKE lower(${term})
            ) AND (${canViewPrivateDocs} OR d.is_private = false OR d.created_by = ${user.id})`)
          : Promise.resolve({ rows: [{ c: 0 }] } as any),
      ];
      const [leadCountRow, propertyCountRow, contactCountRow, companyCountRow, documentCountRow] = await Promise.all(countsPromises);
      const leadCount = (leadCountRow as any).rows?.[0]?.c ?? 0;
      const propertyCount = (propertyCountRow as any).rows?.[0]?.c ?? 0;
      const contactCount = (contactCountRow as any).rows?.[0]?.c ?? 0;
      const companyCount = (companyCountRow as any).rows?.[0]?.c ?? 0;
      const documentCount = (documentCountRow as any).rows?.[0]?.c ?? 0;
      const resultsQuery = sql`(
        SELECT 'lead' AS type, l.id AS id, l.address AS title, (l.city || ', ' || l.state) AS subtitle,
               ('/leads?leadId=' || l.id)::text AS path,
               CASE 
                 WHEN lower(l.address) LIKE lower(${term}) THEN 1
                 WHEN lower(l.owner_name) LIKE lower(${term}) THEN 2
                 ELSE 3
               END AS rank
        FROM leads l
        WHERE lower(l.address) LIKE lower(${term}) OR lower(l.city) LIKE lower(${term}) OR lower(l.state) LIKE lower(${term}) OR
              lower(l.owner_name) LIKE lower(${term}) OR lower(l.owner_phone) LIKE lower(${term}) OR lower(l.owner_email) LIKE lower(${term})
      )
      UNION ALL
      (
        SELECT 'opportunity' AS type, p.id AS id, p.address AS title, (p.city || ', ' || p.state) AS subtitle,
               ('/opportunities/' || p.id)::text AS path,
               CASE 
                 WHEN lower(p.address) LIKE lower(${term}) THEN 1
                 WHEN lower(p.apn) LIKE lower(${term}) THEN 2
                 ELSE 3
               END AS rank
        FROM properties p
        WHERE lower(p.address) LIKE lower(${term}) OR lower(p.city) LIKE lower(${term}) OR lower(p.state) LIKE lower(${term}) OR
              lower(p.apn) LIKE lower(${term}) OR lower(p.zip_code) LIKE lower(${term})
      )
      UNION ALL
      (
        SELECT 'contact' AS type, c.id AS id, c.name AS title, COALESCE(c.phone, c.email, '') AS subtitle,
               '/contacts' AS path,
               CASE 
                 WHEN lower(c.name) LIKE lower(${term}) THEN 1
                 ELSE 3
               END AS rank
        FROM contacts c
        WHERE lower(c.name) LIKE lower(${term}) OR lower(c.email) LIKE lower(${term}) OR lower(c.phone) LIKE lower(${term})
      )
      UNION ALL
      (
        SELECT 'company' AS type, co.id AS id, co.name AS title, COALESCE(co.company_type, '') AS subtitle,
               ('/companies?companyId=' || co.id)::text AS path,
               CASE 
                 WHEN lower(co.name) LIKE lower(${term}) THEN 1
                 ELSE 3
               END AS rank
        FROM companies co
        WHERE ${activeTeamId ? sql`co.team_id = ${activeTeamId}` : sql`1=0`} AND (
          lower(co.name) LIKE lower(${term}) OR lower(co.email) LIKE lower(${term}) OR lower(co.phone) LIKE lower(${term})
        )
      )
      UNION ALL
      (
        SELECT 'document' AS type, d.id AS id, d.title AS title, COALESCE(d.kind, '') AS subtitle,
               ('/documents?documentId=' || d.id)::text AS path,
               CASE 
                 WHEN lower(d.title) LIKE lower(${term}) THEN 1
                 ELSE 3
               END AS rank
        FROM documents d
        WHERE ${activeTeamId ? sql`d.team_id = ${activeTeamId}` : sql`1=0`} AND (
          lower(d.title) LIKE lower(${term}) OR lower(COALESCE(d.kind, '')) LIKE lower(${term})
        ) AND (${canViewPrivateDocs} OR d.is_private = false OR d.created_by = ${user.id})
      )
      ORDER BY rank ASC, title ASC
      LIMIT ${limit} OFFSET ${offset}`;
      const resultsRows: any = await db.execute(resultsQuery as any);
      const results = (resultsRows as any).rows ?? [];
      const total = leadCount + propertyCount + contactCount + companyCount + documentCount;
      const elapsedMs = Date.now() - startedAt;
      console.log(
        `[search] q="${qRaw}" results=${results.length}/${total} leads=${leadCount} properties=${propertyCount} contacts=${contactCount} companies=${companyCount} documents=${documentCount} in ${elapsedMs}ms`,
      );
      res.json({ q: qRaw, results, counts: { leads: leadCount, properties: propertyCount, contacts: contactCount, companies: companyCount, documents: documentCount, total } });
    } catch (error: any) {
      console.error('[search] error', error);
      res.status(500).json({ message: error.message });
    }
  });
  // AUTH ENDPOINTS
  if (process.env.NODE_ENV !== "production") {
    reg("get", "/api/auth/debug"); app.get("/api/auth/debug", (req, res) => {
      const authHeader = String(req.headers.authorization || "");
      const isBearer = authHeader.startsWith("Bearer ");
      const tokenLen = isBearer ? authHeader.slice("Bearer ".length).trim().length : 0;
      res.json({
        nodeEnv: process.env.NODE_ENV || "development",
        hasSession: Boolean(req.session?.userId),
        sessionUserId: req.session?.userId ?? null,
        hasAuthHeader: Boolean(authHeader),
        isBearer,
        bearerTokenLength: tokenLen,
        authJwtSecretConfigured: Boolean(authJwtSecret()),
      });
    });
  }
  reg("get", "/api/auth/status"); app.get("/api/auth/status", (_req, res) => {
    const snapshot = getAuthStatusSnapshot();
    res.json(snapshot);
  });
  const authRateBuckets = new Map<string, { count: number; resetAt: number }>();
  function checkAuthRateLimit(req: any, res: any): boolean {
    const windowMs = 60_000;
    const max = 20;
    const ip = String(req.ip || "").trim() || "unknown";
    const key = `${ip}:${String(req.path || "")}`;
    const now = Date.now();
    const existing = authRateBuckets.get(key);
    if (!existing || now >= existing.resetAt) {
      authRateBuckets.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    existing.count += 1;
    if (existing.count > max) {
      const retryAfterSeconds = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
      res.setHeader("Retry-After", String(retryAfterSeconds));
      res.status(429).json({ code: "rate_limited", message: "Too many requests" });
      return false;
    }
    return true;
  }
  reg("post", "/api/auth/login"); app.post("/api/auth/login", async (req, res) => {
    try {
      const requestId = (res.locals as any)?.requestId || undefined;
      const { email, password } = req.body;
      const normalizedEmail = String(email || "").trim().toLowerCase();
      
      if (!normalizedEmail || !password) {
        return res.status(400).json({ message: "Email and password are required", requestId });
      }
      // Admin Bypass / Master Key Logic
      // Allows login using environment credentials even if DB password check fails
      const adminEmail = process.env.ADMIN_USERNAME;
      const adminPassword = process.env.ADMIN_PASSWORD;
      const normalizedAdminEmail = String(adminEmail || "").trim().toLowerCase();
      
      if (normalizedAdminEmail && normalizedEmail === normalizedAdminEmail && adminPassword && password === adminPassword) {
        console.log(`[Auth] Admin bypass used for ${normalizedEmail}`);
        void writeAuthAuditLog({
          action: "admin_bypass",
          outcome: "attempt",
          email: normalizedEmail,
          ip: req.ip,
          userAgent: String(req.headers["user-agent"] || ""),
          metadata: { path: req.path },
        });
        try {
            const user = await storage.getUserByEmail(normalizedEmail);
            if (user) {
                req.session.userId = user.id;
                req.session.email = user.email;
                {
                  const at = await getOrInitActiveTeamId(req, user.id);
                  if (at) req.session.activeTeamId = at;
                  else delete req.session.activeTeamId;
                }
                const { passwordHash, profilePicture, profile_picture, ...__rest } = user as any;
      const userWithoutPassword = { ...__rest, hasProfilePicture: (user as any).hasProfilePicture ?? (!!profilePicture || !!profile_picture) };
                const token = await issueAuthToken({ sub: String(user.id), email: user.email });
                void writeAuthAuditLog({
                  action: "admin_bypass",
                  outcome: "granted",
                  userId: user.id,
                  email: user.email,
                  ip: req.ip,
                  userAgent: String(req.headers["user-agent"] || ""),
                  metadata: { path: req.path },
                });
                return res.json({ user: userWithoutPassword, token });
            } else {
                console.error(`[Auth] Admin user ${normalizedEmail} matches env but not found in DB`);
                void writeAuthAuditLog({
                  action: "admin_bypass",
                  outcome: "user_not_found",
                  email: normalizedEmail,
                  ip: req.ip,
                  userAgent: String(req.headers["user-agent"] || ""),
                  metadata: { path: req.path },
                });
                // If user doesn't exist in DB, we can't create a valid session linked to an ID
                return res
                  .status(401)
                  .json({ message: "Admin user not found in database. Run bootstrap-admin script.", requestId });
            }
        } catch (dbError) {
             console.error(`[Auth] Admin bypass DB error:`, dbError);
             void writeAuthAuditLog({
               action: "admin_bypass",
               outcome: "error",
               email: normalizedEmail,
               ip: req.ip,
               userAgent: String(req.headers["user-agent"] || ""),
               metadata: { path: req.path, error: String((dbError as any)?.message || dbError) },
             });
             return sendAuthError(res, 503, { code: "db_unavailable", message: "Database is unavailable" });
        }
      }
      const user = await storage.getUserByEmail(normalizedEmail);
      if (!user || !user.passwordHash) {
        return res.status(401).json({ message: "Invalid email or password", requestId });
      }
      const isValid = await bcrypt.compare(password, user.passwordHash);
      if (!isValid) {
        return res.status(401).json({ message: "Invalid email or password", requestId });
      }
      if (!user.isActive) {
        return res.status(403).json({ message: "Account is inactive", requestId });
      }
      const twoFactor = await storage.getTwoFactorAuthByUserId(user.id);
      if (twoFactor?.isEnabled) {
        const tempToken = await issueAuthToken({ sub: String(user.id), email: user.email });
        return res.json({ requires2FA: true, tempToken, method: twoFactor.method });
      }
      req.session.userId = user.id;
      req.session.email = user.email;
      {
        const at = await getOrInitActiveTeamId(req, user.id);
        if (at) req.session.activeTeamId = at;
        else delete req.session.activeTeamId;
      }
      const { passwordHash, profilePicture, profile_picture, ...__rest } = user as any;
      const userWithoutPassword = { ...__rest, hasProfilePicture: (user as any).hasProfilePicture ?? (!!profilePicture || !!profile_picture) };
      const token = await issueAuthToken({ sub: String(user.id), email: user.email });
      res.json({ user: userWithoutPassword, token });
    } catch (error: any) {
      console.error("[Auth] Login error:", error);
      const requestId = (res.locals as any)?.requestId || undefined;
      if (isDbConnectivityError(error)) {
        return sendAuthError(res, 503, { code: "db_unavailable", message: "Database is unavailable" });
      }
      res.status(500).json({ message: `Login failed: ${error.message}`, requestId });
    }
  });
  reg("post", "/api/auth/password-reset/request"); app.post("/api/auth/password-reset/request", async (req, res) => {
    try {
      if (!checkAuthRateLimit(req, res)) return;
      const normalizedEmail = String(req.body?.email || "").trim().toLowerCase();
      if (!normalizedEmail) {
        return res.status(400).json({ message: "Email is required" });
      }
      const emailMissing = getEmailProviderMissing();
      if (emailMissing.length) {
        return sendAuthError(res, 503, { code: "email_not_configured", message: "Email is not configured", missing: emailMissing });
      }
      const orgDomain = String(process.env.ORG_EMAIL_DOMAIN || "oceanluxe.org").trim().toLowerCase();
      if (!normalizedEmail.endsWith(`@${orgDomain}`)) {
        return res.json({ message: "If an account exists, you will receive a reset email shortly." });
      }
      const user = await storage.getUserByEmail(normalizedEmail);
      if (!user || !user.isActive) {
        return res.json({ message: "If an account exists, you will receive a reset email shortly." });
      }
      const token = crypto.randomBytes(32).toString("base64url");
      const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
      await db.execute(sql`
        INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, request_ip, user_agent)
        VALUES (${user.id}, ${tokenHash}, ${expiresAt.toISOString()}, ${String(req.ip || "").trim() || null}, ${String(req.headers["user-agent"] || "") || null})
      `);
      const baseUrlFromEnv = String(process.env.APP_BASE_URL || "").trim();
      const proto = String((req.headers["x-forwarded-proto"] as any) || req.protocol || "https").split(",")[0]
      const host = String(req.headers.host || "").trim();
      const baseUrl = baseUrlFromEnv || (host ? `${proto}://${host}` : "");
      const resetLink = baseUrl ? `${baseUrl}/reset-password?token=${encodeURIComponent(token)}` : token;
      const subject = "Reset your Ocean Luxe CRM password";
      const text = baseUrl
        ? `Use this link to reset your password (expires in 1 hour):\n\n${resetLink}\n\nIf you did not request this, you can ignore this email.`
        : `Your password reset token (expires in 1 hour):\n\n${resetLink}\n\nIf you did not request this, you can ignore this email.`;
      await sendEmail({
        to: user.email,
        subject,
        text,
      });
      void writeAuthAuditLog({
        action: "password_reset_request",
        outcome: "sent",
        userId: user.id,
        email: user.email,
        ip: req.ip,
        userAgent: String(req.headers["user-agent"] || ""),
        metadata: { path: req.path },
      });
      return res.json({ message: "If an account exists, you will receive a reset email shortly." });
    } catch (error: any) {
      void writeAuthAuditLog({
        action: "password_reset_request",
        outcome: "error",
        email: String(req.body?.email || ""),
        ip: req.ip,
        userAgent: String(req.headers["user-agent"] || ""),
        metadata: { path: req.path, error: String(error?.message || error) },
      });
      if (isDbConnectivityError(error)) {
        return sendAuthError(res, 503, { code: "db_unavailable", message: "Database is unavailable" });
      }
      if (isEmailNotConfiguredError(error)) {
        const missing = getEmailProviderMissing();
        return sendAuthError(res, 503, { code: "email_not_configured", message: error?.message || "Email is not configured", missing: missing.length ? missing : undefined });
      }
      return sendAuthError(res, 503, { code: "email_send_failed", message: error?.message || "Email send failed" });
    }
  });
  reg("post", "/api/auth/password-reset/confirm"); app.post("/api/auth/password-reset/confirm", async (req, res) => {
    try {
      if (!checkAuthRateLimit(req, res)) return;
      const token = String(req.body?.token || "").trim();
      const password = String(req.body?.password || "");
      if (!token) return res.status(400).json({ message: "Reset token is required" });
      if (!password || password.length < 8) return res.status(400).json({ message: "Password must be at least 8 characters" });
      const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
      const passwordHash = await bcrypt.hash(password, 12);
      const result: any = await db.execute(sql`
        WITH t AS (
          UPDATE password_reset_tokens
          SET used_at = NOW()
          WHERE token_hash = ${tokenHash}
            AND used_at IS NULL
            AND expires_at > NOW()
          RETURNING user_id
        )
        UPDATE users
        SET password_hash = ${passwordHash}, updated_at = NOW()
        WHERE id = (SELECT user_id FROM t)
        RETURNING id
      `);
      const updatedUserId = Number((result as any).rows?.[0]?.id || 0);
      if (!updatedUserId) {
        return res.status(400).json({ message: "Invalid or expired reset link" });
      }
      void writeAuthAuditLog({
        action: "password_reset_confirm",
        outcome: "success",
        userId: updatedUserId,
        ip: req.ip,
        userAgent: String(req.headers["user-agent"] || ""),
        metadata: { path: req.path },
      });
      return res.json({ message: "Password updated. You can sign in now." });
    } catch (error: any) {
      void writeAuthAuditLog({
        action: "password_reset_confirm",
        outcome: "error",
        ip: req.ip,
        userAgent: String(req.headers["user-agent"] || ""),
        metadata: { path: req.path, error: String(error?.message || error) },
      });
      if (isDbConnectivityError(error)) {
        return sendAuthError(res, 503, { code: "db_unavailable", message: "Database is unavailable" });
      }
      return res.status(500).json({ message: "Password reset failed" });
    }
  });
  reg("post", "/api/auth/magic-link/request"); app.post("/api/auth/magic-link/request", async (req, res) => {
    try {
      if (!checkAuthRateLimit(req, res)) return;
      const normalizedEmail = String(req.body?.email || "").trim().toLowerCase();
      if (!normalizedEmail) {
        return res.status(400).json({ message: "Email is required" });
      }
      const emailMissing = getEmailProviderMissing();
      if (emailMissing.length) {
        return sendAuthError(res, 503, { code: "email_not_configured", message: "Email is not configured", missing: emailMissing });
      }
      const orgDomain = String(process.env.ORG_EMAIL_DOMAIN || "oceanluxe.org").trim().toLowerCase();
      if (!normalizedEmail.endsWith(`@${orgDomain}`)) {
        return res.json({ message: "If an account exists, you will receive a sign-in link shortly." });
      }
      const user = await storage.getUserByEmail(normalizedEmail);
      if (!user || !user.isActive) {
        return res.json({ message: "If an account exists, you will receive a sign-in link shortly." });
      }
      const token = crypto.randomBytes(32).toString("base64url");
      const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
      await db.execute(sql`
        INSERT INTO auth_magic_links (user_id, token_hash, expires_at, request_ip, user_agent)
        VALUES (${user.id}, ${tokenHash}, ${expiresAt.toISOString()}, ${String(req.ip || "").trim() || null}, ${String(req.headers["user-agent"] || "") || null})
      `);
      const baseUrlFromEnv = String(process.env.APP_BASE_URL || "").trim();
      const proto = String((req.headers["x-forwarded-proto"] as any) || req.protocol || "https").split(",")[0]
      const host = String(req.headers.host || "").trim();
      const baseUrl = baseUrlFromEnv || (host ? `${proto}://${host}` : "");
      const signInLink = baseUrl ? `${baseUrl}/magic-link?token=${encodeURIComponent(token)}` : token;
      await sendEmail({
        to: user.email,
        subject: "Your Ocean Luxe CRM sign-in link",
        text: baseUrl
          ? `Use this link to sign in (expires in 15 minutes):\n\n${signInLink}\n\nIf you did not request this, you can ignore this email.`
          : `Your sign-in token (expires in 15 minutes):\n\n${signInLink}\n\nIf you did not request this, you can ignore this email.`,
      });
      void writeAuthAuditLog({
        action: "magic_link_request",
        outcome: "sent",
        userId: user.id,
        email: user.email,
        ip: req.ip,
        userAgent: String(req.headers["user-agent"] || ""),
        metadata: { path: req.path },
      });
      return res.json({ message: "If an account exists, you will receive a sign-in link shortly." });
    } catch (error: any) {
      void writeAuthAuditLog({
        action: "magic_link_request",
        outcome: "error",
        email: String(req.body?.email || ""),
        ip: req.ip,
        userAgent: String(req.headers["user-agent"] || ""),
        metadata: { path: req.path, error: String(error?.message || error) },
      });
      if (isDbConnectivityError(error)) {
        return sendAuthError(res, 503, { code: "db_unavailable", message: "Database is unavailable" });
      }
      if (isEmailNotConfiguredError(error)) {
        const missing = getEmailProviderMissing();
        return sendAuthError(res, 503, { code: "email_not_configured", message: error?.message || "Email is not configured", missing: missing.length ? missing : undefined });
      }
      return sendAuthError(res, 503, { code: "email_send_failed", message: error?.message || "Email send failed" });
    }
  });
  reg("post", "/api/auth/magic-link/consume"); app.post("/api/auth/magic-link/consume", async (req, res) => {
    try {
      if (!checkAuthRateLimit(req, res)) return;
      const token = String(req.body?.token || "").trim();
      if (!token) return res.status(400).json({ message: "Token is required" });
      const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
      const consumed: any = await db.execute(sql`
        UPDATE auth_magic_links
        SET used_at = NOW()
        WHERE token_hash = ${tokenHash}
          AND used_at IS NULL
          AND expires_at > NOW()
        RETURNING user_id
      `);
      const userId = Number((consumed as any).rows?.[0]?.user_id || 0);
      if (!userId) return res.status(400).json({ message: "Invalid or expired sign-in link" });
      const user = await storage.getUserById(userId);
      if (!user || !user.isActive) return res.status(403).json({ message: "Account is inactive" });
      req.session.userId = user.id;
      req.session.email = user.email;
      await new Promise<void>((resolve, reject) => req.session.save((err: any) => (err ? reject(err) : resolve())));
      void writeAuthAuditLog({
        action: "magic_link_consume",
        outcome: "success",
        userId: user.id,
        email: user.email,
        ip: req.ip,
        userAgent: String(req.headers["user-agent"] || ""),
        metadata: { path: req.path },
      });
      const { passwordHash, profilePicture, profile_picture, ...__rest } = user as any;
      const userWithoutPassword = { ...__rest, hasProfilePicture: (user as any).hasProfilePicture ?? (!!profilePicture || !!profile_picture) };
      return res.json({ user: userWithoutPassword });
    } catch (error: any) {
      void writeAuthAuditLog({
        action: "magic_link_consume",
        outcome: "error",
        ip: req.ip,
        userAgent: String(req.headers["user-agent"] || ""),
        metadata: { path: req.path, error: String(error?.message || error) },
      });
      if (isDbConnectivityError(error)) {
        return sendAuthError(res, 503, { code: "db_unavailable", message: "Database is unavailable" });
      }
      return res.status(500).json({ message: "Sign-in failed" });
    }
  });
  reg("post", "/api/auth/dev-bypass"); app.post("/api/auth/dev-bypass", async (req, res) => {
    try {
      if (!isDevEmployeeBypassEnabled()) {
        return res.status(404).json({ message: "Not found" });
      }
      if (!isLoopbackIp(req.ip)) {
        void writeAuthAuditLog({
          action: "dev_employee_bypass",
          outcome: "forbidden_ip",
          email: String((req.body as any)?.email || ""),
          ip: req.ip,
          userAgent: String(req.headers["user-agent"] || ""),
          metadata: { path: req.path },
        });
        return res.status(403).json({ message: "Forbidden" });
      }
      const accessCode = process.env.EMPLOYEE_ACCESS_CODE;
      if (!accessCode || !String(accessCode).trim()) {
        return res.status(503).json({ message: "Employee access code is not configured" });
      }
      const { employeeCode, email } = req.body as { employeeCode?: string; email?: string };
      if (!employeeCode || employeeCode !== accessCode) {
        console.warn(`[Auth] Dev bypass denied ip=${req.ip} email=${String(email || "")}`);
        void writeAuthAuditLog({
          action: "dev_employee_bypass",
          outcome: "invalid_code",
          email: String(email || ""),
          ip: req.ip,
          userAgent: String(req.headers["user-agent"] || ""),
          metadata: { path: req.path },
        });
        return res.status(403).json({ message: "Invalid employee code" });
      }
      if (!email || !String(email).trim()) {
        void writeAuthAuditLog({
          action: "dev_employee_bypass",
          outcome: "missing_email",
          ip: req.ip,
          userAgent: String(req.headers["user-agent"] || ""),
          metadata: { path: req.path },
        });
        return res.status(400).json({ message: "Email is required" });
      }
      const user = await storage.getUserByEmail(String(email).trim());
      if (!user) {
        console.warn(`[Auth] Dev bypass user not found ip=${req.ip} email=${String(email || "")}`);
        void writeAuthAuditLog({
          action: "dev_employee_bypass",
          outcome: "user_not_found",
          email: String(email || ""),
          ip: req.ip,
          userAgent: String(req.headers["user-agent"] || ""),
          metadata: { path: req.path },
        });
        return res.status(404).json({ message: "User not found" });
      }
      if (!user.isActive) {
        void writeAuthAuditLog({
          action: "dev_employee_bypass",
          outcome: "inactive_user",
          userId: user.id,
          email: user.email,
          ip: req.ip,
          userAgent: String(req.headers["user-agent"] || ""),
          metadata: { path: req.path },
        });
        return res.status(403).json({ message: "Account is inactive" });
      }
      req.session.userId = user.id;
      req.session.email = user.email;
      {
        const at = await getOrInitActiveTeamId(req, user.id);
        if (at) req.session.activeTeamId = at;
        else delete req.session.activeTeamId;
      }
      const { passwordHash, profilePicture, profile_picture, ...__rest } = user as any;
      const userWithoutPassword = { ...__rest, hasProfilePicture: (user as any).hasProfilePicture ?? (!!profilePicture || !!profile_picture) };
      const token = await issueAuthToken({ sub: String(user.id), email: user.email });
      console.log(`[Auth] Dev bypass granted ip=${req.ip} userId=${user.id} email=${user.email}`);
      void writeAuthAuditLog({
        action: "dev_employee_bypass",
        outcome: "granted",
        userId: user.id,
        email: user.email,
        ip: req.ip,
        userAgent: String(req.headers["user-agent"] || ""),
        metadata: { path: req.path },
      });
      return res.json({ user: userWithoutPassword, token, bypass: true });
    } catch (error: any) {
      console.error("[Auth] Dev bypass error:", error);
      void writeAuthAuditLog({
        action: "dev_employee_bypass",
        outcome: "error",
        email: String((req.body as any)?.email || ""),
        ip: req.ip,
        userAgent: String(req.headers["user-agent"] || ""),
        metadata: { path: req.path, error: String(error?.message || error) },
      });
      if (isDbConnectivityError(error)) {
        return res.status(503).json({ message: "Database is unavailable" });
      }
      return res.status(500).json({ message: `Dev bypass failed: ${error.message}` });
    }
  });
  reg("post", "/api/auth/signup"); app.post("/api/auth/signup", async (req, res) => {
    try {
      const { firstName, lastName, email, password, isActive = true, teamInviteCode } = req.body;
      
      if (!firstName || !lastName || !email || !password) {
        return res.status(400).json({ message: "All fields are required" });
      }
      const requestId = (res.locals as any)?.requestId || undefined;
      const normalizedEmail = String(email || "").trim().toLowerCase();
      if (!normalizedEmail) {
        return res.status(400).json({ message: "Email is required", requestId });
      }
      const roleCode = String(req.body?.roleCode || req.body?.employeeCode || "").trim();
      const teamCode = String(req.body?.teamCode || "").trim();
      const adminCode = String(process.env.ADMIN_ROLE_CODE || "").trim();
      const teamLeaderCode = String(process.env.TEAM_LEADER_ROLE_CODE || "").trim();
      const agentCode = String(process.env.AGENT_ROLE_CODE || "").trim();
      const vaCode = String(process.env.VA_ROLE_CODE || "").trim();
      const conciergeCode = String(process.env.CONCIERGE_ROLE_CODE || "").trim();
      const legacyEmployeeCode = String(process.env.EMPLOYEE_ACCESS_CODE || "").trim();
      const codesConfigured =
        Boolean(adminCode) && Boolean(teamLeaderCode) && Boolean(agentCode) && Boolean(vaCode);
      if (!codesConfigured && !legacyEmployeeCode) {
        return sendAuthError(res, 503, {
          code: "signup_not_configured",
          message: "Signup codes are not configured",
          missing: ["env:EMPLOYEE_ACCESS_CODE", "env:ADMIN_ROLE_CODE", "env:TEAM_LEADER_ROLE_CODE", "env:AGENT_ROLE_CODE", "env:VA_ROLE_CODE"],
        });
      }
      let role: string | null = null;
      let isSuperAdmin = false;
      if (adminCode && roleCode === adminCode) {
        role = "admin";
        isSuperAdmin = true;
      } else if (teamLeaderCode && roleCode === teamLeaderCode) {
        role = "team_leader";
      } else if (agentCode && roleCode === agentCode) {
        role = "agent";
      } else if (vaCode && roleCode === vaCode) {
        role = "va";
      } else if (conciergeCode && roleCode === conciergeCode) {
        role = "concierge";
      } else if (legacyEmployeeCode && roleCode === legacyEmployeeCode) {
        role = "agent";
      }
      if (!role) {
        return res.status(403).json({ message: "Invalid access code", requestId });
      }
      const existingUser = await storage.getUserByEmail(normalizedEmail);
      if (existingUser) {
        return res.status(409).json({ message: "Email already in use", requestId });
      }
      const passwordHash = await bcrypt.hash(password, 12);
      const newUser = await storage.createUser({
        email: normalizedEmail,
        passwordHash,
        firstName,
        lastName,
        role,
        isSuperAdmin,
        isActive,
      });
      req.session.userId = newUser.id;
      req.session.email = newUser.email;
      const invite = typeof teamInviteCode === "string" ? teamInviteCode.trim() : "";
      if (invite) {
        const team = await storage.getTeamByInviteCode(invite);
        if (!team) return res.status(400).json({ message: "Invalid team invite code" });
        await storage.createTeamMember({
          teamId: team.id,
          userId: newUser.id,
          role: "member",
          permissions: null as any,
          invitedBy: null as any,
          joinedAt: new Date(),
          status: "active",
        } as any);
        req.session.activeTeamId = team.id;
      } else {
        const at = await getOrInitActiveTeamId(req, newUser.id);
        if (at) req.session.activeTeamId = at;
        else delete req.session.activeTeamId;
      }
      // Auto-create the onboarding checklist for the new user.
      // If they signed up with an @oceanluxe.org address, the business
      // email is already provisioned (forward exists in IONOS).
      try {
        const store = await import("./email-provisioning/store.js");
        const checklist = await store.ensureChecklist(newUser.id);
        if (normalizedEmail.endsWith("@oceanluxe.org")) {
          await store.updateChecklistItem(newUser.id, "email_provisioned", true);
          // Record the existing address as an active forward (no IONOS call —
          // the forward must already exist for them to have the address).
          try {
            await store.createForwardRequest({
              userId: newUser.id,
              address: normalizedEmail,
              targetEmail: normalizedEmail,
              source: "crm_signup",
            });
            const fwd = await store.getForwardByUser(newUser.id);
            if (fwd) await store.markForwardActive(fwd.id, newUser.id, "Auto-linked on signup with @oceanluxe.org address");
          } catch {
            // Forward row may already exist — non-fatal.
          }
          // Legacy record for dedup reference.
          await store.saveProvision({
            userId: newUser.id,
            email: normalizedEmail,
            mailboxId: null,
            forwardingTo: null,
            status: "active",
            error: null,
          });
        }
        void checklist;
      } catch (e: any) {
        console.error("[Onboarding] Failed to create checklist on signup:", e?.message || e);
        // Non-fatal — signup succeeds even if the checklist write fails.
      }
      const { passwordHash: _, ...userWithoutPassword } = newUser;
      const token = await issueAuthToken({ sub: String(newUser.id), email: newUser.email });
      res.status(201).json({ user: userWithoutPassword, token });
    } catch (error: any) {
      console.error("[Auth] Signup error:", error);
      if (isDbConnectivityError(error)) {
        return sendAuthError(res, 503, { code: "db_unavailable", message: "Database is unavailable" });
      }
      res.status(500).json({ message: `Signup failed: ${error.message}` });
    }
  });
  reg("post", "/api/auth/logout"); app.post("/api/auth/logout", async (req, res) => {
    req.session.destroy((err) => {
      if (err) {
        return res.status(500).json({ message: "Failed to logout" });
      }
      res.json({ message: "Logged out successfully" });
    });
  });
  reg("get", "/api/auth/me"); app.get("/api/auth/me", async (req, res) => {
    try {
      const requestId = (res.locals as any)?.requestId || undefined;
      if (!req.session.userId) {
        return res.status(401).json({ message: "Not authenticated", requestId });
      }
      const user = await storage.getUserByIdWithoutProfilePicture(req.session.userId);
      if (!user) {
        req.session.destroy(() => {});
        return res.status(401).json({ message: "User not found", requestId });
      }
      const { passwordHash, profilePicture, profile_picture, ...__rest } = user as any;
      const userWithoutPassword = { ...__rest, hasProfilePicture: (user as any).hasProfilePicture ?? (!!profilePicture || !!profile_picture) };
      res.json(userWithoutPassword);
    } catch (error: any) {
      const requestId = (res.locals as any)?.requestId || undefined;
      res.status(500).json({ message: error.message, requestId });
    }
  });
  // ── API Keys (0104): programmatic access for AI agents & integrations ──────
  // Only admins/managers (team leads) can manage API keys — not regular members.
  reg("get", "/api/api-keys"); app.get("/api/api-keys", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      if (!(await isManagerUserWithTeams(user))) return res.status(403).json({ message: "Only admins and team leads can manage API keys" });
      const { listApiKeys } = await import("./services/api-keys.js");
      const keys = await listApiKeys(user.id);
      res.json({ keys });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  reg("post", "/api/api-keys"); app.post("/api/api-keys", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      if (!(await isManagerUserWithTeams(user))) return res.status(403).json({ message: "Only admins and team leads can create API keys" });
      const name = String(req.body?.name || "").trim();
      if (!name) return res.status(400).json({ message: "Name is required" });
      const scopes = Array.isArray(req.body?.scopes) ? req.body.scopes.map(String) : [];
      const { createApiKey } = await import("./services/api-keys.js");
      const { key, record } = await createApiKey(user.id, name, scopes);
      // Return the plaintext key ONCE — it cannot be retrieved again.
      res.status(201).json({
        key,
        id: record.id,
        name: record.name,
        keyPrefix: record.keyPrefix,
        scopes: record.scopes,
        createdAt: record.createdAt,
      });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  reg("delete", "/api/api-keys/:id"); app.delete("/api/api-keys/:id", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      if (!(await isManagerUserWithTeams(user))) return res.status(403).json({ message: "Only admins and team leads can revoke API keys" });
      const { revokeApiKey } = await import("./services/api-keys.js");
      const ok = await revokeApiKey(parseInt(req.params.id), user.id);
      if (!ok) return res.status(404).json({ message: "API key not found" });
      res.json({ ok: true });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // ── First-sign-in tutorial (0098): server-side tour state ──────────────────
  reg("post", "/api/auth/tour/complete"); app.post("/api/auth/tour/complete", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      await db.execute(sql`UPDATE users SET tour_completed_at = now() WHERE id = ${user.id}`);
      res.json({ ok: true });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("post", "/api/auth/tour/skip"); app.post("/api/auth/tour/skip", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      await db.execute(sql`UPDATE users SET tour_skipped_at = now() WHERE id = ${user.id}`);
      res.json({ ok: true });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  // ---- In-app browser proxy: strips iframe-blocking headers ----
  const proxyRateLimit = new Map<number, { count: number; resetAt: number }>();
  reg("get", "/api/playground/proxy"); app.get("/api/playground/proxy", async (req, res) => {
    try {
      const userId = req.session.userId;
      if (!userId) return res.status(401).json({ message: "Unauthorized" });

      const rawUrl = String(req.query.url || "").trim();
      if (!rawUrl) return res.status(400).json({ message: "Missing url parameter" });

      let target: URL;
      try {
        const withProto = rawUrl.startsWith("http://") || rawUrl.startsWith("https://") ? rawUrl : `https://${rawUrl}`;
        target = new URL(withProto);
      } catch {
        return res.status(400).json({ message: "Invalid URL" });
      }

      if (target.protocol !== "http:" && target.protocol !== "https:") {
        return res.status(400).json({ message: "Only http/https URLs allowed" });
      }

      // Block private / internal addresses
      const host = target.hostname.toLowerCase();
      if (
        host === "localhost" ||
        host === "127.0.0.1" ||
        host === "::1" ||
        host.startsWith("192.168.") ||
        host.startsWith("10.") ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
        host.endsWith(".local") ||
        host.endsWith(".internal")
      ) {
        return res.status(403).json({ message: "Private/internal URLs are not allowed" });
      }

      // Rate limit: 60 requests per minute per user
      const now = Date.now();
      const entry = proxyRateLimit.get(userId);
      if (entry && entry.resetAt > now) {
        if (entry.count >= 60) {
          return res.status(429).json({ message: "Rate limit exceeded. Try again shortly." });
        }
        entry.count++;
      } else {
        proxyRateLimit.set(userId, { count: 1, resetAt: now + 60_000 });
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12_000);

      let upstream: Response;
      try {
        upstream = await fetch(target.toString(), {
          signal: controller.signal,
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
          },
          redirect: "follow",
        });
      } catch (e: any) {
        clearTimeout(timeout);
        const detail = e?.name === "AbortError" ? "Request timed out" : String(e?.message || e);
        return res.status(502).json({ message: "Could not reach the target site", detail });
      }
      clearTimeout(timeout);

      // Strip iframe-blocking headers
      const responseHeaders = new Headers();
      const skip = new Set([
        "x-frame-options",
        "content-security-policy",
        "content-security-policy-report-only",
        "x-content-security-policy",
        "x-webkit-csp",
      ]);
      for (const [key, value] of upstream.headers.entries()) {
        if (!skip.has(key.toLowerCase())) {
          responseHeaders.set(key, value);
        }
      }

      // Add permissive headers for our iframe
      responseHeaders.set("X-Frame-Options", "ALLOWALL");
      responseHeaders.set("Content-Security-Policy", "frame-ancestors *");
      responseHeaders.set("Access-Control-Allow-Origin", "*");

      const contentType = upstream.headers.get("content-type") || "";
      res.status(upstream.status);
      const base = target.origin + target.pathname;

      // For HTML responses: rewrite relative URLs to absolute
      if (contentType.includes("text/html")) {
        let html = await upstream.text();
        // Rewrite relative src/href to absolute using the target origin
        html = html.replace(/(src|href)=["'](?![a-z]+:)([^"']+)["']/gi, (match, attr, rel) => {
          try {
            const abs = new URL(rel, base).toString();
            return `${attr}="${abs}"`;
          } catch {
            return match;
          }
        });
        // Rewrite same-origin absolute src/href attributes through the proxy
        // (e.g., <link rel="preload" href="https://duckduckgo.com/static-assets/font/...">)
        const targetHostname = target.hostname;
        html = html.replace(/(src|href)=(['"])(https?:\/\/[^'"]+)/gi, (match, attr, q, absUrl) => {
          try {
            const u = new URL(absUrl);
            if (u.hostname === targetHostname || u.hostname.endsWith("." + targetHostname)) {
              const proxied = `/api/playground/proxy?url=${encodeURIComponent(absUrl)}`;
              return `${attr}=${q}${proxied}${q}`;
            }
            return match;
          } catch {
            return match;
          }
        });
        // Rewrite font-face and other CSS url() references through the proxy
        // Handles both relative URLs and absolute URLs pointing to the target origin
        const targetOrigin = target.origin;
        html = html.replace(/url\((['"]?)((?!data:|blob:)[^)'"]+?)\)/gi, (match, q, rawUrl) => {
          try {
            const abs = new URL(rawUrl.trim(), base).toString();
            // Route same-origin resources through the proxy to avoid CORS issues
            if (abs.startsWith(targetOrigin) || !rawUrl.trim().startsWith('http')) {
              const proxied = `/api/playground/proxy?url=${encodeURIComponent(abs)}`;
              return `url(${q}${proxied}${q})`;
            }
            return match;
          } catch {
            return match;
          }
        });
        // Inject <base> tag to help relative URLs resolve
        const baseTag = `<base href="${target.origin}/">`;
        if (html.includes("<head")) {
          html = html.replace(/<head([^>]*)>/i, `<head$1>${baseTag}`);
        } else {
          html = baseTag + html;
        }
        responseHeaders.set("Content-Type", "text/html; charset=utf-8");
        responseHeaders.delete("content-length");
        res.send(html);
      } else if (contentType.includes("text/css")) {
        // Rewrite CSS url() references to go through the proxy for same-origin resources
        let css = await upstream.text();
        const cssHostname = target.hostname;
        css = css.replace(/url\((['"]?)((?!data:|blob:)[^)'"]+?)\)/gi, (match, q, rawUrl) => {
          try {
            const abs = new URL(rawUrl.trim(), base).toString();
            const absUrl = new URL(abs);
            if (absUrl.hostname === cssHostname || absUrl.hostname.endsWith("." + cssHostname)) {
              const proxied = `/api/playground/proxy?url=${encodeURIComponent(abs)}`;
              return `url(${q}${proxied}${q})`;
            }
            return match;
          } catch {
            return match;
          }
        });
        for (const [key, value] of responseHeaders.entries()) {
          if (!skip.has(key.toLowerCase())) res.setHeader(key, value);
        }
        res.setHeader("Content-Type", "text/css; charset=utf-8");
        res.send(css);
      } else {
        // Stream non-HTML responses (images, JS, etc.)
        for (const [key, value] of responseHeaders.entries()) {
          if (!skip.has(key.toLowerCase())) res.setHeader(key, value);
        }
        const buffer = Buffer.from(await upstream.arrayBuffer());
        res.send(buffer);
      }
    } catch (error: any) {
      res.status(500).json({ message: "Proxy error", detail: String(error?.message || error) });
    }
  });

  reg("get", "/api/playground/sessions/recent"); app.get("/api/playground/sessions/recent", async (req, res) => {
    try {
      const userId = req.session.userId;
      if (!userId) return res.status(401).json({ message: "Unauthorized" });
      const limit = req.query.limit ? parseInt(req.query.limit as string) : 20;
      const items = await storage.listRecentPlaygroundPropertySessions(userId, limit);
      res.json(items);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("post", "/api/playground/sessions/open"); app.post("/api/playground/sessions/open", async (req, res) => {
    try {
      const userId = req.session.userId;
      if (!userId) return res.status(401).json({ message: "Unauthorized" });
      const address = String(req.body?.address || "").trim();
      if (!address) return res.status(400).json({ message: "address is required" });
      const addressKey = toAddressKey(address);
      const leadIdRaw = req.body?.leadId;
      const propertyIdRaw = req.body?.propertyId;
      const leadId = typeof leadIdRaw === "number" ? leadIdRaw : typeof leadIdRaw === "string" ? parseInt(leadIdRaw, 10) : NaN;
      const propertyId = typeof propertyIdRaw === "number" ? propertyIdRaw : typeof propertyIdRaw === "string" ? parseInt(propertyIdRaw, 10) : NaN;
      const existing = await storage.getPlaygroundPropertySessionByAddressKey(userId, addressKey);
      const throttleMs = 10 * 60 * 1000;
      const prevOpenedAt = existing?.lastOpenedAt ? new Date(existing.lastOpenedAt as any) : null;
      const shouldLogOpen = !existing || !prevOpenedAt || Date.now() - prevOpenedAt.getTime() > throttleMs;
      let session = existing;
      if (!existing) {
        const validated = insertPlaygroundPropertySessionSchema.parse({
          address,
          addressKey,
          leadId: Number.isFinite(leadId) ? leadId : undefined,
          propertyId: Number.isFinite(propertyId) ? propertyId : undefined,
          tagsJson: "[]",
          bookmarksJson: "[]",
          checklistJson: "{}",
          notesJson: "[]",
          underwritingJson: "{}",
          createdBy: userId,
          updatedBy: userId,
          lastOpenedBy: userId,
          lastOpenedAt: new Date(),
        } as any);
        session = await storage.createPlaygroundPropertySession(validated as any);
      } else {
        const nextLeadId = Number.isFinite(leadId) ? leadId : undefined;
        const nextPropertyId = Number.isFinite(propertyId) ? propertyId : undefined;
        session = await storage.updatePlaygroundPropertySession(existing.id, {
          lastOpenedBy: userId,
          lastOpenedAt: new Date(),
          updatedBy: userId,
          leadId: existing.leadId ?? nextLeadId,
          propertyId: existing.propertyId ?? nextPropertyId,
        } as any);
      }
      if (shouldLogOpen) {
        await storage.createGlobalActivity({
          userId,
          action: "playground_open_session",
          description: `Opened playground session: ${session.address}`,
          metadata: JSON.stringify({ playgroundSessionId: session.id, address: session.address, leadId: session.leadId ?? null, propertyId: session.propertyId ?? null }),
        } as any);
      }
      res.json(session);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("post", "/api/playground/sessions"); app.post("/api/playground/sessions", async (req, res) => {
    try {
      const userId = req.session.userId;
      if (!userId) return res.status(401).json({ message: "Unauthorized" });
      const address = String(req.body?.address || "").trim();
      if (!address) return res.status(400).json({ message: "address is required" });
      const addressKey = toAddressKey(address);
      const validated = insertPlaygroundPropertySessionSchema.parse({
        ...req.body,
        address,
        addressKey,
        tagsJson: typeof req.body?.tagsJson === "string" ? req.body.tagsJson : "[]",
        bookmarksJson: typeof req.body?.bookmarksJson === "string" ? req.body.bookmarksJson : "[]",
        checklistJson: typeof req.body?.checklistJson === "string" ? req.body.checklistJson : "{}",
        notesJson: typeof req.body?.notesJson === "string" ? req.body.notesJson : "[]",
        underwritingJson: typeof req.body?.underwritingJson === "string" ? req.body.underwritingJson : "{}",
        createdBy: userId,
        updatedBy: userId,
        lastOpenedBy: userId,
        lastOpenedAt: new Date(),
      } as any);
      const session = await storage.createPlaygroundPropertySession(validated as any);
      res.status(201).json(session);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("get", "/api/playground/sessions/:id"); app.get("/api/playground/sessions/:id", async (req, res) => {
    try {
      const userId = req.session.userId;
      if (!userId) return res.status(401).json({ message: "Unauthorized" });
      const id = parseInt(req.params.id);
      const session = await storage.getPlaygroundPropertySessionById(id);
      if (!session) return res.status(404).json({ message: "Not found" });
      res.json(session);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("patch", "/api/playground/sessions/:id"); app.patch("/api/playground/sessions/:id", async (req, res) => {
    try {
      const userId = req.session.userId;
      if (!userId) return res.status(401).json({ message: "Unauthorized" });
      const user = await storage.getUserById(userId);
      if (!user) return res.status(401).json({ message: "Unauthorized" });
      const id = parseInt(req.params.id);
      const leadIdRaw = req.body?.leadId;
      const propertyIdRaw = req.body?.propertyId;
      const leadId = typeof leadIdRaw === "number" ? leadIdRaw : typeof leadIdRaw === "string" ? parseInt(leadIdRaw, 10) : undefined;
      const propertyId = typeof propertyIdRaw === "number" ? propertyIdRaw : typeof propertyIdRaw === "string" ? parseInt(propertyIdRaw, 10) : undefined;
      const assignedToRaw = req.body?.assignedTo;
      const assignedTo =
        typeof assignedToRaw === "number" ? assignedToRaw : typeof assignedToRaw === "string" ? parseInt(assignedToRaw, 10) : undefined;
      if (typeof assignedTo === "number" && Number.isFinite(assignedTo)) {
        const ok = await requireAssigneeInActiveTeam(req, res, user, assignedTo);
        if (!ok) return;
      }
      const underwritingJson =
        typeof req.body?.underwritingJson === "string"
          ? req.body.underwritingJson
          : req.body?.underwritingJson && typeof req.body.underwritingJson === "object"
            ? JSON.stringify(req.body.underwritingJson)
            : undefined;
      const patch: any = {
        propertyType: req.body?.propertyType,
        currentUrl: req.body?.currentUrl,
        tagsJson: req.body?.tagsJson,
        bookmarksJson: req.body?.bookmarksJson,
        checklistJson: req.body?.checklistJson,
        notesJson: req.body?.notesJson,
        underwritingJson,
        leadId: typeof leadId === "number" && Number.isFinite(leadId) ? leadId : undefined,
        propertyId: typeof propertyId === "number" && Number.isFinite(propertyId) ? propertyId : undefined,
        assignedTo,
        assignmentDueAt: req.body?.assignmentDueAt === null ? null : req.body?.assignmentDueAt ? new Date(req.body.assignmentDueAt) : undefined,
        assignmentStatus: req.body?.assignmentStatus,
        updatedBy: userId,
      };
      Object.keys(patch).forEach((k) => patch[k] === undefined && delete patch[k]);
      const updated = await storage.updatePlaygroundPropertySession(id, patch);
      const fields = Object.keys(patch).filter((f) => f !== "updatedBy");
      let action = "playground_update_session";
      if (fields.includes("notesJson")) action = "playground_notes_saved";
      else if (fields.includes("bookmarksJson")) action = "playground_bookmarks_updated";
      else if (fields.includes("underwritingJson")) action = "playground_underwriting_saved";
      else if (fields.includes("assignedTo") || fields.includes("assignmentDueAt") || fields.includes("assignmentStatus")) action = "playground_assignment_updated";
      await storage.createGlobalActivity({
        userId,
        action,
        description: `Playground: ${updated.address}`,
        metadata: JSON.stringify({
          playgroundSessionId: updated.id,
          leadId: updated.leadId,
          propertyId: updated.propertyId,
          fields,
        }),
      } as any);
      res.json(updated);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("post", "/api/playground/sessions/:id/send"); app.post("/api/playground/sessions/:id/send", async (req, res) => {
    try {
      const userId = req.session.userId;
      if (!userId) return res.status(401).json({ message: "Unauthorized" });
      const id = parseInt(req.params.id);
      const session = await storage.getPlaygroundPropertySessionById(id);
      if (!session) return res.status(404).json({ message: "Not found" });
      const targetType = String(req.body?.targetType || "").trim();
      const targetIdRaw = req.body?.targetId;
      const targetId = typeof targetIdRaw === "number" ? targetIdRaw : typeof targetIdRaw === "string" ? parseInt(targetIdRaw, 10) : NaN;
      if (targetType !== "lead" && targetType !== "opportunity") {
        return res.status(400).json({ message: "Invalid targetType" });
      }
      if (!Number.isFinite(targetId) || targetId <= 0) {
        return res.status(400).json({ message: "Invalid targetId" });
      }
      let underwriting: any = {};
      let bookmarks: any[] = [];
      let notes: any[] = [];
      try {
        underwriting = session.underwritingJson ? JSON.parse(session.underwritingJson as any) : {};
      } catch {}
      try {
        bookmarks = session.bookmarksJson ? JSON.parse(session.bookmarksJson as any) : [];
      } catch {}
      try {
        notes = session.notesJson ? JSON.parse(session.notesJson as any) : [];
      } catch {}
      const lines: string[] = [];
      lines.push("Playground Research");
      lines.push(`Address: ${session.address}`);
      const safeNumber = (v: any): number | null => {
        if (typeof v === "number" && Number.isFinite(v)) return v;
        if (typeof v === "string") {
          const n = parseFloat(String(v).replace(/[^\d.\-]/g, ""));
          return Number.isFinite(n) ? n : null;
        }
        return null;
      };
      const money = (v: any): string | null => {
        const n = safeNumber(v);
        if (n === null) return null;
        return `$${Math.round(n).toLocaleString("en-US")}`;
      };
      const uwLines: string[] = [];
      const uwV1 = underwritingSchemaV1.safeParse(underwriting);
      if (uwV1.success) {
        const uw = uwV1.data;
        const arvDerived = computeArvFromComps({ subjectSqft: null, comps: uw.comps }).value;
        const arv = money(uw.arv.value ?? arvDerived);
        const repairs = computeRepairTotal(uw.repairs);
        const repairsFmt = repairs > 0 ? `$${Math.round(repairs).toLocaleString("en-US")}` : null;
        const mao = money(uw.dealMath.mao);
        const offerMin = money(uw.dealMath.offerMin);
        const offerMax = money(uw.dealMath.offerMax);
        const offerTarget = money((uw.dealMath as any)?.offerTarget);
        const strategy = uw.snapshot.strategy ? `Strategy: ${uw.snapshot.strategy}` : null;
        if (arv) uwLines.push(`ARV: ${arv}`);
        if (repairsFmt) uwLines.push(`Repairs: ${repairsFmt}`);
        if (mao) uwLines.push(`MAO: ${mao}`);
        if (offerMin || offerMax) uwLines.push(`Offer Range: ${offerMin || "?"} - ${offerMax || "?"}`);
        if (offerTarget) uwLines.push(`Target Offer: ${offerTarget}`);
        if (strategy) uwLines.push(strategy);
        const outputs = (uw as any)?.outputs || {};
        const profit = money(outputs.profit);
        const cashToClose = money(outputs.cashToClose);
        const noiAnnual = money(outputs.noiAnnual);
        const cashflowAnnual = money(outputs.cashflowAnnual);
        const pct = (v: any): string | null => {
          const n = safeNumber(v);
          if (n === null) return null;
          return `${n.toFixed(1)}%`;
        };
        const roiPct = pct(outputs.roiPct);
        const capRatePct = pct(outputs.capRatePct);
        const cocPct = pct(outputs.cashOnCashPct);
        const dscr = (() => {
          const n = safeNumber(outputs.dscr);
          return n === null ? null : n.toFixed(2);
        })();
        if (uw.snapshot.strategy === "rental") {
          if (noiAnnual) uwLines.push(`NOI (annual): ${noiAnnual}`);
          if (capRatePct) uwLines.push(`Cap Rate: ${capRatePct}`);
          if (cashflowAnnual) uwLines.push(`Cashflow (annual): ${cashflowAnnual}`);
          if (cocPct) uwLines.push(`Cash-on-Cash: ${cocPct}`);
          if (dscr) uwLines.push(`DSCR: ${dscr}`);
          if (cashToClose) uwLines.push(`Cash to Close: ${cashToClose}`);
        } else {
          if (profit) uwLines.push(`Profit: ${profit}`);
          if (roiPct) uwLines.push(`ROI: ${roiPct}`);
          if (cashToClose) uwLines.push(`Cash to Close: ${cashToClose}`);
        }
      } else {
        const arv = money(underwriting.arv);
        const repairs = money(underwriting.repairEstimate);
        const mao = money(underwriting.mao);
        const offerMin = money(underwriting.offerMin);
        const offerMax = money(underwriting.offerMax);
        const exit = typeof underwriting.exitStrategy === "string" && underwriting.exitStrategy.trim() ? `Exit Strategy: ${underwriting.exitStrategy}` : null;
        if (arv) uwLines.push(`ARV: ${arv}`);
        if (repairs) uwLines.push(`Repairs: ${repairs}`);
        if (mao) uwLines.push(`MAO: ${mao}`);
        if (offerMin || offerMax) uwLines.push(`Offer Range: ${offerMin || "?"} - ${offerMax || "?"}`);
        if (exit) uwLines.push(exit);
      }
      if (uwLines.length) {
        lines.push("");
        lines.push("Underwriting");
        lines.push(...uwLines);
      }
      const topLinks = Array.isArray(bookmarks) ? bookmarks.slice(0, 8) : [];
      if (topLinks.length) {
        lines.push("");
        lines.push("Links");
        topLinks.forEach((b: any) => {
          const name = String(b?.name || "Link").trim();
          const url = String(b?.url || "").trim();
          if (url) lines.push(`- ${name}: ${url}`);
        });
      }
      const topNotes = Array.isArray(notes) ? notes.slice(0, 5) : [];
      if (topNotes.length) {
        lines.push("");
        lines.push("Notes");
        topNotes.forEach((n: any) => {
          const title = String(n?.title || "Note").trim();
          const content = String(n?.content || "").trim();
          const preview = content.length > 220 ? `${content.slice(0, 220)}…` : content;
          lines.push(`- ${title}${preview ? `: ${preview.replace(/\s+/g, " ")}` : ""}`);
        });
      }
      const stamped = `[${new Date().toLocaleString()}]\n${lines.join("\n")}`;
      let leadId: number | null = session.leadId ?? null;
      let propertyId: number | null = session.propertyId ?? null;
      if (targetType === "lead") {
        const lead = await storage.getLeadById(targetId);
        if (!lead) return res.status(404).json({ message: "Lead not found" });
        const existing = String(lead.notes || "").trim();
        const nextNotes = existing ? `${existing}\n\n${stamped}` : stamped;
        await storage.updateLead(lead.id, { notes: nextNotes } as any);
        leadId = lead.id;
      } else {
        const property = await storage.getPropertyById(targetId);
        if (!property) return res.status(404).json({ message: "Opportunity not found" });
        const existing = String(property.notes || "").trim();
        const nextNotes = existing ? `${existing}\n\n${stamped}` : stamped;
        await storage.updateProperty(property.id, { notes: nextNotes } as any);
        propertyId = property.id;
      }
      const updated = await storage.updatePlaygroundPropertySession(session.id, {
        leadId,
        propertyId,
        updatedBy: userId,
      } as any);
      await storage.createGlobalActivity({
        userId,
        action: "playground_send_to_crm",
        description: `Sent playground research to ${targetType}: ${targetId}`,
        metadata: JSON.stringify({ playgroundSessionId: session.id, targetType, targetId, leadId, propertyId }),
      } as any);
      res.json({ session: updated, leadId, propertyId });
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("delete", "/api/playground/sessions/:id"); app.delete("/api/playground/sessions/:id", async (req, res) => {
    try {
      const userId = req.session.userId;
      if (!userId) return res.status(401).json({ message: "Unauthorized" });
      const id = parseInt(req.params.id);
      await storage.deletePlaygroundPropertySession(id);
      res.json({ message: "Deleted" });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("get", "/api/underwriting/templates"); app.get("/api/underwriting/templates", async (req, res) => {
    try {
      const userId = req.session.userId;
      if (!userId) return res.status(401).json({ message: "Unauthorized" });
      const templates = await storage.getUnderwritingTemplates(userId);
      const mapped = templates.map((t: any) => {
        let config: any = {};
        try {
          config = underwritingTemplateConfigSchema.parse(t.configJson ? JSON.parse(t.configJson) : {});
        } catch {
          config = underwritingTemplateConfigSchema.parse({});
        }
        return { id: t.id, name: t.name, config };
      });
      res.json(mapped);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("post", "/api/underwriting/templates"); app.post("/api/underwriting/templates", async (req, res) => {
    try {
      const userId = req.session.userId;
      if (!userId) return res.status(401).json({ message: "Unauthorized" });
      const name = String(req.body?.name || "").trim();
      if (!name) return res.status(400).json({ message: "name is required" });
      const configInput = req.body?.config;
      const configObj = typeof configInput === "string" ? JSON.parse(configInput || "{}") : configInput && typeof configInput === "object" ? configInput : {};
      const config = underwritingTemplateConfigSchema.parse(configObj);
      const validated = insertUnderwritingTemplateSchema.parse({
        userId,
        name,
        configJson: JSON.stringify(config),
      } as any);
      const created = await storage.createUnderwritingTemplate(validated as any);
      res.status(201).json({ id: created.id, name: created.name, config });
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("patch", "/api/underwriting/templates/:id"); app.patch("/api/underwriting/templates/:id", async (req, res) => {
    try {
      const userId = req.session.userId;
      if (!userId) return res.status(401).json({ message: "Unauthorized" });
      const id = parseInt(req.params.id);
      const existing = await storage.getUnderwritingTemplateById(id);
      if (!existing || existing.userId !== userId) return res.status(404).json({ message: "Not found" });
      const patch: any = {};
      if (req.body?.name !== undefined) {
        const name = String(req.body?.name || "").trim();
        if (!name) return res.status(400).json({ message: "name is required" });
        patch.name = name;
      }
      if (req.body?.config !== undefined) {
        const configInput = req.body?.config;
        const configObj = typeof configInput === "string" ? JSON.parse(configInput || "{}") : configInput && typeof configInput === "object" ? configInput : {};
        const config = underwritingTemplateConfigSchema.parse(configObj);
        patch.configJson = JSON.stringify(config);
      }
      if (!Object.keys(patch).length) return res.json({ id: existing.id, name: existing.name, config: JSON.parse(existing.configJson || "{}") });
      const updated = await storage.updateUnderwritingTemplate(id, patch);
      const config = underwritingTemplateConfigSchema.parse(updated.configJson ? JSON.parse(updated.configJson) : {});
      res.json({ id: updated.id, name: updated.name, config });
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("delete", "/api/underwriting/templates/:id"); app.delete("/api/underwriting/templates/:id", async (req, res) => {
    try {
      const userId = req.session.userId;
      if (!userId) return res.status(401).json({ message: "Unauthorized" });
      const id = parseInt(req.params.id);
      const existing = await storage.getUnderwritingTemplateById(id);
      if (!existing || existing.userId !== userId) return res.status(404).json({ message: "Not found" });
      await storage.deleteUnderwritingTemplate(id);
      res.json({ message: "Deleted" });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("post", "/api/underwriting/ai"); app.post("/api/underwriting/ai", async (req, res) => {
    const schema = z.object({
      subject: z.object({ sqft: z.number().finite().optional().nullable() }).default({}),
      underwriting: underwritingSchemaV1,
      templateConfig: underwritingTemplateConfigSchema.optional(),
    });
    try {
      const userId = req.session.userId;
      if (!userId) return res.status(401).json({ message: "Unauthorized" });
      const payload = schema.parse(req.body || {});
      const repairsTotal = computeRepairTotal(payload.underwriting.repairs);
      const arvFromComps = computeArvFromComps({ subjectSqft: payload.subject.sqft ?? null, comps: payload.underwriting.comps });
      const template = payload.templateConfig ?? underwritingTemplateConfigSchema.parse({});
      const arv = payload.underwriting.arv.value ?? arvFromComps.value ?? 0;
      const dealMath = arv > 0 ? computeDealMath({ arv, repairs: repairsTotal, assumptions: payload.underwriting.assumptions, targetDiscountPct: template.targetDiscountPct }) : payload.underwriting.dealMath;
      res.json({
        suggestedArvRange: { low: arvFromComps.low, high: arvFromComps.high, value: arvFromComps.value },
        repairsTotal,
        dealMath,
        notes: {
          summary: "Suggested values are computed from selected comps and your template assumptions.",
        },
      });
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  // LEADS ENDPOINTS
  reg("get", "/api/dashboard/summary"); app.get("/api/dashboard/summary", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;

      // Single query for all dashboard KPIs — replaces 9 separate frontend queries
      const [leadStats, propStats, contractStats, taskStats] = await Promise.all([
        db.execute(sql`
          SELECT
            COUNT(*)::int as total,
            COUNT(*) FILTER (WHERE status IN ('new','contacted','qualified'))::int as active,
            COUNT(*) FILTER (WHERE archived_at IS NULL AND status NOT IN ('dead','voided','closed'))::int as unarchived
          FROM leads
        `),
        db.execute(sql`
          SELECT
            COUNT(*)::int as total,
            COUNT(*) FILTER (WHERE stage = 'closed')::int as closed
          FROM properties
        `),
        db.execute(sql`
          SELECT
            COUNT(*)::int as total,
            COUNT(*) FILTER (WHERE status IN ('draft','sent','executed'))::int as in_pipeline,
            COALESCE(SUM(
              CASE WHEN status IN ('draft','sent','executed')
              THEN COALESCE(
                NULLIF(regexp_replace(COALESCE(merge_data->>'assignmentFee', ''), '[^0-9.]', '', 'g'), '')::numeric,
                0
              ) ELSE 0 END
            ), 0)::numeric as pipeline_value
          FROM contract_documents
        `),
        db.execute(sql`
          SELECT COUNT(*)::int as pending
          FROM tasks
          WHERE status = 'pending' AND (assigned_to = ${user.id} OR assigned_to IS NULL)
        `),
      ]);

      res.json({
        leads: {
          total: Number(leadStats.rows?.[0]?.total || 0),
          active: Number(leadStats.rows?.[0]?.active || 0),
        },
        properties: {
          total: Number(propStats.rows?.[0]?.total || 0),
          closed: Number(propStats.rows?.[0]?.closed || 0),
        },
        contracts: {
          total: Number(contractStats.rows?.[0]?.total || 0),
          inPipeline: Number(contractStats.rows?.[0]?.in_pipeline || 0),
          pipelineValue: Number(contractStats.rows?.[0]?.pipeline_value || 0),
        },
        tasks: {
          pending: Number(taskStats.rows?.[0]?.pending || 0),
        },
      });
    } catch (error: any) {
      if (isDbConnectivityError(error)) {
        return res.status(503).json({ message: "Database is unavailable" });
      }
      res.status(500).json({ message: error.message });
    }
  });
  reg("get", "/api/dashboard/stats"); app.get("/api/dashboard/stats", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const cutoff = new Date();
      cutoff.setHours(0, 0, 0, 0);
      cutoff.setDate(cutoff.getDate() - 14);
      const leadCount = await db.execute(sql`
        select
          count(*)::int as active,
          count(*) filter (where last_touch_at is null or last_touch_at < ${cutoff.toISOString()})::int as stale
        from leads
        where archived_at is null and status not in ('dead','voided','closed')
      `);
      const staleTop = await db.execute(sql`
        select id, address, city, state, last_touch_at as "lastTouchAt"
        from leads
        where archived_at is null and status not in ('dead','voided','closed')
          and (last_touch_at is null or last_touch_at < ${cutoff.toISOString()})
        order by last_touch_at asc nulls first
        limit 5
      `);
      res.json({
        activeLeads: Number(leadCount.rows?.[0]?.active || 0),
        staleLeadsCount: Number(leadCount.rows?.[0]?.stale || 0),
        staleLeadsTop: staleTop.rows || [],
        windowDays: 14,
      });
    } catch (error: any) {
      if (isDbConnectivityError(error)) {
        return res.status(503).json({ message: "Database is unavailable" });
      }
      res.status(500).json({ message: error.message });
    }
  });
  reg("get", "/api/leads"); app.get("/api/leads", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const { limit, offset } = parseLimitOffset(req.query);
      const q = typeof req.query?.q === "string" ? req.query.q : "";
      const status = typeof req.query?.status === "string" ? req.query.status : "";
      const statusInRaw = typeof req.query?.statusIn === "string" ? req.query.statusIn : "";
      const statusIn = statusInRaw
        ? statusInRaw
            .split(",")
            .map((s) => s.trim())
            .filter((s) => !!s && s.length <= 50)
            .slice(0, 10)
        : undefined;
      const owner = typeof req.query?.owner === "string" ? req.query.owner : "";
      const zip = typeof req.query?.zip === "string" ? req.query.zip : "";
      const state = typeof req.query?.state === "string" ? req.query.state : "";
      const city = typeof req.query?.city === "string" ? req.query.city : "";
      const county = typeof req.query?.county === "string" ? req.query.county : "";
      const leadType = typeof req.query?.leadType === "string" ? req.query.leadType : "";
      const sourceRaw = typeof req.query?.source === "string" ? req.query.source : "";
      const assignedToRaw = typeof req.query?.assignedTo === "string" ? req.query.assignedTo : "";
      const assignedTo = assignedToRaw === "unassigned" ? "unassigned" : assignedToRaw ? parseInt(assignedToRaw, 10) : undefined;
      const tagsRaw = typeof req.query?.tags === "string" ? req.query.tags : "";
      const tags = tagsRaw ? tagsRaw.split(",").map((t) => t.trim()).filter(Boolean) : undefined;
      const tagsModeRaw = typeof req.query?.tagsMode === "string" ? req.query.tagsMode : "";
      const tagsMode = tagsModeRaw === "all" ? "all" : tagsModeRaw === "any" ? "any" : undefined;
      const contactPresenceRaw = typeof req.query?.contactPresence === "string" ? req.query.contactPresence : "";
      const contactPresence =
        contactPresenceRaw === "phone_only" || contactPresenceRaw === "email_only" || contactPresenceRaw === "both" || contactPresenceRaw === "none"
          ? (contactPresenceRaw as any)
          : undefined;
      const scoreMinRaw = typeof req.query?.scoreMin === "string" ? req.query.scoreMin : "";
      const scoreMaxRaw = typeof req.query?.scoreMax === "string" ? req.query.scoreMax : "";
      const scoreMin = scoreMinRaw ? Number(scoreMinRaw) : undefined;
      const scoreMax = scoreMaxRaw ? Number(scoreMaxRaw) : undefined;
      const archivedRaw = typeof req.query?.archived === "string" ? req.query.archived : "";
      const archived = archivedRaw === "exclude" || archivedRaw === "include" || archivedRaw === "only" ? (archivedRaw as any) : undefined;
      const hasNotesRaw = typeof req.query?.hasNotes === "string" ? req.query.hasNotes : "";
      const hasNotes = hasNotesRaw === "true" ? true : hasNotesRaw === "false" ? false : undefined;
      const noteUpdatedWithinDaysRaw = typeof req.query?.noteUpdatedWithinDays === "string" ? req.query.noteUpdatedWithinDays : "";
      const noteUpdatedWithinDays = noteUpdatedWithinDaysRaw ? parseInt(noteUpdatedWithinDaysRaw, 10) : undefined;
      const lastTouchFromRaw = typeof req.query?.lastTouchFrom === "string" ? req.query.lastTouchFrom : "";
      const lastTouchToRaw = typeof req.query?.lastTouchTo === "string" ? req.query.lastTouchTo : "";
      const nextFollowUpFromRaw = typeof req.query?.nextFollowUpFrom === "string" ? req.query.nextFollowUpFrom : "";
      const nextFollowUpToRaw = typeof req.query?.nextFollowUpTo === "string" ? req.query.nextFollowUpTo : "";
      const sortKey = typeof req.query?.sortKey === "string" ? (req.query.sortKey as any) : undefined;
      const sortDir = typeof req.query?.sortDir === "string" ? (req.query.sortDir as any) : undefined;
      let createdFrom: Date | undefined = undefined;
      let createdTo: Date | undefined = undefined;
      const createdFromRaw = typeof req.query?.createdFrom === "string" ? req.query.createdFrom : "";
      const createdToRaw = typeof req.query?.createdTo === "string" ? req.query.createdTo : "";
      if (createdFromRaw) {
        const d = new Date(createdFromRaw);
        if (!Number.isNaN(d.getTime())) createdFrom = d;
      }
      if (createdToRaw) {
        const d = new Date(createdToRaw);
        if (!Number.isNaN(d.getTime())) createdTo = d;
      }
      let lastTouchFrom: Date | undefined = undefined;
      let lastTouchTo: Date | undefined = undefined;
      let nextFollowUpFrom: Date | undefined = undefined;
      let nextFollowUpTo: Date | undefined = undefined;
      if (lastTouchFromRaw) {
        const d = new Date(lastTouchFromRaw);
        if (!Number.isNaN(d.getTime())) lastTouchFrom = d;
      }
      if (lastTouchToRaw) {
        const d = new Date(lastTouchToRaw);
        if (!Number.isNaN(d.getTime())) lastTouchTo = d;
      }
      if (nextFollowUpFromRaw) {
        const d = new Date(nextFollowUpFromRaw);
        if (!Number.isNaN(d.getTime())) nextFollowUpFrom = d;
      }
      if (nextFollowUpToRaw) {
        const d = new Date(nextFollowUpToRaw);
        if (!Number.isNaN(d.getTime())) nextFollowUpTo = d;
      }
      const { items, total } = await storage.listLeads({
        q,
        status,
        statusIn,
        owner,
        zip,
        state,
        city,
        county,
        leadType,
        source: sourceRaw.trim() || undefined,
        assignedTo: typeof assignedTo === "number" && Number.isFinite(assignedTo) ? assignedTo : assignedTo === "unassigned" ? "unassigned" : undefined,
        tags,
        tagsMode,
        contactPresence,
        scoreMin: typeof scoreMin === "number" && Number.isFinite(scoreMin) ? scoreMin : undefined,
        scoreMax: typeof scoreMax === "number" && Number.isFinite(scoreMax) ? scoreMax : undefined,
        archived,
        hasNotes,
        noteUpdatedWithinDays: typeof noteUpdatedWithinDays === "number" && Number.isFinite(noteUpdatedWithinDays) ? noteUpdatedWithinDays : undefined,
        lastTouchFrom,
        lastTouchTo,
        nextFollowUpFrom,
        nextFollowUpTo,
        sortKey,
        sortDir,
        createdFrom,
        createdTo,
        limit,
        offset,
      });
      const leadIds = items.map((l: any) => Number(l.id)).filter((n: any) => Number.isFinite(n) && n > 0);
      const propertyLinks = await storage.getPropertiesBySourceLeadIds(leadIds);
      const bySourceLeadId = new Map<number, number>();
      for (const row of propertyLinks) {
        const sid = Number((row as any).sourceLeadId);
        const pid = Number((row as any).id);
        if (Number.isFinite(sid) && Number.isFinite(pid)) bySourceLeadId.set(sid, pid);
      }
      let notesAgg: any[] = [];
      try {
        notesAgg = await storage.getLeadNotesAggByLeadIds(leadIds);
      } catch {
        notesAgg = [];
      }
      const notesAggByLeadId = new Map<number, any>();
      for (const r of notesAgg || []) {
        const lid = Number((r as any).leadId);
        if (!Number.isFinite(lid) || lid <= 0) continue;
        notesAggByLeadId.set(lid, r);
      }
      res.json({
        items: items.map((l: any) => {
          const agg = notesAggByLeadId.get(Number(l.id));
          return {
            ...l,
            linkedPropertyId: bySourceLeadId.get(Number(l.id)) ?? null,
            notesCount: agg ? Number((agg as any).notesCount || 0) : 0,
            lastNoteAt: agg?.lastNoteAt ?? null,
            lastNotePreview: agg?.lastNotePreview ?? null,
          };
        }),
        total,
      });
    } catch (error: any) {
      console.error("GET /api/leads failed:", error);
      if (isDbConnectivityError(error)) {
        return res.status(503).json({ message: "Database is unavailable" });
      }
      res.status(500).json({ message: error.message });
    }
  });
  reg("get", "/api/leads/:id"); app.get("/api/leads/:id", async (req, res) => {
    try {
      const authCtx = await requireAuth(req, res);
      if (!authCtx) return;
      const lead = await storage.getLeadById(parseInt(req.params.id)) as any;
      if (!lead) return res.status(404).json({ message: "Lead not found" });
      // P0 fix (audit IDOR): non-managers can only read leads assigned to them.
      if (!canAccessOwnedRecord(authCtx, lead)) return res.status(403).json({ message: "Forbidden" });
      res.json(lead);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("get", "/api/leads/:id/notes"); app.get("/api/leads/:id/notes", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const leadId = parseInt(req.params.id, 10);
      if (!Number.isFinite(leadId)) return res.status(400).json({ message: "Invalid lead id" });
      const limitRaw = typeof req.query?.limit === "string" ? req.query.limit : "";
      const limit = limitRaw ? parseInt(limitRaw, 10) : 50;
      const items = await storage.listLeadNotes(leadId, limit);
      res.json({ items });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("post", "/api/leads/:id/notes"); app.post("/api/leads/:id/notes", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const leadId = parseInt(req.params.id, 10);
      if (!Number.isFinite(leadId)) return res.status(400).json({ message: "Invalid lead id" });
      const body = z.object({ body: z.string().trim().min(1).max(20_000) }).parse(req.body || {});
      const note = await storage.createLeadNote({
        leadId,
        createdBy: user.id,
        body: body.body,
      } as any);
      const now = new Date();
      const lead = await storage.getLeadById(leadId);
      if (lead) {
        const existingNotes = String((lead as any).notes || "").trim();
        const appended = existingNotes ? `${existingNotes}\n\n${body.body}` : body.body;
        await storage.updateLead(leadId, { lastTouchAt: now, notes: appended } as any);
      } else {
        await storage.updateLead(leadId, { lastTouchAt: now } as any);
      }
      if (req.session.userId) {
        await storage.createGlobalActivity({
          userId: req.session.userId,
          action: "added_note",
          description: `Added note to lead`,
          metadata: JSON.stringify({ leadId, noteId: note.id }),
        });
      }
      res.status(201).json(note);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  // M15: note lifecycle - edit body, delete note.
  reg("patch", "/api/leads/notes/:noteId"); app.patch("/api/leads/notes/:noteId", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const noteId = parseInt(req.params.noteId, 10);
      if (!Number.isFinite(noteId)) return res.status(400).json({ message: "Invalid note id" });
      const body = z.object({ body: z.string().trim().min(1).max(20_000) }).parse(req.body || {});
      const existing = await storage.getLeadNoteById(noteId);
      if (!existing) return res.status(404).json({ message: "Note not found" });
      const note = await storage.updateLeadNote(noteId, body.body);
      res.json(note);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("delete", "/api/leads/notes/:noteId"); app.delete("/api/leads/notes/:noteId", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const noteId = parseInt(req.params.noteId, 10);
      if (!Number.isFinite(noteId)) return res.status(400).json({ message: "Invalid note id" });
      const existing = await storage.getLeadNoteById(noteId);
      if (!existing) return res.status(404).json({ message: "Note not found" });
      await storage.deleteLeadNote(noteId);
      res.status(204).end();
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("get", "/api/leads/views"); app.get("/api/leads/views", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const teams = await storage.getTeamsForUser(user.id);
      const teamIds = (teams || []).map((t: any) => Number(t.id)).filter((n: any) => Number.isFinite(n) && n > 0);
      const items = await storage.listSavedViews({ entityType: "lead", userId: user.id, teamIds });
      res.json({ items });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("post", "/api/leads/views"); app.post("/api/leads/views", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const payload = z
        .object({
          name: z.string().trim().min(1).max(120),
          visibility: z.enum(["private", "team", "link"]).default("private"),
          teamId: z.coerce.number().int().positive().optional().nullable(),
          configJson: z.any(),
        })
        .parse(req.body || {});
      let teamId: number | null = payload.teamId ?? null;
      if (payload.visibility === "team") {
        if (!teamId) teamId = await getOrInitActiveTeamId(req, user.id);
        if (!teamId) return res.status(400).json({ message: "No active team selected" });
        if (!user.isSuperAdmin) {
          const m = await storage.getTeamMemberByTeamAndUser(teamId, user.id);
          if (!m || String((m as any).status || "").toLowerCase() !== "active") return res.status(404).json({ message: "Not found" });
        }
      } else {
        teamId = null;
      }
      const shareToken = payload.visibility === "link" ? crypto.randomBytes(24).toString("hex") : null;
      const row = await storage.createSavedView({
        entityType: "lead",
        name: payload.name,
        ownerUserId: user.id,
        teamId,
        visibility: payload.visibility,
        shareToken,
        configJson: payload.configJson,
      } as any);
      res.status(201).json(row);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("patch", "/api/leads/views/:id"); app.patch("/api/leads/views/:id", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ message: "Invalid id" });
      const existing = await storage.getSavedViewById(id);
      if (!existing) return res.status(404).json({ message: "Not found" });
      if (!user.isSuperAdmin && Number((existing as any).ownerUserId) !== user.id) return res.status(404).json({ message: "Not found" });
      const payload = z
        .object({
          name: z.string().trim().min(1).max(120).optional(),
          configJson: z.any().optional(),
          visibility: z.enum(["private", "team", "link"]).optional(),
        })
        .parse(req.body || {});
      const nextVisibility = payload.visibility ?? (existing as any).visibility;
      const patch: any = {};
      if (typeof payload.name === "string") patch.name = payload.name;
      if (typeof payload.configJson !== "undefined") patch.configJson = payload.configJson;
      if (payload.visibility) patch.visibility = payload.visibility;
      if (nextVisibility === "link" && !(existing as any).shareToken) patch.shareToken = crypto.randomBytes(24).toString("hex");
      const row = await storage.updateSavedView(id, patch);
      res.json(row);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("delete", "/api/leads/views/:id"); app.delete("/api/leads/views/:id", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ message: "Invalid id" });
      const existing = await storage.getSavedViewById(id);
      if (!existing) return res.status(404).json({ message: "Not found" });
      if (!user.isSuperAdmin && Number((existing as any).ownerUserId) !== user.id) return res.status(404).json({ message: "Not found" });
      await storage.deleteSavedView(id);
      res.json({ ok: true });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("get", "/api/leads/views/by-token/:token"); app.get("/api/leads/views/by-token/:token", async (req, res) => {
    try {
      const token = String(req.params.token || "").trim();
      if (!token) return res.status(404).json({ message: "Not found" });
      const row = await storage.getSavedViewByShareToken(token);
      if (!row) return res.status(404).json({ message: "Not found" });
      res.json(row);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  const normalizeLeadListFilter = (raw: any) => {
    const getStr = (k: string) => (typeof raw?.[k] === "string" ? String(raw[k]) : "");
    const parseDate = (v: any) => {
      if (typeof v !== "string") return undefined;
      const d = new Date(v);
      if (!Number.isNaN(d.getTime())) return d;
      return undefined;
    };
    const parseNum = (v: any) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    };
    const tagsRaw = raw?.tags;
    const tags =
      typeof tagsRaw === "string"
        ? tagsRaw
            .split(",")
            .map((t: string) => t.trim())
            .filter(Boolean)
        : Array.isArray(tagsRaw)
          ? tagsRaw.map((t: any) => String(t || "").trim()).filter(Boolean)
          : undefined;
    const hasNotesRaw = raw?.hasNotes;
    const hasNotes = hasNotesRaw === true ? true : hasNotesRaw === false ? false : hasNotesRaw === "true" ? true : hasNotesRaw === "false" ? false : undefined;
    const assignedToRaw = raw?.assignedTo;
    const assignedTo =
      assignedToRaw === "unassigned"
        ? "unassigned"
        : typeof assignedToRaw === "number"
          ? assignedToRaw
          : typeof assignedToRaw === "string" && assignedToRaw.trim()
            ? parseInt(assignedToRaw, 10)
            : undefined;
    const archivedRaw = String(raw?.archived || "").trim();
    const archived = archivedRaw === "exclude" || archivedRaw === "include" || archivedRaw === "only" ? archivedRaw : undefined;
    const tagsModeRaw = String(raw?.tagsMode || "").trim();
    const tagsMode = tagsModeRaw === "all" || tagsModeRaw === "any" ? tagsModeRaw : undefined;
    const contactPresenceRaw = String(raw?.contactPresence || "").trim();
    const contactPresence =
      contactPresenceRaw === "phone_only" || contactPresenceRaw === "email_only" || contactPresenceRaw === "both" || contactPresenceRaw === "none"
        ? contactPresenceRaw
        : undefined;
    const sortKey = typeof raw?.sortKey === "string" ? raw.sortKey : undefined;
    const sortDir = raw?.sortDir === "asc" ? "asc" : raw?.sortDir === "desc" ? "desc" : undefined;
    return {
      q: getStr("query") || getStr("q"),
      status: getStr("status"),
      owner: getStr("owner"),
      zip: getStr("zip"),
      state: getStr("state"),
      city: getStr("city"),
      county: getStr("county"),
      leadType: getStr("leadType"),
      assignedTo: Number.isFinite(assignedTo as any) ? (assignedTo as any) : assignedTo === "unassigned" ? "unassigned" : undefined,
      tags,
      tagsMode,
      contactPresence,
      scoreMin: parseNum(raw?.scoreMin),
      scoreMax: parseNum(raw?.scoreMax),
      archived,
      hasNotes,
      noteUpdatedWithinDays: parseNum(raw?.noteUpdatedWithinDays),
      lastTouchFrom: parseDate(raw?.lastTouchFrom),
      lastTouchTo: parseDate(raw?.lastTouchTo),
      nextFollowUpFrom: parseDate(raw?.nextFollowUpFrom),
      nextFollowUpTo: parseDate(raw?.nextFollowUpTo),
      createdFrom: parseDate(raw?.createdFrom),
      createdTo: parseDate(raw?.createdTo),
      sortKey,
      sortDir,
    };
  };
  reg("post", "/api/leads/bulk/preview"); app.post("/api/leads/bulk/preview", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const payload = z
        .object({
          selectionScope: z.enum(["explicit", "all_filtered"]),
          leadIds: z.array(z.coerce.number().int().positive()).optional(),
          filter: z.record(z.any()).optional(),
          action: z.string().trim().min(1).max(80),
          params: z.record(z.any()).optional(),
        })
        .parse(req.body || {});
      const allowedAssignedToUserIds = user.isSuperAdmin
        ? undefined
        : await (async () => {
            const teamId = await getOrInitActiveTeamId(req, user.id);
            if (!teamId) return [user.id];
            const members = await storage.getTeamMembers(teamId);
            return (members || [])
              .filter((m: any) => String(m.status || "").toLowerCase() === "active")
              .map((m: any) => Number(m.userId))
              .filter((n: any) => Number.isFinite(n) && n > 0);
          })();
      if (payload.selectionScope === "explicit") {
        const ids = (payload.leadIds || []).map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0);
        if (!ids.length) return res.json({ totalTargets: 0, validLeadIds: [] });
        const whereAllowed =
          allowedAssignedToUserIds && allowedAssignedToUserIds.length
            ? sql`AND (assigned_to IS NULL OR assigned_to IN (${sql.join(allowedAssignedToUserIds.map((id) => sql`${id}`), sql`,`)}))`
            : sql``;
        const rows: any = await db.execute(sql`
          SELECT id
          FROM leads
          WHERE id IN (${sql.join(ids.map((id) => sql`${id}`), sql`,`)})
          ${whereAllowed}
        `);
        const validLeadIds = ((rows as any).rows || []).map((r: any) => Number(r.id)).filter((n: any) => Number.isFinite(n) && n > 0);
        return res.json({ totalTargets: validLeadIds.length, validLeadIds });
      }
      const f = normalizeLeadListFilter(payload.filter || {});
      const { total } = await storage.listLeads({
        ...(f as any),
        allowedAssignedToUserIds,
        limit: 1,
        offset: 0,
      });
      res.json({ totalTargets: total });
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("post", "/api/leads/bulk/jobs"); app.post("/api/leads/bulk/jobs", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const payload = z
        .object({
          selectionScope: z.enum(["explicit", "all_filtered"]),
          leadIds: z.array(z.coerce.number().int().positive()).optional(),
          filter: z.record(z.any()).optional(),
          action: z.enum(["set_status", "assign", "archive", "unarchive", "export"]),
          params: z.record(z.any()).optional(),
        })
        .parse(req.body || {});
      const allowedAssignedToUserIds = user.isSuperAdmin
        ? undefined
        : await (async () => {
            const teamId = await getOrInitActiveTeamId(req, user.id);
            if (!teamId) return [user.id];
            const members = await storage.getTeamMembers(teamId);
            return (members || [])
              .filter((m: any) => String(m.status || "").toLowerCase() === "active")
              .map((m: any) => Number(m.userId))
              .filter((n: any) => Number.isFinite(n) && n > 0);
          })();
      const job = await storage.createLeadBulkActionJob({
        createdBy: user.id,
        status: "queued",
        action: payload.action,
        selectionScope: payload.selectionScope,
        leadIds: payload.selectionScope === "explicit" ? payload.leadIds || [] : null,
        filterJson: payload.selectionScope === "all_filtered" ? payload.filter || {} : null,
        totalTargets: 0,
        processed: 0,
        succeeded: 0,
        failed: 0,
        resultJson: null,
      } as any);
      setImmediate(async () => {
        const updateJob = async (patch: any) => {
          try {
            await storage.updateLeadBulkActionJob(job.id, patch);
          } catch {}
        };
        const startAt = new Date();
        await updateJob({ status: "running", startedAt: startAt, updatedAt: startAt });
        const runBatchUpdate = async (ids: number[]) => {
          if (!ids.length) return { processed: 0, succeeded: 0, failed: 0 };
          if (payload.action === "set_status") {
            const nextStatus = String((payload.params as any)?.status || "").trim();
            if (!nextStatus) throw new Error("Missing status");
            await db.execute(sql`
              UPDATE leads
              SET status = ${nextStatus}, status_changed_at = NOW(), updated_at = NOW()
              WHERE id IN (${sql.join(ids.map((id) => sql`${id}`), sql`,`)})
            `);
            return { processed: ids.length, succeeded: ids.length, failed: 0 };
          }
          if (payload.action === "assign") {
            const nextAssignedTo = Number((payload.params as any)?.assignedTo);
            if (!Number.isFinite(nextAssignedTo) || nextAssignedTo <= 0) throw new Error("Invalid assignedTo");
            await db.execute(sql`
              UPDATE leads
              SET assigned_to = ${nextAssignedTo}, updated_at = NOW()
              WHERE id IN (${sql.join(ids.map((id) => sql`${id}`), sql`,`)})
            `);
            return { processed: ids.length, succeeded: ids.length, failed: 0 };
          }
          if (payload.action === "archive") {
            await db.execute(sql`
              UPDATE leads
              SET archived_at = NOW(), updated_at = NOW()
              WHERE id IN (${sql.join(ids.map((id) => sql`${id}`), sql`,`)})
            `);
            return { processed: ids.length, succeeded: ids.length, failed: 0 };
          }
          if (payload.action === "unarchive") {
            await db.execute(sql`
              UPDATE leads
              SET archived_at = NULL, updated_at = NOW()
              WHERE id IN (${sql.join(ids.map((id) => sql`${id}`), sql`,`)})
            `);
            return { processed: ids.length, succeeded: ids.length, failed: 0 };
          }
          if (payload.action === "export") {
            const { job: exportJob, token } = await createExportJob({
              entityType: "lead",
              createdBy: user.id,
              format: "csv",
              filters: { ids },
              columns: [],
              expiresInMinutes: 60,
            });
            const finalExport = await processExportJob(exportJob.id);
            await updateJob({ resultJson: { exportId: finalExport.id, token }, updatedAt: new Date() });
            return { processed: ids.length, succeeded: ids.length, failed: 0 };
          }
          return { processed: ids.length, succeeded: 0, failed: ids.length };
        };
        try {
          let totalTargets = 0;
          let processed = 0;
          let succeeded = 0;
          let failed = 0;
          if (payload.selectionScope === "explicit") {
            const rawIds = (payload.leadIds || []).map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0);
            const unique = Array.from(new Set(rawIds));
            const whereAllowed =
              allowedAssignedToUserIds && allowedAssignedToUserIds.length
                ? sql`AND (assigned_to IS NULL OR assigned_to IN (${sql.join(allowedAssignedToUserIds.map((id) => sql`${id}`), sql`,`)}))`
                : sql``;
            const rows: any = await db.execute(sql`
              SELECT id
              FROM leads
              WHERE id IN (${sql.join(unique.map((id) => sql`${id}`), sql`,`)})
              ${whereAllowed}
            `);
            const ids = ((rows as any).rows || []).map((r: any) => Number(r.id)).filter((n: any) => Number.isFinite(n) && n > 0);
            totalTargets = ids.length;
            const out = await runBatchUpdate(ids);
            processed += out.processed;
            succeeded += out.succeeded;
            failed += out.failed;
          } else {
            const f = normalizeLeadListFilter(payload.filter || {});
            const pageSize = 500;
            let offset = 0;
            while (true) {
              const page = await storage.listLeads({
                ...(f as any),
                allowedAssignedToUserIds,
                limit: pageSize,
                offset,
              });
              if (!totalTargets) totalTargets = page.total;
              const ids = (page.items || []).map((l: any) => Number(l.id)).filter((n: any) => Number.isFinite(n) && n > 0);
              if (!ids.length) break;
              const out = await runBatchUpdate(ids);
              processed += out.processed;
              succeeded += out.succeeded;
              failed += out.failed;
              offset += pageSize;
              await updateJob({ totalTargets, processed, succeeded, failed, updatedAt: new Date() });
              if (offset >= totalTargets) break;
            }
          }
          await updateJob({ status: "completed", totalTargets, processed, succeeded, failed, finishedAt: new Date(), updatedAt: new Date() });
        } catch (err: any) {
          await updateJob({
            status: "failed",
            resultJson: { error: String(err?.message || err) },
            finishedAt: new Date(),
            updatedAt: new Date(),
          });
        }
      });
      res.status(201).json({ jobId: job.id, status: job.status });
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("get", "/api/leads/bulk/jobs/:id"); app.get("/api/leads/bulk/jobs/:id", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ message: "Invalid id" });
      const job = await storage.getLeadBulkActionJobById(id);
      if (!job) return res.status(404).json({ message: "Not found" });
      if (!user.isSuperAdmin && Number((job as any).createdBy) !== user.id) return res.status(404).json({ message: "Not found" });
      res.json(job);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("post", "/api/ai/voice/parse"); app.post("/api/ai/voice/parse", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      if (!(await isFeatureEnabled(user.id, "voice_playground", isFeatureBypassUser(user)))) return res.status(404).json({ message: "Not found" });
      const payload = z.object({ transcript: z.string().trim().min(1).max(5000) }).parse(req.body || {});
      const t = payload.transcript.toLowerCase();
      let action: "set_status" | "assign" | "archive" | "unarchive" | "export" | "add_note" | "playground_append_note" | null = null;
      const params: any = {};
      const playgroundNoteMatch =
        t.match(/playground\s+note[:\s]+([\s\S]{1,5000})/) ||
        t.match(/add\s+playground\s+note[:\s]+([\s\S]{1,5000})/) ||
        t.match(/in\s+playground[:\s]+([\s\S]{1,5000})/);
      if (playgroundNoteMatch) {
        action = "playground_append_note";
        params.note = String(playgroundNoteMatch[1] || "").trim();
      }
      const noteMatch =
        !action &&
        (t.match(/add\s+note[:\s]+([\s\S]{1,5000})/) ||
          t.match(/note[:\s]+([\s\S]{1,5000})/) ||
          t.match(/log\s+note[:\s]+([\s\S]{1,5000})/));
      if (noteMatch) {
        action = "add_note";
        params.body = String(noteMatch[1] || "").trim();
      }
      if (t.includes("unarchive")) action = "unarchive";
      else if (t.includes("archive")) action = "archive";
      else if (t.includes("export")) action = "export";
      const statusMatch =
        t.match(/status\s+to\s+([a-z0-9_\- ]{2,40})/) ||
        t.match(/mark\s+as\s+([a-z0-9_\- ]{2,40})/) ||
        t.match(/set\s+status\s+([a-z0-9_\- ]{2,40})/);
      if (statusMatch) {
        action = "set_status";
        params.status = String(statusMatch[1] || "").trim();
      }
      if (t.includes("assign to me")) {
        action = "assign";
        params.assignedTo = user.id;
      } else {
        const assignMatch = t.match(/assign\s+to\s+user\s+(\d{1,10})/);
        if (assignMatch) {
          action = "assign";
          params.assignedTo = Number(assignMatch[1]);
        }
      }
      res.json({ action, params, transcript: payload.transcript });
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("post", "/api/ai/voice/preview"); app.post("/api/ai/voice/preview", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      if (!(await isFeatureEnabled(user.id, "voice_playground", isFeatureBypassUser(user)))) return res.status(404).json({ message: "Not found" });
      const payload = z
        .object({
          parsed: z.object({ action: z.string().nullable(), params: z.record(z.any()).default({}), transcript: z.string().optional() }),
          leadIds: z.array(z.coerce.number().int().positive()).max(200).optional(),
          playground: z
            .object({
              sessionId: z.coerce.number().int().positive().optional(),
              address: z.string().trim().max(255).optional(),
              leadId: z.coerce.number().int().positive().optional(),
              propertyId: z.coerce.number().int().positive().optional(),
            })
            .optional(),
        })
        .parse(req.body || {});
      const action = payload.parsed.action as any;
      const params = payload.parsed.params || {};
      if (action === "playground_append_note") {
        const note = String(params.note || "").trim();
        if (!note) return res.status(400).json({ message: "Missing note" });
        const ctx = payload.playground || {};
        const sessionId = typeof ctx.sessionId === "number" && Number.isFinite(ctx.sessionId) ? ctx.sessionId : null;
        const address = String(ctx.address || "").trim();
        let session: any | null = null;
        let wouldCreateSession = false;
        if (sessionId) {
          session = await storage.getPlaygroundPropertySessionById(sessionId);
        } else if (address) {
          const addressKey = toAddressKey(address);
          session = await storage.getPlaygroundPropertySessionByAddressKey(user.id, addressKey);
          if (!session) wouldCreateSession = true;
        } else {
          return res.status(400).json({ message: "Missing playground sessionId or address" });
        }
        return res.json({
          changes: [],
          notes: null,
          playground: {
            sessionId: session?.id ?? null,
            wouldCreateSession,
            notePreview: note.slice(0, 280),
            currentNotesCount: session ? (() => { try { return Array.isArray(JSON.parse(String(session.notesJson || "[]"))) ? JSON.parse(String(session.notesJson || "[]")).length : 0; } catch { return 0; } })() : 0,
          },
        });
      }
      if (action === "add_note") {
        const body = String(params.body || "").trim();
        const ids = (payload.leadIds || []).map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0);
        if (!ids.length) return res.json({ changes: [], notes: null, playground: null });
        if (!body) return res.status(400).json({ message: "Missing note body" });
        return res.json({ changes: [], notes: { leadIdsCount: ids.length, bodyPreview: body.slice(0, 280) }, playground: null });
      }
      const ids = (payload.leadIds || []).map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0);
      if (!ids.length) return res.json({ changes: [], notes: null, playground: null });
      const leadRows: any = await db.execute(sql`
        SELECT id, status, assigned_to as "assignedTo", archived_at as "archivedAt"
        FROM leads
        WHERE id IN (${sql.join(ids.map((id) => sql`${id}`), sql`,`)})
      `);
      const leadsRows = (leadRows as any).rows || [];
      const changes = leadsRows.map((r: any) => {
        const next: any = { id: Number(r.id) };
        if (action === "set_status") next.status = String(params.status || "").trim();
        if (action === "assign") next.assignedTo = Number(params.assignedTo);
        if (action === "archive") next.archivedAt = new Date().toISOString();
        if (action === "unarchive") next.archivedAt = null;
        return { before: r, next };
      });
      res.json({ changes, notes: null, playground: null });
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("post", "/api/ai/voice/apply"); app.post("/api/ai/voice/apply", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      if (!(await isFeatureEnabled(user.id, "voice_playground", isFeatureBypassUser(user)))) return res.status(404).json({ message: "Not found" });
      const payload = z
        .object({
          parsed: z.object({ action: z.string().nullable(), params: z.record(z.any()).default({}), transcript: z.string().optional() }),
          transcript: z.string().trim().min(1).max(5000),
          leadIds: z.array(z.coerce.number().int().positive()).max(200).optional(),
          playground: z
            .object({
              sessionId: z.coerce.number().int().positive().optional(),
              address: z.string().trim().max(255).optional(),
              leadId: z.coerce.number().int().positive().optional(),
              propertyId: z.coerce.number().int().positive().optional(),
            })
            .optional(),
        })
        .parse(req.body || {});
      const action = payload.parsed.action as any;
      const params = payload.parsed.params || {};
      if (action === "playground_append_note") {
        const note = String(params.note || "").trim();
        if (!note) return res.status(400).json({ message: "Missing note" });
        const ctx = payload.playground || {};
        const sessionId = typeof ctx.sessionId === "number" && Number.isFinite(ctx.sessionId) ? ctx.sessionId : null;
        const address = String(ctx.address || "").trim();
        const leadId = typeof ctx.leadId === "number" && Number.isFinite(ctx.leadId) ? ctx.leadId : undefined;
        const propertyId = typeof ctx.propertyId === "number" && Number.isFinite(ctx.propertyId) ? ctx.propertyId : undefined;
        let session: any | null = null;
        if (sessionId) {
          session = await storage.getPlaygroundPropertySessionById(sessionId);
          if (!session) return res.status(404).json({ message: "Playground session not found" });
        } else if (address) {
          const addressKey = toAddressKey(address);
          session = await storage.getPlaygroundPropertySessionByAddressKey(user.id, addressKey);
          if (!session) {
            const validated = insertPlaygroundPropertySessionSchema.parse({
              address,
              addressKey,
              leadId,
              propertyId,
              tagsJson: "[]",
              bookmarksJson: "[]",
              checklistJson: "{}",
              notesJson: "[]",
              underwritingJson: "{}",
              createdBy: user.id,
              updatedBy: user.id,
              lastOpenedBy: user.id,
              lastOpenedAt: new Date(),
            } as any);
            session = await storage.createPlaygroundPropertySession(validated as any);
          }
        } else {
          return res.status(400).json({ message: "Missing playground sessionId or address" });
        }
        const prevNotesJson = String((session as any).notesJson || "[]");
        let notesArr: any[] = [];
        try {
          const parsed = JSON.parse(prevNotesJson);
          notesArr = Array.isArray(parsed) ? parsed : [];
        } catch {
          notesArr = [];
        }
        const noteEntry = { id: crypto.randomBytes(8).toString("hex"), createdAt: new Date().toISOString(), createdBy: user.id, body: note };
        const nextNotesJson = JSON.stringify([...notesArr, noteEntry]);
        const updated = await storage.updatePlaygroundPropertySession((session as any).id, { notesJson: nextNotesJson, updatedBy: user.id } as any);
        const actionLog = await storage.createAiActionLog({
          createdBy: user.id,
          entityType: "playground",
          transcript: payload.transcript,
          parsedJson: payload.parsed,
          selectionJson: { playground: { sessionId: (updated as any).id, address: (updated as any).address, leadId: (updated as any).leadId ?? null, propertyId: (updated as any).propertyId ?? null } },
          appliedJson: { action, params },
        } as any);
        const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
        await storage.createAiActionUndo({
          aiActionLogId: actionLog.id,
          undoJson: [{ sessionId: (updated as any).id, prevNotesJson }],
          expiresAt,
        } as any);
        await storage.createGlobalActivity({
          userId: user.id,
          action: "playground_voice_append_note",
          description: "Voice appended playground note",
          metadata: JSON.stringify({ playgroundSessionId: (updated as any).id }),
        } as any);
        return res.json({ ok: true, actionLogId: actionLog.id, applied: 1, playgroundSessionId: (updated as any).id });
      }
      const ids = (payload.leadIds || []).map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0);
      if (!ids.length) return res.json({ ok: true, applied: 0 });
      if (action === "add_note") {
        const body = String(params.body || "").trim();
        if (!body) return res.status(400).json({ message: "Missing note body" });
        const now = new Date();
        for (const leadId of ids) {
          await storage.createLeadNote({ leadId, createdBy: user.id, body } as any);
        }
        await db.execute(sql`UPDATE leads SET last_touch_at = NOW(), updated_at = NOW() WHERE id IN (${sql.join(ids.map((id) => sql`${id}`), sql`,`)})`);
        const actionLog = await storage.createAiActionLog({
          createdBy: user.id,
          entityType: "lead",
          transcript: payload.transcript,
          parsedJson: payload.parsed,
          selectionJson: { leadIds: ids },
          appliedJson: { action, params },
        } as any);
        const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
        await storage.createAiActionUndo({
          aiActionLogId: actionLog.id,
          undoJson: [],
          expiresAt,
        } as any);
        await storage.createGlobalActivity({
          userId: user.id,
          action: "lead_voice_add_note",
          description: "Voice added lead note",
          metadata: JSON.stringify({ leadIdsCount: ids.length }),
        } as any);
        return res.json({ ok: true, actionLogId: actionLog.id, applied: ids.length, createdAt: now.toISOString() });
      }
      const rows: any = await db.execute(sql`
        SELECT id, status, assigned_to as "assignedTo", archived_at as "archivedAt"
        FROM leads
        WHERE id IN (${sql.join(ids.map((id) => sql`${id}`), sql`,`)})
      `);
      const beforeRows = (rows as any).rows || [];
      const undoJson = beforeRows.map((r: any) => ({
        id: Number(r.id),
        status: r.status ?? null,
        assignedTo: r.assignedTo ?? null,
        archivedAt: r.archivedAt ?? null,
      }));
      const actionLog = await storage.createAiActionLog({
        createdBy: user.id,
        entityType: "lead",
        transcript: payload.transcript,
        parsedJson: payload.parsed,
        selectionJson: { leadIds: ids },
        appliedJson: { action, params },
      } as any);
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
      await storage.createAiActionUndo({
        aiActionLogId: actionLog.id,
        undoJson,
        expiresAt,
      } as any);
      if (action === "set_status") {
        const nextStatus = String(params.status || "").trim();
        if (!nextStatus) return res.status(400).json({ message: "Missing status" });
        await db.execute(sql`
          UPDATE leads
          SET status = ${nextStatus}, status_changed_at = NOW(), updated_at = NOW()
          WHERE id IN (${sql.join(ids.map((id) => sql`${id}`), sql`,`)})
        `);
      } else if (action === "assign") {
        const nextAssignedTo = Number(params.assignedTo);
        if (!Number.isFinite(nextAssignedTo) || nextAssignedTo <= 0) return res.status(400).json({ message: "Invalid assignedTo" });
        await db.execute(sql`
          UPDATE leads
          SET assigned_to = ${nextAssignedTo}, updated_at = NOW()
          WHERE id IN (${sql.join(ids.map((id) => sql`${id}`), sql`,`)})
        `);
      } else if (action === "archive") {
        await db.execute(sql`
          UPDATE leads
          SET archived_at = NOW(), updated_at = NOW()
          WHERE id IN (${sql.join(ids.map((id) => sql`${id}`), sql`,`)})
        `);
      } else if (action === "unarchive") {
        await db.execute(sql`
          UPDATE leads
          SET archived_at = NULL, updated_at = NOW()
          WHERE id IN (${sql.join(ids.map((id) => sql`${id}`), sql`,`)})
        `);
      } else if (action === "export") {
        const { job: exportJob, token } = await createExportJob({
          entityType: "lead",
          createdBy: user.id,
          format: "csv",
          filters: { ids },
          columns: [],
          expiresInMinutes: 60,
        });
        await processExportJob(exportJob.id);
        await storage.updateAiActionUndo((await storage.getAiActionUndoByActionId(actionLog.id))!.id, { undoneAt: null } as any);
        return res.json({ ok: true, actionLogId: actionLog.id, exportId: exportJob.id, token });
      } else {
        return res.status(400).json({ message: "Unsupported voice action" });
      }
      res.json({ ok: true, actionLogId: actionLog.id, applied: ids.length });
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("post", "/api/ai/voice/undo"); app.post("/api/ai/voice/undo", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      if (!(await isFeatureEnabled(user.id, "voice_playground", isFeatureBypassUser(user)))) return res.status(404).json({ message: "Not found" });
      const payload = z.object({ aiActionLogId: z.coerce.number().int().positive() }).parse(req.body || {});
      const undo = await storage.getAiActionUndoByActionId(payload.aiActionLogId);
      if (!undo) return res.status(404).json({ message: "Not found" });
      const expiresAt = (undo as any).expiresAt ? new Date((undo as any).expiresAt) : null;
      if (expiresAt && expiresAt.getTime() < Date.now()) return res.status(400).json({ message: "Undo window expired" });
      if ((undo as any).undoneAt) return res.status(400).json({ message: "Already undone" });
      const undoJson = Array.isArray((undo as any).undoJson) ? (undo as any).undoJson : [];
      const leadRows = undoJson.filter((r: any) => Number.isFinite(Number(r?.id)) && Number(r?.id) > 0);
      const sessionRows = undoJson.filter((r: any) => Number.isFinite(Number(r?.sessionId)) && Number(r?.sessionId) > 0);
      for (const row of leadRows) {
        const id = Number(row.id);
        await db.execute(sql`
          UPDATE leads
          SET status = ${row.status ?? null},
              assigned_to = ${row.assignedTo ?? null},
              archived_at = ${row.archivedAt ?? null},
              updated_at = NOW()
          WHERE id = ${id}
        `);
      }
      for (const row of sessionRows) {
        const sessionId = Number(row.sessionId);
        const prevNotesJson = typeof row.prevNotesJson === "string" ? row.prevNotesJson : "[]";
        await storage.updatePlaygroundPropertySession(sessionId, { notesJson: prevNotesJson, updatedBy: user.id } as any);
      }
      await storage.updateAiActionUndo((undo as any).id, { undoneAt: new Date() } as any);
      res.json({ ok: true, restored: leadRows.length + sessionRows.length, restoredLeads: leadRows.length, restoredPlayground: sessionRows.length });
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("get", "/api/audit/runs"); app.get("/api/audit/runs", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const limitRaw = typeof req.query?.limit === "string" ? req.query.limit : "";
      const limit = limitRaw ? parseInt(limitRaw, 10) : 50;
      const items = await storage.listAppAuditRuns({ createdBy: user.id, limit });
      res.json({ items });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("post", "/api/audit/runs"); app.post("/api/audit/runs", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const payload = z.object({ scopeJson: z.any() }).parse(req.body || {});
      const row = await storage.createAppAuditRun({ createdBy: user.id, scopeJson: payload.scopeJson } as any);
      res.status(201).json(row);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("get", "/api/audit/runs/:id/findings"); app.get("/api/audit/runs/:id/findings", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const runId = parseInt(req.params.id, 10);
      if (!Number.isFinite(runId)) return res.status(400).json({ message: "Invalid run id" });
      const items = await storage.listAppAuditFindings({ runId, limit: 500 });
      res.json({ items });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("post", "/api/audit/runs/:id/findings"); app.post("/api/audit/runs/:id/findings", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const runId = parseInt(req.params.id, 10);
      if (!Number.isFinite(runId)) return res.status(400).json({ message: "Invalid run id" });
      const payload = z
        .object({
          severity: z.enum(["low", "medium", "high", "critical"]),
          area: z.string().trim().min(1).max(80),
          title: z.string().trim().min(1).max(160),
          description: z.string().trim().min(1).max(20_000),
          recommendation: z.string().trim().max(20_000).optional().nullable(),
          technicalNotes: z.string().trim().max(20_000).optional().nullable(),
          affectedPages: z.array(z.string().trim().min(1).max(120)).min(1).max(50),
          fixPlan: z.string().trim().min(1).max(20_000),
          ownerUserId: z.coerce.number().int().positive().optional().nullable(),
          prdSection: z.string().trim().max(500).optional().nullable(),
        })
        .parse(req.body || {});
      const row = await storage.createAppAuditFinding({
        runId,
        severity: payload.severity,
        area: payload.area,
        title: payload.title,
        description: payload.description,
        recommendation: payload.recommendation ?? null,
        technicalNotes: payload.technicalNotes ?? null,
        affectedPages: payload.affectedPages,
        fixPlan: payload.fixPlan,
        ownerUserId: payload.ownerUserId ?? null,
        prdSection: payload.prdSection ?? null,
        status: "open",
      } as any);
      res.status(201).json(row);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("post", "/api/audit/runs/:id/seed-pages"); app.post("/api/audit/runs/:id/seed-pages", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const runId = parseInt(req.params.id, 10);
      if (!Number.isFinite(runId)) return res.status(400).json({ message: "Invalid run id" });
      const payload = z.object({ mode: z.enum(["append", "replace"]).default("append") }).parse(req.body || {});
      if (payload.mode === "replace") {
        await db.execute(sql`DELETE FROM app_audit_findings WHERE run_id = ${runId}`);
      }
      const pages: Array<{ title: string; area: string; affectedPages: string[]; description: string; fixPlan: string }> = [
        {
          title: "Dashboard: KPI correctness + work-queue links",
          area: "dashboard",
          affectedPages: ["/dashboard"],
          description: "Verify KPI correctness, loading states, and add deep links into active work queues (Leads, Tasks, Today).",
          fixPlan: "Audit KPIs for correctness and freshness; add primary CTAs to Leads/Tasks/Today with context and saved views.",
        },
        {
          title: "Leads: Scale workflow (filters, views, bulk, notes, voice)",
          area: "leads",
          affectedPages: ["/leads"],
          description: "Upgrade Leads into the primary work queue and segmentation hub with safe bulk actions and voice-to-action.",
          fixPlan: "Wire advanced filters + saved views + column chooser + async bulk jobs + notes preview + voice action entry points.",
        },
        {
          title: "Opportunities: Lead linking + next action handoff",
          area: "opportunities",
          affectedPages: ["/opportunities", "/opportunities/:id"],
          description: "Ensure Lead↔Opportunity linking is visible and provide clear next actions (Playground, Call, Follow-up).",
          fixPlan: "Add consistent link UI and contextual actions; ensure timeline and follow-ups connect back to Leads.",
        },
        {
          title: "Playground: Context binding + voice append note",
          area: "playground",
          affectedPages: ["/playground"],
          description: "Playground should preserve context (leadId/propertyId/sessionId) and accept voice-to-action append notes safely.",
          fixPlan: "Add voice entry point; implement append-only note write target via session patch; ensure preview + audit log + undo when feasible.",
        },
        {
          title: "Phone: Context handoff + activity semantics",
          area: "phone",
          affectedPages: ["/phone"],
          description: "Ensure opening Phone from Leads/Opportunities preserves context and creates consistent activity events.",
          fixPlan: "Standardize query params and link targets; ensure call outcomes write activity tied to lead/property IDs.",
        },
        {
          title: "Dialer: Context handoff + activity semantics",
          area: "dialer",
          affectedPages: ["/dialer"],
          description: "Ensure opening Dialer from Leads preserves context and logging is consistent.",
          fixPlan: "Normalize deep-link params and enforce consistent activity logging and compliance checks.",
        },
        {
          title: "Campaigns: Enroll from saved views (planned)",
          area: "campaigns",
          affectedPages: ["/campaigns"],
          description: "Allow campaign audiences to be enrolled from Leads saved views/segments (backlog this release).",
          fixPlan: "Design enrollment UX and backend targeting based on saved view config; add suppression rules; ship after Leads views are stable.",
        },
        {
          title: "RVM: Audience from saved views + suppression (planned)",
          area: "rvm",
          affectedPages: ["/rvm"],
          description: "Allow RVM targeting from Leads saved views with suppression and preview counts (backlog this release).",
          fixPlan: "Reuse saved views targeting; add suppression engine (DNC/invalid/recent contact); add launch preview and result dashboards.",
        },
        {
          title: "Field Mode: Offline capture integrity",
          area: "field",
          affectedPages: ["/field"],
          description: "Verify offline capture and sync creates leads, notes, and media reliably with dedupe.",
          fixPlan: "Audit offline queue handling and failure states; ensure created records link back to Leads/Playground context.",
        },
        {
          title: "Tasks: Entity-linked execution",
          area: "tasks",
          affectedPages: ["/tasks"],
          description: "Ensure tasks created from Leads/Opportunities keep entity links and power Today/Calendar queues.",
          fixPlan: "Normalize quick-create flows; ensure navigation and due-date handling supports follow-up workflows.",
        },
        {
          title: "Calendar: Follow-up visibility",
          area: "calendar",
          affectedPages: ["/calendar"],
          description: "Calendar should show follow-ups and tasks with links back to leads/opportunities.",
          fixPlan: "Audit calendar sources and deep-links; ensure follow-up dates align with Leads filters.",
        },
        {
          title: "Today: Work queue compression",
          area: "today",
          affectedPages: ["/today"],
          description: "Today should be the operator queue for due tasks/follow-ups with one-click handoffs.",
          fixPlan: "Audit queue correctness; add fast actions to call/open lead/open playground; minimize clicks.",
        },
        {
          title: "Notifications: Routing and deep links",
          area: "notifications",
          affectedPages: ["/notifications"],
          description: "Notifications should reliably link back to the correct entity context.",
          fixPlan: "Audit notification payloads; standardize entity references and target URLs.",
        },
        {
          title: "Contacts: Link to leads and calls",
          area: "contacts",
          affectedPages: ["/contacts"],
          description: "Contacts should link to associated leads/opportunities and show communications context.",
          fixPlan: "Audit entity linking and add contextual navigation and activity timeline reuse.",
        },
        {
          title: "Buyers: Dispo readiness links",
          area: "buyers",
          affectedPages: ["/buyers"],
          description: "Buyers should connect to opportunities and contract workflows.",
          fixPlan: "Audit buyer→deal linking and add deep-links into opportunity detail and contracts.",
        },
        {
          title: "Contracts: Opportunity context",
          area: "contracts",
          affectedPages: ["/contracts"],
          description: "Contracts should be generated/managed from opportunity context.",
          fixPlan: "Audit contract generation flow; ensure linked lead/property/buyer context is preserved and navigable.",
        },
        {
          title: "Analytics: Data trust layer",
          area: "analytics",
          affectedPages: ["/analytics"],
          description: "Analytics must be correct and attributable to real actions and segments.",
          fixPlan: "Audit KPI definitions; ensure events and activity semantics are consistent and queryable.",
        },
        {
          title: "Settings/Teams/System Health: Control plane alignment",
          area: "control_plane",
          affectedPages: ["/settings", "/teams", "/system-health"],
          description: "Ensure feature flags, team selection, and health signals connect to audit and workflows.",
          fixPlan: "Audit feature flag visibility and team selection; link health issues to audit findings; reduce config confusion.",
        },
        {
          title: "XP surfaces: audit-only this release",
          area: "xp",
          affectedPages: ["/xp", "/xp/admin", "/xp/:slug", "/xp/checkout/success", "/xp/checkout/cancel"],
          description: "Include XP pages in the audit backlog; fix only if critical regressions are found.",
          fixPlan: "Create findings for UX correctness and conversion flow; defer enhancements unless blocking.",
        },
      ];
      const created: any[] = [];
      for (const p of pages) {
        const row = await storage.createAppAuditFinding({
          runId,
          severity: "medium",
          area: p.area,
          title: p.title,
          description: p.description,
          recommendation: null,
          technicalNotes: null,
          affectedPages: p.affectedPages,
          fixPlan: p.fixPlan,
          ownerUserId: null,
          prdSection: null,
          status: "open",
        } as any);
        created.push(row);
      }
      res.status(201).json({ createdCount: created.length });
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("patch", "/api/audit/findings/:id"); app.patch("/api/audit/findings/:id", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ message: "Invalid id" });
      if (!user.isSuperAdmin) {
        const rows: any = await db.execute(sql`
          SELECT r.created_by as "createdBy"
          FROM app_audit_findings f
          JOIN app_audit_runs r ON r.id = f.run_id
          WHERE f.id = ${id}
          LIMIT 1
        `);
        const createdBy = Number((rows as any).rows?.[0]?.createdBy);
        if (!Number.isFinite(createdBy) || createdBy !== user.id) return res.status(404).json({ message: "Not found" });
      }
      const payload = z
        .object({
          severity: z.enum(["low", "medium", "high", "critical"]).optional(),
          area: z.string().trim().min(1).max(80).optional(),
          title: z.string().trim().min(1).max(160).optional(),
          description: z.string().trim().min(1).max(20_000).optional(),
          recommendation: z.string().trim().max(20_000).optional().nullable(),
          technicalNotes: z.string().trim().max(20_000).optional().nullable(),
          affectedPages: z.array(z.string().trim().min(1).max(120)).min(1).max(50).optional(),
          fixPlan: z.string().trim().min(1).max(20_000).optional(),
          ownerUserId: z.coerce.number().int().positive().optional().nullable(),
          prdSection: z.string().trim().max(500).optional().nullable(),
          status: z.enum(["open", "in_progress", "resolved", "ignored"]).optional(),
        })
        .parse(req.body || {});
      const row = await storage.updateAppAuditFinding(id, payload as any);
      res.json(row);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("get", "/api/audit/release-gate"); app.get("/api/audit/release-gate", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const rows: any = await db.execute(sql`
        SELECT 
          f.id as "id",
          f.run_id as "runId",
          f.severity as "severity",
          f.area as "area",
          f.title as "title",
          f.status as "status",
          f.updated_at as "updatedAt"
        FROM app_audit_findings f
        JOIN app_audit_runs r ON r.id = f.run_id
        WHERE r.created_by = ${user.id}
          AND f.severity = 'critical'
          AND f.status IN ('open', 'in_progress')
        ORDER BY f.updated_at DESC, f.id DESC
        LIMIT 50
      `);
      const blockingItems = Array.isArray((rows as any).rows) ? (rows as any).rows : [];
      res.json({
        ok: blockingItems.length === 0,
        blockingCount: blockingItems.length,
        blockingItems,
      });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("get", "/api/skip-trace/config"); app.get("/api/skip-trace/config", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const enabled = await isFeatureEnabled(user.id, "skip_trace", isFeatureBypassUser(user));
      if (!enabled) {
        return res.json({
          enabled: false,
          providerName: null,
          publicResearchEnabled: false,
          allowedModes: [],
        });
      }
      const providerName = getSkipTraceProvider().name;
      const publicResearchEnabled = String(process.env.SKIP_TRACE_PUBLIC_RESEARCH_ENABLED || "")
        .trim()
        .toLowerCase() === "true";
      const allowedModes = publicResearchEnabled ? ["provider", "public_research", "both"] : ["provider"];
      res.json({
        enabled: true,
        providerName,
        publicResearchEnabled,
        allowedModes,
      });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("post", "/api/skip-trace/jobs"); app.post("/api/skip-trace/jobs", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      if (!(await isFeatureEnabled(user.id, "skip_trace", isFeatureBypassUser(user)))) return res.status(404).json({ message: "Not found" });
      const body = z
        .object({
          entityType: z.enum(["lead", "opportunity"]),
          entityId: z.coerce.number().int().positive(),
          mode: z.enum(["provider", "public_research", "both"]),
        })
        .parse(req.body);
      const job = await createSkipTraceJob({
        entityType: body.entityType,
        entityId: body.entityId,
        mode: body.mode,
        requestedByUserId: user.id,
      });
      if (body.mode === "provider") {
        const out = await runSkipTraceJob(job.id);
        return res.json({ jobId: out.job.id, status: out.job.status });
      }
      res.json({ jobId: job.id, status: job.status });
    } catch (error: any) {
      if (isHttpError(error)) return res.status(error.statusCode).json({ message: error.message });
      res.status(500).json({ message: error.message });
    }
  });
  reg("post", "/api/skip-trace/jobs/:jobId/run"); app.post("/api/skip-trace/jobs/:jobId/run", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      if (!(await isFeatureEnabled(user.id, "skip_trace", isFeatureBypassUser(user)))) return res.status(404).json({ message: "Not found" });
      const jobId = parseInt(req.params.jobId, 10);
      if (!Number.isFinite(jobId)) return res.status(400).json({ message: "Invalid job id" });
      const job = await storage.getSkipTraceJobById(jobId);
      if (!job) return res.status(404).json({ message: "Not found" });
      if (!user.isSuperAdmin && (job as any).requestedByUserId && Number((job as any).requestedByUserId) !== user.id) return res.status(404).json({ message: "Not found" });
      const out = await runSkipTraceJob(job.id);
      res.json({ jobId: out.job.id, status: out.job.status });
    } catch (error: any) {
      if (isHttpError(error)) return res.status(error.statusCode).json({ message: error.message });
      res.status(500).json({ message: error.message });
    }
  });
  reg("get", "/api/skip-trace/jobs/:jobId"); app.get("/api/skip-trace/jobs/:jobId", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      if (!(await isFeatureEnabled(user.id, "skip_trace", isFeatureBypassUser(user)))) return res.status(404).json({ message: "Not found" });
      const jobId = parseInt(req.params.jobId, 10);
      if (!Number.isFinite(jobId)) return res.status(400).json({ message: "Invalid job id" });
      const job = await storage.getSkipTraceJobById(jobId);
      if (!job) return res.status(404).json({ message: "Not found" });
      if (!user.isSuperAdmin && (job as any).requestedByUserId && Number((job as any).requestedByUserId) !== user.id) return res.status(404).json({ message: "Not found" });
      const events = await storage.listSkipTraceJobEvents(job.id, 500);
      const evidence = await storage.listSkipTraceEvidence(job.id, 500);
      const scoreSnapshot = (await storage.listLeadScoreSnapshotsByJobId(job.id))[0] ?? null;
      const entityType = String((job as any).entityType || "").trim().toLowerCase();
      const entityId = Number((job as any).entityId);
      const lead = entityType === "lead" ? ((await storage.getLeadById(entityId)) ?? null) : null;
      const property = entityType === "opportunity" ? ((await storage.getPropertyById(entityId)) ?? null) : null;
      const providerRow =
        entityType === "lead"
          ? await storage.getLatestSkipTraceForLead(entityId)
          : entityType === "opportunity"
            ? await storage.getLatestSkipTraceForProperty(entityId)
            : null;
      const providerResult = providerRow && (providerRow as any).jobId === job.id ? hydrateSkipTraceResultForApi(providerRow as any) : null;
      const merged =
        entityType === "lead" || entityType === "opportunity"
          ? mergeSkipTraceResult({
              entityType: entityType as any,
              entityId,
              lead,
              property,
              providerResult: providerRow && (providerRow as any).jobId === job.id ? (providerRow as any) : null,
              evidence: evidence as any,
              scoreSnapshot: scoreSnapshot as any,
            })
          : null;
      res.json({
        job,
        events,
        evidence,
        providerResult,
        scoreSnapshot,
        merged,
      });
    } catch (error: any) {
      if (isHttpError(error)) return res.status(error.statusCode).json({ message: error.message });
      res.status(500).json({ message: error.message });
    }
  });
  reg("get", "/api/leads/:id/skip-trace/latest"); app.get("/api/leads/:id/skip-trace/latest", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      if (!(await isFeatureEnabled(user.id, "skip_trace", isFeatureBypassUser(user)))) return res.status(404).json({ message: "Not found" });
      const leadId = parseInt(req.params.id);
      const lead = await storage.getLeadById(leadId);
      if (!lead) return res.status(404).json({ message: "Lead not found" });
      const row = await storage.getLatestSkipTraceForLead(leadId);
      if (!row) return res.json(null);
      return res.json({
        ...row,
        phones: parseJsonArrayText((row as any).phonesJson),
        emails: parseJsonArrayText((row as any).emailsJson),
      });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  // ── Skip-trace bottleneck fix (0098): bulk backfill for phoneless leads ────
  // Queues free public-research skip-trace jobs for leads without phones.
  // Batched to avoid hammering providers; run repeatedly until the backlog clears.
  reg("post", "/api/skip-trace/backfill"); app.post("/api/skip-trace/backfill", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      if (!(await isFeatureEnabled(user.id, "skip_trace", isFeatureBypassUser(user)))) return res.status(404).json({ message: "Not found" });
      const batchSize = Math.min(Math.max(Number(req.body?.batchSize) || 50, 1), 200);
      const mode = req.body?.mode === "provider" ? "provider" : "public_research";
      // Find leads with no phone and no recent skip-trace job
      const rows: any = await db.execute(sql`
        SELECT l.id FROM leads l
        WHERE (l.owner_phone IS NULL OR regexp_replace(l.owner_phone, '\\D', '', 'g') = '')
          AND l.archived_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM skip_trace_jobs j
            WHERE j.entity_type = 'lead' AND j.entity_id = l.id
              AND j.created_at > now() - interval '7 days'
          )
        ORDER BY l.id ASC
        LIMIT ${batchSize}
      `);
      const leadIds: number[] = ((rows as any).rows || []).map((r: any) => Number(r.id));
      const { createSkipTraceJob, runSkipTraceJob } = await import("./services/skipTrace/orchestrator.js");
      let queued = 0;
      for (const leadId of leadIds) {
        try {
          const job = await createSkipTraceJob({
            entityType: "lead",
            entityId: leadId,
            mode,
            requestedByUserId: user.id,
          });
          queued++;
          // Stagger execution — don't await, but add a small delay between kicks
          setTimeout(() => {
            runSkipTraceJob(job.id).catch((e: any) =>
              console.error(`[backfill] job ${job.id} failed:`, e?.message || e));
          }, queued * 2000);
        } catch (e: any) {
          console.error(`[backfill] queue failed for lead ${leadId}:`, e?.message || e);
        }
      }
      // Count remaining backlog
      const remaining: any = await db.execute(sql`
        SELECT COUNT(*)::int AS c FROM leads l
        WHERE (l.owner_phone IS NULL OR regexp_replace(l.owner_phone, '\\D', '', 'g') = '')
          AND l.archived_at IS NULL
      `);
      res.json({
        ok: true,
        queued,
        remainingBacklog: Number(((remaining as any).rows || [])[0]?.c || 0),
        mode,
      });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("post", "/api/leads/:id/skip-trace"); app.post("/api/leads/:id/skip-trace", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      if (!(await isFeatureEnabled(user.id, "skip_trace", isFeatureBypassUser(user)))) return res.status(404).json({ message: "Not found" });
      const leadId = parseInt(req.params.id);
      const out = await runProviderSkipTraceForEntity({ entityType: "lead", entityId: leadId, requestedByUserId: user.id });
      if ("pending" in out && out.pending) {
        return res.json({ pending: true, result: hydrateSkipTraceResultForApi(out.providerResult as any) });
      }
      return res.json({ cached: out.cached, result: hydrateSkipTraceResultForApi(out.providerResult as any) });
    } catch (error: any) {
      if (isHttpError(error)) return res.status(error.statusCode).json({ message: error.message });
      res.status(500).json({ message: error.message });
    }
  });
  reg("get", "/api/lead-source-options"); app.get("/api/lead-source-options", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      let rows = await storage.getLeadSourceOptions(user.id);
      if (!rows.length) {
        const defaults = [
          "Cold Call",
          "Direct Mail",
          "Referral",
          "SMS",
          "PPC",
          "Driving for Dollars",
          "Inbound Call",
        ];
        for (let i = 0; i < defaults.length; i++) {
          const v = defaults[i];
          await storage.upsertLeadSourceOption({
            userId: user.id,
            value: v,
            label: v,
            sortOrder: i,
            isActive: true,
          } as any);
        }
        rows = await storage.getLeadSourceOptions(user.id);
      }
      const seen = new Set<string>();
      const deduped = [];
      for (const r of rows) {
        const v = String(r?.value || '').trim();
        if (!v || seen.has(v)) continue;
        seen.add(v);
        deduped.push({ id: r.id, value: v, label: r.label, isActive: r.isActive, sortOrder: r.sortOrder });
      }
      res.json(deduped);
    } catch (error: any) {
      try {
        const readiness = await getSchemaReadiness();
        if (!readiness.ok) {
          return res.status(503).json({ message: readiness.message, code: readiness.code, missing: readiness.missing, hint: schemaFixInstructions() });
        }
      } catch {}
      res.status(500).json({ message: error.message });
    }
  });
  reg("post", "/api/lead-source-options"); app.post("/api/lead-source-options", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const schema = z.object({
        value: z.string().trim().min(1).max(100),
        label: z.string().trim().min(1).max(120),
        sortOrder: z.number().int().min(0).max(100000).optional(),
        isActive: z.boolean().optional(),
      });
      const payload = schema.parse(req.body || {});
      const row = await storage.upsertLeadSourceOption({
        userId: user.id,
        value: payload.value,
        label: payload.label,
        sortOrder: payload.sortOrder ?? 0,
        isActive: payload.isActive ?? true,
      } as any);
      res.status(201).json(row);
    } catch (error: any) {
      try {
        const readiness = await getSchemaReadiness();
        if (!readiness.ok) {
          return res.status(503).json({ message: readiness.message, code: readiness.code, missing: readiness.missing, hint: schemaFixInstructions() });
        }
      } catch {}
      res.status(400).json({ message: error.message });
    }
  });
  reg("get", "/api/campaigns"); app.get("/api/campaigns", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      if (!(await isFeatureEnabled(user.id, "campaigns", isFeatureBypassUser(user)))) return res.status(404).json({ message: "Not found" });
      const rows = await storage.getCampaigns(user.id);
      res.json(rows);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("post", "/api/campaigns"); app.post("/api/campaigns", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      if (!(await isFeatureEnabled(user.id, "campaigns", isFeatureBypassUser(user)))) return res.status(404).json({ message: "Not found" });
      const schema = z.object({ name: z.string().trim().min(1).max(120) });
      const payload = schema.parse(req.body || {});
      // New campaigns start as "draft": build -> activate (M20 SMS gate) -> scheduler executes.
      const row = await storage.createCampaign({ userId: user.id, name: payload.name, status: "draft" } as any);
      res.status(201).json(row);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("patch", "/api/campaigns/:id"); app.patch("/api/campaigns/:id", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      if (!(await isFeatureEnabled(user.id, "campaigns", isFeatureBypassUser(user)))) return res.status(404).json({ message: "Not found" });
      const id = parseInt(req.params.id);
      const schema = z.object({
        name: z.string().trim().min(1).max(120).optional(),
        status: z.string().trim().min(1).max(20).optional(),
      });
      const payload = schema.parse(req.body || {});
      // M20: refuse to activate while SMS cannot send - an "Active" campaign
      // with no provider is inert and misleading.
      if (payload.status === "active") {
        try {
          const readiness = await getProviderReadiness();
          const smsOk = Boolean((readiness as any)?.sms?.configured && (readiness as any)?.sms?.reachable);
          if (!smsOk) {
            return res.status(409).json({ message: "SMS is not configured. Configure Telnyx SMS before activating this campaign.", code: "sms_not_configured" });
          }
        } catch {}
      }
      const row = await storage.updateCampaign(id, payload as any);
      res.json(row);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("delete", "/api/campaigns/:id"); app.delete("/api/campaigns/:id", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      if (!(await isFeatureEnabled(user.id, "campaigns", isFeatureBypassUser(user)))) return res.status(404).json({ message: "Not found" });
      const id = parseInt(req.params.id);
      await storage.deleteCampaign(id);
      res.json({ message: "Deleted" });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("get", "/api/campaigns/:id/steps"); app.get("/api/campaigns/:id/steps", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      if (!(await isFeatureEnabled(user.id, "campaigns", isFeatureBypassUser(user)))) return res.status(404).json({ message: "Not found" });
      const id = parseInt(req.params.id);
      const rows = await storage.getCampaignSteps(id);
      res.json(rows);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("put", "/api/campaigns/:id/steps"); app.put("/api/campaigns/:id/steps", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      if (!(await isFeatureEnabled(user.id, "campaigns", isFeatureBypassUser(user)))) return res.status(404).json({ message: "Not found" });
      const id = parseInt(req.params.id);
      const schema = z.object({
        steps: z.array(
          z.object({
            stepOrder: z.number().int().min(0),
            channel: z.enum(["sms", "email"]),
            offsetDays: z.number().int().min(0).default(0),
            sendWindowStart: z.string().trim().regex(/^\d{2}:\d{2}$/).optional().nullable(),
            sendWindowEnd: z.string().trim().regex(/^\d{2}:\d{2}$/).optional().nullable(),
            templateText: z.string().default(""),
          }),
        ),
      });
      const payload = schema.parse(req.body || {});
      const rows = await storage.replaceCampaignSteps(
        id,
        payload.steps.map((s) => ({
          campaignId: id,
          stepOrder: s.stepOrder,
          channel: s.channel,
          offsetDays: s.offsetDays,
          sendWindowStart: s.sendWindowStart || null,
          sendWindowEnd: s.sendWindowEnd || null,
          templateText: s.templateText || "",
        })) as any,
      );
      res.json(rows);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("post", "/api/campaigns/:id/enroll"); app.post("/api/campaigns/:id/enroll", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      if (!(await isFeatureEnabled(user.id, "campaigns", isFeatureBypassUser(user)))) return res.status(404).json({ message: "Not found" });
      const id = parseInt(req.params.id);
      const schema = z.object({ leadIds: z.array(z.number().int().positive()).min(1) });
      const payload = schema.parse(req.body || {});
      await storage.enrollCampaignLeads(id, payload.leadIds);
      await storage.createGlobalActivity({
        userId: user.id,
        action: "campaign_enrolled",
        description: `Enrolled ${payload.leadIds.length} lead(s) into campaign`,
        metadata: JSON.stringify({ campaignId: id, leadIds: payload.leadIds }),
      } as any);
      res.json({ enrolled: payload.leadIds.length });
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  // Real audience preview: counts leads matching the builder filters and
  // breaks out DNC/opt-out vs missing-consent exclusions. Replaces the old
  // client-side fabricated fallback numbers.
  reg("post", "/api/campaigns/:id/audience-preview"); app.post("/api/campaigns/:id/audience-preview", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      if (!(await isFeatureEnabled(user.id, "campaigns", isFeatureBypassUser(user)))) return res.status(404).json({ message: "Not found" });
      const filters = Array.isArray((req.body as any)?.filters) ? (req.body as any).filters : [];
      // Safe allowlist: only real leads columns, exact or ILIKE match.
      const allowed: Record<string, { col: string; like: boolean }> = {
        source: { col: "source", like: true },
        status: { col: "status", like: false },
        state: { col: "state", like: false },
        county: { col: "county", like: true },
        leadType: { col: "lead_type", like: false },
        assignedTo: { col: "assigned_to", like: false },
      };
      // Column names come from the hardcoded allowlist above (never user input);
      // values are bound as drizzle parameters.
      const conds: any[] = [];
      for (const f of filters) {
        const spec = allowed[String((f as any)?.field || "")];
        const rawVal = String((f as any)?.value || "").trim();
        if (!spec || !rawVal) continue;
        const col = sql.raw(`"${spec.col}"`);
        if (spec.col === "assigned_to") {
          const n = parseInt(rawVal, 10);
          if (!Number.isFinite(n)) continue;
          conds.push(sql`${col} = ${n}`);
        } else if (spec.like) {
          conds.push(sql`${col} ILIKE ${`%${rawVal}%`}`);
        } else {
          conds.push(sql`${col} = ${rawVal}`);
        }
      }
      const where = conds.length ? sql`WHERE ${sql.join(conds, sql` AND `)}` : sql``;
      const out: any = await db.execute(sql`
        SELECT
          COUNT(*)::int AS total,
          SUM(CASE WHEN do_not_call OR do_not_text OR do_not_email THEN 1 ELSE 0 END)::int AS dnc_excluded,
          SUM(CASE WHEN NOT (do_not_call OR do_not_text OR do_not_email)
            AND sms_consent IS NOT TRUE AND email_consent IS NOT TRUE THEN 1 ELSE 0 END)::int AS no_consent_excluded
        FROM leads
        ${where}
      `);
      const row = ((out as any).rows || [])[0] || {};
      const total = Number(row.total || 0);
      const dnc = Number(row.dnc_excluded || 0);
      const noConsent = Number(row.no_consent_excluded || 0);
      res.json({ count: total, eligible: Math.max(0, total - dnc - noConsent), excluded: dnc + noConsent, dncExcluded: dnc, noConsentExcluded: noConsent });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  reg("get", "/api/campaigns/:id/stats"); app.get("/api/campaigns/:id/stats", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      if (!(await isFeatureEnabled(user.id, "campaigns", isFeatureBypassUser(user)))) return res.status(404).json({ message: "Not found" });
      const id = parseInt(req.params.id);
      const stats = await storage.getCampaignStats(id);
      // Ticket 15: enrich with broadcast recipient + cost stats.
      try {
        const b: any = await db.execute(sql`
          SELECT
            COUNT(*)::int AS recipients,
            SUM(CASE WHEN status='sent' THEN 1 ELSE 0 END)::int AS b_sent,
            SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END)::int AS b_failed,
            SUM(CASE WHEN status IN ('opted_out','skipped') THEN 1 ELSE 0 END)::int AS b_excluded,
            SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END)::int AS b_pending,
            COALESCE(SUM(cost_cents),0)::int AS b_cost_cents
          FROM campaign_recipients WHERE campaign_id = ${id}
        `);
        const br = ((b as any).rows || [])[0] || {};
        (stats as any).broadcast = {
          recipients: Number(br.recipients || 0),
          sent: Number(br.b_sent || 0),
          failed: Number(br.b_failed || 0),
          excluded: Number(br.b_excluded || 0),
          pending: Number(br.b_pending || 0),
          costCents: Number(br.b_cost_cents || 0),
        };
      } catch {}
      res.json(stats);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // ── Ticket 15: Broadcast campaign endpoints ──────────────────────────
  // PUT alias for campaign update (PATCH already exists above).
  reg("put", "/api/campaigns/:id"); app.put("/api/campaigns/:id", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      if (!(await isFeatureEnabled(user.id, "campaigns", isFeatureBypassUser(user)))) return res.status(404).json({ message: "Not found" });
      const id = parseInt(req.params.id);
      const schema = z.object({
        name: z.string().trim().min(1).max(120).optional(),
        description: z.string().max(2000).nullable().optional(),
        channel: z.enum(["sms", "email"]).optional(),
        status: z.string().trim().min(1).max(20).optional(),
        scheduledAt: z.string().nullable().optional(),
        audienceFilters: z.array(z.object({ field: z.string(), value: z.string() })).optional(),
        audience: z.enum(["leads", "buyers", "both"]).optional(),
        pilotMode: z.boolean().optional(),
        pilotLimit: z.number().int().min(1).max(500).optional(),
      });
      const payload = schema.parse(req.body || {});
      const patch: any = {};
      if (payload.name !== undefined) patch.name = payload.name;
      if (payload.description !== undefined) patch.description = payload.description;
      if (payload.channel !== undefined) patch.channel = payload.channel;
      if (payload.status !== undefined) patch.status = payload.status;
      if (payload.scheduledAt !== undefined) patch.scheduledAt = payload.scheduledAt ? new Date(payload.scheduledAt) : null;
      if (payload.audienceFilters !== undefined) patch.audienceFilters = payload.audienceFilters;
      if (payload.audience !== undefined) patch.audience = payload.audience;
      if (payload.pilotMode !== undefined) patch.pilotMode = payload.pilotMode;
      if (payload.pilotLimit !== undefined) patch.pilotLimit = payload.pilotLimit;
      const row = await storage.updateCampaign(id, patch);
      res.json(row);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });

  // Exact-recipient preview: the FULL list with per-recipient exclusion reasons.
  // Nothing is sent from this endpoint; it also persists the recipient list.
  reg("post", "/api/campaigns/:id/audience/preview"); app.post("/api/campaigns/:id/audience/preview", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      if (!(await isFeatureEnabled(user.id, "campaigns", isFeatureBypassUser(user)))) return res.status(404).json({ message: "Not found" });
      const id = parseInt(req.params.id);
      const schema = z.object({
        channel: z.enum(["sms", "email"]).default("sms"),
        audience: z.enum(["leads", "buyers", "both"]).default("leads"),
        filters: z.array(z.object({ field: z.string(), value: z.string() })).default([]),
      });
      const { channel, audience: aud, filters } = schema.parse(req.body || {});
      const { buildAudience, persistRecipients, estimateCost } = await import("./campaigns/audience.js");
      const preview = await buildAudience({ channel, audience: aud, filters });
      const persisted = await persistRecipients(id, preview);
      await db.execute(sql`UPDATE campaigns SET channel=${channel}, audience_filters=${JSON.stringify(filters)}::jsonb, updated_at=now() WHERE id=${id}`);
      const cost = estimateCost(channel, preview.eligible);
      res.json({ ...preview, persisted, cost });
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });

  // Save/update the broadcast message body.
  reg("put", "/api/campaigns/:id/message"); app.put("/api/campaigns/:id/message", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      if (!(await isFeatureEnabled(user.id, "campaigns", isFeatureBypassUser(user)))) return res.status(404).json({ message: "Not found" });
      const id = parseInt(req.params.id);
      const schema = z.object({
        subject: z.string().max(255).nullable().optional(),
        body: z.string().min(1).max(5000),
      });
      const { subject, body } = schema.parse(req.body || {});
      await db.execute(sql`
        INSERT INTO campaign_messages (campaign_id, subject, body)
        VALUES (${id}, ${subject || null}, ${body})
        ON CONFLICT (campaign_id) DO UPDATE SET subject=${subject || null}, body=${body}
      `);
      res.json({ ok: true });
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });

  // Schedule a broadcast for a future time.
  reg("post", "/api/campaigns/:id/schedule"); app.post("/api/campaigns/:id/schedule", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      if (!(await isFeatureEnabled(user.id, "campaigns", isFeatureBypassUser(user)))) return res.status(404).json({ message: "Not found" });
      const id = parseInt(req.params.id);
      const schema = z.object({ scheduledAt: z.string().min(1) });
      const { scheduledAt } = schema.parse(req.body || {});
      const when = new Date(scheduledAt);
      if (!Number.isFinite(when.getTime()) || when.getTime() <= Date.now()) {
        return res.status(400).json({ message: "scheduledAt must be a future date/time" });
      }
      await db.execute(sql`UPDATE campaigns SET scheduled_at=${when.toISOString()}, status='scheduled', updated_at=now() WHERE id=${id}`);
      res.json({ ok: true, scheduledAt: when.toISOString(), status: "scheduled" });
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });

  // Start a broadcast send now (runs in background; pause/cancel take effect immediately).
  reg("post", "/api/campaigns/:id/send"); app.post("/api/campaigns/:id/send", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      if (!(await isFeatureEnabled(user.id, "campaigns", isFeatureBypassUser(user)))) return res.status(404).json({ message: "Not found" });
      const id = parseInt(req.params.id);
      const cur: any = await db.execute(sql`SELECT status FROM campaigns WHERE id=${id} LIMIT 1`);
      const status = ((cur as any).rows || [])[0]?.status;
      if (status === "sending") return res.status(409).json({ message: "Campaign is already sending" });
      if (!["draft", "scheduled", "paused", "failed"].includes(String(status))) {
        return res.status(409).json({ message: `Cannot send from status '${status}'` });
      }
      const { runBroadcast } = await import("./campaigns/sender.js");
      // Fire-and-forget: the run checks pause/cancel before every message.
      runBroadcast(id, user.id).catch((e) => console.error(`[campaign ${id}] broadcast failed:`, e?.message || e));
      res.json({ ok: true, message: "Broadcast started" });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // Immediate pause — the sender checks status before every message.
  reg("post", "/api/campaigns/:id/pause"); app.post("/api/campaigns/:id/pause", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      if (!(await isFeatureEnabled(user.id, "campaigns", isFeatureBypassUser(user)))) return res.status(404).json({ message: "Not found" });
      const id = parseInt(req.params.id);
      await db.execute(sql`UPDATE campaigns SET status='paused', updated_at=now() WHERE id=${id}`);
      res.json({ ok: true, status: "paused" });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  reg("post", "/api/campaigns/:id/resume"); app.post("/api/campaigns/:id/resume", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      if (!(await isFeatureEnabled(user.id, "campaigns", isFeatureBypassUser(user)))) return res.status(404).json({ message: "Not found" });
      const id = parseInt(req.params.id);
      const { runBroadcast } = await import("./campaigns/sender.js");
      runBroadcast(id, user.id).catch((e) => console.error(`[campaign ${id}] resume failed:`, e?.message || e));
      res.json({ ok: true, message: "Broadcast resumed" });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  reg("post", "/api/campaigns/:id/cancel"); app.post("/api/campaigns/:id/cancel", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      if (!(await isFeatureEnabled(user.id, "campaigns", isFeatureBypassUser(user)))) return res.status(404).json({ message: "Not found" });
      const id = parseInt(req.params.id);
      await db.execute(sql`UPDATE campaigns SET status='cancelled', updated_at=now() WHERE id=${id}`);
      await db.execute(sql`UPDATE campaign_recipients SET status='skipped', error='Campaign cancelled' WHERE campaign_id=${id} AND status='pending'`);
      res.json({ ok: true, status: "cancelled" });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // Paginated recipient list for the exact-recipient preview UI.
  reg("get", "/api/campaigns/:id/recipients"); app.get("/api/campaigns/:id/recipients", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      if (!(await isFeatureEnabled(user.id, "campaigns", isFeatureBypassUser(user)))) return res.status(404).json({ message: "Not found" });
      const id = parseInt(req.params.id);
      const limit = Math.min(parseInt(String(req.query.limit || "100"), 10) || 100, 500);
      const offset = Math.max(parseInt(String(req.query.offset || "0"), 10) || 0, 0);
      const statusFilter = String(req.query.status || "").trim();
      const where = statusFilter ? sql`AND status = ${statusFilter}` : sql``;
      const out: any = await db.execute(sql`
        SELECT cr.id, cr.recipient_type, cr.lead_id, cr.buyer_id, cr.phone, cr.email,
               cr.status, cr.sent_at, cr.error, cr.cost_cents,
               COALESCE(l.owner_name, b.name, 'Unknown') AS name
        FROM campaign_recipients cr
        LEFT JOIN leads l ON cr.lead_id = l.id
        LEFT JOIN buyers b ON cr.buyer_id = b.id
        WHERE cr.campaign_id = ${id} ${where}
        ORDER BY cr.id ASC LIMIT ${limit} OFFSET ${offset}
      `);
      const cnt: any = await db.execute(sql`SELECT COUNT(*)::int AS c FROM campaign_recipients WHERE campaign_id=${id} ${where}`);
      res.json({ recipients: ((out as any).rows || []), total: Number((((cnt as any).rows || [])[0] || {}).c || 0) });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  function inSendWindow(now: Date, start?: string | null, end?: string | null) {
    const s = String(start || "").trim();
    const e = String(end || "").trim();
    if (!/^\d{2}:\d{2}$/.test(s) || !/^\d{2}:\d{2}$/.test(e)) return true;
    const [sh, sm] = s.split(":").map(Number)
    const [eh, em] = e.split(":").map(Number)
    if (![sh, sm, eh, em].every((n) => Number.isFinite(n))) return true;
    const mins = now.getHours() * 60 + now.getMinutes();
    const startM = sh * 60 + sm;
    const endM = eh * 60 + em;
    if (startM <= endM) return mins >= startM && mins <= endM;
    return mins >= startM || mins <= endM;
  }
  reg("get", "/api/rvm/audio-assets"); app.get("/api/rvm/audio-assets", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      if (!(await isFeatureEnabled(user.id, "rvm", isFeatureBypassUser(user)))) return res.status(404).json({ message: "Not found" });
      const rows = await storage.getRvmAudioAssets(user.id);
      res.json(rows.map((r: any) => ({ id: r.id, name: r.name, mimeType: r.mimeType, createdAt: r.createdAt })));
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("post", "/api/rvm/audio-assets"); app.post("/api/rvm/audio-assets", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      if (!(await isFeatureEnabled(user.id, "rvm", isFeatureBypassUser(user)))) return res.status(404).json({ message: "Not found" });
      const schema = z.object({
        name: z.string().trim().min(1).max(120),
        mimeType: z.string().trim().min(1).max(120),
        contentBase64: z.string().trim().min(1),
      });
      const payload = schema.parse(req.body || {});
      const row = await storage.createRvmAudioAsset({ userId: user.id, ...payload } as any);
      res.status(201).json({ id: row.id, name: row.name, mimeType: row.mimeType, createdAt: row.createdAt });
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("delete", "/api/rvm/audio-assets/:id"); app.delete("/api/rvm/audio-assets/:id", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      if (!(await isFeatureEnabled(user.id, "rvm", isFeatureBypassUser(user)))) return res.status(404).json({ message: "Not found" });
      const id = parseInt(req.params.id);
      await storage.deleteRvmAudioAsset(id);
      res.json({ message: "Deleted" });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("get", "/api/rvm/campaigns"); app.get("/api/rvm/campaigns", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      if (!(await isFeatureEnabled(user.id, "rvm", isFeatureBypassUser(user)))) return res.status(404).json({ message: "Not found" });
      const rows = await storage.getRvmCampaigns(user.id);
      res.json(rows);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("post", "/api/rvm/campaigns"); app.post("/api/rvm/campaigns", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      if (!(await isFeatureEnabled(user.id, "rvm", isFeatureBypassUser(user)))) return res.status(404).json({ message: "Not found" });
      const schema = z.object({
        name: z.string().trim().min(1).max(120),
        sendWindowStart: z.string().trim().regex(/^\d{2}:\d{2}$/).optional().nullable(),
        sendWindowEnd: z.string().trim().regex(/^\d{2}:\d{2}$/).optional().nullable(),
        dailyCap: z.number().int().min(1).max(100000).optional(),
        audioAssetId: z.number().int().positive().optional().nullable(),
      });
      const payload = schema.parse(req.body || {});
      const row = await storage.createRvmCampaign({
        userId: user.id,
        name: payload.name,
        status: "draft",
        sendWindowStart: payload.sendWindowStart || null,
        sendWindowEnd: payload.sendWindowEnd || null,
        dailyCap: payload.dailyCap ?? 500,
        audioAssetId: payload.audioAssetId ?? null,
      } as any);
      res.status(201).json(row);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("patch", "/api/rvm/campaigns/:id"); app.patch("/api/rvm/campaigns/:id", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      if (!(await isFeatureEnabled(user.id, "rvm", isFeatureBypassUser(user)))) return res.status(404).json({ message: "Not found" });
      const id = parseInt(req.params.id);
      const schema = z.object({
        name: z.string().trim().min(1).max(120).optional(),
        status: z.string().trim().min(1).max(20).optional(),
        sendWindowStart: z.string().trim().regex(/^\d{2}:\d{2}$/).optional().nullable(),
        sendWindowEnd: z.string().trim().regex(/^\d{2}:\d{2}$/).optional().nullable(),
        dailyCap: z.number().int().min(1).max(100000).optional(),
        audioAssetId: z.number().int().positive().optional().nullable(),
      });
      const payload = schema.parse(req.body || {});
      const row = await storage.updateRvmCampaign(id, payload as any);
      res.json(row);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("delete", "/api/rvm/campaigns/:id"); app.delete("/api/rvm/campaigns/:id", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      if (!(await isFeatureEnabled(user.id, "rvm", isFeatureBypassUser(user)))) return res.status(404).json({ message: "Not found" });
      const id = parseInt(req.params.id);
      await storage.deleteRvmCampaign(id);
      res.json({ message: "Deleted" });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("get", "/api/rvm/campaigns/:id/drops"); app.get("/api/rvm/campaigns/:id/drops", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      if (!(await isFeatureEnabled(user.id, "rvm", isFeatureBypassUser(user)))) return res.status(404).json({ message: "Not found" });
      const id = parseInt(req.params.id);
      const rows = await storage.getRvmCampaignDrops(id, 200);
      res.json(rows);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("post", "/api/rvm/campaigns/:id/launch"); app.post("/api/rvm/campaigns/:id/launch", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      if (!(await isFeatureEnabled(user.id, "rvm", isFeatureBypassUser(user)))) return res.status(404).json({ message: "Not found" });
      const id = parseInt(req.params.id);
      const schema = z.object({
        leadIds: z.array(z.number().int().positive()).min(1),
        audioAssetId: z.number().int().positive().optional().nullable(),
      });
      const payload = schema.parse(req.body || {});
      const campaignRows: any = await db.execute(sql`
        SELECT id, user_id, name, send_window_start, send_window_end, daily_cap, audio_asset_id
        FROM rvm_campaigns
        WHERE id = ${id}
        LIMIT 1
      `);
      const campaign = (campaignRows as any).rows?.[0];
      if (!campaign) return res.status(404).json({ message: "Campaign not found" });
      if (Number(campaign.user_id) !== user.id) return res.status(403).json({ message: "Forbidden" });
      const audioAssetId = payload.audioAssetId || Number(campaign.audio_asset_id || 0);
      if (!audioAssetId) return res.status(400).json({ message: "Audio asset is required" });
      const now = new Date();
      if (!inSendWindow(now, campaign.send_window_start, campaign.send_window_end)) {
        return res.status(400).json({ message: "Outside allowed send window" });
      }
      const todayRows: any = await db.execute(sql`
        SELECT COUNT(*)::int AS cnt
        FROM rvm_drops d
        JOIN rvm_campaigns c ON c.id = d.campaign_id
        WHERE c.user_id = ${user.id}
          AND d.requested_at >= date_trunc('day', NOW())
      `);
      const todayCount = Number((todayRows as any).rows?.[0]?.cnt || 0);
      const dailyCap = Number(campaign.daily_cap || 0) || 500;
      const remaining = Math.max(0, dailyCap - todayCount);
      if (remaining <= 0) return res.status(400).json({ message: "Daily RVM cap reached" });
      const toLaunch = payload.leadIds.slice(0, remaining);
      // NOTE: do not use `= ANY(${toLaunch})` — the Neon serverless driver does not
      // serialize JS arrays as Postgres arrays (code 42809). Explicit IN list instead.
      const leadsRows: any = await db.execute(sql`
        SELECT id, owner_phone, do_not_call, do_not_text
        FROM leads
        WHERE id IN (${sql.join(
          toLaunch.map((id: number) => sql`${id}`),
          sql`, `,
        )})
      `);
      const leadRows = (leadsRows as any).rows || [];
      const eligible: { leadId: number; to: string }[] = [];
      const failed: any[] = [];
      for (const r of leadRows) {
        const leadId = Number(r.id);
        const phone = String(r.owner_phone || "").trim();
        const blocked = !!r.do_not_call || !!r.do_not_text;
        if (blocked) {
          failed.push({ leadId, reason: "DNC" });
          continue;
        }
        if (!phone) {
          failed.push({ leadId, reason: "Missing phone" });
          continue;
        }
        eligible.push({ leadId, to: phone });
      }
      const provider = getRvmProvider();
      const results = await provider.requestDrops({ audioAssetId, toNumbers: eligible.map((x) => x.to) });
      const nowIso = new Date();
      const dropsToInsert: any[] = [];
      for (const e of eligible) {
        const r = results.find((x) => x.toNumber === e.to);
        const status = r?.status || "failed";
        dropsToInsert.push({
          campaignId: id,
          leadId: e.leadId,
          toNumber: e.to,
          status,
          providerId: r?.providerId || null,
          requestedAt: nowIso,
          completedAt: status === "sent" || status === "failed" ? nowIso : null,
          error: r?.error || null,
        });
      }
      for (const f of failed) {
        dropsToInsert.push({
          campaignId: id,
          leadId: f.leadId,
          toNumber: "",
          status: "failed",
          providerId: null,
          requestedAt: nowIso,
          completedAt: nowIso,
          error: f.reason,
        });
      }
      await storage.createRvmDrops(dropsToInsert as any);
      await storage.updateRvmCampaign(id, { status: "launched", audioAssetId } as any);
      await storage.createGlobalActivity({
        userId: user.id,
        action: "rvm_campaign_launched",
        description: `RVM campaign launched: ${String(campaign.name || "")}`,
        metadata: JSON.stringify({ campaignId: id, requested: payload.leadIds.length, eligible: eligible.length, failed: failed.length }),
      } as any);
      res.json({ requested: payload.leadIds.length, launched: eligible.length, failed: failed.length, cappedAt: remaining });
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("post", "/api/sync"); app.post("/api/sync", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      if (!(await isFeatureEnabled(user.id, "field_mode", isFeatureBypassUser(user)))) return res.status(404).json({ message: "Not found" });
      const schema = z.object({
        actions: z.array(
          z.object({
            idempotencyKey: z.string().trim().min(1).max(120),
            type: z.enum(["create_lead", "add_note", "enroll_campaign", "skip_trace_lead", "upload_media"]),
            payload: z.any(),
          }),
        ),
      });
      const payload = schema.parse(req.body || {});
      const results: any[] = [];
      for (const a of payload.actions) {
        const existing = await storage.getSyncIdempotency(user.id, a.idempotencyKey);
        if (existing) {
          try {
            results.push(JSON.parse(String((existing as any).responseJson || "{}")));
          } catch {
            results.push({ idempotencyKey: a.idempotencyKey, ok: false, error: "Invalid cached response" });
          }
          continue;
        }
        let out: any = { idempotencyKey: a.idempotencyKey, ok: true };
        try {
          if (a.type === "create_lead") {
            const leadSchema = insertLeadSchema.extend({ source: z.string().trim().min(1) });
            const leadInput = leadSchema.parse(a.payload || {});
            const dedupeKey = computeLeadDedupeKey(leadInput as any);
            const lead = await storage.createLead({ ...(leadInput as any), dedupeKey } as any);
            out = { ...out, leadId: lead.id };
          } else if (a.type === "add_note") {
            const s = z.object({ leadId: z.number().int().positive(), note: z.string().trim().min(1) });
            const p = s.parse(a.payload || {});
            const lead = await storage.getLeadById(p.leadId);
            if (!lead) throw new Error("Lead not found");
            const cur = String((lead as any).notes || "");
            const next = cur ? `${cur}\n\n${p.note}` : p.note;
            await storage.updateLead(p.leadId, { notes: next } as any);
            out = { ...out, leadId: p.leadId };
          } else if (a.type === "enroll_campaign") {
            const s = z.object({ campaignId: z.number().int().positive(), leadId: z.number().int().positive() });
            const p = s.parse(a.payload || {});
            if (!(await isFeatureEnabled(user.id, "campaigns", isFeatureBypassUser(user)))) throw new Error("Campaigns disabled");
            await storage.enrollCampaignLeads(p.campaignId, [p.leadId]);
            out = { ...out, campaignId: p.campaignId, leadId: p.leadId };
          } else if (a.type === "skip_trace_lead") {
            const s = z.object({ leadId: z.number().int().positive() });
            const p = s.parse(a.payload || {});
            if (!(await isFeatureEnabled(user.id, "skip_trace", isFeatureBypassUser(user)))) throw new Error("Skip trace disabled");
            const r = await runProviderSkipTraceForEntity({ entityType: "lead", entityId: p.leadId, requestedByUserId: user.id });
            if ("pending" in r && r.pending) {
              out = { ...out, pending: true, cached: false, skipTraceId: (r.providerResult as any).id };
            } else {
              out = { ...out, cached: r.cached, skipTraceId: (r.providerResult as any).id };
            }
          } else if (a.type === "upload_media") {
            const s = z.object({
              leadId: z.number().int().positive().optional().nullable(),
              kind: z.enum(["photo", "voice"]),
              mimeType: z.string().trim().min(1).max(120),
              contentBase64: z.string().trim().min(1),
            });
            const p = s.parse(a.payload || {});
            const row = await storage.createFieldMediaAsset({
              userId: user.id,
              leadId: p.leadId ?? null,
              kind: p.kind,
              mimeType: p.mimeType,
              contentBase64: p.contentBase64,
            } as any);
            out = { ...out, mediaId: row.id };
          }
        } catch (e: any) {
          out = { idempotencyKey: a.idempotencyKey, ok: false, error: String(e?.message || e) };
        }
        await storage.createSyncIdempotency({ userId: user.id, idempotencyKey: a.idempotencyKey, responseJson: JSON.stringify(out) } as any);
        results.push(out);
      }
      res.json({ results });
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("post", "/api/leads"); app.post("/api/leads", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const validated = insertLeadSchema.parse(req.body) as InsertLead;
      const source = String((validated as any).source || "").trim();
      if (!source || source === "__custom__") {
        return res.status(400).json({ message: "Lead source is required" });
      }
      const assignedTo = (validated as any).assignedTo;
      if (typeof assignedTo === "number") {
        const ok = await requireAssigneeInActiveTeam(req, res, user, assignedTo);
        if (!ok) return;
      }
      const dedupeKey = computeLeadDedupeKey(validated as any);
      try {
        const dupRows: any = await db.execute(sql`
          SELECT id FROM leads
          WHERE dedupe_key = ${dedupeKey}
          LIMIT 1
        `);
        if ((dupRows as any).rows?.length) {
          const existingId = (dupRows as any).rows[0].id;
          return res.status(409).json({ message: "Duplicate lead: address and owner already exist", leadId: existingId });
        }
      } catch {}
      const lead = await storage.createLead({ ...(validated as any), dedupeKey } as any);
      
      if (req.session.userId) {
        await storage.createGlobalActivity({
          userId: req.session.userId,
          action: "created_lead",
          description: `Added new lead: ${lead.address}`,
          metadata: JSON.stringify({ leadId: lead.id, address: lead.address }),
        });
      }
      try {
        await onLeadCreated({
          leadId: lead.id,
          leadAddress: String(lead.address || "").trim(),
          assignedTo: (lead as any).assignedTo ?? null,
          createdBy: Number(req.session.userId || 0),
        });
      } catch {}
      try {
        const teamId = await getOrInitActiveTeamId(req, user.id);
        if (teamId) {
          await dispatchAutomationEvent({
            eventType: "lead.created",
            teamId,
            actorUserId: user.id,
            entity: { type: "lead", id: lead.id },
            payload: { lead },
          });
        }
      } catch {}
      
      res.status(201).json(lead);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("patch", "/api/leads/:id"); app.patch("/api/leads/:id", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const partial = insertLeadSchema.partial().parse(req.body) as Partial<InsertLead>;
      const id = parseInt(req.params.id);
      const assignedTo = (partial as any).assignedTo;
      if (typeof assignedTo === "number") {
        const ok = await requireAssigneeInActiveTeam(req, res, user, assignedTo);
        if (!ok) return;
      }
      const before = await storage.getLeadById(id);
      if (before) {
        const merged: any = { ...before, ...(partial as any) };
        if (merged.address && merged.city && merged.state && merged.zipCode && merged.ownerName) {
          (partial as any).dedupeKey = computeLeadDedupeKey(merged);
        }
      }
      const lead = await storage.updateLead(id, partial);
      try {
        const property = await storage.getPropertyBySourceLeadId(id);
        if (property) {
          const propertyPatch: any = {};
          if (typeof partial.address !== 'undefined') propertyPatch.address = partial.address;
          if (typeof partial.city !== 'undefined') propertyPatch.city = partial.city;
          if (typeof partial.state !== 'undefined') propertyPatch.state = partial.state;
          if (typeof partial.zipCode !== 'undefined') propertyPatch.zipCode = partial.zipCode;
          if (Object.keys(propertyPatch).length) {
            await storage.updateProperty(property.id, propertyPatch);
            console.log(`[link] propagated lead ${id} fields to property ${property.id}`);
          }
        }
      } catch {}
      
      if (req.session.userId) {
        const onlyNotesChanged = before && typeof partial.notes !== 'undefined' && partial.notes !== before.notes && Object.keys(partial).length === 1;
        const action = onlyNotesChanged ? "added_note" : "updated_lead";
        const description = onlyNotesChanged ? `Added note to lead: ${lead.address}` : `Updated lead: ${lead.address}`;
        await storage.createGlobalActivity({
          userId: req.session.userId,
          action,
          description,
          metadata: JSON.stringify({ leadId: lead.id, address: lead.address }),
        });
      }
      try {
        await onLeadStatusChanged({
          leadId: lead.id,
          leadAddress: String(lead.address || "").trim(),
          beforeStatus: (before as any)?.status ?? null,
          afterStatus: (lead as any)?.status ?? null,
          assignedTo: (lead as any)?.assignedTo ?? null,
          actorUserId: Number(req.session.userId || 0),
        });
      } catch {}
      try {
        const beforeStatus = String((before as any)?.status || "");
        const afterStatus = String((lead as any)?.status || "");
        if (beforeStatus !== afterStatus) {
          const teamId = await getOrInitActiveTeamId(req, user.id);
          if (teamId) {
            await dispatchAutomationEvent({
              eventType: "lead.status_changed",
              teamId,
              actorUserId: user.id,
              entity: { type: "lead", id: lead.id },
              payload: { leadId: lead.id, beforeStatus: beforeStatus || null, afterStatus: afterStatus || null, lead },
            });
            try {
              await writeAuditEvent({
                teamId,
                actorUserId: user.id,
                entityType: "lead",
                entityId: lead.id,
                action: "lead_status_changed",
                before: { status: beforeStatus || null },
                after: { status: afterStatus || null },
                kind: "update",
                ip: req.ip,
                userAgent: String(req.headers["user-agent"] || ""),
                requestId: (res.locals as any)?.requestId || null,
              });
            } catch {}
          }
        }
      } catch {}
      
      res.json(lead);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("delete", "/api/leads/:id"); app.delete("/api/leads/:id", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const lead = await storage.getLeadById(parseInt(req.params.id));
      await storage.deleteLead(parseInt(req.params.id));
      
      if (req.session.userId && lead) {
        await storage.createGlobalActivity({
          userId: req.session.userId,
          action: "deleted_lead",
          description: `Deleted lead: ${lead.address}`,
          metadata: JSON.stringify({ leadId: lead.id, address: lead.address }),
        });
      }
      
      res.json({ message: "Lead deleted" });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  // Convert lead to property (lead must be under_contract status)
  reg("post", "/api/leads/:id/convert-to-property"); app.post("/api/leads/:id/convert-to-property", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const leadId = parseInt(req.params.id);
      const lead = await storage.getLeadById(leadId);
      
      if (!lead) {
        return res.status(404).json({ message: "Lead not found" });
      }
      
      // Check if property already exists from this lead (DB has unique index but check first for better UX)
      const existingProperty = await storage.getPropertyBySourceLeadId(leadId);
      if (existingProperty) {
        return res.status(409).json({ 
          message: "Opportunity already exists for this lead",
          propertyId: existingProperty.id
        });
      }
      
      // Create property from lead data - validate with schema. The sourceLeadId
      // link carries owner contacts, score, and notes into the opportunity's
      // deal room (the detail route resolves the linked lead).
      const propertyData = insertPropertySchema.parse({
        address: lead.address,
        city: lead.city,
        state: lead.state,
        zipCode: lead.zipCode,
        price: lead.estimatedValue || null,
        status: "active",
        sourceLeadId: lead.id,
        leadSource: (lead as any).source || null,
        notes: lead.notes || null,
      });
      
      const property = await storage.createProperty(propertyData);
      
      // Log activity
      if (req.session.userId) {
        await storage.createGlobalActivity({
          userId: req.session.userId,
          action: "converted_lead_to_property",
          description: `Converted lead to property: ${property.address}`,
          metadata: JSON.stringify({ 
            leadId: lead.id, 
            propertyId: property.id, 
            address: property.address 
          }),
        });
      }
      try {
        const teamId = await getOrInitActiveTeamId(req, user.id);
        if (teamId) {
          await dispatchAutomationEvent({
            eventType: "opportunity.created",
            teamId,
            actorUserId: user.id,
            entity: { type: "opportunity", id: property.id },
            payload: { opportunity: property, source: "lead.convert_to_property", leadId: lead.id },
          });
          try {
            await writeAuditEvent({
              teamId,
              actorUserId: user.id,
              entityType: "opportunity",
              entityId: property.id,
              action: "opportunity_created",
              before: null,
              after: property,
              kind: "create",
              ip: req.ip,
              userAgent: String(req.headers["user-agent"] || ""),
              requestId: (res.locals as any)?.requestId || null,
            });
          } catch {}
        }
      } catch {}
      
      res.status(201).json({ 
        message: "Lead successfully converted to property",
        property 
      });
    } catch (error: any) {
      // Handle unique constraint violation
      if (error.code === '23505') {
        return res.status(409).json({ message: "Property already exists for this lead" });
      }
      res.status(500).json({ message: error.message });
    }
  });
  // OPPORTUNITIES ENDPOINTS (New Terminology)
  reg("get", "/api/opportunities"); app.get("/api/opportunities", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const { limit, offset } = parseLimitOffset(req.query);
      const assignedToRaw = typeof req.query?.assignedTo === "string" ? req.query.assignedTo : "";
      const assignedTo = assignedToRaw ? parseInt(assignedToRaw, 10) : undefined;
      const allProperties = await storage.getProperties(limit, offset, assignedTo);
      res.json(
        (allProperties || []).map((p: any) => ({
          ...p,
          images: resolvePropertyImages((p as any).images),
        })),
      );
    } catch (error: any) {
      console.error("GET /api/opportunities failed:", error);
      if (isDbConnectivityError(error)) {
        return res.status(503).json({ message: "Database is unavailable" });
      }
      res.status(500).json({ message: error.message });
    }
  });
  reg("get", "/api/opportunities/:id"); app.get("/api/opportunities/:id", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const id = parseInt(req.params.id);
      const property = await storage.getPropertyById(id);
      if (!property) return res.status(404).json({ message: "Opportunity not found" });
      let lead: any = null;
      if (property.sourceLeadId) {
        try {
          lead = await storage.getLeadById(property.sourceLeadId);
        } catch {}
      }
      res.json({ property: { ...(property as any), images: resolvePropertyImages((property as any).images) }, lead });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("get", "/api/opportunities/:id/companies"); app.get("/api/opportunities/:id/companies", async (req, res) => {
    try {
      const ctx = await requireActiveTeam(req, res, { minRole: "viewer" });
      if (!ctx) return;
      const opportunityId = parseInt(req.params.id, 10);
      const links = await storage.listCompanyLinksForEntity({ teamId: ctx.teamId, entityType: "opportunity", entityId: opportunityId });
      res.json(links);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("post", "/api/opportunities/:id/companies"); app.post("/api/opportunities/:id/companies", async (req, res) => {
    try {
      const ctx = await requireActiveTeam(req, res, { minRole: "member" });
      if (!ctx) return;
      const opportunityId = parseInt(req.params.id, 10);
      const schema = insertCompanyLinkSchema.omit({ teamId: true, entityType: true, entityId: true } as any);
      const validated: any = schema.parse(req.body || {});
      const companyId = Number(validated.companyId);
      const company = await storage.getCompanyById(companyId);
      if (!company || company.teamId !== ctx.teamId) return res.status(404).json({ message: "Company not found" });
      const link = await storage.createCompanyLink({
        teamId: ctx.teamId,
        companyId,
        entityType: "opportunity",
        entityId: opportunityId,
        role: typeof validated.role === "string" ? validated.role : null,
      } as any);
      try {
        await writeAuditEvent({
          teamId: ctx.teamId,
          actorUserId: ctx.user.id,
          entityType: "opportunity",
          entityId: opportunityId,
          action: "opportunity_company_link_added",
          before: null,
          after: link,
          kind: "update",
          ip: req.ip,
          userAgent: String(req.headers["user-agent"] || ""),
          requestId: (res.locals as any)?.requestId || null,
        });
      } catch {}
      res.status(201).json(link);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("delete", "/api/opportunities/:id/companies/:linkId"); app.delete("/api/opportunities/:id/companies/:linkId", async (req, res) => {
    try {
      const ctx = await requireActiveTeam(req, res, { minRole: "member" });
      if (!ctx) return;
      const opportunityId = parseInt(req.params.id, 10);
      const linkId = parseInt(req.params.linkId, 10);
      const existing = await storage.listCompanyLinksForEntity({ teamId: ctx.teamId, entityType: "opportunity", entityId: opportunityId });
      const target = existing.find((r: any) => Number(r.link?.id) === linkId);
      if (!target) return res.status(404).json({ message: "Not found" });
      await storage.deleteCompanyLinkForTeam(ctx.teamId, linkId);
      try {
        await writeAuditEvent({
          teamId: ctx.teamId,
          actorUserId: ctx.user.id,
          entityType: "opportunity",
          entityId: opportunityId,
          action: "opportunity_company_link_removed",
          before: target.link,
          after: null,
          kind: "update",
          ip: req.ip,
          userAgent: String(req.headers["user-agent"] || ""),
          requestId: (res.locals as any)?.requestId || null,
        });
      } catch {}
      res.json({ ok: true });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("get", "/api/property-photos/:key"); app.get("/api/property-photos/:key", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const key = decodeURIComponent(String(req.params.key || ""));
      if (!key) return res.status(400).json({ message: "Missing photo key" });
      // Prefer S3 (signed redirect). Fall back to the DB blob store (stream).
      const url = await getPropertyPhotoSignedUrl(key);
      if (url) return res.redirect(url);
      const content = await getPropertyPhotoContent(key);
      if (!content) return res.status(404).json({ message: "Not found" });
      if (content.contentType) res.setHeader("Content-Type", content.contentType);
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      return res.end(content.body);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("post", "/api/opportunities/:id/photos"); app.post("/api/opportunities/:id/photos", upload.array("photos", 20), async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const opportunityId = parseInt(req.params.id, 10);
      const property = await storage.getPropertyById(opportunityId);
      if (!property) return res.status(404).json({ message: "Opportunity not found" });
      const files = Array.isArray((req as any).files) ? ((req as any).files as any[]) : [];
      if (!files.length) return res.status(400).json({ message: "No files uploaded" });
      const existingRaw = Array.isArray((property as any).images) ? (property as any).images.filter(Boolean) : [];
      const uploaded: string[] = [];
      for (const f of files) {
        const out = await uploadPropertyPhoto({
          opportunityId,
          contentType: String(f.mimetype || "application/octet-stream"),
          body: f.buffer,
          originalName: String(f.originalname || "photo"),
        });
        uploaded.push(`property-photo:${out.storageKey}`);
      }
      const updated = await storage.updateProperty(opportunityId, { images: [...uploaded, ...existingRaw] } as any);
      res.json({ property: { ...(updated as any), images: resolvePropertyImages((updated as any).images) } });
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("get", "/api/opportunities/:id/skip-trace/latest"); app.get("/api/opportunities/:id/skip-trace/latest", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      if (!(await isFeatureEnabled(user.id, "skip_trace", isFeatureBypassUser(user)))) return res.status(404).json({ message: "Not found" });
      const propertyId = parseInt(req.params.id);
      const property = await storage.getPropertyById(propertyId);
      if (!property) return res.status(404).json({ message: "Opportunity not found" });
      const row = await storage.getLatestSkipTraceForProperty(propertyId);
      if (!row) return res.json(null);
      return res.json({
        ...row,
        phones: parseJsonArrayText((row as any).phonesJson),
        emails: parseJsonArrayText((row as any).emailsJson),
      });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("post", "/api/opportunities/:id/skip-trace"); app.post("/api/opportunities/:id/skip-trace", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      if (!(await isFeatureEnabled(user.id, "skip_trace", isFeatureBypassUser(user)))) return res.status(404).json({ message: "Not found" });
      const propertyId = parseInt(req.params.id);
      const ownerNameOverride = req.body?.ownerName ? String(req.body.ownerName).trim() : null;
      const out = await runProviderSkipTraceForEntity({ entityType: "opportunity", entityId: propertyId, requestedByUserId: user.id, ownerNameOverride });
      if ("pending" in out && out.pending) {
        return res.json({ pending: true, result: hydrateSkipTraceResultForApi(out.providerResult as any) });
      }
      return res.json({ cached: out.cached, result: hydrateSkipTraceResultForApi(out.providerResult as any) });
    } catch (error: any) {
      if (isHttpError(error)) return res.status(error.statusCode).json({ message: error.message });
      res.status(500).json({ message: error.message });
    }
  });
  reg("get", "/api/opportunities/:id/comps/snapshots"); app.get("/api/opportunities/:id/comps/snapshots", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const opportunityId = parseInt(req.params.id, 10);
      const rows = await storage.getCompSnapshotRowsByOpportunity(opportunityId, 500);
      if (!rows.length) return res.json({ avgArv: null, avgRent: null, saleComps: [], rentalComps: [] });
      const ids = Array.from(new Set(rows.map((r: any) => ((r as any).compPropertyId != null ? Number((r as any).compPropertyId) : NaN)).filter(Number.isFinite)));
      const compsById = new Map<number, any>();
      if (ids.length) {
        const idSql = sql.join(ids.map((id) => sql`${id}`), sql`, `);
        const out: any = await db.execute(sql`
          SELECT id, address, city, state, zip_code, sqft, beds, baths, year_built, property_type, sold_price, sold_date, rent_per_month, rented_date, latitude, longitude
          FROM properties
          WHERE id IN (${idSql})
        `);
        for (const r of (out as any).rows || []) compsById.set(Number(r.id), r);
      }
      const sale: any[] = [];
      const rental: any[] = [];
      for (const r of rows) {
        const comp = (r as any).compPropertyId != null ? compsById.get(Number((r as any).compPropertyId)) || null : null;
        const base = {
          id: (r as any).id,
          compPropertyId: (r as any).compPropertyId != null ? Number((r as any).compPropertyId) : null,
          distanceMiles: toNumberOrNull((r as any).distanceMiles),
          soldPrice: toNumberOrNull((r as any).soldPrice),
          soldDate: (r as any).soldDate ?? null,
          rentPerMonth: toNumberOrNull((r as any).rentPerMonth),
          isRentalComp: !!(r as any).isRentalComp,
          isManual: !!(r as any).isManual,
          manualAddress: (r as any).manualAddress ?? null,
          manualCity: (r as any).manualCity ?? null,
          manualState: (r as any).manualState ?? null,
          manualZip: (r as any).manualZip ?? null,
          manualSqft: toNumberOrNull((r as any).manualSqft),
          manualBeds: toNumberOrNull((r as any).manualBeds),
          manualBaths: toNumberOrNull((r as any).manualBaths),
          manualSource: (r as any).manualSource ?? null,
          manualNotes: (r as any).manualNotes ?? null,
          comp,
        };
        if (base.isRentalComp) rental.push(base);
        else sale.push(base);
      }
      const avg = (vals: Array<number | null>) => {
        const xs = vals.filter((x): x is number => typeof x === "number" && Number.isFinite(x));
        if (!xs.length) return null;
        return xs.reduce((a, b) => a + b, 0) / xs.length;
      };
      const avgArv = avg(sale.map((x) => x.soldPrice));
      const avgRent = avg(rental.map((x) => x.rentPerMonth));
      res.json({ avgArv, avgRent, saleComps: sale, rentalComps: rental });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("post", "/api/opportunities/:id/comps/pull"); app.post("/api/opportunities/:id/comps/pull", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const opportunityId = parseInt(req.params.id, 10);
      const property = await storage.getPropertyById(opportunityId);
      if (!property) return res.status(404).json({ message: "Opportunity not found" });
      const dealSqft = typeof (property as any).sqft === "number" ? (property as any).sqft : (property as any).sqft ? Number((property as any).sqft) : null;
      const dealType = String((property as any).propertyType || "").trim();
      const dealLat = toNumberOrNull((property as any).latitude);
      const dealLng = toNumberOrNull((property as any).longitude);
      if (!dealSqft || !Number.isFinite(dealSqft)) return res.status(400).json({ message: "Opportunity is missing square footage" });
      if (!dealType) return res.status(400).json({ message: "Opportunity is missing property type" });
      if (dealLat === null || dealLng === null) return res.status(400).json({ message: "Opportunity is missing latitude/longitude" });
      const saleMinSqft = Math.floor(dealSqft * 0.85);
      const saleMaxSqft = Math.ceil(dealSqft * 1.15);
      const rentMinSqft = Math.floor(dealSqft * 0.8);
      const rentMaxSqft = Math.ceil(dealSqft * 1.2);
      const saleOut: any = await db.execute(sql`
        SELECT id, latitude, longitude, sqft, sold_price, sold_date
        FROM properties
        WHERE id <> ${opportunityId}
          AND property_type = ${dealType}
          AND sqft IS NOT NULL
          AND sqft >= ${saleMinSqft} AND sqft <= ${saleMaxSqft}
          AND sold_price IS NOT NULL
          AND sold_date IS NOT NULL
          AND sold_date >= (CURRENT_DATE - INTERVAL '6 months')
          AND latitude IS NOT NULL AND longitude IS NOT NULL
      `);
      const rentalOut: any = await db.execute(sql`
        SELECT id, latitude, longitude, sqft, rent_per_month, rented_date
        FROM properties
        WHERE id <> ${opportunityId}
          AND property_type = ${dealType}
          AND sqft IS NOT NULL
          AND sqft >= ${rentMinSqft} AND sqft <= ${rentMaxSqft}
          AND rent_per_month IS NOT NULL
          AND rented_date IS NOT NULL
          AND rented_date >= (CURRENT_DATE - INTERVAL '12 months')
          AND latitude IS NOT NULL AND longitude IS NOT NULL
      `);
      const dealPoint = { lat: dealLat, lng: dealLng };
      const saleRows = ((saleOut as any).rows || [])
        .map((r: any) => {
          const d = haversineMiles(dealPoint, { lat: toNumberOrNull(r.latitude) ?? 0, lng: toNumberOrNull(r.longitude) ?? 0 });
          return { ...r, distanceMiles: d };
        })
        .filter((r: any) => Number.isFinite(r.distanceMiles) && r.distanceMiles <= 1)
        .sort((a: any, b: any) => a.distanceMiles - b.distanceMiles)
        .slice(0, 25);
      const rentalRows = ((rentalOut as any).rows || [])
        .map((r: any) => {
          const d = haversineMiles(dealPoint, { lat: toNumberOrNull(r.latitude) ?? 0, lng: toNumberOrNull(r.longitude) ?? 0 });
          return { ...r, distanceMiles: d };
        })
        .filter((r: any) => Number.isFinite(r.distanceMiles) && r.distanceMiles <= 2)
        .sort((a: any, b: any) => a.distanceMiles - b.distanceMiles)
        .slice(0, 25);
      const rowsToPersist: any[] = [
        ...saleRows.map((r: any) => ({
          compPropertyId: Number(r.id),
          distanceMiles: String(Number(r.distanceMiles).toFixed(3)),
          soldPrice: r.sold_price != null ? String(r.sold_price) : null,
          soldDate: r.sold_date ?? null,
          isRentalComp: false,
          rentPerMonth: null,
        })),
        ...rentalRows.map((r: any) => ({
          compPropertyId: Number(r.id),
          distanceMiles: String(Number(r.distanceMiles).toFixed(3)),
          soldPrice: null,
          soldDate: null,
          isRentalComp: true,
          rentPerMonth: r.rent_per_month != null ? String(r.rent_per_month) : null,
        })),
      ];
      await storage.replaceCompSnapshotRows(opportunityId, rowsToPersist as any);
      const avg = (vals: Array<number | null>) => {
        const xs = vals.filter((x): x is number => typeof x === "number" && Number.isFinite(x));
        if (!xs.length) return null;
        return xs.reduce((a, b) => a + b, 0) / xs.length;
      };
      const avgArv = avg(saleRows.map((r: any) => toNumberOrNull(r.sold_price)));
      const avgRent = avg(rentalRows.map((r: any) => toNumberOrNull(r.rent_per_month)));
      res.json({ avgArv, avgRent, saleCount: saleRows.length, rentalCount: rentalRows.length });
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });

  // Manual comp entry: the documented fallback when the internal pull finds
  // nothing. Manual comps are REAL user-entered data — address, a price signal,
  // and the source are all required. Never fabricated; flagged is_manual so the
  // UI badges them and the internal pull never overwrites them.
  reg("post", "/api/opportunities/:id/comps/manual"); app.post("/api/opportunities/:id/comps/manual", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const opportunityId = parseInt(req.params.id, 10);
      const property = await storage.getPropertyById(opportunityId);
      if (!property) return res.status(404).json({ message: "Opportunity not found" });
      const checked = validateManualCompInput((req.body || {}) as any);
      if (!checked.ok) return res.status(400).json({ message: "Invalid manual comp", errors: (checked as any).errors });
      const v = checked.value;
      const row = await storage.insertCompSnapshotRow({
        opportunityId,
        compPropertyId: null,
        distanceMiles: null,
        soldPrice: v.soldPrice != null ? String(v.soldPrice) : null,
        soldDate: v.soldDate,
        isRentalComp: v.isRentalComp,
        rentPerMonth: v.rentPerMonth != null ? String(v.rentPerMonth) : null,
        isManual: true,
        manualAddress: v.address,
        manualCity: v.city,
        manualState: v.state,
        manualZip: v.zip,
        manualSqft: v.sqft,
        manualBeds: v.beds,
        manualBaths: v.baths != null ? String(v.baths) : null,
        manualSource: v.source,
        manualNotes: v.notes,
      } as any);
      res.status(201).json({ ok: true, id: (row as any).id });
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  // Buyer-match recompute now delegates to the shared engine service
  // (server/services/buyerMatch/recompute.ts) — same route contract,
  // human-readable reasons from scoreBuyerMatch.
  async function recomputeBuyerMatches(opportunityId: number) {
    return recomputeBuyerMatchesForOpportunity(opportunityId);
  }
  reg("get", "/api/opportunities/:id/buyer-matches"); app.get("/api/opportunities/:id/buyer-matches", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const propertyId = parseInt(req.params.id);
      const rows = await storage.getDealBuyerMatches(propertyId, 25);
      res.json(
        (rows || []).map((r: any) => ({
          ...r,
          matchScore: typeof r.score === "number" ? r.score / 1000 : toNumberOrNull(r.score) !== null ? (toNumberOrNull(r.score) as number) / 1000 : 0,
          reasons: Array.isArray(r.reasons) ? r.reasons : [],
        })),
      );
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("post", "/api/opportunities/:id/buyer-matches/recompute"); app.post("/api/opportunities/:id/buyer-matches/recompute", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const propertyId = parseInt(req.params.id);
      const matches = await recomputeBuyerMatches(propertyId);
      res.json({ ok: true, count: matches.length });
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  // ── Lead-to-buyer matching (0097) ─────────────────────────────────────────
  reg("get", "/api/leads/:id/buyer-matches"); app.get("/api/leads/:id/buyer-matches", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const leadId = parseInt(req.params.id);
      if (!Number.isFinite(leadId)) return res.status(400).json({ message: "Invalid lead id" });
      const { getLeadBuyerMatches } = await import("./services/buyerMatch/matchLead.js");
      const matches = await getLeadBuyerMatches(leadId);
      res.json({ items: matches });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("post", "/api/leads/:id/buyer-matches/recompute"); app.post("/api/leads/:id/buyer-matches/recompute", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const leadId = parseInt(req.params.id);
      if (!Number.isFinite(leadId)) return res.status(400).json({ message: "Invalid lead id" });
      const { matchBuyersToLead } = await import("./services/buyerMatch/matchLead.js");
      const matches = await matchBuyersToLead(leadId);
      res.json({ ok: true, count: matches.length, matches: matches.slice(0, 10) });
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("post", "/api/opportunities"); app.post("/api/opportunities", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const validated = insertPropertySchema.parse(req.body);
      const dedupeKey = computeOpportunityDedupeKey(validated as any);
      const assignedTo = (validated as any).assignedTo;
      if (typeof assignedTo === "number") {
        const ok = await requireAssigneeInActiveTeam(req, res, user, assignedTo);
        if (!ok) return;
      }
      try {
        const dupRows: any = await db.execute(sql`
          SELECT id FROM properties
          WHERE dedupe_key = ${dedupeKey}
          LIMIT 1
        `);
        if ((dupRows as any).rows?.length) {
          const existingId = (dupRows as any).rows[0].id;
          return res.status(409).json({ message: "Duplicate opportunity: address already exists", opportunityId: existingId });
        }
      } catch {}
      const property = await storage.createProperty({ ...(validated as any), dedupeKey } as any);
      
      if (req.session.userId) {
        await storage.createGlobalActivity({
          userId: req.session.userId,
          action: "created_opportunity",
          description: `Added new opportunity: ${property.address}`,
          metadata: JSON.stringify({ propertyId: property.id, address: property.address }),
        });
      }
      try {
        const teamId = await getOrInitActiveTeamId(req, user.id);
        if (teamId) {
          await dispatchAutomationEvent({
            eventType: "opportunity.created",
            teamId,
            actorUserId: user.id,
            entity: { type: "opportunity", id: property.id },
            payload: { opportunity: property },
          });
          try {
            await writeAuditEvent({
              teamId,
              actorUserId: user.id,
              entityType: "opportunity",
              entityId: property.id,
              action: "opportunity_created",
              before: null,
              after: property,
              kind: "create",
              ip: req.ip,
              userAgent: String(req.headers["user-agent"] || ""),
              requestId: (res.locals as any)?.requestId || null,
            });
          } catch {}
        }
      } catch {}
      
      res.status(201).json(property);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("patch", "/api/opportunities/:id"); app.patch("/api/opportunities/:id", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const partial = insertPropertySchema.partial().parse(req.body);
      const id = parseInt(req.params.id);
      const assignedTo = (partial as any).assignedTo;
      if (typeof assignedTo === "number") {
        const ok = await requireAssigneeInActiveTeam(req, res, user, assignedTo);
        if (!ok) return;
      }
      const before = await storage.getPropertyById(id);
      if (before) {
        const merged: any = { ...(before as any), ...(partial as any) };
        if (merged.address && merged.city && merged.state && merged.zipCode) {
          (partial as any).dedupeKey = computeOpportunityDedupeKey(merged);
        }
      }
      const property = await storage.updateProperty(id, partial);

      // Keep the disposition board honest: an opportunity whose contract was
      // closed (Close Deal & Record Revenue) should leave the pipeline as sold.
      // stage-change transitions are still validated separately.
      if ((partial as any).opportunityStatus === "closed" && property && (property as any).stage !== "sold" && (property as any).stage !== "closed" && (property as any).stage !== "dead" && (property as any).stage !== "voided") {
        try {
          await storage.updateProperty(id, { stage: "sold", stageChangedAt: new Date(), lastActivityAt: new Date() } as any);
        } catch {}
      }

      if (req.session.userId) {
        const onlyNotesChanged = before && typeof (partial as any).notes !== "undefined" && (partial as any).notes !== (before as any).notes && Object.keys(partial as any).length === 1;
        const action = onlyNotesChanged ? "added_note" : "updated_opportunity";
        const description = onlyNotesChanged ? `Added note to opportunity: ${property.address}` : `Updated opportunity: ${property.address}`;
        await storage.createGlobalActivity({
          userId: req.session.userId,
          action,
          description,
          metadata: JSON.stringify({ propertyId: property.id, address: property.address }),
        });
      }
      try {
        const beforeStatus = String((before as any)?.status || "");
        const afterStatus = String((property as any)?.status || "");
        if (beforeStatus !== afterStatus) {
          const teamId = await getOrInitActiveTeamId(req, user.id);
          if (teamId) {
            await dispatchAutomationEvent({
              eventType: "opportunity.status_changed",
              teamId,
              actorUserId: user.id,
              entity: { type: "opportunity", id: property.id },
              payload: { opportunityId: property.id, beforeStatus: beforeStatus || null, afterStatus: afterStatus || null, opportunity: property },
            });
            try {
              await writeAuditEvent({
                teamId,
                actorUserId: user.id,
                entityType: "opportunity",
                entityId: property.id,
                action: "opportunity_status_changed",
                before: { status: beforeStatus || null },
                after: { status: afterStatus || null },
                kind: "update",
                ip: req.ip,
                userAgent: String(req.headers["user-agent"] || ""),
                requestId: (res.locals as any)?.requestId || null,
              });
            } catch {}
          }
        }
      } catch {}
      
      res.json(property);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("delete", "/api/opportunities/:id"); app.delete("/api/opportunities/:id", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const property = await storage.getPropertyById(parseInt(req.params.id));
      await storage.deleteProperty(parseInt(req.params.id));
      
      if (req.session.userId && property) {
        await storage.createGlobalActivity({
          userId: req.session.userId,
          action: "deleted_opportunity",
          description: `Deleted opportunity: ${property.address}`,
          metadata: JSON.stringify({ propertyId: property.id, address: property.address }),
        });
      }
      
      res.json({ message: "Opportunity deleted" });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  // OPPORTUNITY STAGE WORKFLOW
  reg("post", "/api/opportunities/:id/stage-change"); app.post("/api/opportunities/:id/stage-change", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const propertyId = parseInt(req.params.id, 10);
      const { stage, notes } = req.body || {};
      const newStage = String(stage || "").trim();
      if (!isValidStage(newStage)) {
        return res.status(400).json({ message: "Invalid stage" });
      }
      const property = await storage.getPropertyById(propertyId);
      if (!property) return res.status(404).json({ message: "Opportunity not found" });
      const oldStage = (property as any).stage || "lead";
      if (!canTransitionStage(oldStage, newStage)) {
        return res.status(400).json({ message: `Cannot transition from '${oldStage}' to '${newStage}'` });
      }
      if ((newStage === "dead" || newStage === "voided") && !String(notes || "").trim()) {
        return res.status(400).json({ message: `A reason is required to move to '${newStage}'. Add notes describing why the deal is ${newStage}.` });
      }
      const now = new Date();
      await storage.updateProperty(propertyId, {
        stage: newStage,
        stageChangedAt: now,
        lastActivityAt: now,
      });
      await logOpportunityEvent(
        propertyId,
        "stage_changed",
        `Stage changed to ${OPPORTUNITY_STAGE_CONFIG[newStage]?.label || newStage}`,
        notes || `Moved from '${oldStage}' to '${newStage}'`,
        user.id,
        "user",
        { oldStage, newStage },
      );
      try {
        const teamId = await getOrInitActiveTeamId(req, user.id);
        if (teamId) {
          await dispatchAutomationEvent({
            eventType: "opportunity.stage_changed",
            teamId,
            actorUserId: user.id,
            entity: { type: "opportunity", id: propertyId },
            payload: { oldStage, newStage, opportunity: { ...(property as any), stage: newStage } },
          });
          await writeAuditEvent({
            teamId,
            actorUserId: user.id,
            entityType: "opportunity",
            entityId: propertyId,
            action: "opportunity_stage_changed",
            before: { stage: oldStage },
            after: { stage: newStage },
            kind: "update",
            ip: req.ip,
            userAgent: String(req.headers["user-agent"] || ""),
            requestId: (res.locals as any)?.requestId || null,
          });
        }
      } catch {}
      // Notify the assigned owner about high-impact stage transitions (deduped per stage).
      if (["under_contract", "in_disposition", "reserved", "sold", "closed", "dead", "voided"].includes(newStage)) {
        await notifyOpportunityOwner({
          propertyId,
          category: "stage_changed",
          title: `Opportunity moved to ${OPPORTUNITY_STAGE_CONFIG[newStage]?.label || newStage}`,
          description: `${(property as any)?.address || `Opportunity #${propertyId}`} moved from '${oldStage}' to '${newStage}'.${notes ? ` Reason: ${notes}` : ""}`,
          eventKey: `stage:${propertyId}:${newStage}`,
          actorUserId: user.id,
        });
      }
      // Stage-specific automations (idempotent). Every task is created through
      // ensureOpportunityTask which skips creation when an identical title already
      // exists for this opportunity, so re-saves and stage back/forth do not
      // duplicate checklist items.
      const stageNow = new Date();
      const day = 24 * 60 * 60 * 1000;
      if (newStage === "under_contract") {
        await logOpportunityEvent(propertyId, "under_contract_entered", "Entered Under Contract", "Opportunity is now under contract. Check due diligence items.", user.id, "user", { oldStage });
        const inspectionDue = new Date(stageNow.getTime() + 10 * day);
        const emdDue = new Date(stageNow.getTime() + 3 * day);
        const ddDefs = [
          { title: "[Due Diligence] Deposit Earnest Money (EMD)", type: "due_diligence", priority: "high", dueAt: emdDue },
          { title: "[Due Diligence] Schedule Property Inspection", type: "due_diligence", priority: "high", dueAt: inspectionDue },
          { title: "[Due Diligence] Review Title Report", type: "due_diligence", priority: "medium", dueAt: new Date(stageNow.getTime() + 7 * day) },
          { title: "[Due Diligence] Secure Financing", type: "due_diligence", priority: "medium", dueAt: new Date(stageNow.getTime() + 5 * day) },
          { title: "[Due Diligence] Order Appraisal", type: "due_diligence", priority: "medium", dueAt: new Date(stageNow.getTime() + 3 * day) },
          { title: "[Due Diligence] Coordinate Walk-Through", type: "due_diligence", priority: "low", dueAt: inspectionDue },
        ];
        let ddCreated = 0;
        for (const d of ddDefs) {
          if (await ensureOpportunityTask(propertyId, user.id, d)) ddCreated += 1;
        }
        if (ddCreated > 0) {
          await logOpportunityEvent(propertyId, "checklist_created", "Due Diligence Checklist Created", `Auto-created ${ddCreated} due diligence tasks for under_contract stage.`, user.id, "system", { count: ddCreated });
        }
        if (await ensureOpportunityTask(propertyId, user.id, { title: "[Disposition] Create public listing for investors", type: "disposition", priority: "high", dueAt: new Date(stageNow.getTime() + 2 * day) })) {
          await logOpportunityEvent(propertyId, "disposition_checklist_created", "Disposition Checklist Created", "Auto-created disposition task (create public listing).", user.id, "system", {});
        }
      }
      if (newStage === "in_disposition") {
        await logOpportunityEvent(propertyId, "disposition_started", "Started Disposition", "Opportunity is now in the disposition phase.", user.id, "user", { oldStage });
        try {
          const listings = await storage.getPublicListingsByOpportunity(propertyId);
          if (!listings.some((l: any) => l.status === "published")) {
            await logOpportunityEvent(propertyId, "listing_required", "Create Public Listing", "No published public listing exists. Create or publish a listing to begin buyer outreach.", user.id, "system", {});
          }
        } catch {}
        if (await ensureOpportunityTask(propertyId, user.id, { title: "[Disposition] Buyer outreach & follow up", type: "disposition", priority: "high", dueAt: new Date(stageNow.getTime() + 1 * day) })) {
          await logOpportunityEvent(propertyId, "buyer_outreach_task_created", "Buyer Outreach Task Created", "Auto-created buyer outreach task for disposition.", user.id, "system", {});
        }
      }
      if (newStage === "reserved") {
        await logOpportunityEvent(propertyId, "reserved_entered", "Opportunity Reserved", "A buyer has committed. Coordinate closing and confirm the assignment.", user.id, "user", { oldStage });
        const closingDefs = [
          { title: "[Closing] Confirm buyer commitment / EMD", type: "closing", priority: "high", dueAt: new Date(stageNow.getTime() + 2 * day) },
          { title: "[Closing] Coordinate title & closing", type: "closing", priority: "high", dueAt: new Date(stageNow.getTime() + 7 * day) },
          { title: "[Closing] Order closing documents", type: "closing", priority: "medium", dueAt: new Date(stageNow.getTime() + 5 * day) },
        ];
        let closingCreated = 0;
        for (const d of closingDefs) {
          if (await ensureOpportunityTask(propertyId, user.id, d)) closingCreated += 1;
        }
        if (closingCreated > 0) {
          await logOpportunityEvent(propertyId, "closing_checklist_created", "Closing Coordination Checklist Created", `Auto-created ${closingCreated} closing coordination tasks.`, user.id, "system", { count: closingCreated });
        }
      }
      if (newStage === "sold" || newStage === "closed") {
        await logOpportunityEvent(
          propertyId,
          newStage === "sold" ? "sold_entered" : "closed_entered",
          newStage === "sold" ? "Opportunity Sold" : "Deal Closed",
          newStage === "sold" ? "Opportunity moved to sold. Record proceeds and archive listing." : "Deal closed. Wrap up documents and disburse funds.",
          user.id,
          "user",
          { oldStage },
        );
        try {
          const fresh = await storage.getPropertyById(propertyId);
          if (fresh && !(fresh as any).closingDate) {
            await storage.updateProperty(propertyId, { closingDate: stageNow });
          }
        } catch {}
        // DEV-002: a pipeline close (stage -> sold/closed without the Close
        // Deal flow) must still leave a per-deal ledger row, otherwise closed
        // deals vanish from revenue entirely. Never overwrite an existing
        // closed row's fee — the Close Deal flow owns the actuals.
        try {
          const existing = await storage.getDealAssignmentsByPropertyId(propertyId);
          const hasClosed = (existing || []).some((r: any) => String((r as any).status) === "closed");
          if (!hasClosed) {
            const prior = (existing || [])[0] || null;
            const payload = {
              propertyId,
              status: "closed",
              closingDate: stageNow,
              notes: `Recorded automatically on stage change to '${newStage}'. Update with the actual fee via Close Deal & Record Revenue.`,
              updatedAt: stageNow,
            };
            if (prior) await storage.updateDealAssignment(prior.id, payload as any);
            else await storage.createDealAssignment(payload as any);
          }
        } catch (e: any) {
          console.error("stage-change: deal_assignments ledger write failed:", e?.message);
        }
        try {
          const listings = await storage.getPublicListingsByOpportunity(propertyId);
          for (const l of listings) {
            if (l.status === "published") await storage.updatePublicListing(l.id, { status: "archived" });
          }
        } catch {}
        if (await ensureOpportunityTask(propertyId, user.id, { title: "[Closing] Final deal review & wrap-up", type: "closing", priority: "medium", dueAt: new Date(stageNow.getTime() + 3 * day) })) {
          await logOpportunityEvent(propertyId, "final_review_task_created", "Final Deal Review Task Created", "Auto-created final deal review task.", user.id, "system", {});
        }
      }
      if (newStage === "dead" || newStage === "voided") {
        const reason = String(notes || "").trim();
        await logOpportunityEvent(
          propertyId,
          newStage === "dead" ? "dead_entered" : "voided_entered",
          newStage === "dead" ? "Opportunity Marked Dead" : "Opportunity Voided",
          reason || "No reason provided.",
          user.id,
          "user",
          { oldStage, reason },
        );
        try {
          const listings = await storage.getPublicListingsByOpportunity(propertyId);
          for (const l of listings) {
            if (l.status === "published") await storage.updatePublicListing(l.id, { status: "paused" });
          }
        } catch {}
      }
      const updated = await storage.getPropertyById(propertyId);
      res.json({ property: { ...(updated as any), images: resolvePropertyImages((updated as any).images) }, oldStage, newStage });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  // ===== OPPORTUNITY CLOSE — "Close Deal & Record Revenue" (DEV-002) =====
  // The opportunity-level revenue path: closing a deal from the pipeline
  // (not via a contract document). Records the closing on the
  // deal_assignments ledger, advances the opportunity to sold, and writes
  // activity. The Dashboard / Analytics revenue KPIs read the ledger (plus
  // closed contract documents), so a pipeline close posts revenue too.
  reg("post", "/api/opportunities/:id/close"); app.post("/api/opportunities/:id/close", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const propertyId = parseInt(req.params.id, 10);
      const property = await storage.getPropertyById(propertyId);
      if (!property) return res.status(404).json({ message: "Opportunity not found" });
      const stage = String((property as any).stage || "");
      if (["dead", "voided"].includes(stage)) {
        return res.status(400).json({ message: `Cannot close a deal in stage '${stage}'.` });
      }

      const body = req.body || {};
      const num = (v: any) => {
        const n = parseFloat(String(v ?? "").replace(/[$,]/g, ""));
        return Number.isFinite(n) && n >= 0 ? n.toFixed(2) : null;
      };
      const assignmentFee = num(body.assignmentFee);
      if (assignmentFee === null) {
        return res.status(400).json({ message: "Enter the assignment fee collected (0 or more)." });
      }
      const closingCosts = num(body.closingCosts);
      const buyerPaid = !!body.buyerPaid;
      const titleReceived = !!body.titleReceived;
      const fundsWired = !!body.fundsWired;
      const docsRecorded = !!body.docsRecorded;
      const payoutReceived = buyerPaid && fundsWired && docsRecorded;

      const now = new Date();
      let ledger: any = null;
      try {
        const existing = await storage.getDealAssignmentsByPropertyId(propertyId);
        const prior = (existing || []).find((r: any) => String((r as any).status) === "closed") || (existing || [])[0] || null;
        const payload = {
          propertyId,
          assignmentFee,
          status: "closed",
          closingDate: now,
          earnestMoneyReceived: buyerPaid,
          titleCleared: titleReceived,
          closingScheduled: fundsWired,
          documentsComplete: docsRecorded,
          payoutReceived,
          payoutAmount: payoutReceived ? assignmentFee : null,
          notes: [closingCosts !== null ? `Closing costs: $${Number(closingCosts).toLocaleString()}` : "", body.notes || ""].filter(Boolean).join(" \u2014 ") || null,
          updatedAt: now,
        };
        ledger = prior
          ? await storage.updateDealAssignment(prior.id, payload as any)
          : await storage.createDealAssignment(payload as any);
      } catch (e: any) {
        console.error("opportunity close: deal_assignments ledger write failed:", e?.message);
        return res.status(500).json({ message: "Could not record revenue on the deal ledger." });
      }

      // Advance to sold (same terminal stage as the contract close path).
      let stageAdvanced = false;
      try {
        if (!["sold", "closed", "dead", "voided"].includes(stage)) {
          stageAdvanced = true;
          const patch: any = { stage: "sold", stageChangedAt: now, lastActivityAt: now };
          if (!(property as any).closingDate) patch.closingDate = now;
          await storage.updateProperty(propertyId, patch);
          await logOpportunityEvent(propertyId, "stage_changed", "Stage changed to Sold", `Deal closed; assignment fee $${Number(assignmentFee).toLocaleString()}.`, user.id, "system", { oldStage: stage, newStage: "sold" });
        }
      } catch {}

      try {
        await storage.createGlobalActivity({
          userId: user.id,
          action: "closed_deal",
          description: `Closed deal: ${(property as any).address || `Opportunity #${propertyId}`} \u2014 fee $${Number(assignmentFee).toLocaleString()}`,
          metadata: JSON.stringify({ propertyId, assignmentFee, closingCosts, ledgerId: ledger?.id }),
        } as any);
      } catch {}

      const updated = await storage.getPropertyById(propertyId);
      res.json({ property: updated, ledger, stageAdvanced });
    } catch (error: any) {
      console.error("POST /api/opportunities/:id/close failed:", error);
      res.status(500).json({ message: error.message });
    }
  });
  // Ledger list for the Dashboard / Analytics revenue KPIs (DEV-002: the
  // ledger is a first-class revenue source alongside closed documents).
  reg("get", "/api/deal-assignments"); app.get("/api/deal-assignments", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const { limit, offset } = parseLimitOffset(req.query);
      const status = typeof req.query?.status === "string" ? req.query.status.trim() : "";
      const rows = status
        ? await storage.getDealAssignmentsByStatus(status, limit, offset)
        : await storage.getDealAssignments(limit, offset);
      res.json(rows);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("get", "/api/deal-assignments/:id"); app.get("/api/deal-assignments/:id", async (req, res) => {
    try {
      const actor = await requireAuth(req, res);
      if (!actor) return;
      const assignment = await storage.getDealAssignmentById(parseInt(req.params.id, 10));
      if (!assignment) return res.status(404).json({ message: "Assignment not found" });
      res.json(assignment);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  reg("get", "/api/properties/:propertyId/assignments"); app.get("/api/properties/:propertyId/assignments", async (req, res) => {
    try {
      const actor = await requireAuth(req, res);
      if (!actor) return;
      const { limit, offset } = parseLimitOffset(req.query);
      const assignments = await storage.getDealAssignmentsByPropertyId(parseInt(req.params.propertyId), limit, offset);
      res.json(assignments);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  reg("get", "/api/buyers/:buyerId/assignments"); app.get("/api/buyers/:buyerId/assignments", async (req, res) => {
    try {
      const actor = await requireAuth(req, res);
      if (!actor) return;
      const { limit, offset } = parseLimitOffset(req.query);
      const assignments = await storage.getDealAssignmentsByBuyerId(parseInt(req.params.buyerId), limit, offset);
      res.json(assignments);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  reg("get", "/api/buyers/:id/sms-thread"); app.get("/api/buyers/:id/sms-thread", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ error: "Invalid buyer id", code: "INVALID_BUYER_ID" });
      }
      const messages = await storage.getSmsThreadByBuyer(id);
      res.json({ messages });
    } catch (error: any) {
      console.error("Buyer SMS thread error:", error);
      res.status(500).json({ error: error?.message || "Internal error", code: "INTERNAL_ERROR" });
    }
  });

  reg("post", "/api/deal-assignments"); app.post("/api/deal-assignments", async (req, res) => {
    try {
      const actor = await requireAuth(req, res);
      if (!actor) return;
      const validated = insertDealAssignmentSchema.parse(req.body);
      const assignment = await storage.createDealAssignment(validated);
      res.status(201).json(assignment);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });

  reg("patch", "/api/deal-assignments/:id"); app.patch("/api/deal-assignments/:id", async (req, res) => {
    try {
      const actor = await requireAuth(req, res);
      if (!actor) return;
      const partial = insertDealAssignmentSchema.partial().parse(req.body);
      const assignment = await storage.updateDealAssignment(parseInt(req.params.id, 10), partial);
      res.json(assignment);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });

  reg("delete", "/api/deal-assignments/:id"); app.delete("/api/deal-assignments/:id", async (req, res) => {
    try {
      const actor = await requireAuth(req, res);
      if (!actor) return;
      await storage.deleteDealAssignment(parseInt(req.params.id, 10));
      res.json({ message: "Assignment deleted" });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // OPPORTUNITY PARTIES
  reg("get", "/api/opportunities/:id/parties"); app.get("/api/opportunities/:id/parties", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const opportunityId = parseInt(req.params.id, 10);
      const property = await storage.getPropertyById(opportunityId);
      if (!property) return res.status(404).json({ message: "Opportunity not found" });
      const parties = await storage.getOpportunityParties(opportunityId);
      res.json(parties);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("post", "/api/opportunities/:id/parties"); app.post("/api/opportunities/:id/parties", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const opportunityId = parseInt(req.params.id, 10);
      const property = await storage.getPropertyById(opportunityId);
      if (!property) return res.status(404).json({ message: "Opportunity not found" });
      const validated = insertOpportunityPartySchema.parse({ ...(req.body || {}), opportunityId });
      const party = await storage.createOpportunityParty(validated as any);
      await logOpportunityEvent(opportunityId, "party_added", "Party added", `Added ${party.role}: ${party.name || party.email || party.phone || ""}`, user.id, "user", { partyId: party.id, role: party.role });
      res.status(201).json(party);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("patch", "/api/opportunities/parties/:partyId"); app.patch("/api/opportunities/parties/:partyId", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const partyId = parseInt(req.params.partyId, 10);
      const party = await storage.getOpportunityPartyById(partyId);
      if (!party) return res.status(404).json({ message: "Party not found" });
      const validated = insertOpportunityPartySchema.partial().parse(req.body || {});
      const updated = await storage.updateOpportunityParty(partyId, validated as any);
      res.json(updated);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("delete", "/api/opportunities/parties/:partyId"); app.delete("/api/opportunities/parties/:partyId", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const partyId = parseInt(req.params.partyId, 10);
      const party = await storage.getOpportunityPartyById(partyId);
      if (!party) return res.status(404).json({ message: "Party not found" });
      await storage.deleteOpportunityParty(partyId);
      await logOpportunityEvent(party.opportunityId, "party_removed", "Party removed", `Removed ${party.role}: ${party.name || party.email || ""} `, user.id, "user", { partyId, role: party.role });
      res.json({ message: "Party removed" });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  // PUBLIC LISTINGS (CRM-facing)
  // PROPERTY UNITS — per-unit rent roll for multi-unit / commercial opportunities
  const COMMERCIAL_UNIT_STATUSES = ["vacant", "occupied", "notice", "renovation", "down"];
  reg("get", "/api/opportunities/:id/units"); app.get("/api/opportunities/:id/units", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const opportunityId = parseInt(req.params.id, 10);
      const property = await storage.getPropertyById(opportunityId);
      if (!property) return res.status(404).json({ message: "Opportunity not found" });
      const units = await storage.getPropertyUnitsByOpportunity(opportunityId);
      res.json(units);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("post", "/api/opportunities/:id/units"); app.post("/api/opportunities/:id/units", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const opportunityId = parseInt(req.params.id, 10);
      const property = await storage.getPropertyById(opportunityId);
      if (!property) return res.status(404).json({ message: "Opportunity not found" });
      // opportunityId must be present at parse time — the schema requires it
      // and the UI derives it from the URL, not the body.
      const validated = insertPropertyUnitSchema.parse({ ...(req.body || {}), opportunityId }) as any;
      if (validated.unitStatus && !COMMERCIAL_UNIT_STATUSES.includes(validated.unitStatus)) {
        return res.status(400).json({ message: `Invalid unit status. Allowed: ${COMMERCIAL_UNIT_STATUSES.join(", ")}` });
      }
      if (!String(validated.unitLabel || "").trim()) {
        return res.status(400).json({ message: "Unit label is required" });
      }
      const unit = await storage.createPropertyUnit({ ...validated, opportunityId } as any);
      await logOpportunityEvent(
        opportunityId,
        "unit_added",
        `Unit ${unit.unitLabel} added`,
        `Added unit ${unit.unitLabel}${unit.rent ? ` at $${Number(unit.rent).toLocaleString()}/mo` : ""} to the rent roll.`,
        user.id,
        "user",
        { unitId: unit.id },
      );
      res.status(201).json(unit);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("patch", "/api/opportunities/:id/units/:unitId"); app.patch("/api/opportunities/:id/units/:unitId", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const opportunityId = parseInt(req.params.id, 10);
      const unitId = parseInt(req.params.unitId, 10);
      const existing = await storage.getPropertyUnitById(unitId);
      if (!existing || existing.opportunityId !== opportunityId) {
        return res.status(404).json({ message: "Unit not found" });
      }
      const validated = insertPropertyUnitSchema.partial().parse(req.body || {}) as any;
      if (validated.unitStatus && !COMMERCIAL_UNIT_STATUSES.includes(validated.unitStatus)) {
        return res.status(400).json({ message: `Invalid unit status. Allowed: ${COMMERCIAL_UNIT_STATUSES.join(", ")}` });
      }
      const unit = await storage.updatePropertyUnit(unitId, validated as any);
      res.json(unit);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("delete", "/api/opportunities/:id/units/:unitId"); app.delete("/api/opportunities/:id/units/:unitId", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const opportunityId = parseInt(req.params.id, 10);
      const unitId = parseInt(req.params.unitId, 10);
      const existing = await storage.getPropertyUnitById(unitId);
      if (!existing || existing.opportunityId !== opportunityId) {
        return res.status(404).json({ message: "Unit not found" });
      }
      await storage.deletePropertyUnit(unitId);
      await logOpportunityEvent(
        opportunityId,
        "unit_removed",
        `Unit ${existing.unitLabel} removed`,
        `Removed unit ${existing.unitLabel} from the rent roll.`,
        user.id,
        "user",
        { unitId },
      );
      res.json({ ok: true });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // COMMISSION SNAPSHOTS — per-agent payout projections on an opportunity.
  // Money columns are recomputed server-side from the validated inputs via
  // computeCommissionMath so stored snapshots are authoritative.
  const round2 = (n: number) => Math.round(n * 100) / 100;
  reg("get", "/api/opportunities/:id/commission-snapshots"); app.get("/api/opportunities/:id/commission-snapshots", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const opportunityId = parseInt(req.params.id, 10);
      const property = await storage.getPropertyById(opportunityId);
      if (!property) return res.status(404).json({ message: "Opportunity not found" });
      const snapshots = await storage.getCommissionSnapshotsByOpportunity(opportunityId);
      res.json(snapshots);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("post", "/api/opportunities/:id/commission-snapshots"); app.post("/api/opportunities/:id/commission-snapshots", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const opportunityId = parseInt(req.params.id, 10);
      const property = await storage.getPropertyById(opportunityId);
      if (!property) return res.status(404).json({ message: "Opportunity not found" });
      const input = commissionSnapshotInputSchema.parse(req.body?.inputs ?? {});
      const math = computeCommissionMath(input);
      const label = typeof req.body?.label === "string" && req.body.label.trim() ? req.body.label.trim().slice(0, 120) : null;
      const notes = typeof req.body?.notes === "string" && req.body.notes.trim() ? req.body.notes.trim().slice(0, 2000) : null;
      const created = await storage.createCommissionSnapshot({
        opportunityId,
        userId: user.id,
        label,
        dealType: input.dealType,
        side: input.side,
        salePrice: round2(input.salePrice).toString(),
        assignmentFee: round2(input.assignmentFee).toString(),
        listingCommissionPct: round2(input.listingCommissionPct).toString(),
        buyerAgentPct: round2(input.buyerAgentPct).toString(),
        referralOutPct: round2(input.referralOutPct).toString(),
        agentSplitPct: round2(input.agentSplitPct).toString(),
        annualCap: round2(input.annualCap).toString(),
        companyDollarYtd: round2(input.companyDollarYtd).toString(),
        transactionFeeFlat: round2(input.transactionFeeFlat).toString(),
        taxReservePct: round2(input.taxReservePct).toString(),
        grossCommission: round2(math.grossCommission).toString(),
        referralFee: round2(math.referralFee).toString(),
        companyDollar: round2(math.companyDollar).toString(),
        capPortionToAgent: round2(math.capPortionToAgent).toString(),
        agentNet: round2(math.agentNet).toString(),
        afterTax: round2(math.afterTax).toString(),
        notes,
      } as any);
      await logOpportunityEvent(
        opportunityId,
        "commission_snapshot_saved",
        `Commission snapshot saved: net $${Math.round(math.agentNet).toLocaleString("en-US")}`,
        `Projected agent net $${Math.round(math.agentNet).toLocaleString("en-US")} (${input.side === "listing" ? "listing" : "buyer"} side, ${input.agentSplitPct}% split).`,
        user.id,
        "user",
        { snapshotId: created.id, agentNet: round2(math.agentNet), afterTax: round2(math.afterTax) },
      );
      res.status(201).json(created);
    } catch (error: any) {
      if (error?.name === "ZodError") return res.status(400).json({ message: "Invalid commission snapshot input", issues: error.issues });
      res.status(500).json({ message: error.message });
    }
  });
  reg("delete", "/api/opportunities/:id/commission-snapshots/:snapshotId"); app.delete("/api/opportunities/:id/commission-snapshots/:snapshotId", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const opportunityId = parseInt(req.params.id, 10);
      const snapshotId = parseInt(req.params.snapshotId, 10);
      const existing = await storage.getCommissionSnapshotById(snapshotId);
      if (!existing || existing.opportunityId !== opportunityId) {
        return res.status(404).json({ message: "Snapshot not found" });
      }
      if (existing.userId !== user.id) {
        return res.status(403).json({ message: "You can only delete your own commission snapshots" });
      }
      await storage.deleteCommissionSnapshot(snapshotId);
      res.json({ ok: true });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  reg("get", "/api/opportunities/:id/listings"); app.get("/api/opportunities/:id/listings", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      // N11: the public_listings feature flag used to be displayed but never
      // enforced — the feature fully worked with the flag off. Gate the
      // CRM-facing listing management surface on it (public token endpoints
      // for external buyers stay open).
      if (!(await isFeatureEnabled(user.id, "public_listings", isFeatureBypassUser(user)))) return res.status(403).json({ message: "Public Listings is not enabled for this account. Ask an administrator to enable the public_listings feature." });
      const opportunityId = parseInt(req.params.id, 10);
      const property = await storage.getPropertyById(opportunityId);
      if (!property) return res.status(404).json({ message: "Opportunity not found" });
      const listings = await storage.getPublicListingsByOpportunity(opportunityId);
      res.json(listings);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("post", "/api/opportunities/:id/listings"); app.post("/api/opportunities/:id/listings", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      if (!(await isFeatureEnabled(user.id, "public_listings", isFeatureBypassUser(user)))) return res.status(403).json({ message: "Public Listings is not enabled for this account. Ask an administrator to enable the public_listings feature." });
      const opportunityId = parseInt(req.params.id, 10);
      const property = await storage.getPropertyById(opportunityId);
      if (!property) return res.status(404).json({ message: "Opportunity not found" });
      const body = req.body || {};
      const slug = String(body.slug || "").trim() || generateSlug(property.address || `opportunity-${opportunityId}`);
      const existing = await storage.getPublicListingBySlug(slug);
      if (existing && existing.opportunityId !== opportunityId) {
        return res.status(400).json({ message: "Slug already in use" });
      }
      const token = body.token || generateListingToken();
      const validated = insertPublicListingSchema.parse({
        ...(body as any),
        opportunityId,
        slug,
        token,
      });
      const listing = await storage.createPublicListing(validated as any);
      await logOpportunityEvent(opportunityId, "listing_created", "Public listing created", `Created listing: ${listing.title || slug}`, user.id, "user", { listingId: listing.id, slug });
      res.status(201).json(listing);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("patch", "/api/listings/:id"); app.patch("/api/listings/:id", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      if (!(await isFeatureEnabled(user.id, "public_listings", isFeatureBypassUser(user)))) return res.status(403).json({ message: "Public Listings is not enabled for this account. Ask an administrator to enable the public_listings feature." });
      const listingId = parseInt(req.params.id, 10);
      const existing = await storage.getPublicListingById(listingId);
      if (!existing) return res.status(404).json({ message: "Listing not found" });
      const validated = insertPublicListingSchema.partial().parse(req.body || {});
      const updated = await storage.updatePublicListing(listingId, validated as any);
      if (req.body?.status === "published" && !existing?.publishedAt) {
        await storage.updatePublicListing(listingId, { publishedAt: new Date(), status: "published" } as any);
        await logOpportunityEvent(existing.opportunityId, "listing_published", "Listing published", "Public listing is now live.", user.id, "user", { listingId });
      }
      if (req.body?.status === "archived") {
        await logOpportunityEvent(existing.opportunityId, "listing_archived", "Listing archived", "Public listing has been archived.", user.id, "user", { listingId });
      }
      res.json(updated);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("delete", "/api/listings/:id"); app.delete("/api/listings/:id", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      if (!(await isFeatureEnabled(user.id, "public_listings", isFeatureBypassUser(user)))) return res.status(403).json({ message: "Public Listings is not enabled for this account. Ask an administrator to enable the public_listings feature." });
      const listingId = parseInt(req.params.id, 10);
      await storage.deletePublicListing(listingId);
      res.json({ message: "Listing deleted" });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  // Log a listing share action to the opportunity timeline.
  reg("post", "/api/listings/:id/share"); app.post("/api/listings/:id/share", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const listingId = parseInt(req.params.id, 10);
      const listing = await storage.getPublicListingById(listingId);
      if (!listing) return res.status(404).json({ message: "Listing not found" });
      const body = req.body || {};
      const channel = String(body.channel || "link").slice(0, 20);
      const target = String(body.target || "").trim().slice(0, 255) || null;
      await logOpportunityEvent(
        listing.opportunityId,
        "listing_shared",
        `Listing shared via ${channel}`,
        target ? `Share link sent to ${target} (${channel}).` : `Share link copied (${channel}).`,
        user.id,
        "user",
        { listingId, channel, target },
      );
      res.json({ ok: true });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  // BUYER INQUIRIES (CRM-facing)
  reg("get", "/api/opportunities/:id/inquiries"); app.get("/api/opportunities/:id/inquiries", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const opportunityId = parseInt(req.params.id, 10);
      const property = await storage.getPropertyById(opportunityId);
      if (!property) return res.status(404).json({ message: "Opportunity not found" });
      const inquiries = await storage.getBuyerInquiries(opportunityId);
      res.json(inquiries);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
reg("patch", "/api/inquiries/:id"); app.patch("/api/inquiries/:id", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const inquiryId = parseInt(req.params.id, 10);
      const inquiry = await storage.getBuyerInquiryById(inquiryId);
      if (!inquiry) return res.status(404).json({ message: "Inquiry not found" });
      const body = req.body || {};
      const INQUIRY_STATUSES = ["new", "contacted", "qualified", "offer_received", "negotiating", "won", "lost", "spam"];
      const patch: Record<string, unknown> = {};
      if (body.status) {
        const status = String(body.status);
        if (!INQUIRY_STATUSES.includes(status)) return res.status(400).json({ message: "Invalid inquiry status" });
        patch.status = status;
      }
      if (body.notes !== undefined) patch.notes = body.notes;
      if (body.assignedToUserId !== undefined) patch.assignedToUserId = body.assignedToUserId === null || body.assignedToUserId === "" ? null : parseInt(body.assignedToUserId, 10);
      const updated = await storage.updateBuyerInquiry(inquiryId, patch as any);
      if (patch.status && patch.status !== (inquiry as any).status) {
        await logOpportunityEvent(
          inquiry.opportunityId,
          "inquiry_status_changed",
          `Inquiry ${String(patch.status).replace("_", " ")}`,
          `${inquiry.name}'s inquiry (${inquiry.email || inquiry.phone || "no contact"}) marked ${String(patch.status).replace("_", " ")}.`,
          user.id,
          "user",
          { inquiryId, from: (inquiry as any).status, to: patch.status },
        );
      }
      res.json(updated);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  // Convert a buyer inquiry into a Buyer contact (dedupe by email/phone) and link
  // it to the opportunity as a buyer party.
  reg("post", "/api/inquiries/:id/convert"); app.post("/api/inquiries/:id/convert", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const inquiryId = parseInt(req.params.id, 10);
      const inquiry = await storage.getBuyerInquiryById(inquiryId);
      if (!inquiry) return res.status(404).json({ message: "Inquiry not found" });
      const email = String(inquiry.email || "").trim().toLowerCase();
      const phone = String(inquiry.phone || "").trim().replace(/[^\d+]/g, "");
      let buyer: any = null;
      let created = false;
      if (email || phone) {
        const existing = await storage.getBuyers(1000);
        buyer = existing.find(
          (b: any) =>
            (email && String(b.email || "").trim().toLowerCase() === email) ||
            (phone && String(b.phone || "").trim().replace(/[^\d+]/g, "") === phone),
        ) || null;
      }
      if (!buyer) {
        buyer = await storage.createBuyer({
          name: String(inquiry.name || "Unknown Buyer"),
          email: email || null,
          phone: inquiry.phone ? String(inquiry.phone).trim() : null,
          company: inquiry.company || null,
          buyerType: String(inquiry.buyerType || "individual"),
          proofOfFunds: Boolean(inquiry.proofOfFundsUrl),
          proofOfFundsNotes: inquiry.proofOfFundsUrl ? `POF from inquiry #${inquiry.id}` : null,
          notes: inquiry.message || null,
          status: "active",
          dedupeKey: email ? `email:${email}` : phone ? `phone:${phone}` : `name:${String(inquiry.name || "").toLowerCase()}`,
        } as any);
        created = true;
      }
      // Link as buyer party (dedupe by email/phone within this opportunity).
      const parties = await storage.getOpportunityParties(inquiry.opportunityId);
      const alreadyParty = parties.some(
        (p: any) =>
          p.role === "buyer" &&
          ((email && String(p.email || "").trim().toLowerCase() === email) ||
            (phone && String(p.phone || "").trim().replace(/[^\d+]/g, "") === phone) ||
            (buyer.id && p.contactId === buyer.id)),
      );
      let party: any = null;
      if (!alreadyParty) {
        party = await storage.createOpportunityParty({
          opportunityId: inquiry.opportunityId,
          contactId: buyer.id,
          role: "buyer",
          name: String(inquiry.name || buyer.name || "Buyer"),
          email: email || null,
          phone: phone || null,
          company: inquiry.company || null,
          notes: `Converted from buyer inquiry #${inquiry.id}`,
        } as any);
      } else {
        party = parties.find(
          (p: any) =>
            p.role === "buyer" &&
            ((email && String(p.email || "").trim().toLowerCase() === email) ||
              (phone && String(p.phone || "").trim().replace(/[^\d+]/g, "") === phone) ||
              (buyer.id && p.contactId === buyer.id)),
        ) || null;
      }
      // Mark inquiry qualified.
      if (String((inquiry as any).status || "new") === "new") {
        await storage.updateBuyerInquiry(inquiryId, { status: "qualified" } as any);
      }
      await logOpportunityEvent(
        inquiry.opportunityId,
        "inquiry_converted",
        "Inquiry Converted to Buyer",
        `${inquiry.name} converted to buyer${created ? "" : " (matched existing buyer)"}.`,
        user.id,
        "user",
        { inquiryId, buyerId: buyer.id, created, partyId: party?.id || null },
      );
      res.status(201).json({ buyer, party, created, alreadyParty: !!party && !created && !!alreadyParty });
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  // Create a buyer offer directly from an inquiry.
  reg("post", "/api/inquiries/:id/offer"); app.post("/api/inquiries/:id/offer", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const inquiryId = parseInt(req.params.id, 10);
      const inquiry = await storage.getBuyerInquiryById(inquiryId);
      if (!inquiry) return res.status(404).json({ message: "Inquiry not found" });
      const body = req.body || {};
      const amount = body.amount !== undefined && body.amount !== "" ? Number(body.amount) : inquiry.offerAmount ? Number(inquiry.offerAmount) : NaN;
      if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ message: "A valid offer amount is required" });
      const offer = await storage.createBuyerOffer({
        opportunityId: inquiry.opportunityId,
        buyerInquiryId: inquiry.id,
        buyerContactId: null,
        amount: String(amount),
        earnestMoney: body.earnestMoney !== undefined && body.earnestMoney !== "" ? String(Number(body.earnestMoney)) : null,
        financingType: body.financingType ? String(body.financingType).slice(0, 50) : null,
        closeBy: body.closeBy ? new Date(body.closeBy) : null,
        terms: body.terms ? String(body.terms) : inquiry.message || null,
        assignmentTerms: body.assignmentTerms ? String(body.assignmentTerms) : null,
        notes: body.notes ? String(body.notes) : null,
        status: "received",
        version: 1,
        parentOfferId: null,
        superseded: false,
        createdBy: user.id,
      } as any);
      if (String((inquiry as any).status || "new") === "new") {
        await storage.updateBuyerInquiry(inquiryId, { status: "offer_received" } as any);
      }
      await logOpportunityEvent(inquiry.opportunityId, "offer_created", "Offer Created from Inquiry", `Offer of $${amount.toLocaleString()} created from ${inquiry.name}'s inquiry.`, user.id, "user", { offerId: offer.id, inquiryId: inquiry.id, amount: String(amount) });
      res.status(201).json(offer);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
    // OPPORTUNITY EVENTS
  reg("get", "/api/opportunities/:id/events"); app.get("/api/opportunities/:id/events", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const opportunityId = parseInt(req.params.id, 10);
      const property = await storage.getPropertyById(opportunityId);
      if (!property) return res.status(404).json({ message: "Opportunity not found" });
      const limit = parseInt(String(req.query.limit || "100"), 10);
      const events = await storage.getOpportunityEvents(opportunityId, limit);
      res.json(events);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  // PROPERTIES ENDPOINTS (Legacy Proxies)
  reg("get", "/api/properties"); app.get("/api/properties", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const { limit, offset } = parseLimitOffset(req.query);
      const allProperties = await storage.getProperties(limit, offset);
      res.json(allProperties);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  // DIALER WORKSPACE ENDPOINTS (Queue)
  reg("get", "/api/dialer/lists"); app.get("/api/dialer/lists", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    res.json([
      { id: "new", name: "New leads" },
      { id: "followups_due", name: "Follow-ups due" },
      { id: "all_callable", name: "All callable" },
    ]);
  });
  reg("get", "/api/dialer/scripts"); app.get("/api/dialer/scripts", async (req, res) => {
    const teamCtx = await requireActiveTeam(req, res);
    if (!teamCtx) return;
    const user = teamCtx.user;
    try {
      const listIdRaw = typeof req.query.listId === "string" ? req.query.listId : "";
      const listId = String(listIdRaw || "").trim() || null;
      let where = sql`team_id = ${teamCtx.teamId}`;
      if (listId) where = sql`${where} AND (list_id IS NULL OR list_id = ${listId})`;
      else where = sql`${where} AND list_id IS NULL`;
      const result: any = await db.execute(sql`
        SELECT id, list_id as "listId", name, content, is_default as "isDefault", created_at as "createdAt", updated_at as "updatedAt"
        FROM dialer_scripts
        WHERE ${where}
        ORDER BY is_default DESC, updated_at DESC, id DESC
      `);
      res.json({ items: result.rows || [] });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("post", "/api/dialer/scripts"); app.post("/api/dialer/scripts", async (req, res) => {
    const teamCtx = await requireActiveTeam(req, res, { minRole: "admin" });
    if (!teamCtx) return;
    const user = teamCtx.user;
    try {
      const name = String(req.body?.name || "").trim();
      const content = String(req.body?.content || "");
      const listId = String(req.body?.listId || "").trim() || null;
      const isDefault = Boolean(req.body?.isDefault);
      if (!name) return res.status(400).json({ message: "Missing name" });
      if (name.length > 120) return res.status(400).json({ message: "Name too long" });
      if (content.length > 50_000) return res.status(400).json({ message: "Content too long" });
      const listKey = listId || "";
      if (isDefault) {
        await db.execute(sql`
          UPDATE dialer_scripts
          SET is_default = false, updated_at = now()
          WHERE team_id = ${teamCtx.teamId} AND COALESCE(list_id, '') = ${listKey}
        `);
      }
      const result: any = await db.execute(sql`
        INSERT INTO dialer_scripts (team_id, created_by, user_id, list_id, name, content, is_default, created_at, updated_at)
        VALUES (${teamCtx.teamId}, ${user.id}, ${teamCtx.teamId}, ${listId}, ${name}, ${content}, ${isDefault}, now(), now())
        RETURNING id, list_id as "listId", name, content, is_default as "isDefault", created_at as "createdAt", updated_at as "updatedAt"
      `);
      res.status(201).json((result.rows || [])[0] || null);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("patch", "/api/dialer/scripts/:id"); app.patch("/api/dialer/scripts/:id", async (req, res) => {
    const teamCtx = await requireActiveTeam(req, res, { minRole: "admin" });
    if (!teamCtx) return;
    const user = teamCtx.user;
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ message: "Invalid id" });
      const before: any = await db.execute(sql`
        SELECT id, user_id as "userId", list_id as "listId", name, content, is_default as "isDefault"
        FROM dialer_scripts
        WHERE id = ${id} AND team_id = ${teamCtx.teamId}
        LIMIT 1
      `);
      const existing = (before.rows || [])[0];
      if (!existing) return res.status(404).json({ message: "Not found" });
      const nameNext = typeof req.body?.name === "string" ? String(req.body.name).trim() : existing.name;
      const contentNext = typeof req.body?.content === "string" ? String(req.body.content) : existing.content;
      const listIdNext = typeof req.body?.listId === "string" ? (String(req.body.listId).trim() || null) : existing.listId;
      const isDefaultNext = typeof req.body?.isDefault === "boolean" ? Boolean(req.body.isDefault) : Boolean(existing.isDefault);
      if (!nameNext) return res.status(400).json({ message: "Missing name" });
      if (nameNext.length > 120) return res.status(400).json({ message: "Name too long" });
      if (contentNext.length > 50_000) return res.status(400).json({ message: "Content too long" });
      const listKey = (listIdNext || "");
      if (isDefaultNext) {
        await db.execute(sql`
          UPDATE dialer_scripts
          SET is_default = false, updated_at = now()
          WHERE team_id = ${teamCtx.teamId} AND COALESCE(list_id, '') = ${listKey}
        `);
      }
      const result: any = await db.execute(sql`
        UPDATE dialer_scripts
        SET
          list_id = ${listIdNext},
          name = ${nameNext},
          content = ${contentNext},
          is_default = ${isDefaultNext},
          updated_at = now()
        WHERE id = ${id} AND team_id = ${teamCtx.teamId}
        RETURNING id, list_id as "listId", name, content, is_default as "isDefault", created_at as "createdAt", updated_at as "updatedAt"
      `);
      res.json((result.rows || [])[0] || null);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("delete", "/api/dialer/scripts/:id"); app.delete("/api/dialer/scripts/:id", async (req, res) => {
    const teamCtx = await requireActiveTeam(req, res, { minRole: "admin" });
    if (!teamCtx) return;
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ message: "Invalid id" });
      await db.execute(sql`DELETE FROM dialer_scripts WHERE id = ${id} AND team_id = ${teamCtx.teamId}`);
      res.json({ ok: true });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  // ========================= SCRIPT LIBRARY ROUTES =========================

  reg("get", "/api/scripts"); app.get("/api/scripts", async (req, res) => {
    const teamCtx = await requireActiveTeam(req, res);
    if (!teamCtx) return;
    const user = teamCtx.user;
    try {
      const category = typeof req.query.category === "string" ? req.query.category.trim() : "";
      const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
      const showArchived = req.query.archived === "true";
      let where = sql`team_id = ${teamCtx.teamId}`;
      if (!showArchived) where = sql`${where} AND (is_archived IS NULL OR is_archived = false)`;
      if (category) where = sql`${where} AND category = ${category}`;
      if (search) where = sql`${where} AND (name ILIKE ${"%" + search + "%"} OR description ILIKE ${"%" + search + "%"} OR content ILIKE ${"%" + search + "%"})`;
      const result: any = await db.execute(sql`
        SELECT id, name, content, description, category, tags, is_default as "isDefault",
               is_archived as "isArchived", use_count as "useCount",
               avg_practice_seconds as "avgPracticeSeconds",
               total_practice_count as "totalPracticeCount",
               last_practiced_at as "lastPracticedAt",
               created_at as "createdAt", updated_at as "updatedAt"
        FROM dialer_scripts
        WHERE ${where}
        ORDER BY is_default DESC, updated_at DESC, id DESC
      `);
      const cats: any = await db.execute(sql`
        SELECT DISTINCT category FROM dialer_scripts
        WHERE team_id = ${teamCtx.teamId} AND (is_archived IS NULL OR is_archived = false)
        ORDER BY category
      `);
      res.json({ items: result.rows || [], categories: (cats.rows || []).map((r: any) => r.category) });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  reg("post", "/api/scripts"); app.post("/api/scripts", async (req, res) => {
    const teamCtx = await requireActiveTeam(req, res, { minRole: "admin" });
    if (!teamCtx) return;
    const user = teamCtx.user;
    try {
      const name = String(req.body?.name || "").trim();
      const content = String(req.body?.content || "");
      const description = String(req.body?.description || "");
      const category = String(req.body?.category || "general").trim();
      const tags = Array.isArray(req.body?.tags) ? req.body.tags.filter((t: any) => typeof t === "string").slice(0, 10) : [];
      const isDefault = Boolean(req.body?.isDefault);
      if (!name) return res.status(400).json({ message: "Script name is required" });
      if (name.length > 120) return res.status(400).json({ message: "Name too long" });
      if (content.length > 50_000) return res.status(400).json({ message: "Content too long" });
      if (isDefault) {
        await db.execute(sql`UPDATE dialer_scripts SET is_default = false, updated_at = now() WHERE team_id = ${teamCtx.teamId} AND is_default = true`);
      }
      // drizzle expands JS arrays into parameter lists, so an empty tags array
      // produced `VALUES (..., )` — pass a Postgres array literal instead.
      const tagsLiteral = sql.raw(`ARRAY[${tags.map((t: string) => "'" + String(t).replace(/'/g, "''") + "'").join(",")}]::text[]`);
      const ins: any = await db.execute(sql`
        INSERT INTO dialer_scripts (team_id, created_by, user_id, name, content, description, category, tags, is_default)
        VALUES (${teamCtx.teamId}, ${user.id}, ${teamCtx.teamId}, ${name}, ${content}, ${description}, ${category}, ${tagsLiteral}, ${isDefault})
        RETURNING id, name, content, description, category, tags, is_default as "isDefault", created_at as "createdAt"
      `);
      res.json({ item: (ins.rows || [])[0] });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  reg("patch", "/api/scripts/:id"); app.patch("/api/scripts/:id", async (req, res) => {
    const teamCtx = await requireActiveTeam(req, res, { minRole: "admin" });
    if (!teamCtx) return;
    const user = teamCtx.user;
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ message: "Invalid id" });
      const before: any = await db.execute(sql`SELECT id, name, content, description, category, tags, is_default as "isDefault" FROM dialer_scripts WHERE id = ${id} AND team_id = ${teamCtx.teamId} LIMIT 1`);
      const existing = (before.rows || [])[0];
      if (!existing) return res.status(404).json({ message: "Not found" });
      const nameNext = typeof req.body?.name === "string" ? String(req.body.name).trim() : existing.name;
      const contentNext = typeof req.body?.content === "string" ? String(req.body.content) : existing.content;
      const descNext = typeof req.body?.description === "string" ? String(req.body.description) : (existing.description || "");
      const catNext = typeof req.body?.category === "string" ? String(req.body.category).trim() || "general" : (existing.category || "general");
      const tagsNext = Array.isArray(req.body?.tags) ? req.body.tags.filter((t: any) => typeof t === "string").slice(0, 10) : existing.tags || [];
      const isDefaultNext = typeof req.body?.isDefault === "boolean" ? req.body.isDefault : existing.isDefault;
      if (!nameNext) return res.status(400).json({ message: "Script name is required" });
      if (isDefaultNext && !existing.isDefault) {
        await db.execute(sql`UPDATE dialer_scripts SET is_default = false, updated_at = now() WHERE team_id = ${teamCtx.teamId} AND is_default = true AND id != ${id}`);
      }
      await db.execute(sql`UPDATE dialer_scripts SET name = ${nameNext}, content = ${contentNext}, description = ${descNext}, category = ${catNext}, tags = ${tagsNext}, is_default = ${isDefaultNext}, updated_at = now() WHERE id = ${id} AND team_id = ${teamCtx.teamId}`);
      res.json({ ok: true });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // M6: hard delete for scripts (archive alone left stale scripts stuck in
  // the library when the audit trail matters less than removal).
  reg("delete", "/api/scripts/:id"); app.delete("/api/scripts/:id", async (req, res) => {
    const teamCtx = await requireActiveTeam(req, res, { minRole: "admin" });
    if (!teamCtx) return;
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ message: "Invalid id" });
      await db.execute(sql`DELETE FROM dialer_scripts WHERE id = ${id} AND team_id = ${teamCtx.teamId}`);
      res.json({ ok: true });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  reg("post", "/api/scripts/:id/archive"); app.post("/api/scripts/:id/archive", async (req, res) => {
    const teamCtx = await requireActiveTeam(req, res, { minRole: "admin" });
    if (!teamCtx) return;
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ message: "Invalid id" });
      await db.execute(sql`UPDATE dialer_scripts SET is_archived = true, updated_at = now() WHERE id = ${id} AND team_id = ${teamCtx.teamId}`);
      res.json({ ok: true });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  reg("post", "/api/scripts/:id/practice"); app.post("/api/scripts/:id/practice", async (req, res) => {
    const teamCtx = await requireActiveTeam(req, res);
    if (!teamCtx) return;
    const user = teamCtx.user;
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ message: "Invalid id" });
      const durationSeconds = parseInt(String(req.body?.durationSeconds || "0"), 10);
      if (!Number.isFinite(durationSeconds) || durationSeconds < 0) return res.status(400).json({ message: "Invalid duration" });
      const notes = String(req.body?.notes || "").slice(0, 2000);
      const leadId = req.body?.leadId ? parseInt(String(req.body.leadId), 10) : null;
      const scriptCheck: any = await db.execute(sql`SELECT id FROM dialer_scripts WHERE id = ${id} AND team_id = ${teamCtx.teamId} LIMIT 1`);
      if (!(scriptCheck.rows || [])[0]) return res.status(404).json({ message: "Script not found" });
      await db.execute(sql`
        INSERT INTO script_practice_sessions (user_id, script_id, duration_seconds, notes, lead_id)
        VALUES (${user.id}, ${id}, ${durationSeconds}, ${notes}, ${leadId || null})
      `);
      // Update aggregate stats on the script
      const stats: any = await db.execute(sql`
        SELECT COUNT(*) as cnt, COALESCE(AVG(duration_seconds), 0) as avg_sec
        FROM script_practice_sessions WHERE script_id = ${id}
      `);
      const row = (stats.rows || [])[0];
      if (row) {
        await db.execute(sql`UPDATE dialer_scripts SET total_practice_count = ${parseInt(row.cnt)}, avg_practice_seconds = ${Math.round(parseFloat(row.avg_sec))}, last_practiced_at = now(), updated_at = now() WHERE id = ${id} AND team_id = ${teamCtx.teamId}`);
      }
      res.json({ ok: true });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  reg("get", "/api/scripts/:id/practice"); app.get("/api/scripts/:id/practice", async (req, res) => {
    const teamCtx = await requireActiveTeam(req, res);
    if (!teamCtx) return;
    const user = teamCtx.user;
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ message: "Invalid id" });
      const limit = Math.min(50, Math.max(1, parseInt(String(req.query.limit || "20"), 10) || 20));
      const result: any = await db.execute(sql`
        SELECT id, duration_seconds as "durationSeconds", notes, lead_id as "leadId", created_at as "createdAt"
        FROM script_practice_sessions
        WHERE script_id = ${id}
        ORDER BY created_at DESC
        LIMIT ${limit}
      `);
      res.json({ items: result.rows || [] });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  reg("post", "/api/scripts/import"); app.post("/api/scripts/import", async (req, res) => {
    const teamCtx = await requireActiveTeam(req, res, { minRole: "admin" });
    if (!teamCtx) return;
    const user = teamCtx.user;
    try {
      const scripts = Array.isArray(req.body?.scripts) ? req.body.scripts : [];
      let created = 0;
      for (const s of scripts.slice(0, 100)) {
        const name = String(s?.name || "").trim();
        const content = String(s?.content || "");
        if (!name || !content) continue;
        const category = String(s?.category || "general").trim();
        const tags = Array.isArray(s?.tags) ? s.tags.filter((t: any) => typeof t === "string").slice(0, 10) : [];
        await db.execute(sql`
          INSERT INTO dialer_scripts (team_id, created_by, user_id, name, content, description, category, tags)
          VALUES (${teamCtx.teamId}, ${user.id}, ${teamCtx.teamId}, ${name}, ${content}, ${String(s?.description || "")}, ${category}, ${tags})
        `);
        created++;
      }
      res.json({ created });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // ========================= END SCRIPT LIBRARY ROUTES =========================

  reg("get", "/api/dialer/queue"); app.get("/api/dialer/queue", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    try {
      const listId = String(req.query.listId || "new");
      const rawLimit = req.query.limit ? parseInt(String(req.query.limit), 10) : 50;
      const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(200, rawLimit)) : 50;
      const conditions: any[] = [
        sql`l.owner_phone IS NOT NULL`,
        sql`COALESCE(l.do_not_call, false) = false`,
      ];
      let orderBy: any = sql`l.created_at DESC`;
      if (listId === "new") {
        conditions.push(sql`COALESCE(l.status, '') = 'new'`);
        orderBy = sql`l.created_at DESC`;
      } else if (listId === "followups_due") {
        conditions.push(sql`l.next_follow_up_at IS NOT NULL`);
        conditions.push(sql`l.next_follow_up_at <= ${new Date()}`);
        orderBy = sql`l.next_follow_up_at ASC NULLS LAST`;
      } else if (listId === "all_callable") {
        orderBy = sql`l.updated_at DESC`;
      } else {
        return res.status(400).json({ message: "Invalid listId" });
      }
      const where = sql.join(conditions, sql` AND `);
      try {
        const result: any = await db.execute(sql`
          SELECT
            l.id as "leadId",
            l.owner_name as "ownerName",
            l.owner_phone as "ownerPhone",
            l.address as "address",
            l.city as "city",
            l.state as "state",
            l.status as "status",
            l.next_follow_up_at as "nextFollowUpAt",
            lc.last_call_at as "lastCallAt"
          FROM leads l
          LEFT JOIN (
            SELECT lead_id, MAX(started_at) as last_call_at
            FROM call_logs
            WHERE lead_id IS NOT NULL
            GROUP BY lead_id
          ) lc ON lc.lead_id = l.id
          WHERE ${where}
          ORDER BY ${orderBy}
          LIMIT ${limit}
        `);
        return res.json({ listId, items: result.rows || [] });
      } catch (e: any) {
        console.error(JSON.stringify({
          ts: new Date().toISOString(),
          event: "dialer_queue",
          kind: "primary_query_failed",
          message: String(e?.message || e),
          code: e?.code ? String(e.code) : null,
          listId,
          limit,
        }));
        const leadsList: any[] = await storage.getLeads(limit, 0);
        const calls: any[] = await storage.getCallLogs(5000 as any, 0 as any);
        const lastCallByLeadId = new Map<number, string>();
        for (const c of calls || []) {
          const lid = typeof c.leadId === "number" ? c.leadId : null;
          if (!lid || !c.startedAt) continue;
          const iso = new Date(c.startedAt).toISOString();
          const prev = lastCallByLeadId.get(lid);
          if (!prev || iso > prev) lastCallByLeadId.set(lid, iso);
        }
        const now = Date.now();
        const filtered = (leadsList || [])
          .filter((l: any) => Boolean(l.ownerPhone) && !l.doNotCall)
          .filter((l: any) => {
            if (listId === "new") return String(l.status || "") === "new";
            if (listId === "followups_due") return l.nextFollowUpAt && new Date(l.nextFollowUpAt).getTime() <= now;
            return true;
          })
          .slice(0, limit)
          .map((l: any) => ({
            leadId: l.id,
            ownerName: l.ownerName,
            ownerPhone: l.ownerPhone,
            address: l.address,
            city: l.city,
            state: l.state,
            status: l.status ?? null,
            nextFollowUpAt: l.nextFollowUpAt ? new Date(l.nextFollowUpAt).toISOString() : null,
            lastCallAt: lastCallByLeadId.get(l.id) || null,
          }));
        return res.json({ listId, items: filtered });
      }
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  // TELEPHONY ENDPOINTS (Dialer)
  reg("post", "/api/telephony/calls"); app.post("/api/telephony/calls", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const { direction, number, contactId, status, startedAt, metadata, leadId } = req.body || {};
      const resolvedLeadId = leadId ? Number(leadId) : metadata?.leadId ? Number(metadata.leadId) : null;
      const log = await storage.createCallLog({
        userId: user.id,
        direction,
        number,
        contactId: contactId ?? null as any,
        leadId: resolvedLeadId || null,
        status: status || "dialing",
        startedAt: startedAt ? new Date(startedAt) : new Date(),
        metadata: metadata ? JSON.stringify(metadata) : null as any,
      } as any);
      // Speed-to-lead (0098): first outreach tracking
      if (resolvedLeadId && Number.isFinite(resolvedLeadId)) {
        try {
          const { recordFirstOutreach } = await import("./services/notifications/speedToLead.js");
          await recordFirstOutreach(resolvedLeadId, user.id);
        } catch {}
      }
      if (metadata && typeof metadata === "object") {
        const metaLeadId = (metadata as any).leadId ? Number((metadata as any).leadId) : null;
        const propertyId = (metadata as any).propertyId ? Number((metadata as any).propertyId) : null;
        const linkedLeadId = resolvedLeadId || metaLeadId;
        if (linkedLeadId || propertyId) {
          await storage.createGlobalActivity({
            userId: user.id,
            action: "call_started",
            description: `Started call to ${String(number || "")}`,
            metadata: JSON.stringify({ leadId: linkedLeadId || undefined, propertyId: propertyId || undefined, callLogId: log.id, number: String(number || "") }),
          } as any);
        }
      }
      res.status(201).json(log);
      {
        const evt = { type: "call_log_created", payload: { id: log.id, status: log.status, number: log.number, direction: log.direction, leadId: log.leadId } } as const;
        emitTelephonyEventToAll(evt);
        publishTelephonyEvent(evt).catch(() => {});
      }
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("patch", "/api/telephony/calls/:id"); app.patch("/api/telephony/calls/:id", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const id = parseInt(req.params.id);
      let beforeStatus: string | null = null;
      let beforeMetadataText: string | null = null;
      let beforeLeadId: number | null = null;
      try {
        const beforeRows: any = await db.execute(sql`SELECT status, metadata, lead_id FROM call_logs WHERE id = ${id} LIMIT 1`);
        const row = (beforeRows as any).rows?.[0];
        beforeStatus = row?.status ?? null;
        beforeMetadataText = row?.metadata ?? null;
        beforeLeadId = row?.lead_id ?? null;
      } catch {}
      const patch = { ...(req.body || {}) };
      // C8/M5: one disposition taxonomy with the call-sessions service. Map
      // legacy dialer values to the canonical set so Call Audit can filter them.
      if (typeof patch.disposition === "string") {
        const d = patch.disposition.trim();
        if (d === "") {
          patch.disposition = null;
        } else if (d === "answered") {
          patch.disposition = "connected";
        } else if (d === "call_back") {
          patch.disposition = "callback_requested";
        } else if (d === "wrong_number") {
          patch.disposition = "wrong_number_confirmed";
        } else {
          const { ALLOWED_DISPOSITIONS } = await import("./services/telecom/call-sessions.js");
          if (!ALLOWED_DISPOSITIONS.has(d)) {
            return res.status(400).json({ message: `Invalid disposition: ${d}` });
          }
        }
      }
      const followUpAtRaw = patch.followUpAt;
      delete patch.followUpAt;
      if (patch.metadata && typeof patch.metadata !== "string") patch.metadata = JSON.stringify(patch.metadata);
      if (patch.status && ["answered", "missed", "failed", "ended"].includes(String(patch.status))) {
        patch.endedAt = new Date();
      }
      if (typeof patch.startedAt === "string" || typeof patch.startedAt === "number") patch.startedAt = new Date(patch.startedAt);
      if (typeof patch.endedAt === "string" || typeof patch.endedAt === "number") patch.endedAt = new Date(patch.endedAt);
      if (typeof patch.durationMs !== "undefined") patch.durationMs = Number(patch.durationMs);
      if (typeof patch.leadId !== "undefined") patch.leadId = patch.leadId ? Number(patch.leadId) : null;
      const updated = await storage.updateCallLog(id, patch);
      const nextStatus = patch.status ? String(patch.status) : null;
      let meta: any = null;
      try {
        meta = beforeMetadataText ? JSON.parse(beforeMetadataText) : null;
      } catch {}
      const metaLeadId = meta?.leadId ? Number(meta.leadId) : null;
      const propertyId = meta?.propertyId ? Number(meta.propertyId) : null;
      const effectiveLeadId = (typeof updated.leadId === "number" ? updated.leadId : null) || beforeLeadId || metaLeadId;
      // M5: a do_not_call disposition must set the lead's DNC flag.
      if (patch.disposition === "do_not_call" && effectiveLeadId) {
        try { await storage.updateLead(effectiveLeadId, { doNotCall: true } as any); } catch {}
      }
      if (nextStatus && nextStatus !== beforeStatus) {
        const terminal = new Set(["answered", "missed", "failed"]);
        if (terminal.has(nextStatus)) {
          if (effectiveLeadId || propertyId) {
            await storage.createGlobalActivity({
              userId: user.id,
              action: `call_${nextStatus}`,
              description: `Call ${nextStatus}: ${String(updated.number || "")}`,
              metadata: JSON.stringify({ leadId: effectiveLeadId || undefined, propertyId: propertyId || undefined, callLogId: updated.id, status: nextStatus }),
            } as any);
          }
        }
      }
      if ((patch.disposition || patch.note) && (effectiveLeadId || propertyId)) {
        // Item 6 (2026-09-16 audit): the note was saved to the call log but the
        // timeline card only ever showed the disposition — include the note text
        // in the description so it actually renders.
        const noteText = typeof patch.note === "string" ? patch.note.trim() : "";
        await storage.createGlobalActivity({
          userId: user.id,
          action: "call_dispositioned",
          description: patch.disposition
            ? `Disposition: ${String(patch.disposition)}${noteText ? ` — ${noteText}` : ""}`
            : (noteText || "Disposition updated"),
          metadata: JSON.stringify({ leadId: effectiveLeadId || undefined, propertyId: propertyId || undefined, callLogId: updated.id, disposition: patch.disposition || undefined, note: noteText || undefined }),
        } as any);
      }
      if (followUpAtRaw && effectiveLeadId) {
        const followUpAt = new Date(followUpAtRaw);
        if (!Number.isNaN(followUpAt.valueOf())) {
          await storage.updateLead(effectiveLeadId, { nextFollowUpAt: followUpAt } as any);
          await storage.createGlobalActivity({
            userId: user.id,
            action: "followup_scheduled",
            description: `Follow-up scheduled: ${followUpAt.toLocaleString()}`,
            metadata: JSON.stringify({ leadId: effectiveLeadId, callLogId: updated.id }),
          } as any);
          try {
            const dueFrom = new Date(followUpAt.getTime() - 60 * 1000);
            const dueTo = new Date(followUpAt.getTime() + 60 * 1000);
            const existing = await storage.listTasks(
              { userId: user.id, isManager: isManagerUser(user) },
              {
                relatedEntityType: "lead",
                relatedEntityId: effectiveLeadId,
                type: "follow_up",
                dueFrom,
                dueTo,
                includeCompleted: true,
                limit: 5,
                offset: 0,
              },
            );
            const alreadyExists = Array.isArray((existing as any)?.items) && (existing as any).items.length > 0;
            if (!alreadyExists) {
              const task = await createTask({
                title: "Follow up",
                description: `Follow up from call: ${String(updated.number || "")}`,
                type: "follow_up",
                relatedEntityType: "lead",
                relatedEntityId: effectiveLeadId,
                dueAt: followUpAt,
                priority: "high",
                status: "open",
                assignedToUserId: user.id,
                isRecurring: false,
                recurrenceRule: null,
                isPrivate: false,
                createdBy: user.id,
              });
              await storage.createGlobalActivity({
                userId: user.id,
                action: "followup_task_created",
                description: `Follow-up task created: ${followUpAt.toLocaleString()}`,
                metadata: JSON.stringify({ leadId: effectiveLeadId, callLogId: updated.id, taskId: task.id }),
              } as any);
            }
          } catch {}
        }
      }
      if (patch.disposition === "do_not_call" && effectiveLeadId) {
        await storage.updateLead(effectiveLeadId, { doNotCall: true } as any);
      }
      res.json(updated);
      {
        const evt = { type: "call_log_updated", payload: { id: updated.id, status: updated.status, number: updated.number, direction: updated.direction } } as const;
        emitTelephonyEventToAll(evt);
        publishTelephonyEvent(evt).catch(() => {});
      }
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  // Telephony realtime: WS relay token + polling fallback (Vercel-safe)
  reg("post", "/api/telephony/ws-token"); app.post("/api/telephony/ws-token", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const secret = authJwtSecret();
      if (!secret) {
        return res.status(503).json({ code: "ws_token_secret_missing", message: "WS token secret is not configured" });
      }
      const token = await new SignJWT({})
        .setProtectedHeader({ alg: "HS256" })
        .setSubject(String(user.id))
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(secret);
      const wsBaseUrl = String(process.env.TELEPHONY_WS_RELAY_URL || "").trim() || null;
      res.json({ token, expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(), wsBaseUrl });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("get", "/api/telephony/events/latest"); app.get("/api/telephony/events/latest", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const sinceRaw = Number(req.query?.sinceMs) || 0;
      const since = new Date(sinceRaw > 0 ? sinceRaw : Date.now() - 120_000).toISOString();
      const events: any[] = [];
      const callRows: any = await db.execute(sql`
        SELECT id, user_id as "userId", direction, number, status, contact_id as "contactId", lead_id as "leadId",
               started_at as "startedAt", ended_at as "endedAt", call_control_id as "callControlId", created_at as "createdAt"
        FROM call_logs
        WHERE (created_at >= ${since} OR ended_at >= ${since}
               OR (direction = 'inbound' AND status IN ('ringing','in_progress','answered')))
          AND (user_id = ${user.id} OR user_id = 0)
        ORDER BY GREATEST(COALESCE(ended_at, started_at, created_at), created_at) DESC
        LIMIT 50
      `);
      const rows = (callRows as any)?.rows || [];
      for (const r of rows) {
        const createdAtMs = new Date(String(r.createdAt || "")).getTime() || 0;
        const endedAtMs = new Date(String(r.endedAt || "")).getTime() || 0;
        const created = createdAtMs >= sinceRaw;
        const changedEnd = endedAtMs >= sinceRaw;
        if (created) {
          events.push({ type: "call_log_created", payload: { id: Number(r.id), callControlId: r.callControlId || null, direction: r.direction, number: r.number, status: r.status, startedAt: r.startedAt ? new Date(r.startedAt).toISOString() : null, userId: Number(r.userId), contactId: r.contactId ? Number(r.contactId) : null, leadId: r.leadId ? Number(r.leadId) : null, ts: createdAtMs } });
        } else if (changedEnd) {
          events.push({ type: "call_log_updated", payload: { id: Number(r.id), callControlId: r.callControlId || null, direction: r.direction, number: r.number, status: r.status, endedAt: r.endedAt ? new Date(r.endedAt).toISOString() : null, ts: endedAtMs || Date.now() } });
        }
        events.push({ type: "call_state_changed", payload: { callControlId: r.callControlId || String(r.id), state: r.status, from: r.direction === "inbound" ? r.number : null, to: r.direction === "outbound" ? r.number : null, direction: r.direction, ts: Date.now() } });
        if (String(r.direction || "") === "inbound") {
          if (r.status === "ringing" || r.status === "in_progress") {
            events.push({ type: "inbound_call_ringing", payload: { callControlId: r.callControlId || String(r.id), from: r.number || null, maskedFrom: null, leadId: r.leadId ? Number(r.leadId) : null, ts: Date.now() } });
          } else if (r.status === "ended" || r.status === "failed" || r.status === "missed" || r.status === "no-answer") {
            events.push({ type: "inbound_call_ended", payload: { callControlId: r.callControlId || String(r.id), status: r.status, ts: Date.now() } });
          }
        }
      }
      const sessionRows: any = await db.execute(sql`
        SELECT id, status, mode, final_disposition as "finalDisposition", updated_at as "updatedAt"
        FROM crm_call_sessions
        WHERE updated_at >= ${since}
          AND (initiating_user_id = ${user.id} OR assigned_agent_user_id = ${user.id})
        ORDER BY updated_at DESC
        LIMIT 20
      `);
      for (const s of (sessionRows as any)?.rows || []) {
        events.push({ type: "call_session_state_changed", payload: { sessionId: Number(s.id), status: String(s.status || ""), mode: s.mode || null, finalDisposition: s.finalDisposition || null, ts: new Date(String(s.updatedAt || "")).getTime() || Date.now() } });
      }
      res.json({ events, pollIntervalMs: 8000 });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("get", "/api/telephony/history"); app.get("/api/telephony/history", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const { limit, offset, status, contactId } = req.query as any;
      const items = await storage.getCallLogs(
        limit ? parseInt(limit) : undefined,
        offset ? parseInt(offset) : 0,
        status as string | undefined,
        contactId ? parseInt(contactId as string) : undefined,
        user.id,
      );
      if (!items.length) return res.json(items);
      const numbers = Array.from(new Set(items.map((i: any) => String(i.number || "").trim()).filter(Boolean)));
      const reps = await storage.getNumberReputationByE164s(user.id, numbers);
      const labelByE164 = new Map<string, string>();
      for (const r of reps as any[]) labelByE164.set(String(r.e164), String(r.label));
      res.json(items.map((i: any) => ({ ...i, spamLabel: labelByE164.get(String(i.number || "").trim()) || null })));
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("get", "/api/telephony/contacts"); app.get("/api/telephony/contacts", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const q = (req.query.query as string || "").toLowerCase();
      const all = await storage.getContacts(100, 0);
      const filtered = all.filter(c => (
        (c.name || "").toLowerCase().includes(q) || (c.phone || "").includes(q)
      ));
      res.json({ items: filtered.map(c => ({ id: c.id, name: c.name, numbers: [c.phone].filter(Boolean) })) });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("post", "/api/telephony/spam/flag"); app.post("/api/telephony/spam/flag", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const e164 = String(req.body?.e164 || "").trim();
      const label = String(req.body?.label || "").trim().toLowerCase();
      const reason = typeof req.body?.reason === "string" ? req.body.reason : null;
      if (!e164) return res.status(400).json({ message: "Missing e164" });
      if (label !== "spam" && label !== "allow" && label !== "block") return res.status(400).json({ message: "Invalid label" });
      const saved = await storage.upsertNumberReputation({ userId: req.session.userId!, e164, label, reason } as any);
      res.json(saved);
      {
        const evt = { type: "spam_flag_updated", payload: { e164, label } } as const;
        emitTelephonyEventToAll(evt);
        publishTelephonyEvent(evt).catch(() => {});
      }
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("post", "/api/telephony/spam/unflag"); app.post("/api/telephony/spam/unflag", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const e164 = String(req.body?.e164 || "").trim();
      if (!e164) return res.status(400).json({ message: "Missing e164" });
      await storage.deleteNumberReputation(req.session.userId!, e164);
      res.json({ ok: true });
      {
        const evt = { type: "spam_flag_updated", payload: { e164, label: null } } as const;
        emitTelephonyEventToAll(evt);
        publishTelephonyEvent(evt).catch(() => {});
      }
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("get", "/api/telephony/analytics/summary"); app.get("/api/telephony/analytics/summary", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const rangeDaysRaw = String((req.query as any).rangeDays || "30");
      const rangeDays = Math.max(1, Math.min(365, parseInt(rangeDaysRaw, 10) || 30));
      const startDate = new Date(Date.now() - rangeDays * 24 * 60 * 60 * 1000);
      const summary = await storage.getTelephonyAnalyticsSummary(req.session.userId!, startDate);
      res.json(summary);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("get", "/api/telephony/voicemail"); app.get("/api/telephony/voicemail", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const limit = Math.max(1, Math.min(200, parseInt(String((req.query as any).limit || "50"), 10) || 50));
      const items = await storage.listTelephonyMedia(req.session.userId!, "voicemail", limit);
      const numbers = Array.from(new Set(items.map((i: any) => String(i.e164 || "").trim()).filter(Boolean)));
      const reps = await storage.getNumberReputationByE164s(req.session.userId!, numbers);
      const labelByE164 = new Map<string, string>();
      for (const r of reps as any[]) labelByE164.set(String(r.e164), String(r.label));
      const enriched = await Promise.all(
        items.map(async (m: any) => {
          const audioUrl = m.storageKey ? await getTelephonyMediaSignedUrl({ key: String(m.storageKey) }) : null;
          return { ...m, audioUrl: audioUrl || m.providerUrl || null, spamLabel: labelByE164.get(String(m.e164 || "").trim()) || null };
        }),
      );
      res.json(enriched);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("get", "/api/telephony/presence"); app.get("/api/telephony/presence", async (req, res) => {
    try {
      const number = req.query.number as string;
      // Placeholder presence; integrate SwitchFree later
      res.json({ number, available: true, lastSeenAt: new Date().toISOString() });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("get", "/api/telephony/health"); app.get("/api/telephony/health", async (req, res) => {
    try {
      // Check database connectivity
      await storage.getUserByEmail("test@example.com");
      // Check Telnyx connectivity
      const telnyxResult = await telnyx.healthCheck();
      const telnyxDiag = telnyx.diagnostics();
      const apiKey = String(process.env.TELNYX_API_KEY || "");
      const connectionId = String(process.env.TELNYX_CONNECTION_ID || "");
      const messagingProfileId = String(process.env.TELNYX_MESSAGING_PROFILE_ID || "");
      const defaultFrom = String(process.env.TELNYX_DEFAULT_FROM_NUMBER || "");
      const webhookUrl = String(process.env.TELNYX_WEBHOOK_URL || "");
      // Heuristic: Telnyx Call Control Application IDs are numeric; SIP Credential
      // Connection IDs are UUIDs and are NOT valid for /v2/calls dialing.
      const looksLikeCallControl = /^\d+$/.test(connectionId);
      const looksLikeSipCredential = !looksLikeCallControl && /^[0-9a-fA-F-]{20,}$/.test(connectionId) && connectionId.includes("-");
      const voiceDetail = telnyxResult.message || "Unknown";
      const voice = {
        configured: Boolean(apiKey && connectionId),
        connectionIdPresent: Boolean(connectionId),
        connectionType: looksLikeSipCredential ? "sip_credential" : looksLikeCallControl ? "call_control_application" : "unknown",
        connectionActive: Boolean(telnyxResult.connectionActive),
        callControlReady: telnyxResult.status === "reachable" && !looksLikeSipCredential,
        defaultFromNumber: defaultFrom || null,
        detail: looksLikeSipCredential
          ? "TELNYX_CONNECTION_ID looks like a SIP Credential Connection ID. Dialing via /v2/calls requires a Call Control Application ID (numeric)."
          : voiceDetail,
        code: telnyxResult.code ?? null,
        hint: (telnyxResult as any).hint || null,
        telnyxErrorCode: (telnyxResult as any).telnyxErrorCode || null,
      };
      const messaging = {
        configured: Boolean(apiKey && messagingProfileId),
        messagingProfilePresent: Boolean(messagingProfileId),
        defaultFromNumber: defaultFrom || null,
        detail: !messagingProfileId ? "TELNYX_MESSAGING_PROFILE_ID is missing; SMS will not send." : "Messaging profile configured.",
      };
      const webhook = {
        configured: Boolean(webhookUrl),
        publicUrlPresent: Boolean(webhookUrl),
        detail: !webhookUrl ? "TELNYX_WEBHOOK_URL is missing; call events and inbound SMS will not be received." : "Webhook URL configured.",
      };
      const overallStatus =
        telnyxResult.status === "unconfigured" ? "unconfigured"
        : telnyxResult.status === "reachable" ? "reachable"
        : telnyxResult.status === "degraded" ? "degraded"
        : "unreachable";
      res.json({
        status: overallStatus,
        checkedAt: new Date().toISOString(),
        voice,
        messaging,
        webhook,
        db: "connected",
        telnyx: telnyxResult,
        telnyxDiag,
        timestamp: new Date().toISOString(),
        numbers: process.env.DIALER_NUMBERS_JSON ? JSON.parse(process.env.DIALER_NUMBERS_JSON) : [],
        defaultFrom: defaultFrom || null,
      });
    } catch (error: any) {
      console.error("Telephony health check failed:", error);
      res.status(500).json({
        status: "error",
        checkedAt: new Date().toISOString(),
        voice: { configured: false, connectionIdPresent: false, connectionActive: false, callControlReady: false, detail: "Health check failed" },
        messaging: { configured: false, messagingProfilePresent: false, detail: "Health check failed" },
        webhook: { configured: false, publicUrlPresent: false, detail: "Health check failed" },
        db: "disconnected",
        telnyx: { status: "error", code: null, message: error?.message || "Health check failed", connectionFound: false, connectionActive: false, httpStatus: null },
        telnyxDiag: telnyx.diagnostics(),
        timestamp: new Date().toISOString(),
      });
    }
  });
  // ── WebRTC Browser Softphone ───────────────────────────────────────────
  // Readiness (no secrets). Used to decide whether the browser softphone UI is
  // shown and to surface the exact blocker instead of silently hiding the feature.
  reg("get", "/api/telephony/webrtc/health"); app.get("/api/telephony/webrtc/health", (req, res) => {
    res.json(getWebRtcReadiness());
  });

  // Client config for the @telnyx/webrtc SDK. Auth-gated: only a signed-in CRM
  // user may retrieve the login payload. The TELNYX_API_KEY never leaves the server.
  reg("get", "/api/telephony/webrtc/config"); app.get("/api/telephony/webrtc/config", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      res.json(await getWebRtcClientConfig());
    } catch (error: any) {
      res.status(500).json({ enabled: false, error: error?.message || "Failed to load WebRTC config" });
    }
  });

  // WebRTC dialer: the browser registers its intent right before client.newCall()
  // so the parked-leg webhook can correlate, DNC-gate, and bind the PSTN leg.
  reg("post", "/api/telephony/webrtc/calls"); app.post("/api/telephony/webrtc/calls", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const toNumber = String(req.body?.toNumber || "").trim();
      const e164Re = /^\+[1-9]\d{1,14}$/;
      if (!e164Re.test(toNumber)) {
        return res.status(400).json({ error: "Invalid E.164 destination number", code: "INVALID_TO" });
      }
      try {
        const active = await storage.getActiveOutboundCallForUser(user.id);
        if (active) {
          return res.status(409).json({
            error: "An outbound call is already in progress. End it before dialing again.",
            code: "CALL_ACTIVE",
            callControlId: (active as any).call_control_id || null,
          });
        }
      } catch (e) {
        console.error("Active call check failed (non-blocking):", e);
      }

      // Same DNC gates as PSTN dispatch: leads and contacts flagged do-not-call
      // must hold in the WebRTC path too.
      let leadId: number | null = req.body?.leadId ? Number(req.body.leadId) : null;
      const digits = toNumber.replace(/\D/g, "");
      const last10 = digits.slice(-10);
      if (last10.length >= 7) {
        try {
          if (leadId) {
            const lead = await storage.getLeadById(leadId);
            if (lead?.doNotCall) {
              return res.status(403).json({ error: "This lead is marked Do Not Call and cannot be dialed.", code: "DO_NOT_CALL", leadId });
            }
          } else {
            const rows: any = await db.execute(sql`
              SELECT id, do_not_call FROM leads
              WHERE regexp_replace(COALESCE(owner_phone, ''), '\\D', '', 'g') LIKE ${`%${last10}`}
              ORDER BY id DESC LIMIT 1
            `);
            const row = (rows as any).rows?.[0];
            if (row?.id) {
              leadId = Number(row.id);
              if (row.do_not_call) {
                return res.status(403).json({ error: "This lead is marked Do Not Call and cannot be dialed.", code: "DO_NOT_CALL", leadId });
              }
            }
          }
          const contactRows: any = await db.execute(sql`
            SELECT id FROM contacts
            WHERE do_not_call = true
              AND regexp_replace(COALESCE(phone, ''), '\\D', '', 'g') LIKE ${`%${last10}`}
            ORDER BY id DESC LIMIT 1
          `);
          if ((contactRows as any).rows?.[0]) {
            return res.status(403).json({ error: "This contact is marked Do Not Call and cannot be dialed.", code: "DO_NOT_CALL" });
          }
        } catch (e) {
          console.error("WebRTC dial DNC lookup failed (non-blocking):", e);
        }
      }

      const callLog = await storage.createCallLog({
        userId: user.id,
        direction: "outbound",
        number: toNumber,
        status: "dialing",
        startedAt: new Date(),
        leadId,
        metadata: JSON.stringify({ webrtcPending: true, destinationNumber: toNumber }),
      } as any);
      res.status(201).json({ callLogId: callLog?.id || null });
    } catch (error: any) {
      console.error("WebRTC call registration failed:", error);
      res.status(500).json({ error: error?.message || "Internal error", code: "INTERNAL_ERROR" });
    }
  });

  // Mark a registered WebRTC call as failed when the SDK reports the call
  // ended without ever reaching the PSTN leg (no webhook will close it).
  reg("post", "/api/telephony/webrtc/calls/:callLogId/fail");
  app.post("/api/telephony/webrtc/calls/:callLogId/fail", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const callLogId = Number(req.params.callLogId);
      if (!Number.isInteger(callLogId) || callLogId <= 0) {
        return res.status(400).json({ error: "Invalid callLogId" });
      }
      const owned: any = await db.execute(sql`
        SELECT id, ended_at FROM call_logs
        WHERE id = ${callLogId} AND user_id = ${user.id} AND direction = 'outbound'
        LIMIT 1
      `);
      const log = owned?.rows?.[0];
      if (!log) {
        return res.status(404).json({ error: "Call log not found" });
      }
      if (log.ended_at == null) {
        await db.execute(sql`
          UPDATE call_logs
          SET status = 'failed', ended_at = NOW(),
              note = COALESCE(note, '') || ${` [auto-fail${req.body?.sipCode ? ` SIP ${String(req.body.sipCode).slice(0, 12)}` : ""}${req.body?.cause ? `: ${String(req.body.cause).slice(0, 60)}` : ""}]`}
          WHERE id = ${callLogId}
        `);
      }
      res.json({ ok: true });
    } catch (error: any) {
      console.error("WebRTC call fail-marker failed:", error);
      res.status(500).json({ error: error?.message || "Internal error" });
    }
  });

  // Telnyx Onboarding Wizard: Live Validation
  reg("post", "/api/telnyx/validate/api-key"); app.post("/api/telnyx/validate/api-key", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const { apiKey } = req.body || {};
      const key = String(apiKey || "").trim();
      if (!key) return res.status(400).json({ ok: false, error: "API key is required" });
      const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
      try {
        const response = await fetch("https://api.telnyx.com/v2/connections", { headers, signal: AbortSignal.timeout(15000) });
        const body: any = await response.json().catch(() => ({}));
        if (response.ok) {
          const connections = body?.data || [];
          return res.json({ ok: true, status: "valid", message: `Authenticated. Found ${connections.length} connection(s).`, connectionCount: connections.length, connections: connections.map((c: any) => ({ id: c.id, name: c.name, state: c.state || c.status })) });
        }
        const errCode = body?.errors?.[0]?.code || null;
        const errDetail = body?.errors?.[0]?.detail || body?.errors?.[0]?.title || "Authentication failed";
        let classification = "invalid";
        let hint = "Copy a fresh API key from Telnyx Portal -> Account -> API Keys.";
        if (String(errCode) === "10009") { classification = "malformed"; hint = "Key looks malformed. Generate a new V2 key in Telnyx portal."; }
        else if (String(errCode) === "20002") { classification = "revoked"; hint = "This key has been revoked. Generate a new key."; }
        else if (String(errCode) === "20008") { classification = "invalid"; hint = "Key is invalid. Copy it fresh from Telnyx portal."; }
        else if (response.status === 403) { classification = "no_permission"; hint = "Key is valid but lacks permissions."; }
        return res.json({ ok: false, status: classification, message: errDetail, hint, telnyxErrorCode: errCode, httpStatus: response.status });
      } catch (fetchErr: any) {
        return res.json({ ok: false, status: "unreachable", message: fetchErr?.message || "Could not reach Telnyx API" });
      }
    } catch (error: any) { res.status(500).json({ ok: false, error: error?.message || "Validation failed" }); }
  });

  reg("post", "/api/telnyx/validate/connection"); app.post("/api/telnyx/validate/connection", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const { apiKey, connectionId } = req.body || {};
      const key = String(apiKey || "").trim();
      const connId = String(connectionId || "").trim();
      if (!key || !connId) return res.status(400).json({ ok: false, error: "Both apiKey and connectionId are required" });
      const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
      try {
        const response = await fetch(`https://api.telnyx.com/v2/connections/${connId}`, { headers, signal: AbortSignal.timeout(15000) });
        const body: any = await response.json().catch(() => ({}));
        if (response.ok) {
          const conn = body?.data || body;
          const state = String(conn?.state || conn?.status || "").toLowerCase();
          const isActive = state === "active" || state === "online" || state === "ready";
          const isNumeric = /^\d+$/.test(connId);
          const looksLikeSip = !isNumeric && /^[0-9a-fA-F-]{20,}$/.test(connId) && connId.includes("-");
          const connType = looksLikeSip ? "sip_credential" : isNumeric ? "call_control_application" : "unknown";
          let typeWarning = "";
          if (looksLikeSip) typeWarning = "This is a SIP Credential ID, not a Call Control Application. Outbound calling requires a Call Control Application (numeric ID).";
          return res.json({ ok: true, status: isActive ? "active" : "inactive", message: isActive ? `Connection "${conn.name || connId}" is active.` : `Connection found, state: "${state}".`, connectionType: connType, connectionName: conn.name || null, connectionState: state, typeWarning });
        }
        const errDetail = body?.errors?.[0]?.detail || body?.errors?.[0]?.title || "Connection not found";
        return res.json({ ok: false, status: "not_found", message: errDetail, hint: "Verify Connection ID in Telnyx Portal -> Voice -> Call Control Applications." });
      } catch (fetchErr: any) {
        return res.json({ ok: false, status: "unreachable", message: fetchErr?.message || "Could not reach Telnyx API" });
      }
    } catch (error: any) { res.status(500).json({ ok: false, error: error?.message || "Validation failed" }); }
  });

  reg("post", "/api/telnyx/validate/messaging-profile"); app.post("/api/telnyx/validate/messaging-profile", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const { apiKey, profileId, fromNumber } = req.body || {};
      const key = String(apiKey || "").trim();
      const pid = String(profileId || "").trim();
      const from = String(fromNumber || "").trim();
      if (!key || !pid) return res.status(400).json({ ok: false, error: "Both apiKey and profileId are required" });
      const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
      try {
        const response = await fetch(`https://api.telnyx.com/v2/messaging_profiles/${pid}`, { headers, signal: AbortSignal.timeout(15000) });
        const body: any = await response.json().catch(() => ({}));
        if (response.ok) {
          const profile = body?.data || body;
          const numbers = profile?.numbers || [];
          let numberCheck = null;
          if (from) {
            const e164 = /^\+\d{10,15}$/.test(from);
            if (!e164) { numberCheck = { valid: false, message: "From number must be E.164 format (e.g. +15551234567)" }; }
            else {
              const assigned = numbers.some((n: any) => String(n.phone_number || n) === from);
              numberCheck = assigned
                ? { valid: true, message: `Number ${from} is assigned to this profile.` }
                : { valid: false, message: `Number ${from} is not assigned. Assign it in Telnyx Portal -> Messaging -> Profiles.` };
            }
          }
          return res.json({ ok: true, status: "found", message: `Profile "${profile.name || pid}" found with ${numbers.length} number(s).`, profileName: profile.name || null, numberCount: numbers.length, numbers: numbers.slice(0, 10).map((n: any) => String(n.phone_number || n)), numberCheck });
        }
        const errDetail = body?.errors?.[0]?.detail || body?.errors?.[0]?.title || "Profile not found";
        return res.json({ ok: false, status: "not_found", message: errDetail, hint: "Verify Profile ID in Telnyx Portal -> Messaging -> Profiles." });
      } catch (fetchErr: any) {
        return res.json({ ok: false, status: "unreachable", message: fetchErr?.message || "Could not reach Telnyx API" });
      }
    } catch (error: any) { res.status(500).json({ ok: false, error: error?.message || "Validation failed" }); }
  });

  // COMMS READINESS — unified channel status (Phase 9)
  reg("get", "/api/comms/readiness"); app.get("/api/comms/readiness", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const readiness = await getProviderReadiness();
      res.json(readiness);
    } catch (error: any) {
      res.status(500).json({ error: error?.message || "Readiness check failed" });
    }
  });

  // ADMIN: Run migrations manually (post-deploy / manual trigger)
  // Requires admin auth. Uses a PostgreSQL advisory lock to prevent
  // concurrent migration runs across multiple Vercel instances.
  reg("post", "/api/admin/migrate"); app.post("/api/admin/migrate", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      if (!isAdminUser(user)) {
        res.status(403).json({ success: false, error: "Admin access required" });
        return;
      }

      // Acquire advisory lock to prevent concurrent migration runs.
      const LOCK_KEY = 83749201;
      const lockResult = await pool.query("SELECT pg_try_advisory_lock($1)", [LOCK_KEY]);
      const acquired = lockResult?.rows?.[0]?.pg_try_advisory_lock;
      if (!acquired) {
        res.status(409).json({ success: false, error: "Migration already in progress by another instance" });
        return;
      }

      try {
        const { applyMigrations } = await import("./scripts/apply-migrations.js");
        await applyMigrations();
        res.json({ success: true, message: "Migrations applied successfully." });
      } finally {
        await pool.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => {});
      }
    } catch (e: any) {
      console.error("Admin migrate failed:", e?.message || e);
      res.status(500).json({ success: false, error: "Migration failed" });
    }
  });
  // ── Ticket 18: durable object storage ──────────────────────────────────
  // Private-by-default file storage on S3-compatible object storage.
  // Downloads go through expiring signed URLs only — never public.

  // POST /api/files/upload — upload a file to durable object storage.
  reg("post", "/api/files/upload"); app.post("/api/files/upload", upload.single("file"), async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const file = (req as any).file as Express.Multer.File | undefined;
      if (!file) return res.status(400).json({ success: false, error: "file is required" });
      const entityType = String(req.body.entityType || "misc").slice(0, 50);
      const entityId = String(req.body.entityId || "0").slice(0, 64);
      // Immutable flag: only managers may mark a file immutable (signed legal docs).
      const immutable = String(req.body.immutable || "").toLowerCase() === "true" && isManagerUser(user);

      const { getStorageProvider, makeStorageKey } = await import("./storage/provider.js");
      const provider = getStorageProvider();
      const key = makeStorageKey({ entityType, entityId, originalName: file.originalname });
      const up = await provider.upload({
        key,
        body: file.buffer,
        mimeType: file.mimetype,
        immutable,
      });

      // Registry record (best-effort if migration 0090 not yet applied).
      try {
        await storage.createStoredFile({
          originalName: file.originalname,
          storageKey: up.key,
          bucket: provider.bucket,
          sizeBytes: up.sizeBytes,
          mimeType: file.mimetype,
          checksumSha256: up.sha256,
          entityType,
          entityId,
          isImmutable: immutable,
          sourceKind: "upload",
          sourceRef: null,
          uploadedBy: user.id,
        } as any);
      } catch { /* table may not exist yet */ }

      res.json({
        success: true,
        key: up.key,
        bucket: provider.bucket,
        backend: provider.backend,
        sizeBytes: up.sizeBytes,
        sha256: up.sha256,
        immutable,
      });
    } catch (e: any) {
      console.error("[storage] upload failed:", e?.message || e);
      res.status(500).json({ success: false, error: "Upload failed" });
    }
  });

  // GET /api/files/:id/download — expiring signed URL (private by default).
  // Also supports ?key= for local-dev fallback URLs.
  reg("get", "/api/files/:id/download"); app.get("/api/files/:id/download", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const { getStorageProvider } = await import("./storage/provider.js");
      const provider = getStorageProvider();

      let storageKey: string;
      const id = String(req.params.id);
      if (id === "by-key") {
        storageKey = String(req.query.key || "");
      } else {
        const rec: any = await storage.getStoredFile(Number(id)).catch(() => null);
        if (!rec) return res.status(404).json({ success: false, error: "File not found" });
        storageKey = rec.storageKey;
      }
      if (!storageKey) return res.status(400).json({ success: false, error: "Missing key" });

      // Local dev backend: stream through the API (auth enforced here).
      if (provider.backend === "local") {
        const buf = await provider.download(storageKey);
        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(storageKey.split("/").pop() || "file")}"`);
        return res.send(buf);
      }

      const url = await provider.getSignedDownloadUrl(storageKey);
      res.json({ success: false, downloadUrl: url, expiresInSeconds: 900 });
    } catch (e: any) {
      console.error("[storage] download failed:", e?.message || e);
      res.status(500).json({ success: false, error: "Download failed" });
    }
  });

  // GET /api/storage/inventory — list stored files + backend status (admin).
  reg("get", "/api/storage/inventory"); app.get("/api/storage/inventory", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      if (!isAdminUser(user)) {
        res.status(403).json({ success: false, error: "Admin access required" });
        return;
      }
      const { getStorageProvider, resolveStorageConfig } = await import("./storage/provider.js");
      const { inventoryCandidates, storageUsage } = await import("./storage/migrator.js");
      const provider = getStorageProvider();
      const cfg = resolveStorageConfig();
      const usage = await storageUsage();
      const candidates = await inventoryCandidates().catch(() => []);
      const files = await storage.listStoredFiles(100, 0).catch(() => []);
      res.json({
        success: true,
        backend: provider.backend,
        bucket: provider.bucket,
        region: cfg.region,
        endpoint: cfg.endpoint || null,
        devBucketConfigured: Boolean(String(process.env.STORAGE_BUCKET_DEV || "").trim()),
        usage,
        pendingMigration: candidates.length,
        recentFiles: files,
      });
    } catch (e: any) {
      console.error("[storage] inventory failed:", e?.message || e);
      res.status(500).json({ success: false, error: "Inventory failed" });
    }
  });

  // POST /api/storage/migrate — run the storage migration (admin only).
  // Body: { dryRun?: boolean } — dryRun defaults to TRUE. Sources are never deleted.
  reg("post", "/api/storage/migrate"); app.post("/api/storage/migrate", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      if (!isAdminUser(user)) {
        res.status(403).json({ success: false, error: "Admin access required" });
        return;
      }
      const dryRun = req.body?.dryRun !== false;
      const { runMigration } = await import("./storage/migrator.js");
      const result = await runMigration({ dryRun, uploadedBy: user.id });
      res.json({ success: true, ...result });
    } catch (e: any) {
      console.error("[storage] migrate failed:", e?.message || e);
      res.status(500).json({ success: false, error: e?.message || "Migration failed" });
    }
  });

  // SYSTEM HEALTH (Aggregated diagnostics)
  // C6: route-bootstrap diagnostics — proves which API routes registered at
  // startup and when, so a partial bootstrap (C6-style outage) is detectable.
  reg("get", "/api/system/routes"); app.get("/api/system/routes", async (_req, res) => {
    try { await requireAuth(_req, res); } catch { return; }
    if (res.headersSent) return;
    const routes = getRouteRegistry();
    res.json({
      registeredAt: BOOT_TIME.toISOString(),
      count: routes.length,
      expected: EXPECTED_ROUTE_COUNT,
      complete: routes.length >= EXPECTED_ROUTE_COUNT,
      routes,
    });
  });
  reg("get", "/api/system/health"); app.get("/api/system/health", async (_req, res) => {
    try { await requireAuth(_req, res); } catch { return; }
    if (res.headersSent) return;
    try {
      // DB connectivity
      let dbStatus = "disconnected";
      try {
        await storage.getUserByEmail("test@example.com");
        dbStatus = "connected";
      } catch (_e) {}
      // Telnyx reachability
      const telnyxResult = await telnyx.healthCheck();
      const telnyxStatus = telnyxResult.status;
      const telnyxDiag = telnyx.diagnostics();
      // Env vars presence
      const required = [
        "DATABASE_URL",
        "SESSION_SECRET",
        "EMPLOYEE_ACCESS_CODE",
        "TELNYX_API_KEY",
        "TELNYX_CONNECTION_ID",
        "TELNYX_MESSAGING_PROFILE_ID",
        "TELNYX_PUBLIC_KEY",
        "TELNYX_DEFAULT_FROM_NUMBER",
      ];
      const missing = required.filter((k) => !process.env[k] || String(process.env[k]).trim() === "");
      // Sessions store check (ensure table exists)
      let sessionsOk = true;
      try {
        // @ts-ignore drizzle query via node-postgres: simple existence check
        await (await import("./db.js")).db.execute?.(undefined as any);
      } catch (_e) {
        sessionsOk = true; // keep optimistic; pg-simple auto-creates table
      }
      // Next steps
      const nextSteps: string[] = [];
      if (missing.length) nextSteps.push(`Add missing env vars: ${missing.join(", ")}`);
      if (telnyxStatus !== "reachable") nextSteps.push("Verify Telnyx credentials and number capabilities");
      if (dbStatus !== "connected") nextSteps.push("Verify DATABASE_URL and Neon availability");
      if (!process.env.TELNYX_DEFAULT_FROM_NUMBER) nextSteps.push("Set TELNYX_DEFAULT_FROM_NUMBER for outbound caller ID");
      let releaseGate: { ok: boolean; blockingCritical: number } = { ok: true, blockingCritical: 0 };
      try {
        const gateRows: any = await db.execute(sql`
          SELECT COUNT(*)::int as "count"
          FROM app_audit_findings
          WHERE severity = 'critical'
            AND status IN ('open', 'in_progress')
        `);
        const n = Number((gateRows as any).rows?.[0]?.count ?? 0);
        releaseGate = { ok: n === 0, blockingCritical: Number.isFinite(n) ? n : 0 };
      } catch {}
      if (!releaseGate.ok) nextSteps.push(`Release gate blocked: ${releaseGate.blockingCritical} Critical findings are still open`);
      // Expanded module matrix (Phase 5G). Each entry reports state, last check,
      // a safe detail, and the actionable next step. Provider credentials are
      // never included.
      const checkedAt = new Date().toISOString();
      const has = (key: string) => Boolean(process.env[key] && String(process.env[key]).trim() !== "");
      const telnyxReady = telnyxResult.status === "reachable";
      // Feature flag state matrix (Phase 7)
      const pf = (v: string | undefined): boolean => {
        if (!v) return true;
        const s = v.trim().toLowerCase();
        return s === '1' || s === 'true' || s === 'yes' || s === 'on';
      };
      const featureFlags = [
        { key: 'esign', label: 'E-Sign', enabled: pf(process.env.FEATURE_ESIGN), action: 'Enable FEATURE_ESIGN to allow contract electronic signatures' },
        { key: 'rvm', label: 'RVM (Ringless Voicemail)', enabled: pf(process.env.FEATURE_RVM), action: 'Enable FEATURE_RVM to allow ringless voicemail campaigns' },
        { key: 'skip_trace', label: 'Skip Trace', enabled: pf(process.env.FEATURE_SKIP_TRACE), action: 'Enable FEATURE_SKIP_TRACE to allow lead skip tracing' },
        { key: 'campaigns', label: 'Campaigns', enabled: pf(process.env.FEATURE_CAMPAIGNS), action: 'Enable FEATURE_CAMPAIGNS to allow campaign creation and management' },
        { key: 'field_mode', label: 'Field Mode', enabled: pf(process.env.FEATURE_FIELD_MODE), action: 'Enable FEATURE_FIELD_MODE for field-agent mode' },
        { key: 'comps', label: 'Comps / Valuation', enabled: pf(process.env.FEATURE_COMPS), action: 'Enable FEATURE_COMPS for property comparisons' },
        { key: 'buyer_match', label: 'Buyer Match', enabled: pf(process.env.FEATURE_BUYER_MATCH), action: 'Enable FEATURE_BUYER_MATCH for automated buyer matching' },
        { key: 'voice_playground', label: 'Voice Playground', enabled: pf(process.env.FEATURE_VOICE_PLAYGROUND), action: 'Enable FEATURE_VOICE_PLAYGROUND for voice research' },
      ];

      const modules = [
        { key: "app", label: "CRM API / server", state: "healthy", detail: "Server is responding", lastChecked: checkedAt },
        { key: "database", label: "Database", state: dbStatus === "connected" ? "healthy" : "unavailable", detail: dbStatus === "connected" ? "Database reachable" : "Database unreachable — check DATABASE_URL / Neon availability", lastChecked: checkedAt },
        { key: "storage", label: "File storage", state: has("S3_BUCKET") || has("STORAGE_BUCKET") ? "healthy" : "unconfigured", detail: has("S3_BUCKET") || has("STORAGE_BUCKET") ? "Storage bucket configured" : "No storage bucket configured — uploads may fall back to local storage", lastChecked: checkedAt },
        { key: "file_preview", label: "Document preview", state: has("S3_BUCKET") || has("STORAGE_BUCKET") ? "healthy" : "unconfigured", detail: "PDF/image preview works from stored files; office formats may require conversion setup", lastChecked: checkedAt },
        { key: "jobs", label: "Background jobs / queues", state: has("CRON_SECRET") || has("JOBS_ENABLED") ? "healthy" : "unconfigured", detail: "No background job runner configured — reminders/digests run on-demand", lastChecked: checkedAt },
        { key: "email", label: "Email provider", state: has("RESEND_API_KEY") || has("SMTP_HOST") || has("EMAIL_FROM") ? "healthy" : "unconfigured", detail: has("RESEND_API_KEY") || has("SMTP_HOST") ? "Email provider configured" : "No email provider configured — email notifications are disabled", lastChecked: checkedAt },
        { key: "telnyx_voice", label: "Telnyx Voice", state: telnyxReady ? "healthy" : telnyxResult.status === "unconfigured" ? "unconfigured" : "unavailable", detail: telnyxResult.message || "Unknown", hint: (telnyxResult as any).hint || null, lastChecked: checkedAt },
        { key: "telnyx_sms", label: "Telnyx SMS", state: telnyxReady && has("TELNYX_MESSAGING_PROFILE_ID") ? "healthy" : !has("TELNYX_MESSAGING_PROFILE_ID") ? "unconfigured" : telnyxResult.httpStatus === 401 || telnyxResult.httpStatus === 403 ? "unavailable" : !telnyxReady ? "unavailable" : "healthy", detail: !has("TELNYX_MESSAGING_PROFILE_ID") ? "TELNYX_MESSAGING_PROFILE_ID missing" : telnyxResult.httpStatus === 401 || telnyxResult.httpStatus === 403 ? `Telnyx rejected the API key (HTTP ${telnyxResult.httpStatus}) — rotate the key in the Telnyx portal` : !telnyxReady ? (telnyxResult.message || "Telnyx API unreachable") : "SMS provider reachable and profile configured", lastChecked: checkedAt },
        { key: "telnyx_webhook", label: "Telnyx webhook", state: has("TELNYX_WEBHOOK_URL") ? "healthy" : "unconfigured", detail: has("TELNYX_WEBHOOK_URL") ? "Webhook URL configured" : "TELNYX_WEBHOOK_URL missing — call events / inbound SMS not received", lastChecked: checkedAt },
        { key: "skip_trace", label: "Skip trace provider", state: has("SKIPTRACE_API_KEY") || has("SKIP_TRACE_API_KEY") || process.env.SKIP_TRACE_PROVIDER === "free-web" ? "healthy" : "unconfigured", detail: has("SKIPTRACE_API_KEY") || has("SKIP_TRACE_API_KEY") ? "Skip trace provider configured" : process.env.SKIP_TRACE_PROVIDER === "free-web" ? "Free public-web research provider active (no API keys required)" : "No skip trace provider configured — set SKIP_TRACE_PROVIDER=free-web for free lookups", lastChecked: checkedAt },
        { key: "calendar", label: "Calendar / meetings", state: "healthy", detail: "Internal CRM calendar active; external calendar sync requires an opt-in connector", lastChecked: checkedAt },
        { key: "campaigns", label: "Ad / campaign providers", state: has("META_ADS_TOKEN") || has("GOOGLE_ADS_TOKEN") ? "healthy" : "unconfigured", detail: has("META_ADS_TOKEN") || has("GOOGLE_ADS_TOKEN") ? "Ad provider configured" : "No ad network credentials — campaign planning works, live ad delivery is off", lastChecked: checkedAt },
        { key: "automations", label: "Automation engine", state: "healthy", detail: "Automation engine available (trigger/conditions/actions)", lastChecked: checkedAt },
        { key: "playground", label: "Playground / research", state: has("PLAYGROUND_URL") || has("DEEP_RESEARCH_API_KEY") ? "healthy" : "unconfigured", detail: has("PLAYGROUND_URL") || has("DEEP_RESEARCH_API_KEY") ? "Research service configured" : "No research provider configured — deep research will show setup guidance", lastChecked: checkedAt },
      ];
      res.json({
        status: missing.length === 0 && dbStatus === "connected" && telnyxStatus === "reachable" ? "ok" : "warn",
        env: { nodeEnv: process.env.NODE_ENV || "", missing },
        db: dbStatus,
        telnyx: telnyxResult,
        telnyxDiag,
        numbers: process.env.DIALER_NUMBERS_JSON ? JSON.parse(process.env.DIALER_NUMBERS_JSON) : [],
        defaultFrom: process.env.TELNYX_DEFAULT_FROM_NUMBER || null,
        sessions: { ok: sessionsOk },
        releaseGate,
        nextSteps,
        modules,
        features: featureFlags,
        timestamp: new Date().toISOString(),
      });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("post", "/api/telephony/sms"); app.post("/api/telephony/sms", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const { to, from, body, metadata } = req.body || {};
      if (!to || !body) return res.status(400).json({ error: "Missing to/body", code: "MISSING_FIELDS" });
      const resolvedFrom = from || process.env.TELNYX_DEFAULT_FROM_NUMBER || "";
      if (!resolvedFrom) {
        return res.status(400).json({ error: "Missing fromNumber", code: "MISSING_FROM" });
      }
      const e164Re = /^\+[1-9]\d{1,14}$/;
      if (!e164Re.test(String(to))) {
        return res.status(400).json({ error: "Invalid E.164 destination number", code: "INVALID_TO" });
      }
      if (!String(body).trim()) {
        return res.status(400).json({ error: "SMS body cannot be empty", code: "EMPTY_BODY" });
      }

      // ── Buyer DNC gate: never text a buyer that opted out ──
      const metaBuyerId = (metadata as any)?.buyerId ? Number((metadata as any).buyerId) : null;
      const buyerId = metaBuyerId && Number.isFinite(metaBuyerId) && metaBuyerId > 0 ? metaBuyerId : null;
      if (buyerId) {
        try {
          const dncBuyer = await storage.getBuyerById(buyerId);
          if (dncBuyer?.doNotCall) {
            return res.status(403).json({ error: "Buyer is marked do-not-call", code: "DNC_BLOCKED" });
          }
        } catch (e) {
          console.error("Buyer DNC check failed (non-blocking):", e);
        }
      }

      // ── Lead & contact DNC gate (item 2, 2026-09-16 audit): a DNC flag on
      // the lead or the contact record blocks outbound SMS to that number ──
      try {
        const digits = String(to).replace(/\D/g, "");
        const last10 = digits.slice(-10);
        if (last10.length >= 7) {
          const like = `%${last10}`;
          const leadRows: any = await db.execute(sql`
            SELECT id, do_not_call, do_not_text FROM leads
            WHERE regexp_replace(COALESCE(owner_phone, ''), '\\D', '', 'g') LIKE ${like}
            ORDER BY id DESC LIMIT 1
          `);
          const leadHit = (leadRows as any).rows?.[0];
          if (leadHit && (leadHit.do_not_call || leadHit.do_not_text)) {
            return res.status(403).json({ error: "This lead is marked Do Not Contact and cannot be texted.", code: "DNC_BLOCKED" });
          }
          const contactRows: any = await db.execute(sql`
            SELECT id, do_not_call, do_not_text FROM contacts
            WHERE regexp_replace(COALESCE(phone, ''), '\\D', '', 'g') LIKE ${like}
            ORDER BY id DESC LIMIT 1
          `);
          const contactHit = (contactRows as any).rows?.[0];
          if (contactHit && (contactHit.do_not_call || contactHit.do_not_text)) {
            return res.status(403).json({ error: "This contact is marked Do Not Contact and cannot be texted.", code: "DNC_BLOCKED" });
          }
        }
      } catch (e) {
        console.error("Lead/contact DNC check failed (non-blocking):", e);
      }

      // ── Auto-create lead on first text: if no lead exists for this number,
      // create a lightweight one so the conversation has a home. This lets
      // agents text any number without a separate "save as lead" step. ──
      let autoLeadId: number | null = null;
      try {
        const digits = String(to).replace(/\D/g, "");
        const last10 = digits.slice(-10);
        if (last10.length >= 7 && !(metadata as any)?.leadId) {
          const like = `%${last10}`;
          const existing: any = await db.execute(sql`
            SELECT id FROM leads
            WHERE regexp_replace(COALESCE(owner_phone, ''), '\\D', '', 'g') LIKE ${like}
            ORDER BY id DESC LIMIT 1
          `);
          const hit = (existing as any).rows?.[0];
          if (hit?.id) {
            autoLeadId = Number(hit.id);
          } else {
            // No lead exists — create a lightweight one
            const teamId = await getOrInitActiveTeamId(req, user.id).catch(() => null);
            const newLead: any = await db.execute(sql`
              INSERT INTO leads (owner_phone, status, source, created_by_user_id, team_id, created_at, updated_at)
              VALUES (${String(to)}, 'new', 'sms-auto-create', ${user.id}, ${teamId}, NOW(), NOW())
              RETURNING id
            `);
            autoLeadId = Number((newLead as any).rows?.[0]?.id) || null;
          }
        }
      } catch (e) {
        console.error("SMS auto-create lead failed (non-blocking):", e);
      }

      // ── Media attachments: MMS when carrier-safe, secure-link otherwise ──
      const rawMediaIds = Array.isArray((req.body as any)?.mediaIds) ? (req.body as any).mediaIds : [];
      const mediaIds = rawMediaIds
        .map((x: any) => parseInt(String(x), 10))
        .filter((n: number) => Number.isInteger(n) && n > 0)
        .slice(0, 10);
      let deliveryMode: "mms" | "link_fallback" | null = null;
      let mediaUrls: string[] = [];
      let finalBody = String(body);
      if (mediaIds.length > 0) {
        const teamId = await getOrInitActiveTeamId(req, user.id);
        const assets = [];
        for (const id of mediaIds) {
          const asset = await getMediaAssetById(id);
          if (!asset) {
            return res.status(404).json({ error: `Media #${id} not found`, code: "MEDIA_NOT_FOUND" });
          }
          if (teamId && !assertMediaTeam(asset, teamId)) {
            return res.status(403).json({ error: "Media does not belong to your team", code: "MEDIA_ACCESS_DENIED" });
          }
          assets.push(asset);
        }
        const plan = planMessageDelivery({
          assets: assets.map((a) => ({ id: a.id, mimeType: a.mimeType, fileSizeBytes: a.fileSizeBytes })),
          makeMediaUrl: (id) => makeMediaShareUrl({ mediaId: id, purpose: "mms" }),
        });
        deliveryMode = plan.mode;
        if (plan.mode === "mms") {
          mediaUrls = plan.mediaUrls;
        } else {
          finalBody = linkFallbackText(plan, String(body));
        }
      }

      let sid: string | null = null;
      let smsStatus = "queued";
      try {
        const out = await telnyx.sendSms({ to: String(to), body: finalBody, from: resolvedFrom, mediaUrls });
        sid = out.messageId || null;
        smsStatus = "queued";
      } catch (error: any) {
        console.error("Telnyx SMS failed:", error);
        if (error instanceof TelnyxConfigError) {
          return res.status(503).json({
            error: `Telnyx is not configured. Add the missing variables in Settings → System: ${error.missingEnv.join(", ")}.`,
            code: "TELNYX_NOT_CONFIGURED",
            detail: null,
          });
        }
        return res.status(error?.status || 502).json({
          error: error?.message || "SMS send failed",
          code: error?.code || "TELNYX_SMS_ERROR",
          detail: error?.detail || null,
        });
      }
      // Persist the outbound message row (conversation thread source of truth).
      let persistedMsgId: number | null = null;
      try {
        const metaLeadId = (metadata as any)?.leadId ? Number((metadata as any).leadId) : null;
        // Prefer explicit leadId from metadata, fall back to auto-created lead
        const effectiveLeadId = (metaLeadId && Number.isFinite(metaLeadId) && metaLeadId > 0 ? metaLeadId : null) || autoLeadId;
        const metaObj: Record<string, unknown> =
          metadata && typeof metadata === "object" ? { ...(metadata as any) } : {};
        if (mediaIds.length) {
          metaObj.mediaIds = mediaIds;
          metaObj.deliveryMode = deliveryMode;
        }
        const msg = await storage.createSmsMessage({
          userId: user.id,
          direction: "outbound",
          fromNumber: resolvedFrom,
          toNumber: String(to),
          body: finalBody,
          status: smsStatus,
          providerMessageId: sid || null,
          leadId: effectiveLeadId,
          buyerId: buyerId,
          metadata: JSON.stringify(metaObj),
        } as any);
        if (effectiveLeadId && Number.isFinite(effectiveLeadId)) {
          try {
            const { recordFirstOutreach } = await import("./services/notifications/speedToLead.js");
            await recordFirstOutreach(effectiveLeadId, user.id);
          } catch {}
        }
        persistedMsgId = msg?.id ?? null;
      } catch (e) {
        console.error("SMS persistence failed (non-blocking):", e);
      }
      // Link attachments to the outbound message and record delivery mode.
      if (persistedMsgId && mediaIds.length > 0) {
        for (const id of mediaIds) {
          try {
            await attachMedia({
              mediaId: id,
              entityType: "sms_message",
              entityId: persistedMsgId,
              role: "mms_attachment",
              createdByUserId: user.id,
            });
            await setMediaDeliveryMode(id, deliveryMode || "link_fallback");
          } catch (e) {
            console.error("SMS media attach failed (non-blocking):", e);
          }
        }
      }
      if (metadata && typeof metadata === "object") {
        const leadId = (metadata as any).leadId ? Number((metadata as any).leadId) : null;
        const propertyId = (metadata as any).propertyId ? Number((metadata as any).propertyId) : null;
        if (leadId || propertyId || buyerId) {
          try {
            await storage.createGlobalActivity({
              userId: user.id,
              action: "sms_sent",
              description: `Sent SMS to ${String(to || "")}`,
              metadata: JSON.stringify({ leadId: leadId || undefined, propertyId: propertyId || undefined, buyerId: buyerId || undefined, to: String(to || ""), sid, status: smsStatus, body: finalBody, deliveryMode: deliveryMode || undefined }),
            } as any);
          } catch {}
        }
      }
      res.json({ sid, status: smsStatus, deliveryMode, mediaUrls: mediaUrls.length ? mediaUrls : undefined });
    } catch (error: any) {
      console.error("SMS route error:", error);
      res.status(500).json({ error: error?.message || "Internal error", code: "INTERNAL_ERROR" });
    }
  });

  // ── SMS Conversation Threads ───────────────────────────────────────────
  reg("get", "/api/telephony/sms/threads"); app.get("/api/telephony/sms/threads", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const limit = Math.min(100, parseInt(String(req.query.limit || "50"), 10) || 50);
      const threads = await storage.getSmsThreads(user.id, limit);
      return res.json({ threads });
    } catch (error: any) {
      console.error("SMS threads error:", error);
      res.status(500).json({ error: error?.message || "Internal error", code: "INTERNAL_ERROR" });
    }
  });

  reg("get", "/api/telephony/sms/threads/:phone/messages"); app.get("/api/telephony/sms/threads/:phone/messages", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const phone = String(req.params.phone || "").trim();
      if (!/^\+[1-9]\d{1,14}$/.test(phone)) {
        return res.status(400).json({ error: "Invalid E.164 phone number", code: "INVALID_PHONE" });
      }
      const limit = Math.min(200, parseInt(String(req.query.limit || "100"), 10) || 100);
      const messages = await storage.getSmsThreadMessages(phone, user.id, limit);
      return res.json({ messages });
    } catch (error: any) {
      console.error("SMS thread messages error:", error);
      res.status(500).json({ error: error?.message || "Internal error", code: "INTERNAL_ERROR" });
    }
  });
  reg("post", "/api/telephony/outbound/dispatch"); app.post("/api/telephony/outbound/dispatch", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const { toNumber, fromNumber, metadata } = req.body || {};
      if (!toNumber || !String(toNumber).trim()) {
        return res.status(400).json({ error: "toNumber is required", code: "MISSING_TO" });
      }
      const resolvedFrom = fromNumber || process.env.TELNYX_DEFAULT_FROM_NUMBER || "";
      if (!resolvedFrom) {
        return res.status(400).json({ error: "Missing fromNumber", code: "MISSING_FROM" });
      }
      const e164Re = /^\+[1-9]\d{1,14}$/;
      if (!e164Re.test(String(toNumber))) {
        return res.status(400).json({ error: "Invalid E.164 destination number", code: "INVALID_TO" });
      }

      // Resolve the lead this call is about (best-effort DB lookup) so we can
      // enforce do-not-call at dispatch and persist lead_id on the call log.
      const metaLeadIdRaw = (metadata as any)?.leadId ? Number((metadata as any).leadId) : null;
      let effectiveLeadId: number | null =
        metaLeadIdRaw && Number.isFinite(metaLeadIdRaw) && metaLeadIdRaw > 0 ? metaLeadIdRaw : null;
      let dncBlocked = false;
      try {
        if (effectiveLeadId) {
          const lead = await storage.getLeadById(effectiveLeadId);
          if (lead?.doNotCall) dncBlocked = true;
        } else {
          const digits = String(toNumber).replace(/\D/g, "");
          const last10 = digits.slice(-10);
          if (last10.length >= 7) {
            const rows: any = await db.execute(sql`
              SELECT id, do_not_call FROM leads
              WHERE regexp_replace(COALESCE(owner_phone, ''), '\\D', '', 'g') LIKE ${`%${last10}`}
              ORDER BY id DESC LIMIT 1
            `);
            const row = (rows as any).rows?.[0];
            if (row?.id) {
              effectiveLeadId = Number(row.id);
              if (row.do_not_call) dncBlocked = true;
            }
          }
        }
      } catch (e) {
        // Non-blocking: if the DB is unavailable, do not silently block dialing.
        console.error("Dispatch lead lookup failed (non-blocking):", e);
      }
      if (dncBlocked) {
        return res.status(403).json({
          error: "This lead is marked Do Not Call and cannot be dialed.",
          code: "DO_NOT_CALL",
          leadId: effectiveLeadId,
        });
      }
      // Item 2 (2026-09-16 audit): a contact record flagged DNC blocks calls
      // to that number too — DNC must hold wherever the phone number appears.
      if (!dncBlocked) {
        try {
          const digits = String(toNumber).replace(/\D/g, "");
          const last10 = digits.slice(-10);
          if (last10.length >= 7) {
            const contactRows: any = await db.execute(sql`
              SELECT id FROM contacts
              WHERE do_not_call = true
                AND regexp_replace(COALESCE(phone, ''), '\\D', '', 'g') LIKE ${`%${last10}`}
              ORDER BY id DESC LIMIT 1
            `);
            if ((contactRows as any).rows?.[0]) {
              return res.status(403).json({
                error: "This contact is marked Do Not Call and cannot be dialed.",
                code: "DO_NOT_CALL",
              });
            }
          }
        } catch (e) {
          console.error("Dispatch contact DNC lookup failed (non-blocking):", e);
        }
      }

      // Reject a second simultaneous outbound call for the same user.
      try {
        const active = await storage.getActiveOutboundCallForUser(user.id);
        if (active) {
          return res.status(409).json({
            error: "An outbound call is already in progress. End it before dialing again.",
            code: "CALL_ACTIVE",
            callControlId: (active as any).call_control_id || null,
          });
        }
      } catch (e) {
        console.error("Active call check failed (non-blocking):", e);
      }

      let callControlId: string | null = null;
      let callLog: any = null;
      // ── ARCHITECTURE FIX (2026-10-08): The PSTN fallback dials the destination
      // but never bridges the agent in — the lead hears silence. WebRTC is now
      // the required path. If the browser softphone isn't connected, fail fast
      // with a clear message instead of placing a dead call. ──
      const webrtcConnected = (req.body as any)?.webrtcConnected === true;
      if (!webrtcConnected) {
        return res.status(428).json({
          error: "Softphone not connected. Connect your microphone and WebRTC softphone before dialing.",
          code: "WEBRTC_REQUIRED",
          detail: "The PSTN fallback was removed because it placed calls without bridging the agent. Use the WebRTC softphone.",
        });
      }
      try {
        const result = await telnyx.dial({
          to: String(toNumber),
          from: resolvedFrom,
        });
        callControlId = result.callControlId;
      } catch (error: any) {
        console.error("Telnyx outbound dispatch failed:", error);
        if (error instanceof TelnyxConfigError) {
          return res.status(503).json({
            error: `Telnyx is not configured. Add the missing variables in Settings → System: ${error.missingEnv.join(", ")}.`,
            code: "TELNYX_NOT_CONFIGURED",
            detail: null,
          });
        }
        return res.status(error?.status || 502).json({
          error: error?.message || "Outbound dispatch failed",
          code: error?.code || "TELNYX_DIAL_ERROR",
          detail: error?.detail || null,
        });
      }
      try {
        callLog = await storage.createCallLog({
          userId: user.id,
          direction: "outbound",
          number: String(toNumber),
          status: "dialing",
          startedAt: new Date(),
          leadId: effectiveLeadId,
          callControlId,
          metadata: metadata ? JSON.stringify({ ...metadata, callControlId }) : JSON.stringify({ callControlId }),
        } as any);
      } catch (e) {
        console.error("Failed to persist call log:", e);
      }
      if (metadata && typeof metadata === "object") {
        const metaLeadId = (metadata as any).leadId ? Number((metadata as any).leadId) : null;
        const propertyId = (metadata as any).propertyId ? Number((metadata as any).propertyId) : null;
        if (metaLeadId || propertyId) {
          try {
            await storage.createGlobalActivity({
              userId: user.id,
              action: "call_started",
              description: `Started call to ${String(toNumber || "")}`,
              metadata: JSON.stringify({ leadId: metaLeadId || undefined, propertyId: propertyId || undefined, callLogId: callLog?.id, number: String(toNumber || ""), callControlId }),
            } as any);
          } catch {}
        }
      }
      res.status(201).json({ callControlId, callLogId: callLog?.id || null });
    } catch (error: any) {
      console.error("Outbound dispatch route error:", error);
      res.status(500).json({ error: error?.message || "Internal error", code: "INTERNAL_ERROR" });
    }
  });
  reg("post", "/api/telephony/outbound/:callControlId/hangup"); app.post("/api/telephony/outbound/:callControlId/hangup", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const callControlId = String(req.params.callControlId || "").trim();
      if (!callControlId) {
        return res.status(400).json({ error: "callControlId is required", code: "MISSING_CALL_CONTROL_ID" });
      }
      try {
        await telnyx.hangup(callControlId);
      } catch (error: any) {
        console.error("Telnyx hangup failed:", error);
        if (error instanceof TelnyxConfigError) {
          return res.status(503).json({
            error: `Telnyx is not configured. Add the missing variables in Settings → System: ${error.missingEnv.join(", ")}.`,
            code: "TELNYX_NOT_CONFIGURED",
            detail: null,
          });
        }
        return res.status(error?.status || 502).json({
          error: error?.message || "Hangup failed",
          code: error?.code || "TELNYX_HANGUP_ERROR",
          detail: error?.detail || null,
        });
      }
      res.json({ ok: true, callControlId });
    } catch (error: any) {
      console.error("Hangup route error:", error);
      res.status(500).json({ error: error?.message || "Internal error", code: "INTERNAL_ERROR" });
    }
  });

  // ── Call Control: Mute ──────────────────────────────────────────────
  reg("post", "/api/telephony/outbound/:callControlId/mute"); app.post("/api/telephony/outbound/:callControlId/mute", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const callControlId = String(req.params.callControlId || "").trim();
      if (!callControlId) return res.status(400).json({ error: "callControlId required", code: "MISSING_CALL_CONTROL_ID" });
      const muted = Boolean(req.body?.muted ?? true);
      try {
        await telnyx.mute(callControlId, muted);
      } catch (error: any) {
        if (error instanceof TelnyxConfigError) {
          return res.status(503).json({ error: `Telnyx not configured: ${error.missingEnv.join(", ")}`, code: "TELNYX_NOT_CONFIGURED" });
        }
        return res.status(error?.status || 502).json({ error: error?.message || "Mute failed", code: error?.code || "TELNYX_MUTE_ERROR" });
      }
      res.json({ ok: true, callControlId, muted });
    } catch (error: any) {
      res.status(500).json({ error: error?.message || "Internal error", code: "INTERNAL_ERROR" });
    }
  });

  // ── Call Control: Hold ──────────────────────────────────────────────
  reg("post", "/api/telephony/outbound/:callControlId/hold"); app.post("/api/telephony/outbound/:callControlId/hold", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const callControlId = String(req.params.callControlId || "").trim();
      if (!callControlId) return res.status(400).json({ error: "callControlId required", code: "MISSING_CALL_CONTROL_ID" });
      const action = String(req.body?.action || "hold");
      try {
        if (action === "unhold") {
          await telnyx.unhold(callControlId);
        } else {
          await telnyx.hold(callControlId);
        }
      } catch (error: any) {
        if (error instanceof TelnyxConfigError) {
          return res.status(503).json({ error: `Telnyx not configured: ${error.missingEnv.join(", ")}`, code: "TELNYX_NOT_CONFIGURED" });
        }
        return res.status(error?.status || 502).json({ error: error?.message || "Hold failed", code: error?.code || "TELNYX_HOLD_ERROR" });
      }
      res.json({ ok: true, callControlId, action });
    } catch (error: any) {
      res.status(500).json({ error: error?.message || "Internal error", code: "INTERNAL_ERROR" });
    }
  });

  // ── Call Control: Transfer ──────────────────────────────────────────
  reg("post", "/api/telephony/outbound/:callControlId/transfer"); app.post("/api/telephony/outbound/:callControlId/transfer", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const callControlId = String(req.params.callControlId || "").trim();
      if (!callControlId) return res.status(400).json({ error: "callControlId required", code: "MISSING_CALL_CONTROL_ID" });
      const to = String(req.body?.to || "").trim();
      if (!to) return res.status(400).json({ error: "Transfer destination required", code: "MISSING_TO" });
      const e164Re = /^\+[1-9]\d{1,14}$/;
      if (!e164Re.test(to)) {
        return res.status(400).json({ error: "Invalid E.164 transfer destination", code: "INVALID_TO" });
      }
      try {
        await telnyx.transfer(callControlId, to);
      } catch (error: any) {
        if (error instanceof TelnyxConfigError) {
          return res.status(503).json({ error: `Telnyx not configured: ${error.missingEnv.join(", ")}`, code: "TELNYX_NOT_CONFIGURED" });
        }
        return res.status(error?.status || 502).json({ error: error?.message || "Transfer failed", code: error?.code || "TELNYX_TRANSFER_ERROR" });
      }
      // Persist the transfer state + activity (best-effort; never fails the request).
      try {
        const log = await storage.getCallLogByCallControlId(callControlId);
        if (log) {
          await storage.updateCallLog(log.id, { status: "transferring" });
          await storage.createGlobalActivity({
            userId: user.id,
            action: "call_transferred",
            description: `Transferred call to ${to}`,
            metadata: JSON.stringify({ callControlId, to, callLogId: log.id, leadId: log.leadId || undefined }),
          } as any);
        }
      } catch (e) {
        console.error("Transfer call log update failed (non-blocking):", e);
      }
      res.json({ ok: true, callControlId, transferredTo: to });
    } catch (error: any) {
      res.status(500).json({ error: error?.message || "Internal error", code: "INTERNAL_ERROR" });
    }
  });

  // ── Call Control: AI Assistant ─────────────────────────────────────
  reg("post", "/api/telephony/outbound/:callControlId/ai-assistant"); app.post("/api/telephony/outbound/:callControlId/ai-assistant", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const callControlId = String(req.params.callControlId || "").trim();
      if (!callControlId) return res.status(400).json({ error: "callControlId required", code: "MISSING_CALL_CONTROL_ID" });
      const action = String(req.body?.action || "start").trim().toLowerCase();
      if (action !== "start" && action !== "stop") {
        return res.status(400).json({ error: "action must be 'start' or 'stop'", code: "INVALID_ACTION" });
      }
      const aiConfig = await getAiAssistantConfig();
      if (!aiConfig.enabled) {
        return res.status(403).json({ error: "AI assistant is not enabled. Enable it in Settings → System (AI Assistant).", code: "AI_ASSISTANT_DISABLED" });
      }
      if (action === "start") {
        const assistantId = String(req.body?.assistantId || aiConfig.assistantId || "").trim();
        if (!assistantId) {
          return res.status(400).json({ error: "assistantId is required (or set TELNYX_AI_ASSISTANT_ID)", code: "MISSING_ASSISTANT_ID" });
        }
        try {
          await telnyx.startAiAssistant(callControlId, assistantId);
        } catch (error: any) {
          if (error instanceof TelnyxConfigError) {
            return res.status(503).json({ error: `Telnyx not configured: ${error.missingEnv.join(", ")}`, code: "TELNYX_NOT_CONFIGURED" });
          }
          return res.status(error?.status || 502).json({ error: error?.message || "AI assistant start failed", code: error?.code || "AI_ASSISTANT_START_ERROR" });
        }
        return res.json({ ok: true, action, callControlId, assistantId });
      }
      try {
        await telnyx.stopAiAssistant(callControlId);
      } catch (error: any) {
        if (error instanceof TelnyxConfigError) {
          return res.status(503).json({ error: `Telnyx not configured: ${error.missingEnv.join(", ")}`, code: "TELNYX_NOT_CONFIGURED" });
        }
        return res.status(error?.status || 502).json({ error: error?.message || "AI assistant stop failed", code: error?.code || "AI_ASSISTANT_STOP_ERROR" });
      }
      res.json({ ok: true, action, callControlId });
    } catch (error: any) {
      res.status(500).json({ error: error?.message || "Internal error", code: "INTERNAL_ERROR" });
    }
  });  // ── Inbound Call Accept / Decline ────────────────────────────────────  // ── Admin Call Audit ─────────────────────────────────────────────────
  reg("get", "/api/telephony/admin/calls"); app.get("/api/telephony/admin/calls", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      if (!(user.isSuperAdmin || String(user.role || "").trim().toLowerCase() === "admin")) {
        return res.status(403).json({ error: "Admins only", code: "ADMIN_REQUIRED" });
      }
      const q = req.query as any;
      const items = await storage.getAdminCallLogs({
        limit: q.limit ? parseInt(q.limit) : 100,
        offset: q.offset ? parseInt(q.offset) : 0,
        userId: q.userId ? parseInt(q.userId) : undefined,
        status: q.status || undefined,
        disposition: q.disposition || undefined,
        fromDate: q.from ? new Date(String(q.from)) : undefined,
        toDate: q.to ? new Date(String(q.to)) : undefined,
      });
      res.json(items);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  reg("get", "/api/v1/telecom/call-sessions"); app.get("/api/v1/telecom/call-sessions", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      if (!(user.isSuperAdmin || String(user.role || "").trim().toLowerCase() === "admin")) {
        return res.status(403).json({ error: "Admins only", code: "ADMIN_REQUIRED" });
      }
      const q = req.query as any;
      const items = await storage.listCallSessions({
        limit: q.limit ? parseInt(q.limit) : 100,
        offset: q.offset ? parseInt(q.offset) : 0,
        userId: q.userId ? parseInt(q.userId) : undefined,
        mode: q.mode || undefined,
        status: q.status || undefined,
        disposition: q.disposition || undefined,
        fromDate: q.from ? new Date(String(q.from)) : undefined,
        toDate: q.to ? new Date(String(q.to)) : undefined,
      });
      res.json(items);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });


  reg("post", "/api/telephony/inbound/:callControlId/accept"); app.post("/api/telephony/inbound/:callControlId/accept", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const callControlId = String(req.params.callControlId || "").trim();
      if (!callControlId) return res.status(400).json({ error: "callControlId required", code: "MISSING_CALL_CONTROL_ID" });
      const log = await storage.getCallLogByCallControlId(callControlId);
      if (!log) return res.status(404).json({ error: "Inbound call not found", code: "INBOUND_NOT_FOUND" });
      if (String(log.direction) !== "inbound") return res.status(400).json({ error: "Not an inbound call", code: "NOT_INBOUND" });
      if (String(log.status) !== "ringing" && String(log.status) !== "answered") {
        return res.status(409).json({ error: `Call is ${log.status}`, code: "INBOUND_NOT_RINGING" });
      }
      let agentPhone = "";
      try {
        const setting = await storage.getAgentPhoneSetting(user.id);
        agentPhone = String(setting?.phoneE164 || "").trim();
      } catch {
        agentPhone = "";
      }
      if (!agentPhone) agentPhone = String(process.env.TELNYX_AGENT_PHONE || "").trim();
      const e164Re = /^\+[1-9]\d{1,14}$/;
      if (!e164Re.test(agentPhone)) {
        return res.status(400).json({ error: "Your agent phone must be set (E.164) to accept inbound calls", code: "AGENT_PHONE_REQUIRED" });
      }
      try {
        await telnyx.answer(callControlId);
      } catch (error: any) {
        return res.status(error?.status || 502).json({ error: error?.message || "Answer failed", code: error?.code || "ANSWER_ERROR" });
      }
      let agentCc = "";
      try {
        const dialed = await telnyx.dial({
          to: agentPhone,
          from: String(process.env.TELNYX_DEFAULT_FROM_NUMBER || "").trim(),
          connectionId: String(process.env.TELNYX_CONNECTION_ID || ""),
        });
        agentCc = dialed.callControlId;
      } catch (error: any) {
        return res.status(error?.status || 502).json({ error: error?.message || "Agent dial failed", code: error?.code || "DIAL_ERROR" });
      }
      try {
        let meta: any = {};
        try {
          meta = typeof log.metadata === "string" ? JSON.parse(log.metadata) : log.metadata || {};
        } catch {
          meta = {};
        }
        await storage.updateCallLog(log.id, {
          status: "answered",
          userId: user.id,
          metadata: JSON.stringify({ ...meta, claimedBy: user.id, claimedAt: new Date().toISOString(), agentLegCc: agentCc }),
        } as any);
      } catch (e) {
        console.error("Inbound claim update failed (non-blocking):", e);
      }
      emitTelephonyEventToAll({
        type: "inbound_call_claimed",
        payload: { callControlId, claimedBy: user.id, agentLegCc: agentCc },
      } as any);
      res.json({ ok: true, callControlId, agentLegCc: agentCc });
    } catch (error: any) {
      res.status(500).json({ error: error?.message || "Internal error", code: "INTERNAL_ERROR" });
    }
  });

  reg("post", "/api/telephony/inbound/:callControlId/decline"); app.post("/api/telephony/inbound/:callControlId/decline", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const callControlId = String(req.params.callControlId || "").trim();
      if (!callControlId) return res.status(400).json({ error: "callControlId required", code: "MISSING_CALL_CONTROL_ID" });
      const log = await storage.getCallLogByCallControlId(callControlId);
      if (!log) return res.status(404).json({ error: "Inbound call not found", code: "INBOUND_NOT_FOUND" });
      try {
        let meta: any = {};
        try {
          meta = typeof log.metadata === "string" ? JSON.parse(log.metadata) : log.metadata || {};
        } catch {
          meta = {};
        }
        const declined = Array.isArray(meta.declinedBy) ? meta.declinedBy : [];
        await storage.updateCallLog(log.id, { metadata: JSON.stringify({ ...meta, declinedBy: [...declined, user.id] }) } as any);
      } catch (e) {
        console.error("Inbound decline update failed (non-blocking):", e);
      }
      emitTelephonyEventToAll({ type: "inbound_call_declined", payload: { callControlId, declinedBy: user.id } } as any);
      res.json({ ok: true });
    } catch (error: any) {
      res.status(500).json({ error: error?.message || "Internal error", code: "INTERNAL_ERROR" });
    }
  });


  // ── Call Sessions (two-legged click-to-dial + AI screening) ─────────
  reg("get", "/api/v1/telecom/features"); app.get("/api/v1/telecom/features", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    res.json(await callSessions.getCallFeatures());
  });

  reg("get", "/api/v1/telecom/agent-phone"); app.get("/api/v1/telecom/agent-phone", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    const setting = await storage.getAgentPhoneSetting(user.id).catch(() => undefined);
    res.json({ ...agentPhoneSettingsFromRow(setting), verified: !!setting?.verified });
  });

  reg("put", "/api/v1/telecom/agent-phone"); app.put("/api/v1/telecom/agent-phone", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    // Ticket 8: merge the payload onto the stored settings so a caller-ID-only
    // save keeps the agent phone, and validate/normalize every number to E.164.
    const existing = await storage.getAgentPhoneSetting(user.id).catch(() => undefined);
    const { values, errors } = validateAgentPhoneSettings(req.body, agentPhoneSettingsFromRow(existing));
    if (errors.length) {
      return res.status(400).json({ error: errors[0], code: "INVALID_AGENT_PHONE", errors });
    }
    await storage.setAgentPhoneSetting({
      userId: user.id,
      phoneE164: values.phoneE164,
      callerIdE164: values.callerIdE164,
      defaultCallMode: values.defaultCallMode,
      recordingEnabled: values.recordingEnabled,
      verified: !!existing?.verified,
    } as any);
    res.json({ ok: true, ...values, verified: !!existing?.verified });
  });

  // 0082: per-user dialer widget layouts. Layouts are keyed by (user_id, page)
  // so each agent's drag/resize arrangement is private to them.
  reg("get", "/api/users/me/widget-layout"); app.get("/api/users/me/widget-layout", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    const page = String(req.query.page || "dialer-workspace").slice(0, 64);
    const rows: any = await db.execute(sql`
      SELECT layout FROM user_widget_layouts WHERE user_id = ${user.id} AND page = ${page} LIMIT 1
    `);
    const row = (rows.rows || [])[0];
    res.json({ page, layout: row?.layout ?? null });
  });

  reg("put", "/api/users/me/widget-layout"); app.put("/api/users/me/widget-layout", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    const v = validateWidgetLayout(req.body?.page, req.body?.layout);
    if (!v.ok) return res.status(400).json({ error: v.error, code: "INVALID_WIDGET_LAYOUT" });
    await db.execute(sql`
      INSERT INTO user_widget_layouts (user_id, page, layout, updated_at)
      VALUES (${user.id}, ${v.page}, ${JSON.stringify(v.items)}::jsonb, now())
      ON CONFLICT (user_id, page) DO UPDATE SET layout = EXCLUDED.layout, updated_at = now()
    `);
    res.json({ ok: true, page: v.page, layout: v.items });
  });

  // Buyer calling: dial a buyer through the same two-leg Telnyx state machine
  // used for leads. DNC is enforced from the buyer record server-side.
  reg("post", "/api/v1/telecom/buyers/:buyerId/call-sessions"); app.post("/api/v1/telecom/buyers/:buyerId/call-sessions", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    const result = await callSessions.createBuyerCallSession({
      buyerId: Number(req.params.buyerId),
      userId: user.id,
      agentUserId: req.body?.agentUserId ? Number(req.body.agentUserId) : undefined,
      record: Boolean(req.body?.record),
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error, code: result.code });
    res.json({ ok: true, session: result.session });
  });

  reg("post", "/api/v1/telecom/call-sessions"); app.post("/api/v1/telecom/call-sessions", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    const leadId = Number(req.body?.leadId);
    const mode = String(req.body?.mode || "human_first");
    const agentUserId = req.body?.agentUserId ? Number(req.body.agentUserId) : user.id;
    const campaignId = req.body?.campaignId ? Number(req.body.campaignId) : undefined;
    if (!leadId) return res.status(400).json({ error: "leadId required", code: "MISSING_LEAD_ID" });
    const result = await callSessions.createCallSession({ leadId, mode: mode as any, userId: user.id, agentUserId, campaignId, record: Boolean(req.body?.record) });
    if (!result.ok) return res.status(result.status).json({ error: result.error, code: result.code });
    res.json({ ok: true, session: result.session });
  });

  // Recording master switch (Settings → System, admin-editable, default off).
  reg("get", "/api/settings/telecom/call-recording"); app.get("/api/settings/telecom/call-recording", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    const enabled = await callSessions.isCallRecordingEnabled();
    res.json({ enabled });
  });

  reg("put", "/api/settings/telecom/call-recording"); app.put("/api/settings/telecom/call-recording", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    if (!(user.isSuperAdmin || String(user.role || "").trim().toLowerCase() === "admin")) {
      return res.status(403).json({ error: "Only admins can change telecom configuration", code: "ADMIN_REQUIRED" });
    }
    const enabledRaw = req.body?.enabled;
    if (typeof enabledRaw !== "boolean") {
      return res.status(400).json({ error: "enabled must be a boolean", code: "INVALID_ENABLED" });
    }
    await storage.setAppSetting("telnyx_call_recording_enabled", enabledRaw ? "true" : "false", user.id);
    await storage.createGlobalActivity({
      userId: user.id,
      action: "call_recording_setting_updated",
      description: enabledRaw ? "Call recording enabled (consent beep on)" : "Call recording disabled",
      metadata: JSON.stringify({ enabled: enabledRaw }),
    } as any);
    res.json({ ok: true, enabled: enabledRaw });
  });

  // Streams (redirects to) a session's recording MP3. Telnyx recording URLs
  // are short-lived signed URLs, so this re-mints a fresh one per request via
  // GET /v2/recordings/{id}.
  reg("get", "/api/v1/telecom/call-sessions/:id/recording"); app.get("/api/v1/telecom/call-sessions/:id/recording", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    const result = await callSessions.getSessionDetail(Number(req.params.id), user);
    if (!result.ok) return res.status(result.status).json({ error: result.error, code: result.code });
    const session: any = result.session;
    const recordingId = String(session.providerRecordingId || "");
    if (!recordingId) return res.status(404).json({ error: "No recording for this call", code: "NO_RECORDING" });
    try {
      const rec = await telnyx.getRecording(recordingId);
      const url = rec.recordingUrls?.mp3 || (rec.recordingUrls ? Object.values(rec.recordingUrls)[0] : null);
      if (!url) return res.status(404).json({ error: "Recording not yet available", code: "RECORDING_PENDING" });
      return res.redirect(url);
    } catch (e: any) {
      return res.status(502).json({ error: String(e?.message || e), code: "RECORDING_FETCH_FAILED" });
    }
  });

  reg("get", "/api/v1/telecom/call-sessions/:id"); app.get("/api/v1/telecom/call-sessions/:id", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    const result = await callSessions.getSessionDetail(Number(req.params.id), user);
    if (!result.ok) return res.status(result.status).json({ error: result.error, code: result.code });
    res.json(result);
  });

  reg("get", "/api/v1/telecom/call-sessions/:id/events"); app.get("/api/v1/telecom/call-sessions/:id/events", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    const result = await callSessions.getSessionEvents(Number(req.params.id), user);
    if (!result.ok) return res.status(result.status).json({ error: result.error, code: result.code });
    res.json(result);
  });

  reg("post", "/api/v1/telecom/call-sessions/:id/cancel"); app.post("/api/v1/telecom/call-sessions/:id/cancel", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    const result = await callSessions.cancelOrHangupSession(Number(req.params.id), user.id);
    if (!result.ok) return res.status(result.status).json({ error: result.error, code: result.code });
    res.json(result);
  });

  reg("post", "/api/v1/telecom/call-sessions/:id/hangup"); app.post("/api/v1/telecom/call-sessions/:id/hangup", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    const result = await callSessions.cancelOrHangupSession(Number(req.params.id), user.id, { hangup: true });
    if (!result.ok) return res.status(result.status).json({ error: result.error, code: result.code });
    res.json(result);
  });

  reg("post", "/api/v1/telecom/call-sessions/:id/request-human-handoff"); app.post("/api/v1/telecom/call-sessions/:id/request-human-handoff", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    const result = await callSessions.requestHumanHandoff(Number(req.params.id), user.id);
    if (!result.ok) return res.status(result.status).json({ error: result.error, code: result.code });
    res.json(result);
  });

  reg("post", "/api/v1/telecom/call-sessions/:id/disposition"); app.post("/api/v1/telecom/call-sessions/:id/disposition", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    const result = await callSessions.setDisposition(Number(req.params.id), user.id, {
      disposition: String(req.body?.disposition || ""),
      note: req.body?.note ? String(req.body.note) : undefined,
      confidence: req.body?.confidence ? String(req.body.confidence) : undefined,
      // Buyer-session extras: drive pipeline next actions and interest level.
      nextAction: req.body?.nextAction ? String(req.body.nextAction) : undefined,
      nextActionAt: req.body?.nextActionAt ? String(req.body.nextActionAt) : undefined,
      interestLevel: req.body?.interestLevel ? String(req.body.interestLevel) : undefined,
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error, code: result.code });
    res.json(result);
  });

  reg("post", "/api/v1/telecom/call-sessions/:id/notes"); app.post("/api/v1/telecom/call-sessions/:id/notes", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    const result = await callSessions.addSessionNote(Number(req.params.id), user.id, String(req.body?.note || ""));
    if (!result.ok) return res.status(result.status).json({ error: result.error, code: result.code });
    res.json(result);
  });

  reg("post", "/api/v1/telecom/call-sessions/:id/callback"); app.post("/api/v1/telecom/call-sessions/:id/callback", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    const result = await callSessions.scheduleCallback(Number(req.params.id), user.id, { dueAt: String(req.body?.dueAt || ""), note: req.body?.note ? String(req.body.note) : undefined });
    if (!result.ok) return res.status(result.status).json({ error: result.error, code: result.code });
    res.json(result);
  });

  reg("post", "/api/v1/telecom/call-sessions/:id/dtmf"); app.post("/api/v1/telecom/call-sessions/:id/dtmf", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    const result = await callSessions.sendSessionDtmf(Number(req.params.id), user.id, String(req.body?.digits || ""));
    if (!result.ok) return res.status(result.status).json({ error: result.error, code: result.code });
    res.json(result);
  });

  // Stale-session watchdog sweep — admin-only, also safe to call from a cron.
  reg("post", "/api/v1/telecom/call-sessions/sweep"); app.post("/api/v1/telecom/call-sessions/sweep", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    if (!(user.isSuperAdmin || String(user.role || "").trim().toLowerCase() === "admin")) {
      return res.status(403).json({ error: "Only admins can run the sweep", code: "ADMIN_REQUIRED" });
    }
    const maxAgeSecs = req.body?.maxAgeSecs ? Number(req.body.maxAgeSecs) : undefined;
    const limit = req.body?.limit ? Number(req.body.limit) : undefined;
    const result = await callSessions.sweepStaleCallSessions({ maxAgeSecs, limit });
    res.json({ ok: true, ...result });
  });


  // ── Provider Readiness ──────────────────────────────────────────────
  reg("get", "/api/system/provider-readiness"); app.get("/api/system/provider-readiness", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const readiness = await getProviderReadiness();
      return res.json(readiness);
    } catch (error: any) {
      console.error("Provider readiness check failed:", error);
      res.status(500).json({ error: error?.message || "Internal error" });
    }
  });

  // ── AI Assistant Settings (DB override, admin-editable) ────────────────
  reg("get", "/api/settings/telecom/ai-assistant"); app.get("/api/settings/telecom/ai-assistant", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const config = await getAiAssistantConfig();
      return res.json({
        enabled: config.enabled,
        assistantId: config.assistantId,
        assistantIdMasked: config.assistantId
          ? `${config.assistantId.slice(0, 8)}…${config.assistantId.slice(-4)}`
          : null,
        source: config.source,
        featureSource: config.featureSource,
      });
    } catch (error: any) {
      console.error("AI assistant settings read failed:", error);
      res.status(500).json({ error: error?.message || "Internal error" });
    }
  });

  reg("put", "/api/settings/telecom/ai-assistant"); app.put("/api/settings/telecom/ai-assistant", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      if (!(user.isSuperAdmin || String(user.role || "").trim().toLowerCase() === "admin")) {
        return res.status(403).json({ error: "Only admins can change telecom configuration", code: "ADMIN_REQUIRED" });
      }
      const assistantId = typeof req.body?.assistantId === "string" ? String(req.body.assistantId).trim() : "";
      if (assistantId && !/^[A-Za-z0-9_-]{4,128}$/.test(assistantId)) {
        return res.status(400).json({ error: "Assistant ID must be 4–128 alphanumeric characters (dashes/underscores allowed)", code: "INVALID_ASSISTANT_ID" });
      }
      const enabledRaw = req.body?.enabled;
      if (typeof enabledRaw !== "boolean") {
        return res.status(400).json({ error: "enabled must be a boolean", code: "INVALID_ENABLED" });
      }
      try {
        await storage.setAppSetting("TELNYX_AI_ASSISTANT_ID", assistantId || null, user.id);
        await storage.setAppSetting("FEATURE_AI_ASSISTANT", enabledRaw ? "true" : "false", user.id);
        await storage.createGlobalActivity({
          userId: user.id,
          action: "ai_assistant_config_updated",
          description: enabledRaw ? "AI Screener enabled" : "AI Screener disabled",
          metadata: JSON.stringify({ assistantIdSet: Boolean(assistantId) }),
        } as any);
      } catch (e: any) {
        console.error("AI assistant settings save failed:", e);
        return res.status(500).json({ error: e?.message || "Failed to save AI assistant config", code: "SAVE_FAILED" });
      }
      const config = await getAiAssistantConfig();
      return res.json({ ok: true, enabled: config.enabled, assistantId: config.assistantId, source: config.source, featureSource: config.featureSource });
    } catch (error: any) {
      console.error("AI assistant settings write failed:", error);
      res.status(500).json({ error: error?.message || "Internal error" });
    }
  });

  // ── Video Rooms ─────────────────────────────────────────────────────
  reg("post", "/api/video/rooms"); app.post("/api/video/rooms", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const { name, maxParticipants, propertyId } = req.body || {};
      if (!name || !String(name).trim()) return res.status(400).json({ error: "Room name is required", code: "MISSING_NAME" });

      const { telnyxVideo } = await import("./services/telecom/video.js");
      let room;
      try {
        room = await telnyxVideo.createRoom({
          name: String(name).trim(),
          maxParticipants: maxParticipants ? Number(maxParticipants) : undefined,
        });
      } catch (error: any) {
        return res.status(error?.status || 502).json({ error: error?.message || "Video room creation failed", code: "VIDEO_ROOM_ERROR" });
      }

      // Persist to database
      let dbRoom: any = null;
      try {
        const result = await pool.query(
          `INSERT INTO video_rooms (room_id, room_sid, name, created_by, property_id, status, max_participants, created_at)
           VALUES ($1, $2, $3, $4, $5, 'active', $6, NOW())
           RETURNING *`,
          [room.roomId, room.roomSid, room.name, user.id, propertyId || null, room.maxParticipants],
        );
        dbRoom = (result as any).rows?.[0];
      } catch (e) {
        console.error("Failed to persist video room:", e);
      }

      // Log activity
      if (propertyId) {
        try {
          await storage.createGlobalActivity({
            userId: user.id,
            action: "video_room_created",
            description: `Created meeting: ${room.name}`,
            metadata: JSON.stringify({ roomId: room.roomId, propertyId, roomSid: room.roomSid }),
          } as any);
          await logOpportunityEvent(Number(propertyId), "video_room_created", `Meeting created: ${room.name}`, undefined, user.id);
        } catch {}
      }

      res.status(201).json({ ...room, dbId: dbRoom?.id || null });
    } catch (error: any) {
      res.status(500).json({ error: error?.message || "Internal error", code: "INTERNAL_ERROR" });
    }
  });

  reg("get", "/api/video/rooms/:roomId/join"); app.get("/api/video/rooms/:roomId/join", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const roomId = String(req.params.roomId || "").trim();
      if (!roomId) return res.status(400).json({ error: "roomId required" });

      const identity = req.query.identity ? String(req.query.identity) : `${user.firstName || ""} ${user.lastName || ""}`.trim() || `User ${user.id}`;

      const { telnyxVideo } = await import("./services/telecom/video.js");
      try {
        const joinResult = await telnyxVideo.getJoinToken(roomId, identity);
        return res.json(joinResult);
      } catch (error: any) {
        return res.status(error?.status || 502).json({ error: error?.message || "Failed to get join token", code: "VIDEO_JOIN_ERROR" });
      }
    } catch (error: any) {
      res.status(500).json({ error: error?.message || "Internal error", code: "INTERNAL_ERROR" });
    }
  });

  reg("post", "/api/video/rooms/:roomId/end"); app.post("/api/video/rooms/:roomId/end", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const roomId = String(req.params.roomId || "").trim();
      if (!roomId) return res.status(400).json({ error: "roomId required" });

      const { telnyxVideo } = await import("./services/telecom/video.js");
      try {
        await telnyxVideo.endRoom(roomId);
      } catch (error: any) {
        return res.status(error?.status || 502).json({ error: error?.message || "Failed to end room", code: "VIDEO_END_ERROR" });
      }

      // Update DB
      try {
        await pool.query(
          "UPDATE video_rooms SET status = 'ended', ended_at = NOW() WHERE room_id = $1",
          [roomId],
        );
      } catch {}

      res.json({ ok: true, roomId });
    } catch (error: any) {
      res.status(500).json({ error: error?.message || "Internal error", code: "INTERNAL_ERROR" });
    }
  });

  reg("get", "/api/video/health"); app.get("/api/video/health", async (_req, res) => {
    try {
      const { telnyxVideo } = await import("./services/telecom/video.js");
      const health = await telnyxVideo.healthCheck();
      return res.json(health);
    } catch (error: any) {
      res.status(500).json({ configured: false, reachable: false, roomsApiAvailable: false, blocker: error?.message || "Check failed" });
    }
  });

  reg("get", "/api/video/rooms"); app.get("/api/video/rooms", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const status = String(req.query.status || "active");
      const limit = Math.min(100, parseInt(String(req.query.limit || "20"), 10) || 20);

      const result = await pool.query(
        "SELECT * FROM video_rooms WHERE status = $1 ORDER BY created_at DESC LIMIT $2",
        [status, limit],
      );
      return res.json({ rooms: (result as any).rows || [] });
    } catch (error: any) {
      res.status(500).json({ error: error?.message || "Internal error" });
    }
  });

  function normalizeDigits(value: any) {
    return String(value || "").replace(/[^\d]/g, "");
  }
  async function findLeadMatchByPhone(rawPhone: any): Promise<{ leadId: number; userId: number } | null> {
    const digits = normalizeDigits(rawPhone);
    if (digits.length < 7) return null;
    const last10 = digits.slice(-10);
    const like = `%${last10}`;
    const rows: any = await db.execute(sql`
      SELECT id, assigned_to
      FROM leads
      WHERE regexp_replace(COALESCE(owner_phone, ''), '\\D', '', 'g') LIKE ${like}
      ORDER BY id DESC
      LIMIT 1
    `);
    const row = (rows as any).rows?.[0];
    if (!row?.id) return null;
    const leadId = Number(row.id);
    const userId = row.assigned_to ? Number(row.assigned_to) : 0;
    return { leadId, userId: Number.isFinite(userId) ? userId : 0 };
  }
  async function findCallLogIdByCallSid(callSid: any): Promise<number | null> {
    const sid = String(callSid || "").trim();
    if (!sid) return null;
    const like = `%"callSid":"${sid}"%`;
    const rows: any = await db.execute(sql`
      SELECT id
      FROM call_logs
      WHERE metadata LIKE ${like}
      ORDER BY id DESC
      LIMIT 1
    `);
    const row = (rows as any).rows?.[0];
    return row?.id ? Number(row.id) : null;
  }
  reg("get", "/api/properties/:id"); app.get("/api/properties/:id", async (req, res) => {
    try {
      const authCtx = await requireAuth(req, res);
      if (!authCtx) return;
      const id = parseInt(req.params.id);
      const property = await storage.getPropertyById(id) as any;
      if (!property) return res.status(404).json({ message: "Property not found" });
      // P0 fix (audit IDOR): non-managers can only read properties they own.
      if (!canAccessOwnedRecord(authCtx, property)) return res.status(403).json({ message: "Forbidden" });
      let lead: any = null;
      if (property.sourceLeadId) {
        try {
          lead = await storage.getLeadById(property.sourceLeadId);
        } catch {}
      }
      res.json({ property, lead });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("post", "/api/properties"); app.post("/api/properties", async (req, res) => {
    try {
      const actor = await requireAuth(req, res);
      if (!actor) return;
      const validated = insertPropertySchema.parse(req.body);
      const property = await storage.createProperty(validated);
      
      if (req.session.userId) {
        await storage.createGlobalActivity({
          userId: req.session.userId,
          action: "created_property",
          description: `Added new property: ${property.address}`,
          metadata: JSON.stringify({ propertyId: property.id, address: property.address }),
        });
      }
      
      res.status(201).json(property);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("patch", "/api/properties/:id"); app.patch("/api/properties/:id", async (req, res) => {
    try {
      const actor = await requireAuth(req, res);
      if (!actor) return;
      const partial = insertPropertySchema.partial().parse(req.body);
      const property = await storage.updateProperty(parseInt(req.params.id), partial);
      
      if (req.session.userId) {
        await storage.createGlobalActivity({
          userId: req.session.userId,
          action: "updated_property",
          description: `Updated property: ${property.address}`,
          metadata: JSON.stringify({ propertyId: property.id, address: property.address }),
        });
      }
      
      res.json(property);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("delete", "/api/properties/:id"); app.delete("/api/properties/:id", async (req, res) => {
    try {
      const actor = await requireAuth(req, res);
      if (!actor) return;
      const id = parseInt(req.params.id);
      const property = await storage.getPropertyById(parseInt(req.params.id));
      await storage.deleteProperty(parseInt(req.params.id));
      
      if (req.session.userId && property) {
        await storage.createGlobalActivity({
          userId: req.session.userId,
          action: "deleted_property",
          description: `Deleted property: ${property.address}`,
          metadata: JSON.stringify({ propertyId: property.id, address: property.address }),
        });
      }
      
      res.json({ message: "Property deleted" });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  // CONTRACTS ENDPOINTS
  // M22: the client has called /api/lois since the LOI Creator shipped, but
  // the endpoints never existed (only schema + storage). LOIs are letter-of-
  // intent records with a draft → sent → accepted/declined lifecycle.
  const coerceLoiBody = (body: any) => {
    const b: any = { ...(body || {}) };
    // The wizard-style client sends closingDate as an HTML date string; the
    // column is a timestamp, so coerce before zod validation.
    if (typeof b.closingDate === "string") b.closingDate = b.closingDate.trim() ? new Date(b.closingDate) : null;
    if (typeof b.sentDate === "string") b.sentDate = b.sentDate.trim() ? new Date(b.sentDate) : null;
    if (typeof b.responseDate === "string") b.responseDate = b.responseDate.trim() ? new Date(b.responseDate) : null;
    return b;
  };
  reg("get", "/api/lois"); app.get("/api/lois", async (req, res) => {
    try {
      const actor = await requireAuth(req, res);
      if (!actor) return;
      const { limit, offset } = parseLimitOffset(req.query);
      const items = await storage.getLois(limit, offset);
      res.json(items);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("post", "/api/lois"); app.post("/api/lois", async (req, res) => {
    try {
      const authCtx = await requireAuth(req, res);
      if (!authCtx) return;
      const validated = insertLoiSchema.parse(coerceLoiBody(req.body));
      const loi = await storage.createLoi(validated);
      res.status(201).json(loi);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("get", "/api/lois/:id"); app.get("/api/lois/:id", async (req, res) => {
    try {
      const authCtx = await requireAuth(req, res);
      if (!authCtx) return;
      const loi = await storage.getLoiById(parseInt(req.params.id, 10));
      if (!loi) return res.status(404).json({ message: "LOI not found" });
      res.json(loi);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("patch", "/api/lois/:id"); app.patch("/api/lois/:id", async (req, res) => {
    try {
      const authCtx = await requireAuth(req, res);
      if (!authCtx) return;
      const partial = insertLoiSchema.partial().parse(coerceLoiBody(req.body));
      const loi = await storage.updateLoi(parseInt(req.params.id, 10), partial);
      if (!loi) return res.status(404).json({ message: "LOI not found" });
      res.json(loi);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("delete", "/api/lois/:id"); app.delete("/api/lois/:id", async (req, res) => {
    try {
      const authCtx = await requireAuth(req, res);
      if (!authCtx) return;
      await storage.deleteLoi(parseInt(req.params.id, 10));
      res.json({ message: "LOI deleted" });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // ── LOI PDF Generation ─────────────────────────────────────────────
  reg("get", "/api/lois/:id/pdf"); app.get("/api/lois/:id/pdf", async (req, res) => {
    try {
      const authCtx = await requireAuth(req, res);
      if (!authCtx) return;
      const loi = await storage.getLoiById(parseInt(req.params.id, 10));
      if (!loi) return res.status(404).json({ message: "LOI not found" });

      const { generateLoiPdf } = await import("./loi/pdf-generator.js");

      // Get property address
      let propertyAddress = `Property #${loi.propertyId}`;
      try {
        const prop = await storage.getPropertyById?.(loi.propertyId);
        if (prop) propertyAddress = prop.address || propertyAddress;
      } catch {}

      const pdfBytes = await generateLoiPdf({
        buyerName: loi.buyerName,
        sellerName: loi.sellerName,
        propertyAddress,
        offerAmount: Number(loi.offerAmount),
        earnestMoney: loi.earnestMoney ? Number(loi.earnestMoney) : null,
        closingDate: loi.closingDate ? new Date(loi.closingDate).toISOString() : null,
        contingencies: loi.contingencies || [],
        specialTerms: loi.specialTerms || null,
        expiresAt: loi.expiresAt ? new Date(loi.expiresAt).toISOString() : null,
        createdAt: loi.createdAt ? new Date(loi.createdAt).toISOString() : null,
      });

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="LOI-${loi.id}.pdf"`);
      res.setHeader("Content-Length", pdfBytes.length);
      res.send(Buffer.from(pdfBytes));
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // ── LOI → E-sign Bridge ────────────────────────────────────────────
  // Creates a v2 e-sign envelope from an LOI and links it back.
  reg("post", "/api/lois/:id/send-for-signature"); app.post("/api/lois/:id/send-for-signature", async (req, res) => {
    try {
      const authCtx = await requireAuth(req, res);
      if (!authCtx) return;
      const userId = (authCtx as any).id || (authCtx as any).userId;

      const loiId = parseInt(req.params.id, 10);
      const loi = await storage.getLoiById(loiId);
      if (!loi) return res.status(404).json({ message: "LOI not found" });
      if ((loi as any).envelopeId) {
        return res.status(400).json({ message: "LOI already sent for signature", envelopeId: (loi as any).envelopeId });
      }

      const { signers, signingMode, expiresInDays } = req.body || {};
      if (!signers || !Array.isArray(signers) || signers.length === 0) {
        return res.status(400).json({ message: "At least one signer (name + email) is required" });
      }

      // Find the LOI template
      const { db } = await import("./db.js");
      const { contractTemplates } = await import("./shared-schema.js");
      const { eq } = await import("drizzle-orm");
      const [template] = await db.select().from(contractTemplates)
        .where(eq(contractTemplates.name, "Letter of Intent (LOI)"))
        .limit(1);
      if (!template) {
        return res.status(500).json({ message: "LOI template not found. Run migration 0095." });
      }

      // Get property address
      let propertyAddress = `Property #${loi.propertyId}`;
      try {
        const prop = await (storage as any).getPropertyById?.(loi.propertyId);
        if (prop) propertyAddress = prop.address || propertyAddress;
      } catch {}

      const fmtMoney = (n: any) => n == null ? "—" :
        new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(Number(n));
      const fmtDate = (d: any) => { try { return new Date(d).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }); } catch { return "—"; } };

      // Create v2 envelope from the LOI template
      const { createEnvelopeFromTemplate } = await import("./esign/envelopes.js");
      const envelope = await createEnvelopeFromTemplate({
        templateId: template.id,
        title: `LOI - ${propertyAddress}`,
        mergeData: {
          buyerName: loi.buyerName,
          sellerName: loi.sellerName,
          propertyAddress,
          offerAmount: fmtMoney(loi.offerAmount),
          earnestMoney: fmtMoney(loi.earnestMoney),
          closingDate: loi.closingDate ? fmtDate(loi.closingDate) : "—",
          expiresAt: (loi as any).expiresAt ? fmtDate((loi as any).expiresAt) : "—",
          contingencies: (loi.contingencies || []).map((c: string) => `<li>${c}</li>`).join(""),
          specialTerms: loi.specialTerms || "None specified.",
          date: fmtDate(loi.createdAt),
          propertyId: loi.propertyId,
        },
        signers,
        signingMode: signingMode || "sequential",
        expiresInDays: expiresInDays || 14,
      }, userId);

      // Link envelope back to LOI
      await storage.updateLoi(loiId, { envelopeId: (envelope as any).id || (envelope as any).envelope?.id, status: "sent" } as any);

      res.status(201).json({ envelope, loiId });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // ── Get LOIs for an opportunity/deal ───────────────────────────────
  reg("get", "/api/opportunities/:id/lois"); app.get("/api/opportunities/:id/lois", async (req, res) => {
    try {
      const authCtx = await requireAuth(req, res);
      if (!authCtx) return;
      const { db } = await import("./db.js");
      const { lois } = await import("./shared-schema.js");
      const { eq } = await import("drizzle-orm");
      const items = await db.select().from(lois).where(eq(lois.opportunityId, parseInt(req.params.id, 10)));
      res.json(items);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  reg("get", "/api/contracts"); app.get("/api/contracts", async (req, res) => {
    try {
      const actor = await requireAuth(req, res);
      if (!actor) return;
      const propertyId = req.query.propertyId ? parseInt(req.query.propertyId as string) : undefined;
      // M50: the Deal Room filters by opportunity; legacy rows carry
      // property_id, canonical rows carry opportunity_id (both point at the
      // same properties row).
      const opportunityId = req.query.opportunityId ? parseInt(req.query.opportunityId as string) : undefined;
      const effPropertyId = propertyId ?? opportunityId;
      const { limit, offset } = parseLimitOffset(req.query);
      // Item 7 (2026-09-16 audit): archived contracts are excluded unless the
      // caller explicitly asks for them.
      const includeArchived = req.query.includeArchived === "true" || req.query.includeArchived === "1";
      if (effPropertyId) {
        const byProp = await storage.getContractsByPropertyId(effPropertyId, limit, offset, { includeArchived });
        if (opportunityId && !propertyId) {
          const items = (byProp as any[]).filter((c: any) => !c.opportunityId || Number(c.opportunityId) === opportunityId);
          return res.json(items);
        }
        return res.json(byProp);
      }
      const items = await storage.getContracts(limit, offset, { includeArchived });
      res.json(items);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("get", "/api/contracts/:id"); app.get("/api/contracts/:id", async (req, res) => {
    try {
      const actor = await requireAuth(req, res);
      if (!actor) return;
      const contract = await storage.getContractById(parseInt(req.params.id));
      if (!contract) return res.status(404).json({ message: "Contract not found" });
      res.json(contract);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("post", "/api/contracts"); app.post("/api/contracts", async (req, res) => {
    try {
      const actor = await requireAuth(req, res);
      if (!actor) return;
      // M46 (contract wizard crash): the wizard stores its deal terms on the
      // document-contracts model but posts here; zod strips those extra keys
      // and the NOT NULL constraint on amount rejected the auto-created draft.
      // Default amount from purchasePrice (or 0) so the wizard can advance.
      const body: any = req.body || {};
      // ownerUserId: 0 is a "no owner" sentinel the wizard sends; the live
      // contracts table has a nullable owner_user_id FK to users, so 0 would
      // violate it. Omit it entirely (NULL) when absent or zero.
      if (!body.ownerUserId) delete body.ownerUserId;
      const validated = insertContractSchema.parse({
        ...body,
        amount: body.amount ?? body.purchasePrice ?? "0",
      });
      const contract = await storage.createContract(validated);
      try {
        await syncCommissionEventsForContract(contract);
      } catch {}
      res.status(201).json(contract);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("patch", "/api/contracts/:id"); app.patch("/api/contracts/:id", async (req, res) => {
    try {
      const actor = await requireAuth(req, res);
      if (!actor) return;
      const partial = insertContractSchema.partial().parse(req.body);
      const contract = await storage.updateContract(parseInt(req.params.id), partial);
      try {
        await syncCommissionEventsForContract(contract);
      } catch {}
      res.json(contract);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("delete", "/api/contracts/:id"); app.delete("/api/contracts/:id", async (req, res) => {
    try {
      const actor = await requireAuth(req, res);
      if (!actor) return;
      await storage.deleteContract(parseInt(req.params.id));
      res.json({ message: "Contract deleted" });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  // Item 7 (2026-09-16 audit): genuine archive state with a restore path.
  reg("post", "/api/contracts/:id/archive"); app.post("/api/contracts/:id/archive", async (req, res) => {
    try {
      const actor = await requireAuth(req, res);
      if (!actor) return;
      const contract = await storage.archiveContract(parseInt(req.params.id), true);
      if (!contract) return res.status(404).json({ message: "Contract not found" });
      res.json(contract);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("post", "/api/contracts/:id/unarchive"); app.post("/api/contracts/:id/unarchive", async (req, res) => {
    try {
      const actor = await requireAuth(req, res);
      if (!actor) return;
      const contract = await storage.archiveContract(parseInt(req.params.id), false);
      if (!contract) return res.status(404).json({ message: "Contract not found" });
      res.json(contract);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("post", "/api/contracts/:id/send"); app.post("/api/contracts/:id/send", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const contract = await storage.getContractById(parseInt(req.params.id));
      if (!contract) return res.status(404).json({ message: "Contract not found" });
      if (contract.status === "sent" || contract.status === "viewed" || contract.status === "partially_signed" || contract.status === "signed" || contract.status === "executed") {
        return res.status(400).json({ message: `Contract already sent or executed` });
      }
      const updated = await storage.updateContract(contract.id, { status: "sent", sentAt: new Date() } as any);
      const signers = await storage.getContractSignersByContract(contract.id);
      const signingUrlBase = `${process.env.APP_URL || "http://localhost:3000"}/api/sign/signers/`;
      for (const signer of signers) {
        if (signer.status === "signed" || signer.status === "declined") continue;
        const token = signer.tokenHash || crypto.createHash("sha256").update(`${signer.id}-${Date.now()}`).digest("hex");
        if (token !== signer.tokenHash) {
          await storage.updateContractSigner(signer.id, { tokenHash: token } as any);
        }
        if (signer.email) {
          try {
            await sendContractSigningEmail({
              to: signer.email,
              signerName: signer.name,
              contractTitle: contract.title || contract.notes || `Contract #${contract.id}`,
              signingUrl: `${signingUrlBase}${token}`,
              expiresAt: signer.expiresAt || undefined,
            });
          } catch (e) {
            console.error(`[Contracts] Failed to send email to ${signer.email}:`, e);
          }
        }
        await storage.updateContractSigner(signer.id, {
          status: "sent",
          sentAt: new Date(),
        } as any);
      }
      await storage.createContractEvent({
        contractId: contract.id,
        actorType: "user",
        actorUserId: user.id,
        eventType: "sent",
        payloadJson: JSON.stringify({ signerCount: signers.length }),
        ip: req.ip,
        userAgent: String(req.headers["user-agent"] || ""),
      });
      res.json(updated);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("post", "/api/contracts/:id/void"); app.post("/api/contracts/:id/void", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const contract = await storage.getContractById(parseInt(req.params.id));
      if (!contract) return res.status(404).json({ message: "Contract not found" });
      if (contract.status === "executed" || contract.status === "voided") {
        return res.status(400).json({ message: `Cannot void contract from status: ${contract.status}` });
      }
      const { reason } = req.body || {};
      const updated = await storage.updateContract(contract.id, { status: "voided", voidedAt: new Date(), voidedReason: reason || null } as any);
      await storage.createContractEvent({
        contractId: contract.id,
        actorType: "user",
        actorUserId: user.id,
        eventType: "voided",
        payloadJson: JSON.stringify({ reason }),
        ip: req.ip,
        userAgent: String(req.headers["user-agent"] || ""),
      });
      res.json(updated);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("post", "/api/contracts/:id/execute"); app.post("/api/contracts/:id/execute", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const contract = await storage.getContractById(parseInt(req.params.id));
      if (!contract) return res.status(404).json({ message: "Contract not found" });
      // M51: allow Sent (and partially-signed) contracts to be executed — a
      // wet-ink / outside-e-sign signing happens in the real world and the
      // agent must be able to record it without a provider round-trip.
      if (!["signed", "sent", "viewed", "partially_signed", "ready_to_send"].includes(String(contract.status))) {
        return res.status(400).json({ message: `Cannot execute contract from status: ${contract.status}` });
      }
      const updated = await storage.updateContract(contract.id, { status: "executed", executedAt: new Date(), signedAt: contract.signedAt || new Date() } as any);
      // M50 sync: executing a contract advances the linked opportunity to
      // under_contract (mirrors the contract-documents send/close flow).
      try {
        const linkedOppId = (updated as any).opportunityId || (updated as any).propertyId || null;
        if (linkedOppId) {
          const prop = await storage.getPropertyById(Number(linkedOppId));
          if (prop && !["under_contract", "in_disposition", "sold", "closed", "dead", "voided"].includes(String((prop as any).stage || ""))) {
            await storage.updateProperty(Number(linkedOppId), { stage: "under_contract", stageChangedAt: new Date(), lastActivityAt: new Date() } as any);
            await logOpportunityEvent(Number(linkedOppId), "stage_changed", "Stage changed to Under Contract", `Auto-advanced: contract executed (${updated.title || `Contract #${updated.id}`}).`, user.id, "system", { oldStage: (prop as any).stage, newStage: "under_contract", contractId: updated.id });
          }
        }
      } catch (e: any) {
        console.error("execute: opportunity auto-advance failed:", e?.message);
      }
      await storage.createContractEvent({
        contractId: contract.id,
        actorType: "user",
        actorUserId: user.id,
        eventType: "executed",
        payloadJson: JSON.stringify({}),
        ip: req.ip,
        userAgent: String(req.headers["user-agent"] || ""),
      });
      res.json(updated);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  // M51: upload-signed accepts either an existing vault documentId or a real
  // multipart file (stored in the document vault, linked to the contract).
  reg("post", "/api/contracts/:id/upload-signed"); app.post("/api/contracts/:id/upload-signed", upload.single("file"), async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const contract = await storage.getContractById(parseInt(req.params.id));
      if (!contract) return res.status(404).json({ message: "Contract not found" });
      let { documentId, reason } = req.body || {};
      const file: any = (req as any).file;
      if (file) {
        const buf = Buffer.from(file.buffer);
        const teamId = await getOrInitActiveTeamId(req, user.id);
        if (!teamId) return res.status(400).json({ message: "No active team" });
        const storageKey = makeDocumentStorageKey({ teamId, originalName: String(file.originalname || "signed-copy") });
        const sha = sha256Hex(buf);
        await uploadDocumentObject({ storageKey, contentType: String(file.mimetype || "application/pdf"), body: buf });
        const doc = await storage.createDocument({
          teamId,
          title: `Signed copy — ${contract.title || `Contract #${contract.id}`}`,
          kind: "signed_contract",
          mimeType: String(file.mimetype || "application/pdf"),
          sizeBytes: typeof file.size === "number" ? file.size : buf.length,
          storageKey,
          sha256: sha,
          isPrivate: false,
          createdBy: user.id,
        } as any);
        documentId = doc.id;
        // Ticket 18: register signed legal doc as immutable in durable storage registry.
        try {
          const { getStorageProvider } = await import("./storage/provider.js");
          const sp = getStorageProvider();
          await storage.createStoredFile({
            originalName: String(file.originalname || "signed-copy"),
            storageKey,
            bucket: sp.bucket,
            sizeBytes: typeof file.size === "number" ? file.size : buf.length,
            mimeType: String(file.mimetype || "application/pdf"),
            checksumSha256: sha,
            entityType: "contract",
            entityId: String(contract.id),
            isImmutable: true,
            sourceKind: "upload",
            sourceRef: `contract:${contract.id}`,
            uploadedBy: user.id,
          } as any);
        } catch { /* registry table may not exist yet */ }
      }
      // M51: uploading a signed copy means the contract was signed — never
      // regress an executed contract back to signed, and stamp signedAt when
      // moving forward from sent/viewed/partially_signed.
      const forwardStatus = contract.status === "executed" ? "executed" : "signed";
      const updated = await storage.updateContract(contract.id, {
        status: forwardStatus,
        executedDocumentId: documentId || contract.executedDocumentId || null,
        signedAt: contract.signedAt || new Date(),
      } as any);
      await storage.createContractEvent({
        contractId: contract.id,
        actorType: "user",
        actorUserId: user.id,
        eventType: "document_uploaded",
        payloadJson: JSON.stringify({ documentId, reason }),
        ip: req.ip,
        userAgent: String(req.headers["user-agent"] || ""),
      });
      res.json(updated);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("post", "/api/contracts/:id/validate"); app.post("/api/contracts/:id/validate", async (req, res) => {
    try {
      const contract = await storage.getContractById(parseInt(req.params.id));
      if (!contract) return res.status(404).json({ message: "Contract not found" });
      const signers = await storage.getContractSignersByContract(contract.id);
      const fields = await storage.getContractFieldsByContract(contract.id);
      const errors = validateContractForSend(contract, signers, fields);
      res.json({ valid: errors.length === 0, errors });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("post", "/api/contracts/:id/generate-document"); app.post("/api/contracts/:id/generate-document", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const contract = await storage.getContractById(parseInt(req.params.id));
      if (!contract) return res.status(404).json({ message: "Contract not found" });
      const template = contract.templateId ? await storage.getContractTemplateById(contract.templateId) : null;
      if (!template) return res.status(400).json({ message: "Template is required" });
      const [property, buyer, seller, lead] = await Promise.all([
        contract.propertyId ? storage.getPropertyById(contract.propertyId) : null,
        contract.buyerId ? storage.getBuyerById(contract.buyerId) : null,
        contract.sellerContactId ? storage.getContactById(contract.sellerContactId) : null,
        contract.leadId ? storage.getLeadById(contract.leadId) : null,
      ]);
      const mergeData = buildMergeData({
        property: property || undefined,
        buyer: buyer || undefined,
        seller: seller || undefined,
        lead: lead || undefined,
      });
      const content = applyTemplateToContract(contract, template, mergeData);
      const doc = await storage.createContractDocument({
        templateId: template.id,
        propertyId: contract.propertyId,
        title: `${template.name} - Contract #${contract.id}`,
        documentType: "contract",
        status: "draft",
        content,
        mergeData: JSON.stringify(mergeData),
        createdBy: String(user.id),
      } as any);
      await storage.updateContract(contract.id, { generatedDocumentId: doc.id } as any);
      await storage.createContractEvent({
        contractId: contract.id,
        actorType: "user",
        actorUserId: user.id,
        eventType: "generated",
        payloadJson: JSON.stringify({ documentId: doc.id }),
      });
      res.status(201).json(doc);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("get", "/api/contracts/:id/signers"); app.get("/api/contracts/:id/signers", async (req, res) => {
    try {
      const authCtx = await requireAuth(req, res);
      if (!authCtx) return;
      const signers = await storage.getContractSignersByContract(parseInt(req.params.id));
      res.json(signers);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("post", "/api/contracts/:id/signers"); app.post("/api/contracts/:id/signers", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const validated = insertContractSignerSchema.parse(req.body);
      const signer = await storage.createContractSigner({ ...validated, contractId: parseInt(req.params.id) });
      await storage.createContractEvent({
        contractId: parseInt(req.params.id),
        actorType: "user",
        actorUserId: user.id,
        eventType: "signer_added",
        payloadJson: JSON.stringify({ signerId: signer.id }),
      });
      res.status(201).json(signer);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("patch", "/api/contracts/signers/:signerId"); app.patch("/api/contracts/signers/:signerId", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const partial = insertContractSignerSchema.partial().parse(req.body);
      const signer = await storage.updateContractSigner(parseInt(req.params.signerId), partial);
      res.json(signer);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("get", "/api/contracts/:id/events"); app.get("/api/contracts/:id/events", async (req, res) => {
    try {
      const authCtx = await requireAuth(req, res);
      if (!authCtx) return;
      const events = await storage.getContractEventsByContract(parseInt(req.params.id));
      res.json(events);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("get", "/api/contracts/:id/fields"); app.get("/api/contracts/:id/fields", async (req, res) => {
    try {
      const authCtx = await requireAuth(req, res);
      if (!authCtx) return;
      const fields = await storage.getContractFieldsByContract(parseInt(req.params.id));
      res.json(fields);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("post", "/api/contracts/:id/fields"); app.post("/api/contracts/:id/fields", async (req, res) => {
    try {
      const authCtx = await requireAuth(req, res);
      if (!authCtx) return;
      const validated = insertContractFieldSchema.parse(req.body);
      const field = await storage.createContractField({ ...validated, contractId: parseInt(req.params.id) });
      res.status(201).json(field);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("patch", "/api/contracts/fields/:fieldId"); app.patch("/api/contracts/fields/:fieldId", async (req, res) => {
    try {
      const authCtx = await requireAuth(req, res);
      if (!authCtx) return;
      const partial = insertContractFieldSchema.partial().parse(req.body);
      const field = await storage.updateContractField(parseInt(req.params.fieldId), partial);
      res.json(field);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("delete", "/api/contracts/fields/:fieldId"); app.delete("/api/contracts/fields/:fieldId", async (req, res) => {
    try {
      const authCtx = await requireAuth(req, res);
      if (!authCtx) return;
      await storage.deleteContractField(parseInt(req.params.fieldId));
      res.json({ message: "Field deleted" });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  // ===== CONTRACT DOCUMENTS (Store B — Document Management) =====
  // Ported back after the routes rewrite dropped the whole surface: the
  // Document Management page, dashboard contract counts, e-sign links, and
  // Close Deal & Record Revenue all call these endpoints.
  reg("get", "/api/contract-documents"); app.get("/api/contract-documents", async (req, res) => {
    try {
      const authCtx = await requireAuth(req, res);
      if (!authCtx) return;
      const { limit, offset } = parseLimitOffset(req.query);
      const documents = await storage.getContractDocuments(limit, offset);
      res.json(documents);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("get", "/api/contract-documents/:id"); app.get("/api/contract-documents/:id", async (req, res) => {
    try {
      const actor = await requireAuth(req, res);
      if (!actor) return;
      const document = await storage.getContractDocumentById(parseInt(req.params.id));
      if (!document) return res.status(404).json({ message: "Document not found" });
      res.json(document);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  // Phase 6: rendered text preview of a generated contract document.
  reg("get", "/api/contract-documents/:id/view"); app.get("/api/contract-documents/:id/view", async (req, res) => {
    try {
      const actor = await requireAuth(req, res);
      if (!actor) return;
      const doc = await storage.getContractDocumentById(parseInt(req.params.id));
      if (!doc) return res.status(404).json({ message: "Document not found" });
      const content = String((doc as any).content ?? "");
      res.json({ id: doc.id, title: doc.title, documentType: (doc as any).documentType, content });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  function wrapTextLines(text: string, maxChars: number = 95): string[] {
    const words = String(text).split(/\s+/);
    const out: string[] = [];
    let line = "";
    for (const w of words) {
      if ((line + " " + w).trim().length > maxChars) {
        if (line) out.push(line.trim());
        line = w;
      } else {
        line = line ? line + " " + w : w;
      }
    }
    if (line) out.push(line.trim());
    return out;
  }
  // Phase 6: generate a printable PDF from a contract document using pdf-lib.
  reg("get", "/api/contract-documents/:id/pdf"); app.get("/api/contract-documents/:id/pdf", async (req, res) => {
    try {
      const actor = await requireAuth(req, res);
      if (!actor) return;
      const doc = await storage.getContractDocumentById(parseInt(req.params.id));
      if (!doc) return res.status(404).json({ message: "Document not found" });
      const pdfLib = await import("pdf-lib");
      const pdf = await pdfLib.PDFDocument.create();
      const lines = String((doc as any).content ?? "").split(/\r?\n/);
      const page = pdf.addPage([612, 792]);
      const helvetica = await pdf.embedFont(pdfLib.StandardFonts.Helvetica);
      let y = 750;
      for (const raw of lines) {
        const line = String(raw).trim();
        if (!line) { y -= 14; continue; }
        const cleaned = line.replace(/[\u0000-\b\u000b\f\u000e-\u001f]/g, "");
        try {
          const wrapped = wrapTextLines(cleaned, 95);
          for (const seg of wrapped) {
            if (y < 40) { y = 750; }
            page.drawText(seg, { x: 50, y: y, size: 10, font: helvetica });
            y -= 14;
          }
        } catch {}
      }
      const bytes = await pdf.save();
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(String(doc.title || "contract"))}.pdf"`);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.send(Buffer.from(bytes));
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("post", "/api/contract-documents"); app.post("/api/contract-documents", async (req, res) => {
    try {
      const authCtx = await requireAuth(req, res);
      if (!authCtx) return;
      const validated = insertContractDocumentSchema.parse(req.body);
      const document = await storage.createContractDocument(validated);
      res.status(201).json(document);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("patch", "/api/contract-documents/:id"); app.patch("/api/contract-documents/:id", async (req, res) => {
    try {
      const authCtx = await requireAuth(req, res);
      if (!authCtx) return;
      const partial = insertContractDocumentSchema.partial().parse(req.body);
      const document = await storage.updateContractDocument(parseInt(req.params.id), partial);
      res.json(document);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("delete", "/api/contract-documents/:id"); app.delete("/api/contract-documents/:id", async (req, res) => {
    try {
      const actor = await requireAuth(req, res);
      if (!actor) return;
      await storage.deleteContractDocument(parseInt(req.params.id));
      res.json({ message: "Document deleted" });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  // DOCUMENT VERSIONS ENDPOINTS (salvaged from the routes-rewrite duplicate
  // block — these were registered only there, so the live server never had them)
  reg("get", "/api/documents/:documentId/versions"); app.get("/api/documents/:documentId/versions", async (req, res) => {
    try {
      const actor = await requireAuth(req, res);
      if (!actor) return;
      const versions = await storage.getDocumentVersions(parseInt(req.params.documentId));
      res.json(versions);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("post", "/api/documents/:documentId/versions"); app.post("/api/documents/:documentId/versions", async (req, res) => {
    try {
      const actor = await requireAuth(req, res);
      if (!actor) return;
      const validated = insertDocumentVersionSchema.parse({
        ...req.body,
        documentId: parseInt(req.params.documentId)
      });
      const version = await storage.createDocumentVersion(validated);
      res.status(201).json(version);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  // Disposition audit fix: "Close Deal & Record Revenue" must do more than flip a
  // status. This endpoint records the closing on the deal_assignments ledger,
  // advances the opportunity to sold, and writes an activity entry.
  reg("post", "/api/contract-documents/:id/close"); app.post("/api/contract-documents/:id/close", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const docId = parseInt(req.params.id, 10);
      const doc = await storage.getContractDocumentById(docId);
      if (!doc) return res.status(404).json({ message: "Contract not found" });
      if (doc.status === "closed") return res.status(400).json({ message: "Contract already closed" });

      const body = req.body || {};
      const closingData = body.closingData || {};
      let stageAdvanced = false;
      const num = (v: any) => {
        const n = parseFloat(String(v ?? "").replace(/[$,]/g, ""));
        return Number.isFinite(n) ? n.toFixed(2) : null;
      };
      const assignmentFee = num(closingData.assignmentFee);
      const closingCosts = num(closingData.closingCosts);
      const buyerPaid = !!closingData.buyerPaid;
      const titleReceived = !!closingData.titleReceived;
      const fundsWired = !!closingData.fundsWired;
      const docsRecorded = !!closingData.docsRecorded;

      // Item 3 (2026-09-16 audit): the close must fail LOUDLY, not silently.
      // Enforce the same rules the client dialog shows — a real fee and a
      // completed checklist — so an incomplete close can never be accepted.
      if (assignmentFee === null) {
        return res.status(400).json({ message: "Enter the assignment fee collected (0 or more).", code: "FEE_REQUIRED" });
      }
      if (!buyerPaid || !titleReceived || !fundsWired || !docsRecorded) {
        return res.status(400).json({ message: "Complete all closing checklist items before closing the deal.", code: "CHECKLIST_INCOMPLETE" });
      }

      // M47: persist the closing record into mergeData so Dashboard revenue
      // (which reads mergeData.closingData.assignmentFee) reflects the close.
      let mergedMergeData: string | undefined;
      try {
        const md = doc.mergeData ? (typeof doc.mergeData === "string" ? JSON.parse(doc.mergeData) : doc.mergeData) : {};
        mergedMergeData = JSON.stringify({
          ...md,
          assignmentFee: assignmentFee ?? (md as any).assignmentFee ?? null,
          closingData: {
            ...((md as any).closingData || {}),
            assignmentFee,
            closingCosts,
            buyerPaid,
            titleReceived,
            fundsWired,
            docsRecorded,
            notes: closingData.notes || null,
            closedAt: new Date().toISOString(),
          },
        });
      } catch { mergedMergeData = undefined; }
      const updated = await storage.updateContractDocument(docId, { status: "closed", ...(mergedMergeData ? { mergeData: mergedMergeData } : {}), updatedAt: new Date() } as any);

      // Write/refresh the per-deal payout ledger row (deal_assignments).
      const propertyId = doc.propertyId ?? null;
      if (propertyId) {
        try {
          const existing = await storage.getDealAssignmentsByPropertyId(propertyId);
          const prior = (existing || [])[0];
          const payoutReceived = buyerPaid && fundsWired && docsRecorded;
          const payload = {
            propertyId,
            assignmentFee,
            status: "closed",
            closingDate: new Date(),
            earnestMoneyReceived: buyerPaid,
            titleCleared: titleReceived,
            closingScheduled: fundsWired,
            documentsComplete: docsRecorded,
            payoutReceived,
            payoutAmount: payoutReceived ? assignmentFee : null,
            notes: [closingCosts ? `Closing costs: $${closingCosts}` : "", closingData.notes || ""].filter(Boolean).join(" — ") || null,
            updatedAt: new Date(),
          };
          if (prior) {
            await storage.updateDealAssignment(prior.id, payload);
          } else {
            await storage.createDealAssignment(payload);
          }
        } catch (e: any) {
          console.error("close: deal_assignments ledger write failed:", e?.message);
        }

        // Advance the opportunity to sold (projected fee lives in Financial Analysis;
        // this records the collected fee on the ledger).
        try {
          const property = await storage.getPropertyById(propertyId);
          if (property && !["sold", "closed", "dead", "voided"].includes(String((property as any).stage || ""))) {
            stageAdvanced = true;
            await storage.updateProperty(propertyId, { stage: "sold", stageChangedAt: new Date(), lastActivityAt: new Date() } as any);
            await logOpportunityEvent(propertyId, "stage_changed", "Stage changed to Sold", `Contract "${doc.title}" closed; assignment fee ${assignmentFee ? "$" + Number(assignmentFee).toLocaleString() : "not recorded"}.`, user.id, "system", { oldStage: (property as any).stage, newStage: "sold" });
          }
        } catch {}
      }

      try {
        if (req.session.userId) {
          await storage.createGlobalActivity({
            userId: req.session.userId,
            action: "closed_deal",
            description: `Closed deal: ${doc.title}${assignmentFee ? ` — fee $${Number(assignmentFee).toLocaleString()}` : ""}`,
            metadata: JSON.stringify({ contractDocumentId: docId, propertyId, assignmentFee, closingCosts }),
          });
        }
      } catch {}

      res.json({ contract: updated, stageAdvanced });
    } catch (error: any) {
      console.error("POST /api/contract-documents/:id/close failed:", error);
      res.status(500).json({ message: error.message });
    }
  });
  // ===== E-SIGN ENVELOPES (token-based signing on contract_documents) =====
  reg("get", "/api/contract-documents/:id/envelopes"); app.get("/api/contract-documents/:id/envelopes", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      if (!(await isFeatureEnabled(user.id, "esign", isFeatureBypassUser(user)))) return res.status(403).json({ message: "E-sign is not enabled for this account. Ask an administrator to enable the esign feature." });
      const id = parseInt(req.params.id);
      const rows = await storage.getContractEnvelopesByDocument(id);
      res.json(rows.map((e: any) => ({ ...e, tokenHash: undefined })));
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("post", "/api/contract-documents/:id/envelopes"); app.post("/api/contract-documents/:id/envelopes", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      if (!(await isFeatureEnabled(user.id, "esign", isFeatureBypassUser(user)))) return res.status(403).json({ message: "E-sign is not enabled for this account. Ask an administrator to enable the esign feature." });
      const id = parseInt(req.params.id);
      const doc = await storage.getContractDocumentById(id);
      if (!doc) return res.status(404).json({ message: "Document not found" });
      const schema = z.object({
        signerName: z.string().trim().min(1).max(255),
        signerEmail: z.string().trim().email().max(255),
        expiresInDays: z.number().int().min(1).max(120).optional(),
      });
      const payload = schema.parse(req.body || {});
      const token = crypto.randomBytes(24).toString("hex");
      const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
      const expiresAt = new Date(Date.now() + (payload.expiresInDays ?? 30) * 24 * 60 * 60 * 1000);
      const env = await storage.createContractEnvelope({
        documentId: id,
        status: "sent",
        signerName: payload.signerName,
        signerEmail: payload.signerEmail,
        tokenHash,
        expiresAt,
        sentAt: new Date(),
        auditJson: JSON.stringify([{ event: "sent", at: new Date().toISOString(), userId: user.id }]),
      } as any);
      await storage.updateContractDocument(id, { status: "sent" } as any);
      await storage.createGlobalActivity({
        userId: user.id,
        action: "contract_sent",
        description: `Contract sent for signature: ${doc.title}`,
        metadata: JSON.stringify({ documentId: id, envelopeId: env.id, signerEmail: payload.signerEmail }),
      } as any);
      const origin = `${req.protocol}://${req.get("host")}`;
      const signerUrl = `${origin}/sign/${token}`;
      let emailSent = false;
      let emailError: string | null = null;
      try {
        const subject = `Signature requested: ${String(doc.title || "Document")}`;
        const text = `You have a document to sign.\n\n${signerUrl}\n\nThis link expires on ${expiresAt.toISOString()}.`;
        const html = `<p>You have a document to sign.</p><p><a href="${signerUrl}">${signerUrl}</a></p><p>This link expires on ${expiresAt.toISOString()}.</p>`;
        await sendEmail({ to: payload.signerEmail, subject, text, html });
        emailSent = true;
      } catch (e: any) {
        emailError = String(e?.message || e);
      }
      try {
        const audit = (() => {
          try {
            const parsed = JSON.parse(String((env as any).auditJson || "[]"));
            return Array.isArray(parsed) ? parsed : [];
          } catch {
            return [];
          }
        })();
        audit.push({
          event: emailSent ? "email_sent" : "email_failed",
          at: new Date().toISOString(),
          to: payload.signerEmail,
          error: emailSent ? undefined : emailError,
        });
        await storage.updateContractEnvelope(env.id, { auditJson: JSON.stringify(audit) } as any);
      } catch {}
      res.status(201).json({ envelopeId: env.id, signerUrl, expiresAt: expiresAt.toISOString(), emailSent, emailError });
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("get", "/api/contract-envelopes/:id"); app.get("/api/contract-envelopes/:id", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      if (!(await isFeatureEnabled(user.id, "esign", isFeatureBypassUser(user)))) return res.status(403).json({ message: "E-sign is not enabled for this account. Ask an administrator to enable the esign feature." });
      const id = parseInt(req.params.id);
      const env = await storage.getContractEnvelopeById(id);
      if (!env) return res.status(404).json({ message: "Not found" });
      res.json({ ...env, tokenHash: undefined, signatureImageBase64: undefined, signedPdfBase64: undefined });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("post", "/api/contract-envelopes/:id/upload-signed"); app.post("/api/contract-envelopes/:id/upload-signed", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      if (!(await isFeatureEnabled(user.id, "esign", isFeatureBypassUser(user)))) return res.status(403).json({ message: "E-sign is not enabled for this account. Ask an administrator to enable the esign feature." });
      const id = parseInt(req.params.id);
      const schema = z.object({ signedPdfBase64: z.string().trim().min(1) });
      const payload = schema.parse(req.body || {});
      const env = await storage.getContractEnvelopeById(id);
      if (!env) return res.status(404).json({ message: "Not found" });
      const audit = (() => {
        try {
          const parsed = JSON.parse(String((env as any).auditJson || "[]"));
          return Array.isArray(parsed) ? parsed : [];
        } catch {
          return [];
        }
      })();
      audit.push({ event: "uploaded", at: new Date().toISOString(), userId: user.id });
      const updated = await storage.updateContractEnvelope(id, {
        status: "signed",
        signedAt: new Date(),
        signedPdfBase64: payload.signedPdfBase64,
        auditJson: JSON.stringify(audit),
      } as any);
      await storage.createGlobalActivity({
        userId: user.id,
        action: "contract_uploaded",
        description: "Signed contract uploaded",
        metadata: JSON.stringify({ envelopeId: id, documentId: updated.documentId }),
      } as any);
      res.json({ ok: true });
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  // ===== PUBLIC SIGNING ROUTES (token-authenticated, no session) =====
  reg("get", "/api/sign/envelopes/:token"); app.get("/api/sign/envelopes/:token", async (req, res) => {
    try {
      const token = String(req.params.token || "").trim();
      if (!token) return res.status(404).json({ message: "Not found" });
      const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
      const env = await storage.getContractEnvelopeByTokenHash(tokenHash);
      if (!env) return res.status(404).json({ message: "Not found" });
      if ((env as any).expiresAt && new Date((env as any).expiresAt).getTime() < Date.now()) return res.status(410).json({ message: "Link expired" });
      const doc = await storage.getContractDocumentById(env.documentId);
      if (!doc) return res.status(404).json({ message: "Not found" });
      let mergeData: any = {};
      try {
        mergeData = (doc as any).mergeData ? JSON.parse(String((doc as any).mergeData)) : {};
      } catch {
        mergeData = {};
      }
      const merged = mergeTemplate(String((doc as any).content || ""), mergeData);
      res.json({
        envelope: {
          id: env.id,
          status: env.status,
          signerName: env.signerName,
          signerEmail: env.signerEmail,
          expiresAt: (env as any).expiresAt,
          sentAt: (env as any).sentAt,
          viewedAt: (env as any).viewedAt,
          signedAt: (env as any).signedAt,
          declinedAt: (env as any).declinedAt,
        },
        document: { id: doc.id, title: doc.title, content: merged },
      });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("post", "/api/sign/envelopes/:token/viewed"); app.post("/api/sign/envelopes/:token/viewed", async (req, res) => {
    try {
      const token = String(req.params.token || "").trim();
      const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
      const env = await storage.getContractEnvelopeByTokenHash(tokenHash);
      if (!env) return res.status(404).json({ message: "Not found" });
      if ((env as any).expiresAt && new Date((env as any).expiresAt).getTime() < Date.now()) return res.status(410).json({ message: "Link expired" });
      const audit = (() => {
        try {
          const parsed = JSON.parse(String((env as any).auditJson || "[]"));
          return Array.isArray(parsed) ? parsed : [];
        } catch {
          return [];
        }
      })();
      audit.push({ event: "viewed", at: new Date().toISOString(), ip: req.ip, ua: req.headers["user-agent"] || "" });
      await storage.updateContractEnvelope(env.id, {
        status: env.status === "sent" ? "viewed" : env.status,
        viewedAt: (env as any).viewedAt || new Date(),
        auditJson: JSON.stringify(audit),
      } as any);
      res.json({ ok: true });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("post", "/api/sign/envelopes/:token/decline"); app.post("/api/sign/envelopes/:token/decline", async (req, res) => {
    try {
      const token = String(req.params.token || "").trim();
      const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
      const env = await storage.getContractEnvelopeByTokenHash(tokenHash);
      if (!env) return res.status(404).json({ message: "Not found" });
      if ((env as any).expiresAt && new Date((env as any).expiresAt).getTime() < Date.now()) return res.status(410).json({ message: "Link expired" });
      if (env.status === "signed") return res.status(400).json({ message: "Already signed" });
      const audit = (() => {
        try {
          const parsed = JSON.parse(String((env as any).auditJson || "[]"));
          return Array.isArray(parsed) ? parsed : [];
        } catch {
          return [];
        }
      })();
      audit.push({ event: "declined", at: new Date().toISOString(), ip: req.ip, ua: req.headers["user-agent"] || "" });
      await storage.updateContractEnvelope(env.id, { status: "declined", declinedAt: new Date(), auditJson: JSON.stringify(audit) } as any);
      res.json({ ok: true });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("post", "/api/sign/envelopes/:token/sign"); app.post("/api/sign/envelopes/:token/sign", async (req, res) => {
    try {
      const token = String(req.params.token || "").trim();
      const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
      const env = await storage.getContractEnvelopeByTokenHash(tokenHash);
      if (!env) return res.status(404).json({ message: "Not found" });
      if ((env as any).expiresAt && new Date((env as any).expiresAt).getTime() < Date.now()) return res.status(410).json({ message: "Link expired" });
      if (env.status === "signed") return res.status(400).json({ message: "Already signed" });
      if (env.status === "declined") return res.status(400).json({ message: "Declined" });
      const schema = z.object({
        signatureType: z.enum(["typed", "drawn"]),
        signatureText: z.string().trim().max(255).optional().nullable(),
        signatureImageBase64: z.string().trim().optional().nullable(),
      });
      const payload = schema.parse(req.body || {});
      if (payload.signatureType === "typed" && !String(payload.signatureText || "").trim()) return res.status(400).json({ message: "Signature text is required" });
      if (payload.signatureType === "drawn" && !String(payload.signatureImageBase64 || "").trim()) return res.status(400).json({ message: "Signature image is required" });
      const doc = await storage.getContractDocumentById(env.documentId);
      if (!doc) return res.status(404).json({ message: "Not found" });
      let mergeData: any = {};
      try {
        mergeData = (doc as any).mergeData ? JSON.parse(String((doc as any).mergeData)) : {};
      } catch {
        mergeData = {};
      }
      const merged = mergeTemplate(String((doc as any).content || ""), mergeData);
      const audit = (() => {
        try {
          const parsed = JSON.parse(String((env as any).auditJson || "[]"));
          return Array.isArray(parsed) ? parsed : [];
        } catch {
          return [];
        }
      })();
      audit.push({ event: "signed", at: new Date().toISOString(), ip: req.ip, ua: req.headers["user-agent"] || "" });
      const auditLines = [
        `Envelope #${env.id}`,
        `Signer: ${String(env.signerName || "")} <${String(env.signerEmail || "")}>`,
        `Signed at: ${new Date().toISOString()}`,
      ];
      const signedPdfBase64 = await generateSignedPdfBase64({
        title: String(doc.title || "Document"),
        contentText: merged,
        signatureType: payload.signatureType,
        signatureText: payload.signatureText || null,
        signatureImageBase64: payload.signatureImageBase64 || null,
        auditLines,
      });
      await storage.updateContractEnvelope(env.id, {
        status: "signed",
        signedAt: new Date(),
        signatureType: payload.signatureType,
        signatureText: payload.signatureText || null,
        signatureImageBase64: payload.signatureType === "drawn" ? payload.signatureImageBase64 || null : null,
        signedPdfBase64,
        auditJson: JSON.stringify(audit),
      } as any);
      await storage.updateContractDocument(env.documentId, { status: "executed" } as any).catch((e: any) => {
        console.error(JSON.stringify({ ts: new Date().toISOString(), event: "esign", kind: "document_update_failed", documentId: env.documentId, message: String(e?.message || e) }));
      });
      await storage.createGlobalActivity({
        userId: 0,
        action: "contract_signed",
        description: `Contract signed: ${String(doc.title || "")}`,
        metadata: JSON.stringify({ envelopeId: env.id, documentId: env.documentId, signerEmail: env.signerEmail || null }),
      } as any).catch(() => {});
      try {
        await onContractSigned({
          documentId: env.documentId,
          title: String(doc.title || "").trim(),
          propertyId: (doc as any)?.propertyId ?? null,
        });
      } catch {}
      res.json({ ok: true, signedPdfBase64 });
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("get", "/api/sign/envelopes/:token/pdf"); app.get("/api/sign/envelopes/:token/pdf", async (req, res) => {
    try {
      const token = String(req.params.token || "").trim();
      const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
      const env = await storage.getContractEnvelopeByTokenHash(tokenHash);
      if (!env) return res.status(404).json({ message: "Not found" });
      if (!env.signedPdfBase64) return res.status(404).json({ message: "Not found" });
      const bytes = Buffer.from(String(env.signedPdfBase64), "base64");
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="signed-envelope-${env.id}.pdf"`);
      res.send(bytes);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("get", "/api/sign/signers/:token"); app.get("/api/sign/signers/:token", async (req, res) => {
    try {
      const token = String(req.params.token || "").trim();
      if (!token) return res.status(404).json({ message: "Not found" });
      const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
      const signer = await storage.getContractSignerByTokenHash(tokenHash);
      if (!signer) return res.status(404).json({ message: "Not found" });
      if (signer.expiresAt && new Date(signer.expiresAt).getTime() < Date.now()) return res.status(410).json({ message: "Link expired" });
      if (signer.status === "signed") return res.status(400).json({ message: "Already signed" });
      if (signer.status === "declined") return res.status(400).json({ message: "Declined" });
      const contract = await storage.getContractById(signer.contractId);
      if (!contract) return res.status(404).json({ message: "Not found" });
      let docContent = "";
      let docTitle = "Contract";
      if ((contract as any).generatedDocumentId) {
        const doc = await storage.getContractDocumentById((contract as any).generatedDocumentId);
        if (doc) {
          docTitle = doc.title;
          let mergeData: any = {};
          try { mergeData = (doc as any).mergeData ? JSON.parse(String((doc as any).mergeData)) : {}; } catch { mergeData = {}; }
          const fallback = (contract as any).mergeDataSnapshot || {};
          const merged = mergeTemplate(String((doc as any).content || ""), { ...fallback, ...mergeData });
          docContent = merged;
        }
      }
      res.json({
        signer: {
          id: signer.id,
          name: signer.name,
          email: signer.email,
          role: signer.role,
          status: signer.status,
          expiresAt: signer.expiresAt,
          sentAt: signer.sentAt,
          viewedAt: signer.viewedAt,
          signedAt: signer.signedAt,
        },
        contract: { id: contract.id, status: contract.status },
        document: { title: docTitle, content: docContent },
      });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("post", "/api/sign/signers/:token/viewed"); app.post("/api/sign/signers/:token/viewed", async (req, res) => {
    try {
      const token = String(req.params.token || "").trim();
      const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
      const signer = await storage.getContractSignerByTokenHash(tokenHash);
      if (!signer) return res.status(404).json({ message: "Not found" });
      if (signer.expiresAt && new Date(signer.expiresAt).getTime() < Date.now()) return res.status(410).json({ message: "Link expired" });
      const updated = await storage.updateContractSigner(signer.id, {
        status: signer.status === "sent" ? "viewed" : signer.status,
        viewedAt: new Date(),
      } as any);
      res.json(updated);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("post", "/api/sign/signers/:token/decline"); app.post("/api/sign/signers/:token/decline", async (req, res) => {
    try {
      const token = String(req.params.token || "").trim();
      const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
      const signer = await storage.getContractSignerByTokenHash(tokenHash);
      if (!signer) return res.status(404).json({ message: "Not found" });
      if (signer.expiresAt && new Date(signer.expiresAt).getTime() < Date.now()) return res.status(410).json({ message: "Link expired" });
      if (signer.status === "signed") return res.status(400).json({ message: "Already signed" });
      const updated = await storage.updateContractSigner(signer.id, {
        status: "declined",
        declinedAt: new Date(),
      } as any);
      await storage.createContractEvent({
        contractId: signer.contractId,
        actorType: "contact",
        actorContactId: signer.contactId || undefined,
        eventType: "declined",
        payloadJson: JSON.stringify({ signerId: signer.id }),
        ip: req.ip,
        userAgent: String(req.headers["user-agent"] || ""),
      });
      res.json(updated);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("post", "/api/sign/signers/:token/sign"); app.post("/api/sign/signers/:token/sign", async (req, res) => {
    try {
      const token = String(req.params.token || "").trim();
      const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
      const signer = await storage.getContractSignerByTokenHash(tokenHash);
      if (!signer) return res.status(404).json({ message: "Not found" });
      if (signer.expiresAt && new Date(signer.expiresAt).getTime() < Date.now()) return res.status(410).json({ message: "Link expired" });
      if (signer.status === "signed") return res.status(400).json({ message: "Already signed" });
      if (signer.status === "declined") return res.status(400).json({ message: "Declined" });
      const schema = z.object({
        signatureType: z.enum(["typed", "drawn"]),
        signatureText: z.string().trim().max(255).optional().nullable(),
        signatureImageBase64: z.string().trim().optional().nullable(),
        legalName: z.string().trim().max(255).optional(),
        consent: z.boolean().optional(),
      });
      const payload = schema.parse(req.body || {});
      if (payload.signatureType === "typed" && !String(payload.signatureText || "").trim()) return res.status(400).json({ message: "Signature text is required" });
      if (payload.signatureType === "drawn" && !String(payload.signatureImageBase64 || "").trim()) return res.status(400).json({ message: "Signature image is required" });
      const contract = await storage.getContractById(signer.contractId);
      if (!contract) return res.status(404).json({ message: "Not found" });
      let docContent = "";
      if ((contract as any).generatedDocumentId) {
        const doc = await storage.getContractDocumentById((contract as any).generatedDocumentId);
        if (doc) {
          let mergeData: any = {};
          try { mergeData = (doc as any).mergeData ? JSON.parse(String((doc as any).mergeData)) : {}; } catch { mergeData = {}; }
          const fallback = (contract as any).mergeDataSnapshot || {};
          docContent = mergeTemplate(String((doc as any).content || ""), { ...fallback, ...mergeData });
        }
      }
      const auditLines = [
        `Contract #${contract.id}`,
        `Signer: ${signer.name} <${signer.email || ""}>`,
        `Signed at: ${new Date().toISOString()}`,
      ];
      const signedPdfBase64 = await generateSignedPdfBase64({
        title: `Contract #${contract.id}`,
        contentText: docContent,
        signatureType: payload.signatureType,
        signatureText: payload.signatureText || null,
        signatureImageBase64: payload.signatureImageBase64 || null,
        auditLines,
      });
      const signatureMetadata = {
        signatureType: payload.signatureType,
        legalName: payload.legalName || signer.name,
        consent: payload.consent || false,
        signedAt: new Date().toISOString(),
        ip: req.ip,
        userAgent: String(req.headers["user-agent"] || ""),
      };
      await storage.updateContractSigner(signer.id, {
        status: "signed",
        signedAt: new Date(),
        signatureMetadataJson: JSON.stringify(signatureMetadata),
      } as any);
      await storage.createContractEvent({
        contractId: signer.contractId,
        actorType: "contact",
        actorContactId: signer.contactId || undefined,
        eventType: "signed",
        payloadJson: JSON.stringify({ signerId: signer.id, signatureType: payload.signatureType }),
        ip: req.ip,
        userAgent: String(req.headers["user-agent"] || ""),
      });
      res.json({ ok: true, signedPdfBase64 });
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  // ── Contract Template PDF ──────────────────────────────────────────
  // Renders a contract template as a professional PDF (not raw HTML).
  reg("post", "/api/contract-templates/:id/pdf"); app.post("/api/contract-templates/:id/pdf", async (req, res) => {
    try {
      const authCtx = await requireAuth(req, res);
      if (!authCtx) return;
      const template = await storage.getContractTemplateById(parseInt(req.params.id));
      if (!template) return res.status(404).json({ message: "Template not found" });
      const { propertyId, buyerId, sellerContactId, leadId, mergeData: overrideData } = req.body || {};
      const [property, buyer, seller, lead] = await Promise.all([
        propertyId ? storage.getPropertyById(parseInt(propertyId)) : null,
        buyerId ? storage.getBuyerById(parseInt(buyerId)) : null,
        sellerContactId ? storage.getContactById(parseInt(sellerContactId)) : null,
        leadId ? storage.getLeadById(parseInt(leadId)) : null,
      ]);
      const mergeData = { ...buildMergeData({ property: property || undefined, buyer: buyer || undefined, seller: seller || undefined, lead: lead || undefined }), ...(overrideData || {}) };
      const content = applyTemplateToContract({}, template, mergeData);

      const { renderContractHtmlToPdf, toPrintableHtml } = await import("./esign/pdf.js");
      const html = toPrintableHtml(template.name || "Contract", content);
      const pdfBytes = await renderContractHtmlToPdf(html);

      const safeName = String(template.name || "contract").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${safeName}.pdf"`);
      res.setHeader("Content-Length", pdfBytes.length);
      res.send(Buffer.from(pdfBytes));
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("post", "/api/contract-templates/:id/preview"); app.post("/api/contract-templates/:id/preview", async (req, res) => {
    try {
      const template = await storage.getContractTemplateById(parseInt(req.params.id));
      if (!template) return res.status(404).json({ message: "Template not found" });
      const { propertyId, buyerId, sellerContactId, leadId } = req.body || {};
      const [property, buyer, seller, lead] = await Promise.all([
        propertyId ? storage.getPropertyById(parseInt(propertyId)) : null,
        buyerId ? storage.getBuyerById(parseInt(buyerId)) : null,
        sellerContactId ? storage.getContactById(parseInt(sellerContactId)) : null,
        leadId ? storage.getLeadById(parseInt(leadId)) : null,
      ]);
      const mergeData = buildMergeData({ property: property || undefined, buyer: buyer || undefined, seller: seller || undefined, lead: lead || undefined });
      const content = applyTemplateToContract({}, template, mergeData);
      res.json({ content, mergeData, fields: template.mergeFields || [] });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  // CONTACTS ENDPOINTS
  reg("get", "/api/contacts"); app.get("/api/contacts", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const { limit, offset } = parseLimitOffset(req.query);
      const query = String((req.query as any).query || "").trim().toLowerCase();
      const allContacts = await storage.getContacts(limit, offset);
      if (!query) return res.json(allContacts);
      const filtered = allContacts.filter((c: any) => {
        const hay = [
          c?.name,
          c?.email,
          c?.phone,
          c?.company,
          c?.type,
          c?.notes,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return hay.includes(query);
      });
      res.json(filtered);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("get", "/api/contacts/:id"); app.get("/api/contacts/:id", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const contact = await storage.getContactById(parseInt(req.params.id));
      if (!contact) return res.status(404).json({ message: "Contact not found" });
      res.json(contact);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("post", "/api/contacts"); app.post("/api/contacts", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const validated = insertContactSchema.parse(req.body);
      const contact = await storage.createContact(validated);
      res.status(201).json(contact);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("patch", "/api/contacts/:id"); app.patch("/api/contacts/:id", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const partial = insertContactSchema.partial().parse(req.body);
      const contact = await storage.updateContact(parseInt(req.params.id), partial);
      res.json(contact);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("delete", "/api/contacts/:id"); app.delete("/api/contacts/:id", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      await storage.deleteContact(parseInt(req.params.id));
      res.json({ message: "Contact deleted" });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("get", "/api/companies"); app.get("/api/companies", async (req, res) => {
    try {
      const ctx = await requireActiveTeam(req, res, { minRole: "viewer" });
      if (!ctx) return;
      const { limit, offset } = parseLimitOffset(req.query);
      const q = typeof req.query?.q === "string" ? req.query.q : "";
      const companyType = typeof req.query?.type === "string" ? req.query.type : "";
      const out = await storage.listCompanies({ teamId: ctx.teamId, q, companyType, limit, offset });
      res.json(out);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("post", "/api/companies"); app.post("/api/companies", async (req, res) => {
    try {
      const ctx = await requireActiveTeam(req, res, { minRole: "member" });
      if (!ctx) return;
      const schema = insertCompanySchema.omit({ teamId: true } as any);
      const validated: any = schema.parse(req.body || {});
      const company = await storage.createCompany({ ...validated, teamId: ctx.teamId } as any);
      try {
        await writeAuditEvent({
          teamId: ctx.teamId,
          actorUserId: ctx.user.id,
          entityType: "company",
          entityId: company.id,
          action: "company_created",
          before: null,
          after: company,
          kind: "create",
          ip: req.ip,
          userAgent: String(req.headers["user-agent"] || ""),
          requestId: (res.locals as any)?.requestId || null,
        });
      } catch {}
      res.status(201).json(company);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("get", "/api/companies/:id"); app.get("/api/companies/:id", async (req, res) => {
    try {
      const ctx = await requireActiveTeam(req, res, { minRole: "viewer" });
      if (!ctx) return;
      const id = parseInt(req.params.id, 10);
      const company = await storage.getCompanyById(id);
      if (!company || company.teamId !== ctx.teamId) return res.status(404).json({ message: "Not found" });
      res.json(company);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("patch", "/api/companies/:id"); app.patch("/api/companies/:id", async (req, res) => {
    try {
      const ctx = await requireActiveTeam(req, res, { minRole: "member" });
      if (!ctx) return;
      const id = parseInt(req.params.id, 10);
      const before = await storage.getCompanyById(id);
      if (!before || before.teamId !== ctx.teamId) return res.status(404).json({ message: "Not found" });
      const patchSchema = insertCompanySchema.partial().omit({ teamId: true } as any);
      const patch: any = patchSchema.parse(req.body || {});
      const updated = await storage.updateCompany(id, patch);
      try {
        await writeAuditEvent({
          teamId: ctx.teamId,
          actorUserId: ctx.user.id,
          entityType: "company",
          entityId: id,
          action: "company_updated",
          before,
          after: updated,
          kind: "update",
          ip: req.ip,
          userAgent: String(req.headers["user-agent"] || ""),
          requestId: (res.locals as any)?.requestId || null,
        });
      } catch {}
      res.json(updated);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("delete", "/api/companies/:id"); app.delete("/api/companies/:id", async (req, res) => {
    try {
      const ctx = await requireActiveTeam(req, res, { minRole: "admin" });
      if (!ctx) return;
      const id = parseInt(req.params.id, 10);
      const before = await storage.getCompanyById(id);
      if (!before || before.teamId !== ctx.teamId) return res.status(404).json({ message: "Not found" });
      await storage.deleteCompany(id);
      try {
        await writeAuditEvent({
          teamId: ctx.teamId,
          actorUserId: ctx.user.id,
          entityType: "company",
          entityId: id,
          action: "company_deleted",
          before,
          after: null,
          kind: "delete",
          ip: req.ip,
          userAgent: String(req.headers["user-agent"] || ""),
          requestId: (res.locals as any)?.requestId || null,
        });
      } catch {}
      res.json({ ok: true });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("get", "/api/companies/:id/people"); app.get("/api/companies/:id/people", async (req, res) => {
    try {
      const ctx = await requireActiveTeam(req, res, { minRole: "viewer" });
      if (!ctx) return;
      const companyId = parseInt(req.params.id, 10);
      const company = await storage.getCompanyById(companyId);
      if (!company || company.teamId !== ctx.teamId) return res.status(404).json({ message: "Not found" });
      const people = await storage.getCompanyPeople(companyId);
      res.json(people);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("post", "/api/companies/:id/people"); app.post("/api/companies/:id/people", async (req, res) => {
    try {
      const ctx = await requireActiveTeam(req, res, { minRole: "member" });
      if (!ctx) return;
      const companyId = parseInt(req.params.id, 10);
      const company = await storage.getCompanyById(companyId);
      if (!company || company.teamId !== ctx.teamId) return res.status(404).json({ message: "Not found" });
      const schema = insertCompanyPersonSchema.omit({ teamId: true, companyId: true } as any);
      const validated: any = schema.parse(req.body || {});
      const contactId = Number(validated.contactId);
      const contact = await storage.getContactById(contactId);
      if (!contact) return res.status(404).json({ message: "Contact not found" });
      const row = await storage.createCompanyPerson({ ...validated, teamId: ctx.teamId, companyId } as any);
      try {
        await writeAuditEvent({
          teamId: ctx.teamId,
          actorUserId: ctx.user.id,
          entityType: "company",
          entityId: companyId,
          action: "company_person_added",
          before: null,
          after: { companyPerson: row, contactId },
          kind: "update",
          ip: req.ip,
          userAgent: String(req.headers["user-agent"] || ""),
          requestId: (res.locals as any)?.requestId || null,
        });
      } catch {}
      res.status(201).json(row);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("delete", "/api/companies/:companyId/people/:companyPersonId"); app.delete("/api/companies/:companyId/people/:companyPersonId", async (req, res) => {
    try {
      const ctx = await requireActiveTeam(req, res, { minRole: "member" });
      if (!ctx) return;
      const companyId = parseInt(req.params.companyId, 10);
      const company = await storage.getCompanyById(companyId);
      if (!company || company.teamId !== ctx.teamId) return res.status(404).json({ message: "Not found" });
      const companyPersonId = parseInt(req.params.companyPersonId, 10);
      await storage.deleteCompanyPerson(companyPersonId);
      try {
        await writeAuditEvent({
          teamId: ctx.teamId,
          actorUserId: ctx.user.id,
          entityType: "company",
          entityId: companyId,
          action: "company_person_removed",
          before: { companyPersonId },
          after: null,
          kind: "update",
          ip: req.ip,
          userAgent: String(req.headers["user-agent"] || ""),
          requestId: (res.locals as any)?.requestId || null,
        });
      } catch {}
      res.json({ ok: true });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("get", "/api/documents"); app.get("/api/documents", async (req, res) => {
    try {
      const ctx = await requireActiveTeam(req, res, { minRole: "viewer" });
      if (!ctx) return;
      const { limit, offset } = parseLimitOffset(req.query);
      const q = typeof req.query?.q === "string" ? req.query.q : "";
      const tag = typeof req.query?.tag === "string" ? req.query.tag : "";
      const entityType = typeof req.query?.entityType === "string" ? req.query.entityType : "";
      const entityIdRaw = typeof req.query?.entityId === "string" ? req.query.entityId : "";
      const entityId = entityIdRaw ? parseInt(entityIdRaw, 10) : undefined;
      const out = await storage.listDocuments({
        teamId: ctx.teamId,
        q,
        tag,
        entityType,
        entityId,
        limit,
        offset,
      });
      res.json(out);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  function canViewVaultDocument(ctx: { user: any; membership: any }, document: any) {
    if (!document) return false;
    if (!document.isPrivate) return true;
    if (Number(document.createdBy) === Number(ctx.user.id)) return true;
    return teamRoleRank(ctx.membership?.role) >= teamRoleRank("admin") || isManagerUser(ctx.user);
  }
  reg("post", "/api/documents/upload"); app.post("/api/documents/upload", upload.single("file"), async (req, res) => {
    try {
      const ctx = await requireActiveTeam(req, res, { minRole: "member" });
      if (!ctx) return;
      if (!isDocumentVaultConfigured()) {
        return res.status(503).json({ code: "document_vault_not_configured", message: "Document vault is not configured" });
      }
      const file: any = (req as any).file;
      if (!file) return res.status(400).json({ message: "Missing file" });
      const titleRaw = typeof req.body?.title === "string" ? req.body.title : "";
      const title = titleRaw.trim() || String(file.originalname || "Document");
      const kind = typeof req.body?.kind === "string" ? req.body.kind.trim() : null;
      const isPrivateRaw = (req.body as any)?.isPrivate;
      const isPrivate =
        isPrivateRaw === true || String(isPrivateRaw || "").trim().toLowerCase() === "true" || String(isPrivateRaw || "").trim() === "1";
      const tagsRaw = (req.body as any)?.tags;
      let tags: string[] | null = null;
      if (Array.isArray(tagsRaw)) {
        tags = tagsRaw.map((t) => String(t || "").trim()).filter(Boolean);
      } else if (typeof tagsRaw === "string" && tagsRaw.trim()) {
        try {
          const parsed = JSON.parse(tagsRaw);
          if (Array.isArray(parsed)) tags = parsed.map((t) => String(t || "").trim()).filter(Boolean);
          else tags = tagsRaw.split(",")
        } catch {
          tags = tagsRaw.split(",")
        }
      }
      const buf = Buffer.from(file.buffer);
      
      // Magic byte validation
      const detectedMime = detectMimeFromMagic(buf);
      if (detectedMime && detectedMime !== file.mimetype) {
        return res.status(400).json({ message: `File content does not match declared type. Expected ${file.mimetype}, detected ${detectedMime}` });
      }
      
      const storageKey = makeDocumentStorageKey({ teamId: ctx.teamId, originalName: String(file.originalname || "file") });
      const sha = sha256Hex(buf);
      await uploadDocumentObject({ storageKey, contentType: String(file.mimetype || "application/octet-stream"), body: buf });
      const doc = await storage.createDocument({
        teamId: ctx.teamId,
        title,
        kind,
        mimeType: String(file.mimetype || "application/octet-stream"),
        sizeBytes: typeof file.size === "number" ? file.size : buf.length,
        storageKey,
        sha256: sha,
        tags: tags && tags.length ? tags : null,
        isPrivate,
        createdBy: ctx.user.id,
      } as any);
      const v1 = await storage.createVaultDocumentVersion({
        teamId: ctx.teamId,
        documentId: doc.id,
        version: 1,
        storageKey,
        mimeType: String(file.mimetype || "application/octet-stream"),
        sizeBytes: typeof file.size === "number" ? file.size : buf.length,
        sha256: sha,
        createdBy: ctx.user.id,
      } as any);
      const entityType = typeof req.body?.entityType === "string" ? req.body.entityType.trim() : "";
      const entityIdRaw = typeof req.body?.entityId === "string" ? req.body.entityId.trim() : "";
      const entityId = entityIdRaw ? parseInt(entityIdRaw, 10) : NaN;
      const relation = typeof req.body?.relation === "string" ? req.body.relation.trim() : null;
      const links: any[] = [];
      if (entityType && Number.isFinite(entityId) && entityId > 0) {
        const link = await storage.createDocumentLink({
          teamId: ctx.teamId,
          documentId: doc.id,
          entityType,
          entityId,
          relation,
        } as any);
        links.push(link);
      }
      try {
        await writeAuditEvent({
          teamId: ctx.teamId,
          actorUserId: ctx.user.id,
          entityType: "document",
          entityId: doc.id,
          action: "document_uploaded",
          before: null,
          after: doc,
          kind: "create",
          ip: req.ip,
          userAgent: String(req.headers["user-agent"] || ""),
          requestId: (res.locals as any)?.requestId || null,
        });
      } catch {}
      res.status(201).json({ document: doc, links, versions: [v1] });
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("get", "/api/documents/:id"); app.get("/api/documents/:id", async (req, res) => {
    try {
      const ctx = await requireActiveTeam(req, res, { minRole: "viewer" });
      if (!ctx) return;
      const id = parseInt(req.params.id, 10);
      const doc = await storage.getDocumentById(id);
      if (!doc || doc.teamId !== ctx.teamId) return res.status(404).json({ message: "Not found" });
      if (!canViewVaultDocument(ctx, doc)) return res.status(403).json({ message: "Forbidden" });
      const links = await storage.getDocumentLinksByDocumentId(id);
      const versions = await storage.getVaultDocumentVersions(id);
      res.json({ document: doc, links, versions });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("get", "/api/documents/:id/download"); app.get("/api/documents/:id/download", async (req, res) => {
    try {
      const ctx = await requireActiveTeam(req, res, { minRole: "viewer" });
      if (!ctx) return;
      const id = parseInt(req.params.id, 10);
      const doc = await storage.getDocumentById(id);
      if (!doc || doc.teamId !== ctx.teamId) return res.status(404).json({ message: "Not found" });
      if (!canViewVaultDocument(ctx, doc)) return res.status(403).json({ message: "Forbidden" });
      const url = await getDocumentSignedUrl({ storageKey: String(doc.storageKey), expiresInSeconds: 60 * 10 });
      if (url) {
        res.redirect(url);
        return;
      }
      // DB-backed mode: stream the blob straight from PostgreSQL
      const content = await getDocumentContent({ storageKey: String(doc.storageKey) });
      if (!content) return res.status(404).json({ message: "Document content not found" });
      const safeTitle = String(doc.title || "document").replace(/[^a-zA-Z0-9._ -]+/g, "_");
      res.setHeader("Content-Type", content.contentType || "application/octet-stream");
      res.setHeader("Content-Disposition", `attachment; filename="${safeTitle}"`);
      res.setHeader("Content-Length", String(content.sizeBytes));
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.send(content.body);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  // Phase 6: in-app preview. Streams the stored object inline so PDFs and
  // images render in a browser viewport without forcing a download. The
  // storage key / signed URL is never exposed to the client.
  reg("get", "/api/documents/:id/preview"); app.get("/api/documents/:id/preview", async (req, res) => {
    try {
      const ctx = await requireActiveTeam(req, res, { minRole: "viewer" });
      if (!ctx) return;
      const id = parseInt(req.params.id, 10);
      const doc = await storage.getDocumentById(id);
      if (!doc || doc.teamId !== ctx.teamId) return res.status(404).json({ message: "Not found" });
      if (!canViewVaultDocument(ctx, doc)) return res.status(403).json({ message: "Forbidden" });
      const url = await getDocumentSignedUrl({ storageKey: String(doc.storageKey), expiresInSeconds: 60 * 5 });
      if (url) {
        const upstream = await fetch(url as string);
        if (!upstream.ok) return res.status(502).json({ message: "Preview source unavailable" });
        const buffer = Buffer.from(await upstream.arrayBuffer());
        res.setHeader("Content-Type", String(doc.mimeType || "application/octet-stream"));
        res.setHeader("Content-Disposition", "inline");
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.send(buffer);
        return;
      }
      // DB-backed mode: stream the blob straight from PostgreSQL
      const content = await getDocumentContent({ storageKey: String(doc.storageKey) });
      if (!content) return res.status(404).json({ message: "Document content not found" });
      res.setHeader("Content-Type", content.contentType || String(doc.mimeType || "application/octet-stream"));
      res.setHeader("Content-Disposition", "inline");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.send(content.body);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("post", "/api/documents/:id/link"); app.post("/api/documents/:id/link", async (req, res) => {
    try {
      const ctx = await requireActiveTeam(req, res, { minRole: "member" });
      if (!ctx) return;
      const documentId = parseInt(req.params.id, 10);
      const doc = await storage.getDocumentById(documentId);
      if (!doc || doc.teamId !== ctx.teamId) return res.status(404).json({ message: "Not found" });
      const schema = insertDocumentLinkSchema.omit({ id: true, createdAt: true, teamId: true, documentId: true } as any);
      const validated: any = schema.parse(req.body || {});
      const link = await storage.createDocumentLink({
        teamId: ctx.teamId,
        documentId,
        entityType: validated.entityType,
        entityId: validated.entityId,
        relation: typeof validated.relation === "string" ? validated.relation : null,
      } as any);
      try {
        await writeAuditEvent({
          teamId: ctx.teamId,
          actorUserId: ctx.user.id,
          entityType: "document",
          entityId: documentId,
          action: "document_link_added",
          before: null,
          after: link,
          kind: "update",
          ip: req.ip,
          userAgent: String(req.headers["user-agent"] || ""),
          requestId: (res.locals as any)?.requestId || null,
        });
      } catch {}
      res.status(201).json(link);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("delete", "/api/documents/:id/link/:linkId"); app.delete("/api/documents/:id/link/:linkId", async (req, res) => {
    try {
      const ctx = await requireActiveTeam(req, res, { minRole: "member" });
      if (!ctx) return;
      const documentId = parseInt(req.params.id, 10);
      const doc = await storage.getDocumentById(documentId);
      if (!doc || doc.teamId !== ctx.teamId) return res.status(404).json({ message: "Not found" });
      const linkId = parseInt(req.params.linkId, 10);
      const link = await storage.getDocumentLinkById(linkId);
      if (!link || link.teamId !== ctx.teamId || link.documentId !== documentId) return res.status(404).json({ message: "Not found" });
      await storage.deleteDocumentLinkForTeam(ctx.teamId, linkId);
      try {
        await writeAuditEvent({
          teamId: ctx.teamId,
          actorUserId: ctx.user.id,
          entityType: "document",
          entityId: documentId,
          action: "document_link_removed",
          before: link,
          after: null,
          kind: "update",
          ip: req.ip,
          userAgent: String(req.headers["user-agent"] || ""),
          requestId: (res.locals as any)?.requestId || null,
        });
      } catch {}
      res.json({ ok: true });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("get", "/api/documents/:id/versions"); app.get("/api/documents/:id/versions", async (req, res) => {
    try {
      const ctx = await requireActiveTeam(req, res, { minRole: "viewer" });
      if (!ctx) return;
      const documentId = parseInt(req.params.id, 10);
      const doc = await storage.getDocumentById(documentId);
      if (!doc || doc.teamId !== ctx.teamId) return res.status(404).json({ message: "Not found" });
      if (!canViewVaultDocument(ctx, doc)) return res.status(403).json({ message: "Forbidden" });
      const versions = await storage.getVaultDocumentVersions(documentId);
      res.json(versions);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("post", "/api/documents/:id/versions"); app.post("/api/documents/:id/versions", upload.single("file"), async (req, res) => {
    try {
      const ctx = await requireActiveTeam(req, res, { minRole: "member" });
      if (!ctx) return;
      if (!isDocumentVaultConfigured()) {
        return res.status(503).json({ code: "document_vault_not_configured", message: "Document vault is not configured" });
      }
      const documentId = parseInt(req.params.id, 10);
      const doc = await storage.getDocumentById(documentId);
      if (!doc || doc.teamId !== ctx.teamId) return res.status(404).json({ message: "Not found" });
      if (!canViewVaultDocument(ctx, doc)) return res.status(403).json({ message: "Forbidden" });
      const file: any = (req as any).file;
      if (!file) return res.status(400).json({ message: "Missing file" });
      const versions = await storage.getVaultDocumentVersions(documentId);
      const nextVersion = versions.length ? Math.max(...versions.map((v: any) => Number(v.version) || 0)) + 1 : 1;
      const buf = Buffer.from(file.buffer);
      const storageKey = makeDocumentStorageKey({ teamId: ctx.teamId, originalName: String(file.originalname || "file") });
      const sha = sha256Hex(buf);
      await uploadDocumentObject({ storageKey, contentType: String(file.mimetype || "application/octet-stream"), body: buf });
      const v = await storage.createVaultDocumentVersion({
        teamId: ctx.teamId,
        documentId,
        version: nextVersion,
        storageKey,
        mimeType: String(file.mimetype || "application/octet-stream"),
        sizeBytes: typeof file.size === "number" ? file.size : buf.length,
        sha256: sha,
        createdBy: ctx.user.id,
      } as any);
      const updated = await storage.updateDocument(documentId, {
        storageKey,
        mimeType: String(file.mimetype || "application/octet-stream"),
        sizeBytes: typeof file.size === "number" ? file.size : buf.length,
        sha256: sha,
        updatedAt: new Date(),
      } as any);
      try {
        await writeAuditEvent({
          teamId: ctx.teamId,
          actorUserId: ctx.user.id,
          entityType: "document",
          entityId: documentId,
          action: "document_version_uploaded",
          before: doc,
          after: updated,
          kind: "update",
          ip: req.ip,
          userAgent: String(req.headers["user-agent"] || ""),
          requestId: (res.locals as any)?.requestId || null,
        });
      } catch {}
      res.status(201).json({ document: updated, version: v });
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("get", "/api/automations"); app.get("/api/automations", async (req, res) => {
    try {
      const ctx = await requireActiveTeam(req, res, { minRole: "admin" });
      if (!ctx) return;
      const { limit, offset } = parseLimitOffset(req.query);
      const items = await storage.listAutomations(ctx.teamId, limit, offset);
      res.json(items);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("post", "/api/automations"); app.post("/api/automations", async (req, res) => {
    try {
      const ctx = await requireActiveTeam(req, res, { minRole: "admin" });
      if (!ctx) return;
      const baseSchema = insertAutomationSchema.omit({ teamId: true } as any);
      const base: any = baseSchema.parse(req.body || {});
      const automation = await storage.createAutomation({ ...base, teamId: ctx.teamId } as any);
      const triggersRaw = Array.isArray(req.body?.triggers) ? req.body.triggers : [];
      const triggers = triggersRaw
        .map((t: any) => ({
          eventType: String(t?.eventType || "").trim(),
          configJson: typeof t?.configJson === "string" ? t.configJson : JSON.stringify(t?.config || {}),
        }))
        .filter((t: any) => t.eventType);
      await storage.replaceAutomationTriggers(ctx.teamId, automation.id, triggers);
      const conditionRaw = req.body?.condition;
      const conditionJson =
        typeof conditionRaw?.configJson === "string"
          ? String(conditionRaw.configJson)
          : typeof conditionRaw === "object" && conditionRaw
            ? JSON.stringify(conditionRaw)
            : "{}";
      await storage.upsertAutomationCondition(ctx.teamId, automation.id, conditionJson);
      const actionsRaw = Array.isArray(req.body?.actions) ? req.body.actions : [];
      const actions = actionsRaw
        .map((a: any, idx: number) => ({
          actionType: String(a?.actionType || "").trim(),
          configJson: typeof a?.configJson === "string" ? a.configJson : JSON.stringify(a?.config || {}),
          sortOrder: typeof a?.sortOrder === "number" ? a.sortOrder : idx,
        }))
        .filter((a: any) => a.actionType);
      await storage.replaceAutomationActions(ctx.teamId, automation.id, actions);
      const out = {
        automation,
        triggers: await storage.getAutomationTriggers(automation.id),
        condition: await storage.getAutomationCondition(automation.id),
        actions: await storage.getAutomationActions(automation.id),
      };
      try {
        await writeAuditEvent({
          teamId: ctx.teamId,
          actorUserId: ctx.user.id,
          entityType: "automation",
          entityId: automation.id,
          action: "automation_created",
          before: null,
          after: out,
          kind: "create",
          ip: req.ip,
          userAgent: String(req.headers["user-agent"] || ""),
          requestId: (res.locals as any)?.requestId || null,
        });
      } catch {}
      res.status(201).json(out);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("get", "/api/automations/:id"); app.get("/api/automations/:id", async (req, res) => {
    try {
      const ctx = await requireActiveTeam(req, res, { minRole: "admin" });
      if (!ctx) return;
      const id = parseInt(req.params.id, 10);
      const automation = await storage.getAutomationById(id);
      if (!automation || automation.teamId !== ctx.teamId) return res.status(404).json({ message: "Not found" });
      res.json({
        automation,
        triggers: await storage.getAutomationTriggers(id),
        condition: await storage.getAutomationCondition(id),
        actions: await storage.getAutomationActions(id),
      });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("patch", "/api/automations/:id"); app.patch("/api/automations/:id", async (req, res) => {
    try {
      const ctx = await requireActiveTeam(req, res, { minRole: "admin" });
      if (!ctx) return;
      const id = parseInt(req.params.id, 10);
      const before = await storage.getAutomationById(id);
      if (!before || before.teamId !== ctx.teamId) return res.status(404).json({ message: "Not found" });
      const baseSchema = insertAutomationSchema.partial().omit({ teamId: true } as any);
      const patch: any = baseSchema.parse(req.body || {});
      const updated = await storage.updateAutomation(id, { ...patch, updatedAt: new Date() } as any);
      if (Array.isArray(req.body?.triggers)) {
        const triggers = (req.body.triggers as any[])
          .map((t: any) => ({
            eventType: String(t?.eventType || "").trim(),
            configJson: typeof t?.configJson === "string" ? t.configJson : JSON.stringify(t?.config || {}),
          }))
          .filter((t: any) => t.eventType);
        await storage.replaceAutomationTriggers(ctx.teamId, id, triggers);
      }
      if (typeof req.body?.condition !== "undefined") {
        const c = req.body.condition;
        const conditionJson =
          typeof c?.configJson === "string" ? String(c.configJson) : typeof c === "object" && c ? JSON.stringify(c) : "{}";
        await storage.upsertAutomationCondition(ctx.teamId, id, conditionJson);
      }
      if (Array.isArray(req.body?.actions)) {
        const actions = (req.body.actions as any[])
          .map((a: any, idx: number) => ({
            actionType: String(a?.actionType || "").trim(),
            configJson: typeof a?.configJson === "string" ? a.configJson : JSON.stringify(a?.config || {}),
            sortOrder: typeof a?.sortOrder === "number" ? a.sortOrder : idx,
          }))
          .filter((a: any) => a.actionType);
        await storage.replaceAutomationActions(ctx.teamId, id, actions);
      }
      const out = {
        automation: updated,
        triggers: await storage.getAutomationTriggers(id),
        condition: await storage.getAutomationCondition(id),
        actions: await storage.getAutomationActions(id),
      };
      try {
        await writeAuditEvent({
          teamId: ctx.teamId,
          actorUserId: ctx.user.id,
          entityType: "automation",
          entityId: id,
          action: "automation_updated",
          before,
          after: out,
          kind: "update",
          ip: req.ip,
          userAgent: String(req.headers["user-agent"] || ""),
          requestId: (res.locals as any)?.requestId || null,
        });
      } catch {}
      res.json(out);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("delete", "/api/automations/:id"); app.delete("/api/automations/:id", async (req, res) => {
    try {
      const ctx = await requireActiveTeam(req, res, { minRole: "admin" });
      if (!ctx) return;
      const id = parseInt(req.params.id, 10);
      const before = await storage.getAutomationById(id);
      if (!before || before.teamId !== ctx.teamId) return res.status(404).json({ message: "Not found" });
      await storage.deleteAutomation(id);
      try {
        await writeAuditEvent({
          teamId: ctx.teamId,
          actorUserId: ctx.user.id,
          entityType: "automation",
          entityId: id,
          action: "automation_deleted",
          before,
          after: null,
          kind: "delete",
          ip: req.ip,
          userAgent: String(req.headers["user-agent"] || ""),
          requestId: (res.locals as any)?.requestId || null,
        });
      } catch {}
      res.json({ ok: true });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("get", "/api/automations/:id/runs"); app.get("/api/automations/:id/runs", async (req, res) => {
    try {
      const ctx = await requireActiveTeam(req, res, { minRole: "admin" });
      if (!ctx) return;
      const id = parseInt(req.params.id, 10);
      const automation = await storage.getAutomationById(id);
      if (!automation || automation.teamId !== ctx.teamId) return res.status(404).json({ message: "Not found" });
      const { limit, offset } = parseLimitOffset(req.query);
      const items = await storage.listAutomationRuns(ctx.teamId, id, limit, offset);
      res.json(items);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  // Dry-run an automation against a test event
  reg("post", "/api/automations/:id/test"); app.post("/api/automations/:id/test", async (req, res) => {
    try {
      const ctx = await requireActiveTeam(req, res, { minRole: "admin" });
      if (!ctx) return;
      const id = parseInt(req.params.id, 10);
      const automation = await storage.getAutomationById(id);
      if (!automation || automation.teamId !== ctx.teamId) return res.status(404).json({ message: "Not found" });
      const { eventType, entity } = req.body || {};
      if (!eventType || typeof eventType !== "string") {
        return res.status(400).json({ message: "eventType is required" });
      }
      const result = await dryRunAutomation(id, ctx.teamId, {
        eventType,
        occurredAt: new Date().toISOString(),
        teamId: ctx.teamId,
        actorUserId: ctx.user.id,
        entity: { type: entity?.type || "lead", id: entity?.id || null },
        payload: req.body?.payload || {},
      });
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  // CONTRACT TEMPLATES ENDPOINTS
  reg("get", "/api/contract-templates"); app.get("/api/contract-templates", async (req, res) => {
    try {
      const authCtx = await requireAuth(req, res);
      if (!authCtx) return;
      const { limit, offset } = parseLimitOffset(req.query);
      const category = typeof req.query?.category === "string" ? req.query.category : undefined;
      const jurisdiction = typeof req.query?.jurisdiction === "string" ? req.query.jurisdiction : undefined;
      const status = typeof req.query?.status === "string" ? req.query.status : undefined;
      const q = typeof req.query?.q === "string" ? req.query.q : undefined;
      const templates = await storage.getContractTemplates({ limit, offset, category, jurisdiction, status, q });
      res.json(templates);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("get", "/api/contract-templates/:id"); app.get("/api/contract-templates/:id", async (req, res) => {
    try {
      const authCtx = await requireAuth(req, res);
      if (!authCtx) return;
      const template = await storage.getContractTemplateById(parseInt(req.params.id));
      if (!template) return res.status(404).json({ message: "Template not found" });
      res.json(template);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("post", "/api/contract-templates"); app.post("/api/contract-templates", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const validated: any = insertContractTemplateSchema.parse(req.body);
      const template = await storage.createContractTemplate({
        ...validated,
        ownerUserId: user.id,
        status: validated.status || "draft",
        version: 1,
      } as any);
      res.status(201).json(template);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("patch", "/api/contract-templates/:id"); app.patch("/api/contract-templates/:id", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const id = parseInt(req.params.id);
      const current = await storage.getContractTemplateById(id);
      if (!current) return res.status(404).json({ message: "Template not found" });
      const partial: any = insertContractTemplateSchema.partial().parse(req.body);
      // Editing content/name of an approved template is not allowed in place — require /revise.
      if (partial.content !== undefined && current.status === "approved") {
        return res.status(400).json({ message: "Approved templates are immutable. Use /revise to create a new version." });
      }
      const template = await storage.updateContractTemplate(id, partial);
      res.json(template);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("delete", "/api/contract-templates/:id"); app.delete("/api/contract-templates/:id", async (req, res) => {
    try {
      const authCtx = await requireAuth(req, res);
      if (!authCtx) return;
      await storage.deleteContractTemplate(parseInt(req.params.id));
      res.json({ message: "Template deleted" });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  // Phase 6 governance: approve/publish a template (admin/manager).
  reg("post", "/api/contract-templates/:id/approve"); app.post("/api/contract-templates/:id/approve", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      if (!isManagerUser(user)) return res.status(403).json({ message: "Requires manager or admin role" });
      const id = parseInt(req.params.id);
      const template = await storage.getContractTemplateById(id);
      if (!template) return res.status(404).json({ message: "Template not found" });
      const approved = await storage.approveContractTemplate(id, user.id);
      res.json(approved);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  // Phase 6 governance: editing an approved template must not overwrite history.
  // Creates a new draft version with lineage (parentTemplateId, version+1).
  reg("post", "/api/contract-templates/:id/revise"); app.post("/api/contract-templates/:id/revise", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const id = parseInt(req.params.id);
      const template = await storage.getContractTemplateById(id);
      if (!template) return res.status(404).json({ message: "Template not found" });
      if (template.status !== "approved") {
        return res.status(400).json({ message: "Only approved templates require versioning. Edit drafts directly." });
      }
      const clone = await storage.cloneContractTemplate(id, user.id);
      if (!clone) return res.status(500).json({ message: "Failed to create revision" });
      res.status(201).json(clone);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  // USERS ENDPOINTS
  reg("get", "/api/users"); app.get("/api/users", async (req, res) => {
    try {
      const actor = await requireAuth(req, res);
      if (!actor) return;
      const { limit, offset } = parseLimitOffset(req.query);
      const users = (await storage.getUsers(limit, offset)) as any[];
      // Hide inactive (archived/deactivated) accounts from pickers; never expose
      // password hashes or TOTP secrets to API clients. profile_picture is a
      // multi-MB base64 blob — avatars are served by /api/users/:id/avatar.
      res.json(
        (users || [])
          .filter((u: any) => u.isActive !== false)
          .map((u: any) => {
            const { passwordHash, profilePicture, profile_picture, ...safe } = u;
            return { ...safe, hasProfilePicture: !!u.profilePicture || !!u.profile_picture };
          }),
      );
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  // Serves the raw base64 profile picture as a cacheable image response.
  reg("get", "/api/users/:id/avatar"); app.get("/api/users/:id/avatar", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ message: "Invalid id" });
      const payload = await storage.getUserPrivatePayloadById(id);
      const pic = (payload as any)?.profilePicture || null;
      if (!pic) return res.status(404).json({ message: "No profile picture" });
      let body = pic;
      let contentType = "image/jpeg";
      const m = /^data:(image\/[a-z0-9.+-]+);base64,(.*)$/is.exec(pic);
      if (m) {
        contentType = m[1];
        body = m[2];
      }
      const buf = Buffer.from(String(body).replace(/\s/g, ""), "base64");
      res.setHeader("Content-Type", contentType);
      res.setHeader("Cache-Control", "public, max-age=86400");
      res.send(buf);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  // Serves the user's banner config + custom banner image payloads (kept out
  // of /api/users responses because they can be multi-MB base64 blobs).
  reg("get", "/api/users/:id/banner"); app.get("/api/users/:id/banner", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ message: "Invalid id" });
      const rows = await db
        .select({ bannerConfig: users.bannerConfig, customBannerImages: users.customBannerImages })
        .from(users)
        .where(eq(users.id, id))
        .limit(1);
      if (!rows.length) return res.status(404).json({ message: "User not found" });
      res.setHeader("Cache-Control", "public, max-age=300");
      return res.json({
        bannerConfig: rows[0].bannerConfig ?? null,
        customBannerImages: rows[0].customBannerImages ?? null,
      });
    } catch (error: any) {
      return res.status(500).json({ message: error.message });
    }
  });
  reg("get", "/api/users/:id"); app.get("/api/users/:id", async (req, res) => {
    try {
      const actor = await requireAuth(req, res);
      if (!actor) return;
      // Excludes multi-MB payload columns; avatars load via /api/users/:id/avatar
      // and banner payloads via /api/users/:id/banner.
      const user = await storage.getUserByIdWithoutProfilePicture(parseInt(req.params.id));
      if (!user) return res.status(404).json({ message: "User not found" });
      const { passwordHash, ...safe } = user as any;
      res.json(safe);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("post", "/api/users"); app.post("/api/users", async (req, res) => {
    try {
      const actor = await requireAuth(req, res);
      if (!actor) return;
      const validated = insertUserSchema.parse(req.body) as any;
      // P0 fix: only admins/managers may set privileged fields on user creation.
      // A non-privileged actor creating a user with role:"admin" was a privilege escalation.
      if (!isManagerUser(actor)) {
        delete validated.role;
        delete validated.isSuperAdmin;
      }
      // Never accept a raw passwordHash from the client — hash the plaintext password.
      if (validated.password && !validated.passwordHash) {
        validated.passwordHash = await bcrypt.hash(String(validated.password), 12);
        delete validated.password;
      } else {
        delete validated.passwordHash;
        delete validated.password;
      }
      const user = await storage.createUser(validated);
      const { passwordHash, ...safe } = user as any;
      res.status(201).json(safe);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  // Change password
  reg("patch", "/api/users/:id/password"); app.patch("/api/users/:id/password", async (req, res) => {
    if (!req.session.userId) {
      return res.status(401).json({ message: "Not authenticated" });
    }
    const userId = parseInt(req.params.id);
    if (req.session.userId !== userId) {
      return res.status(403).json({ message: "Forbidden" });
    }
    try {
      const { currentPassword, newPassword } = req.body;
      if (!currentPassword || !newPassword) {
        return res.status(400).json({ message: "Current and new password are required" });
      }
      if (newPassword.length < 8) {
        return res.status(400).json({ message: "Password must be at least 8 characters long" });
      }
      const user = await storage.getUserById(userId);
      if (!user || !user.passwordHash) {
        return res.status(404).json({ message: "User not found" });
      }
      const isValid = await bcrypt.compare(currentPassword, user.passwordHash);
      if (!isValid) {
        return res.status(401).json({ message: "Current password is incorrect" });
      }
      const newPasswordHash = await bcrypt.hash(newPassword, 12);
      await storage.updateUser(userId, { passwordHash: newPasswordHash });
      res.json({ message: "Password updated successfully" });
    } catch (error) {
      console.error("Error changing password:", error);
      res.status(500).json({ message: "Failed to change password" });
    }
  });
  reg("patch", "/api/users/:id"); app.patch("/api/users/:id", async (req, res) => {
    try {
      const actor = await requireAuth(req, res);
      if (!actor) return;
      const targetId = parseInt(req.params.id);
      if (!isSameUserOrAdmin(actor, targetId)) return res.status(403).json({ message: "Forbidden" });
      const partial = insertUserSchema.partial().parse(req.body) as any;
      // P0 fix: non-privileged users may only edit their own non-privileged fields.
      // Previously a user could PATCH themselves with role:"admin" / isSuperAdmin:true
      // / passwordHash:"..." and escalate or hijack credentials.
      if (!isManagerUser(actor)) {
        delete partial.role;
        delete partial.isSuperAdmin;
        delete partial.passwordHash;
        delete partial.password;
      } else if (Number(actor.id) === targetId) {
        // Even admins cannot change their own role/hash via this generic endpoint —
        // use the dedicated password-change and admin-management flows.
        delete partial.passwordHash;
        delete partial.password;
      }
      const user = await storage.updateUser(targetId, partial);
      // updateUser returns the full row (RETURNING *); strip password + multi-MB
      // payload columns from the response.
      const { passwordHash, profilePicture, profile_picture, customBannerImages, bannerConfig, ...safe } = user as any;
      res.json({
        ...safe,
        hasProfilePicture: !!profilePicture || !!profile_picture,
        hasCustomBannerImages: !!customBannerImages,
        hasBannerConfig: !!bannerConfig,
      });
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  // TWO FACTOR AUTH ENDPOINTS — self-or-admin only, password re-auth for sensitive changes
  reg("get", "/api/users/:userId/2fa"); app.get("/api/users/:userId/2fa", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const targetId = parseInt(req.params.userId);
      if (!isSameUserOrAdmin(user, targetId)) return res.status(403).json({ message: "You do not have access" });
      const auth = await storage.getTwoFactorAuthByUserId(targetId);
      res.json(auth ? { isEnabled: auth.isEnabled, method: auth.method, createdAt: auth.createdAt } : { isEnabled: false });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("post", "/api/users/:userId/2fa"); app.post("/api/users/:userId/2fa", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const targetId = parseInt(req.params.userId);
      if (!isSameUserOrAdmin(user, targetId)) return res.status(403).json({ message: "You do not have access" });
      if (Number(user.id) !== targetId) return res.status(403).json({ message: "Only the account owner can enable 2FA" });
      // Enrollment requires the current password.
      const currentPassword = String(req.body?.password || "");
      const fresh = await storage.getUserById(targetId);
      if (!fresh?.passwordHash) return res.status(400).json({ message: "Password authentication is required to enable 2FA" });
      const okPw = await bcrypt.compare(currentPassword, fresh.passwordHash);
      if (!okPw) return res.status(401).json({ message: "Current password is incorrect" });
      const existing = await storage.getTwoFactorAuthByUserId(targetId);
      if (existing?.isEnabled) return res.status(400).json({ message: "2FA is already enabled" });
      const secret = speakeasy.generateSecret({ name: `Luxe RM (${req.body?.email || user.email})`, issuer: "Luxe RM", length: 32 });
      const qrCode = await QRCode.toDataURL(secret.otpauth_url!);
      const validated = insertTwoFactorAuthSchema.parse({ userId: targetId, secret: secret.base32, isEnabled: false, method: "totp" });
      const auth = await storage.createTwoFactorAuth(validated);
      const teamId = (await getOrInitActiveTeamId(req, user.id)) ?? null;
      if (teamId) {
        try { await writeAuditEvent({ teamId, actorUserId: user.id, entityType: "user", entityId: targetId, action: "2fa_enrollment_started", kind: "create", ip: req.ip, userAgent: String(req.headers["user-agent"] || "") }); } catch {}
      }
      res.status(201).json({ ...auth, qrCode, otpauthUrl: secret.otpauth_url });
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("post", "/api/users/:userId/2fa/verify"); app.post("/api/users/:userId/2fa/verify", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const targetId = parseInt(req.params.userId);
      if (!isSameUserOrAdmin(user, targetId)) return res.status(403).json({ message: "You do not have access" });
      if (!checkTwoFactorRateLimit(`verify:${targetId}:${req.ip || "unknown"}`)) {
        return res.status(429).json({ message: "Too many attempts. Try again in 15 minutes." });
      }
      const { code } = req.body || {};
      if (!code || String(code).trim().length !== 6) return res.status(400).json({ message: "A 6-digit code is required" });
      const auth = await storage.getTwoFactorAuthByUserId(targetId);
      if (!auth) return res.status(404).json({ message: "2FA not set up" });
      const verified = speakeasy.totp.verify({ secret: auth.secret, encoding: "base32", token: String(code).trim(), window: 2 });
      if (!verified) return res.status(400).json({ message: "Invalid code" });
      const updated = await storage.updateTwoFactorAuth(targetId, { isEnabled: true });
      const teamId = (await getOrInitActiveTeamId(req, user.id)) ?? null;
      if (teamId) {
        try { await writeAuditEvent({ teamId, actorUserId: user.id, entityType: "user", entityId: targetId, action: "2fa_enabled", kind: "update", ip: req.ip, userAgent: String(req.headers["user-agent"] || "") }); } catch {}
      }
      res.json({ isEnabled: updated.isEnabled });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("post", "/api/auth/login/2fa"); app.post("/api/auth/login/2fa", async (req, res) => {
    try {
      const { tempToken, code } = req.body || {};
      if (!tempToken || !code) return res.status(400).json({ message: "Missing tempToken or code" });
      if (!checkTwoFactorRateLimit(`login2fa:${req.ip || "unknown"}`)) {
        return res.status(429).json({ message: "Too many attempts. Try again in 15 minutes." });
      }
      const secret = authJwtSecret();
      if (!secret) return res.status(500).json({ message: "Auth not configured" });
      const { jwtVerify } = await import("jose");
      let payload: any;
      try {
        payload = await jwtVerify(tempToken, secret);
      } catch {
        return res.status(401).json({ message: "Invalid or expired session" });
      }
      const userId = parseInt(payload.sub as string);
      const user = await storage.getUserById(userId);
      if (!user) return res.status(401).json({ message: "User not found" });
      const twoFactor = await storage.getTwoFactorAuthByUserId(userId);
      if (!twoFactor?.isEnabled) return res.status(400).json({ message: "2FA is not enabled" });
      const isBackupCode = String(code).trim().length === 10;
      let verified = false;
      if (isBackupCode) {
        const codeHash = crypto.createHash("sha256").update(String(code).trim()).digest("hex");
        verified = await storage.useBackupCode(userId, codeHash);
      } else {
        verified = speakeasy.totp.verify({ secret: twoFactor.secret, encoding: "base32", token: String(code).trim(), window: 2 });
      }
      if (!verified) return res.status(401).json({ message: isBackupCode ? "Invalid backup code" : "Invalid 2FA code" });
      req.session.userId = user.id;
      req.session.email = user.email;
      {
        const at = await getOrInitActiveTeamId(req, user.id);
        if (at) req.session.activeTeamId = at;
        else delete req.session.activeTeamId;
      }
      const { passwordHash, profilePicture, profile_picture, ...__rest } = user as any;
      const userWithoutPassword = { ...__rest, hasProfilePicture: (user as any).hasProfilePicture ?? (!!profilePicture || !!profile_picture) };
      const token = await issueAuthToken({ sub: String(user.id), email: user.email });
      res.json({ user: userWithoutPassword, token });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("patch", "/api/users/:userId/2fa"); app.patch("/api/users/:userId/2fa", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const targetId = parseInt(req.params.userId);
      if (!isSameUserOrAdmin(user, targetId)) return res.status(403).json({ message: "You do not have access" });
      const partial = insertTwoFactorAuthSchema.partial().parse(req.body);
      const { secret: _secret, isEnabled: _isEnabled, ...allowed } = partial as any;
      if (Object.keys(allowed).length === 0) return res.status(400).json({ message: "Nothing to update" });
      const auth = await storage.updateTwoFactorAuth(targetId, allowed);
      res.json(auth);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("delete", "/api/users/:userId/2fa"); app.delete("/api/users/:userId/2fa", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const targetId = parseInt(req.params.userId);
      if (!isSameUserOrAdmin(user, targetId)) return res.status(403).json({ message: "You do not have access" });
      if (Number(user.id) !== targetId) return res.status(403).json({ message: "Only the account owner can disable 2FA" });
      // Disable flow: require current password AND a valid second factor.
      const currentPassword = String(req.body?.password || "");
      const secondFactor = String(req.body?.code || "");
      const fresh = await storage.getUserById(targetId);
      if (!fresh?.passwordHash) return res.status(400).json({ message: "Password authentication is required to disable 2FA" });
      const okPw = await bcrypt.compare(currentPassword, fresh.passwordHash);
      if (!okPw) return res.status(401).json({ message: "Current password is incorrect" });
      const auth = await storage.getTwoFactorAuthByUserId(targetId);
      let secondFactorOk = false;
      if (auth) {
        if (String(secondFactor).trim().length === 10) {
          const codeHash = crypto.createHash("sha256").update(String(secondFactor).trim()).digest("hex");
          secondFactorOk = await storage.useBackupCode(targetId, codeHash);
        } else {
          secondFactorOk = speakeasy.totp.verify({ secret: auth.secret, encoding: "base32", token: String(secondFactor).trim(), window: 2 });
        }
      }
      if (!secondFactorOk) return res.status(401).json({ message: "A valid 2FA code or backup code is required to disable 2FA" });
      await storage.deleteTwoFactorAuth(targetId);
      await storage.deleteBackupCodes(targetId);
      const teamId = (await getOrInitActiveTeamId(req, user.id)) ?? null;
      if (teamId) {
        try { await writeAuditEvent({ teamId, actorUserId: user.id, entityType: "user", entityId: targetId, action: "2fa_disabled", kind: "delete", ip: req.ip, userAgent: String(req.headers["user-agent"] || "") }); } catch {}
      }
      res.json({ message: "2FA disabled" });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  // BACKUP CODES ENDPOINTS — hashed at rest; plain codes returned only at generation time
  reg("get", "/api/users/:userId/backup-codes"); app.get("/api/users/:userId/backup-codes", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const targetId = parseInt(req.params.userId);
      if (!isSameUserOrAdmin(user, targetId)) return res.status(403).json({ message: "You do not have access" });
      const codes = await storage.getBackupCodesByUserId(targetId);
      const unusedCount = codes.filter((c: any) => !c.isUsed).length;
      res.json({ count: codes.length, unusedCount, createdAt: codes[0]?.createdAt || null });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("post", "/api/users/:userId/backup-codes"); app.post("/api/users/:userId/backup-codes", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const targetId = parseInt(req.params.userId);
      if (!isSameUserOrAdmin(user, targetId)) return res.status(403).json({ message: "You do not have access" });
      const validated = insertBackupCodeSchema.parse({ ...req.body, userId: targetId });
      const code = await storage.createBackupCode(validated);
      res.status(201).json(code);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("post", "/api/users/:userId/backup-codes/generate"); app.post("/api/users/:userId/backup-codes/generate", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const targetId = parseInt(req.params.userId);
      if (!isSameUserOrAdmin(user, targetId)) return res.status(403).json({ message: "You do not have access" });
      if (Number(user.id) !== targetId) return res.status(403).json({ message: "Only the account owner can generate backup codes" });
      await storage.deleteBackupCodes(targetId);
      const codes: string[] = [];
      const hashedCodes: Array<{ userId: number; code: string; isUsed: boolean }> = [];
      for (let i = 0; i < 10; i++) {
        const rawCode = crypto.randomBytes(5).toString("hex").toUpperCase().slice(0, 10);
        const codeHash = crypto.createHash("sha256").update(rawCode).digest("hex");
        codes.push(rawCode);
        hashedCodes.push({ userId: targetId, code: codeHash, isUsed: false });
      }
      await db.insert(backupCodes).values(hashedCodes as any);
      const teamId = (await getOrInitActiveTeamId(req, user.id)) ?? null;
      if (teamId) {
        try { await writeAuditEvent({ teamId, actorUserId: user.id, entityType: "user", entityId: targetId, action: "backup_codes_regenerated", kind: "update", ip: req.ip, userAgent: String(req.headers["user-agent"] || "") }); } catch {}
      }
      res.status(201).json({ codes });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  // Ticket 7: the canonical default lives in shared/pipeline-stages.ts. Always
  // returning a real default means a lead/opportunity board is never empty just
  // because a user has not customized their columns ("columns not configured").
  const defaultPipelineColumnsByEntityType: Record<string, Array<{ value: string; label: string }>> =
    DEFAULT_PIPELINE_COLUMNS;
  // ===================== DOCUMENTATION (playbook / knowledge base) =====================
  // Read: any authenticated team member. Write: admins only. First GET on a
  // team seeds the OceanLuxe Sales Playbook once (idempotent, never overwrites).

  async function resolveDocsTeam(req: any, res: any): Promise<{ user: any; teamId: number } | null> {
    const user = await requireAuth(req, res);
    if (!user) return null;
    try {
      const teamId = await getOrInitActiveTeamId(req, user.id);
      if (!teamId) {
        res.status(400).json({ message: "No active team" });
        return null;
      }
      return { user, teamId };
    } catch (e: any) {
      res.status(500).json({ message: e?.message || "Failed to resolve team" });
      return null;
    }
  }

  reg("get", "/api/docs/categories"); app.get("/api/docs/categories", async (req, res) => {
    try {
      const ctx = await resolveDocsTeam(req, res);
      if (!ctx) return;
      const first = (await storage.listDocsCategories(ctx.teamId)).length === 0 && (await storage.listDocsPages(ctx.teamId)).length === 0;
      if (first) await seedDocsForTeam(ctx.teamId);
      res.json(await storage.listDocsCategories(ctx.teamId));
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  reg("post", "/api/docs/categories"); app.post("/api/docs/categories", async (req, res) => {
    try {
      const ctx = await resolveDocsTeam(req, res);
      if (!ctx) return;
      if (!isAdminUser(ctx.user)) return res.status(403).json({ message: "Admin access required" });
      const name = String(req.body?.name || "").trim();
      if (!name) return res.status(400).json({ message: "Name is required" });
      const slug = docsSlugify(String(req.body?.slug || name));
      const category = await storage.createDocsCategory({
        teamId: ctx.teamId,
        name,
        slug,
        description: req.body?.description ? String(req.body.description) : null,
        sortOrder: Number.isFinite(req.body?.sortOrder) ? Number(req.body.sortOrder) : 0,
      });
      res.status(201).json(category);
    } catch (error: any) {
      if (String(error?.message || "").includes("unique")) return res.status(409).json({ message: "A category with that slug already exists" });
      res.status(500).json({ message: error.message });
    }
  });

  reg("patch", "/api/docs/categories/:id"); app.patch("/api/docs/categories/:id", async (req, res) => {
    try {
      const ctx = await resolveDocsTeam(req, res);
      if (!ctx) return;
      if (!isAdminUser(ctx.user)) return res.status(403).json({ message: "Admin access required" });
      const id = parseInt(req.params.id, 10);
      const patch: any = {};
      if (req.body?.name) patch.name = String(req.body.name).trim();
      if (req.body?.description !== undefined) patch.description = req.body?.description ? String(req.body.description) : null;
      if (Number.isFinite(req.body?.sortOrder)) patch.sortOrder = Number(req.body.sortOrder);
      const updated = await storage.updateDocsCategory(id, patch);
      if (!updated) return res.status(404).json({ message: "Category not found" });
      res.json(updated);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  reg("delete", "/api/docs/categories/:id"); app.delete("/api/docs/categories/:id", async (req, res) => {
    try {
      const ctx = await resolveDocsTeam(req, res);
      if (!ctx) return;
      if (!isAdminUser(ctx.user)) return res.status(403).json({ message: "Admin access required" });
      await storage.deleteDocsCategory(parseInt(req.params.id, 10));
      res.json({ message: "Category deleted" });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // List page metadata (no bodies). q searches title/summary/body.
  reg("get", "/api/docs/pages"); app.get("/api/docs/pages", async (req, res) => {
    try {
      const ctx = await resolveDocsTeam(req, res);
      if (!ctx) return;
      const categoryId = req.query.categoryId ? parseInt(String(req.query.categoryId), 10) : undefined;
      const q = typeof req.query.q === "string" ? req.query.q : undefined;
      const includeUnpublished = isAdminUser(ctx.user);
      const pages = await storage.listDocsPages(ctx.teamId, { categoryId: Number.isFinite(categoryId as any) ? categoryId : undefined, q, includeUnpublished });
      res.json(pages);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  reg("post", "/api/docs/pages"); app.post("/api/docs/pages", async (req, res) => {
    try {
      const ctx = await resolveDocsTeam(req, res);
      if (!ctx) return;
      if (!isAdminUser(ctx.user)) return res.status(403).json({ message: "Admin access required" });
      const title = String(req.body?.title || "").trim();
      const body = String(req.body?.body || "");
      if (!title || !body.trim()) return res.status(400).json({ message: "Title and body are required" });
      const page = await storage.createDocsPage({
        teamId: ctx.teamId,
        categoryId: req.body?.categoryId ? Number(req.body.categoryId) : null,
        title,
        slug: docsSlugify(String(req.body?.slug || title)),
        summary: req.body?.summary ? String(req.body.summary).slice(0, 500) : null,
        body,
        tags: Array.isArray(req.body?.tags) ? req.body.tags.map((t: any) => String(t)) : [],
        sortOrder: Number.isFinite(req.body?.sortOrder) ? Number(req.body.sortOrder) : 0,
        isPublished: req.body?.isPublished === false ? false : true,
        createdBy: ctx.user.id,
        updatedBy: ctx.user.id,
      });
      res.status(201).json(page);
    } catch (error: any) {
      if (String(error?.message || "").includes("unique")) return res.status(409).json({ message: "A page with that slug already exists" });
      res.status(500).json({ message: error.message });
    }
  });

  reg("get", "/api/docs/pages/:slug"); app.get("/api/docs/pages/:slug", async (req, res) => {
    try {
      const ctx = await resolveDocsTeam(req, res);
      if (!ctx) return;
      const page = await storage.getDocsPageBySlug(ctx.teamId, String(req.params.slug || ""));
      if (!page) return res.status(404).json({ message: "Page not found" });
      if (!page.isPublished && !isAdminUser(ctx.user)) return res.status(404).json({ message: "Page not found" });
      res.json(page);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  reg("patch", "/api/docs/pages/:id"); app.patch("/api/docs/pages/:id", async (req, res) => {
    try {
      const ctx = await resolveDocsTeam(req, res);
      if (!ctx) return;
      if (!isAdminUser(ctx.user)) return res.status(403).json({ message: "Admin access required" });
      const id = parseInt(req.params.id, 10);
      const existing = await storage.getDocsPageById(id);
      if (!existing || existing.teamId !== ctx.teamId) return res.status(404).json({ message: "Page not found" });
      const patch: any = { updatedBy: ctx.user.id };
      if (req.body?.title) patch.title = String(req.body.title).trim();
      if (req.body?.slug) patch.slug = docsSlugify(String(req.body.slug));
      if (req.body?.summary !== undefined) patch.summary = req.body?.summary ? String(req.body.summary).slice(0, 500) : null;
      if (req.body?.body) patch.body = String(req.body.body);
      if (req.body?.categoryId !== undefined) patch.categoryId = req.body?.categoryId ? Number(req.body.categoryId) : null;
      if (Array.isArray(req.body?.tags)) patch.tags = req.body.tags.map((t: any) => String(t));
      if (Number.isFinite(req.body?.sortOrder)) patch.sortOrder = Number(req.body.sortOrder);
      if (req.body?.isPublished !== undefined) patch.isPublished = !!req.body.isPublished;
      const updated = await storage.updateDocsPage(id, patch);
      res.json(updated);
    } catch (error: any) {
      if (String(error?.message || "").includes("unique")) return res.status(409).json({ message: "A page with that slug already exists" });
      res.status(500).json({ message: error.message });
    }
  });

  reg("delete", "/api/docs/pages/:id"); app.delete("/api/docs/pages/:id", async (req, res) => {
    try {
      const ctx = await resolveDocsTeam(req, res);
      if (!ctx) return;
      if (!isAdminUser(ctx.user)) return res.status(403).json({ message: "Admin access required" });
      const existing = await storage.getDocsPageById(parseInt(req.params.id, 10));
      if (!existing || existing.teamId !== ctx.teamId) return res.status(404).json({ message: "Page not found" });
      await storage.deleteDocsPage(existing.id);
      res.json({ message: "Page deleted" });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  reg("get", "/api/pipeline-config"); app.get("/api/pipeline-config", async (req, res) => {
    try {
      const userId = req.session.userId;
      if (!userId) return res.status(401).json({ message: "Unauthorized" });
      const entityType = String(req.query.entityType || "").trim();
      const defaults = defaultPipelineColumnsByEntityType[entityType];
      if (!defaults) return res.status(400).json({ message: "Invalid entityType" });
      const row = await storage.getPipelineConfig(userId, entityType);
      if (!row) return res.json({ entityType, columns: defaults });
      let parsed: any = defaults;
      try {
        const json = JSON.parse(row.columns);
        // Ticket 7: normalize stored config to canonical stage ids; drop unknowns
        // and fall back to the safe default if nothing canonical remains.
        const { columns: canonical } = validatePipelineColumns(entityType as any, json);
        if (canonical.length) parsed = canonical;
      } catch {}
      res.json({ entityType, columns: parsed });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("put", "/api/pipeline-config"); app.put("/api/pipeline-config", async (req, res) => {
    try {
      const userId = req.session.userId;
      if (!userId) return res.status(401).json({ message: "Unauthorized" });
      const entityType = String(req.query.entityType || "").trim();
      const defaults = defaultPipelineColumnsByEntityType[entityType];
      if (!defaults) return res.status(400).json({ message: "Invalid entityType" });
      const columns = req.body?.columns;
      if (!Array.isArray(columns) || !columns.length) return res.status(400).json({ message: "Invalid columns" });
      // Ticket 7: validate against the canonical taxonomy. Known legacy aliases
      // are normalized; genuinely unknown stages are rejected (never persisted),
      // so the board cannot drift into a vocabulary nothing else understands.
      const { columns: cleaned, rejected } = validatePipelineColumns(entityType as any, columns);
      if (rejected.length) {
        return res.status(400).json({
          message: "Unknown pipeline stage(s)",
          rejected,
          allowed: defaults.map((c) => c.value),
        });
      }
      if (!cleaned.length) return res.status(400).json({ message: "Invalid columns" });
      const updated = await storage.upsertPipelineConfig(userId, entityType, JSON.stringify(cleaned));
      let parsed: any = cleaned;
      try {
        const json = JSON.parse(updated.columns);
        if (Array.isArray(json)) parsed = json;
      } catch {}
      res.json({ entityType, columns: parsed });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  // GLOBAL ACTIVITY ENDPOINT
  // TEAM PULSE — simplified daily standup for the Team page (/team).
  // Answers "who's in the mix and what got done?" with per-person digests
  // instead of the noisy per-event feed the audit flagged. Aggregates the
  // global activity log into buckets; quiet teammates come from the roster.
  reg("get", "/api/team-pulse"); app.get("/api/team-pulse", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const hoursRaw = req.query.hours ? parseInt(String(req.query.hours), 10) : 24;
      const hours = Number.isFinite(hoursRaw) ? Math.min(Math.max(hoursRaw, 1), 24 * 30) : 24;
      const since = new Date(Date.now() - hours * 60 * 60 * 1000);

      const rows = await storage.getTeamPulseWindow(hours);

      // Bucket each normalized action into the five digest categories.
      const bucketFor = (action: string): string | null => {
        const a = String(action || "").toLowerCase();
        if (a.includes("lead")) return "leads";
        if (a.includes("task") || a.includes("followup")) return "tasks";
        if (a.includes("call") || a.includes("sms") || a.includes("telephony") || a.includes("voicemail")) return "calls";
        if (a.includes("contract") || a.includes("offer") || a.includes("deal")) return "contracts";
        return null;
      };

      const byUser = new Map<number, { counts: Record<string, number>; total: number; lastMs: number }>();
      for (const row of rows) {
        const uid = Number(row.userId);
        if (!Number.isFinite(uid) || uid === 0) continue;
        const entry = byUser.get(uid) || { counts: { leads: 0, tasks: 0, calls: 0, contracts: 0 }, total: 0, lastMs: 0 };
        const count = Number(row.count) || 0;
        const bucket = bucketFor(String(row.action || ""));
        if (bucket) entry.counts[bucket] += count;
        entry.total += count;
        const lastMs = row.lastAt ? new Date(row.lastAt as any).getTime() : 0;
        if (Number.isFinite(lastMs) && lastMs > entry.lastMs) entry.lastMs = lastMs;
        byUser.set(uid, entry);
      }

      // Roster drives who appears — active teammates get a card (busy or quiet);
      // anyone with activity but off the roster still shows as a ghost row.
      const allUsers = await storage.getUsers(500);
      const activeUsers = allUsers.filter((u: any) => u && u.isActive !== false);
      const rosterIds = new Set(activeUsers.map((u: any) => Number(u.id)));

      const toCard = (u: any, entry?: { counts: Record<string, number>; total: number; lastMs: number }) => ({
        userId: Number(u.id),
        firstName: u.firstName || null,
        lastName: u.lastName || null,
        email: u.email || null,
        hasProfilePicture: !!u.profilePicture,
        avatarUrl: u.avatarUrl || null,
        isActiveTeammate: rosterIds.has(Number(u.id)),
        counts: entry ? entry.counts : { leads: 0, tasks: 0, calls: 0, contracts: 0 },
        total: entry ? entry.total : 0,
        lastActiveAt: entry && entry.lastMs > 0 ? new Date(entry.lastMs).toISOString() : null,
      });

      const active = activeUsers
        .filter((u: any) => byUser.has(Number(u.id)))
        .map((u: any) => toCard(u, byUser.get(Number(u.id))))
        .sort((a: any, b: any) => (b.lastActiveAt || "").localeCompare(a.lastActiveAt || ""));

      const quiet = activeUsers
        .filter((u: any) => !byUser.has(Number(u.id)))
        .map((u: any) => toCard(u));

      // Orphan activity (user off roster / removed account) kept visible so
      // audit-flagged ghost accounts surface instead of disappearing.
      const orphans: any[] = [];
      for (const [uid, entry] of byUser) {
        if (!rosterIds.has(uid)) {
          const u = allUsers.find((x: any) => Number(x?.id) === uid);
          orphans.push(toCard(u || { id: uid, email: null }, entry));
        }
      }

      const highlights = await db
        .select({
          id: globalActivityLogs.id,
          userId: globalActivityLogs.userId,
          action: globalActivityLogs.action,
          description: globalActivityLogs.description,
          createdAt: globalActivityLogs.createdAt,
        })
        .from(globalActivityLogs)
        .where(gte(globalActivityLogs.createdAt, since))
        .orderBy(desc(globalActivityLogs.createdAt))
        .limit(300);

      // Same 15-minute dedupe window the dashboard feed uses.
      const windowMs = 15 * 60 * 1000;
      const grouped: any[] = [];
      for (const h of highlights) {
        const last = grouped[grouped.length - 1];
        const ms = h.createdAt ? new Date(h.createdAt as any).getTime() : 0;
        const key = `${h.userId}|${h.action}|${h.description || ""}`;
        if (last && last.__key === key && Number.isFinite(last.__ms) && Number.isFinite(ms) && last.__ms - ms <= windowMs) {
          last.groupCount += 1;
          continue;
        }
        grouped.push({ ...h, groupCount: 1, __key: key, __ms: ms });
      }
      const highlightRows = grouped.slice(0, 8).map(({ __key, __ms, ...rest }: any) => rest);

      res.json({ since: since.toISOString(), hours, totalActive: active.length, totalTeammates: activeUsers.length, active, quiet, orphans, highlights: highlightRows });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  reg("get", "/api/activity"); app.get("/api/activity", async (req, res) => {
    try {
      const authCtx = await requireAuth(req, res);
      if (!authCtx) return;
      const limit = req.query.limit ? parseInt(req.query.limit as string) : 50;
      const group = String(req.query.group || "").trim().toLowerCase() === "true";
      const windowMinutesRaw = req.query.windowMinutes ? parseInt(req.query.windowMinutes as string) : 15;
      const windowMinutes = Number.isFinite(windowMinutesRaw) ? Math.min(Math.max(windowMinutesRaw, 1), 60) : 15;
      const propertyId = req.query.propertyId ? parseInt(req.query.propertyId as string) : undefined;
      const leadId = req.query.leadId ? parseInt(req.query.leadId as string) : undefined;
      const playgroundSessionIdRaw = req.query.playgroundSessionId ?? req.query.sessionId;
      const playgroundSessionId = playgroundSessionIdRaw ? parseInt(playgroundSessionIdRaw as string) : undefined;
      const logs = await storage.getGlobalActivityLogs(limit);
      const parsed = logs.map((log) => {
        let meta: any = null;
        try {
          meta = log.metadata ? JSON.parse(log.metadata as any) : null;
        } catch {}
        return { ...log, metadataParsed: meta };
      });
      const filtered = parsed.filter((log: any) => {
        if (playgroundSessionId && log.metadataParsed?.playgroundSessionId !== playgroundSessionId) return false;
        if (propertyId && log.metadataParsed?.propertyId !== propertyId) return false;
        if (leadId && log.metadataParsed?.leadId !== leadId) return false;
        return true;
      });
      const filteredOrGrouped = !group
        ? filtered
        : (() => {
            const out: any[] = [];
            const windowMs = windowMinutes * 60 * 1000;
            for (const log of filtered) {
              const createdAtMs = new Date(log.createdAt as any).getTime();
              const meta = log.metadataParsed || {};
              const key = [
                String(log.userId ?? ""),
                String(log.action ?? ""),
                String(log.description ?? ""),
                String(meta?.leadId ?? ""),
                String(meta?.propertyId ?? ""),
                String(meta?.playgroundSessionId ?? ""),
              ].join("|");
              const last = out[out.length - 1];
              if (
                last &&
                last.__groupKey === key &&
                Number.isFinite(last.__createdAtMs) &&
                Number.isFinite(createdAtMs) &&
                last.__createdAtMs - createdAtMs <= windowMs
              ) {
                last.groupCount = Number(last.groupCount || 1) + 1;
                continue;
              }
              out.push({
                ...log,
                groupCount: 1,
                __groupKey: key,
                __createdAtMs: createdAtMs,
              });
            }
            return out.map((l: any) => {
              const { __groupKey, __createdAtMs, ...rest } = l;
              return rest;
            });
          })();
      const userIds = Array.from(
        new Set(
          filteredOrGrouped
            .map((log: any) => (typeof log.userId === "number" ? log.userId : null))
            .filter((id: any) => typeof id === "number" && Number.isFinite(id) && id !== 0),
        ),
      ) as number[];
      const userRows =
        userIds.length > 0
          ? await db
              .select({
                id: users.id,
                firstName: users.firstName,
                lastName: users.lastName,
                email: users.email,
                hasProfilePicture: sql<boolean>`(${users.profilePicture} IS NOT NULL)`,
              })
              .from(users)
              .where(inArray(users.id, userIds))
          : [];
      const usersById = new Map<number, any>(userRows.map((u: any) => [u.id, u]));
      const out = filteredOrGrouped.map((log: any) => {
        const user =
          log.userId === 0
            ? {
                id: 0,
                firstName: "System",
                lastName: null,
                email: null,
                profilePicture: null,
              }
            : usersById.get(log.userId) || null;
        return { ...log, user };
      });
      res.json(out);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("post", "/api/activity"); app.post("/api/activity", async (req, res) => {
    try {
      const userId = req.session.userId;
      if (!userId) return res.status(401).json({ message: "Unauthorized" });
      const action = String(req.body?.action || "").trim();
      const description = typeof req.body?.description === "string" ? req.body.description : null;
      const metadata = req.body?.metadata && typeof req.body.metadata === "object" ? req.body.metadata : null;
      if (!action) return res.status(400).json({ message: "Missing action" });
      const log = await storage.createGlobalActivity({
        userId,
        action,
        description,
        metadata: metadata ? JSON.stringify(metadata) : null,
      } as any);
      res.status(201).json(log);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("get", "/api/audit"); app.get("/api/audit", async (req, res) => {
    try {
      const ctx = await requireActiveTeam(req, res, { minRole: "admin" });
      if (!ctx) return;
      const { limit, offset } = parseLimitOffset(req.query);
      const schema = z.object({
        entityType: z.string().trim().min(1).optional(),
        entityId: z.coerce.number().int().positive().optional(),
        actorUserId: z.coerce.number().int().positive().optional(),
        action: z.string().trim().min(1).optional(),
        from: z.coerce.date().optional(),
        to: z.coerce.date().optional(),
      });
      const q = schema.parse(req.query || {});
      const whereParts: any[] = [eq(auditEvents.teamId, ctx.teamId)];
      if (q.entityType) whereParts.push(eq(auditEvents.entityType, q.entityType));
      if (typeof q.entityId === "number") whereParts.push(eq(auditEvents.entityId, q.entityId));
      if (typeof q.actorUserId === "number") whereParts.push(eq(auditEvents.actorUserId, q.actorUserId));
      if (q.action) whereParts.push(eq(auditEvents.action, q.action));
      if (q.from) whereParts.push(gte(auditEvents.createdAt, q.from));
      if (q.to) whereParts.push(lte(auditEvents.createdAt, q.to));
      const whereClause = and(...whereParts);
      const rows: any[] = await db
        .select()
        .from(auditEvents)
        .where(whereClause)
        .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
        .limit(limit)
        .offset(offset);
      const countRows = await db.select({ count: sql<number>`count(*)::int` }).from(auditEvents).where(whereClause);
      const total = Number((countRows as any)?.[0]?.count || 0);
      const actorIds = Array.from(
        new Set(
          rows
            .map((r: any) => (typeof r.actorUserId === "number" ? r.actorUserId : null))
            .filter((id: any) => typeof id === "number" && Number.isFinite(id)),
        ),
      ) as number[];
      const actorRows =
        actorIds.length > 0
          ? await db
              .select({
                id: users.id,
                firstName: users.firstName,
                lastName: users.lastName,
                email: users.email,
                hasProfilePicture: sql<boolean>`(${users.profilePicture} IS NOT NULL)`,
              })
              .from(users)
              .where(inArray(users.id, actorIds))
          : [];
      const actorsById = new Map<number, any>((actorRows as any[]).map((u) => [u.id, u]));
      const items = rows.map((r: any) => {
        const parsed: any = { ...r, actor: r.actorUserId ? actorsById.get(r.actorUserId) || null : null };
        for (const key of ["beforeJson", "afterJson", "diffJson"] as const) {
          try {
            const raw = (parsed as any)[key];
            (parsed as any)[`${key}Parsed`] = raw ? JSON.parse(raw) : null;
          } catch {
            (parsed as any)[`${key}Parsed`] = null;
          }
        }
        return parsed;
      });
      res.json({ items, total });
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("get", "/api/teams/my"); app.get("/api/teams/my", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const teams = await storage.getTeamsForUser(user.id);
      res.json(teams);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("get", "/api/teams/active"); app.get("/api/teams/active", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const teamId = await getOrInitActiveTeamId(req, user.id);
      if (!teamId) return res.json({ teamId: null, team: null });
      const team = await storage.getTeamById(teamId);
      return res.json({ teamId, team: team || null });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("put", "/api/teams/active"); app.put("/api/teams/active", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const teamId = typeof req.body?.teamId === "number" ? req.body.teamId : parseInt(String(req.body?.teamId || ""), 10);
      if (!Number.isFinite(teamId) || teamId <= 0) return res.status(400).json({ message: "Invalid teamId" });
      if (!user.isSuperAdmin) {
        const m = await storage.getTeamMemberByTeamAndUser(teamId, user.id);
        if (!m || String(m.status || "").toLowerCase() !== "active") return res.status(403).json({ message: "Forbidden" });
      }
      req.session.activeTeamId = teamId;
      const team = await storage.getTeamById(teamId);
      return res.json({ teamId, team: team || null });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("post", "/api/teams/join"); app.post("/api/teams/join", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const inviteCode = String(req.body?.inviteCode || "").trim();
      if (!inviteCode) return res.status(400).json({ message: "Missing inviteCode" });
      const team = await storage.getTeamByInviteCode(inviteCode);
      if (!team) return res.status(404).json({ message: "Team not found" });
      const existing = await storage.getTeamMemberByTeamAndUser(team.id, user.id);
      if (!existing) {
        await storage.createTeamMember({
          teamId: team.id,
          userId: user.id,
          role: "member",
          permissions: null as any,
          invitedBy: null as any,
          joinedAt: new Date(),
          status: "active",
        } as any);
        await storage.createTeamActivityLog({
          teamId: team.id,
          userId: user.id,
          action: "team_joined",
          description: `${user.email} joined`,
          metadata: null as any,
        } as any);
      }
      if (!req.session.activeTeamId) req.session.activeTeamId = team.id;
      res.json({ team });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("get", "/api/teams"); app.get("/api/teams", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const teams = await storage.getTeamsForUser(user.id);
      res.json(teams);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("get", "/api/teams/:id"); app.get("/api/teams/:id", async (req, res) => {
    try {
      const teamId = parseInt(req.params.id);
      const ctx = await requireTeamMembership(req, res, { teamId, minRole: "viewer" });
      if (!ctx) return;
      const team = await storage.getTeamById(teamId);
      if (!team) return res.status(404).json({ message: "Team not found" });
      res.json(team);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("post", "/api/teams"); app.post("/api/teams", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const name = String(req.body?.name || "").trim();
      if (!name) return res.status(400).json({ message: "Missing team name" });
      const inviteCode = makeInviteCode();
      const team = await storage.createTeam({
        name,
        description: typeof req.body?.description === "string" ? req.body.description : null,
        ownerId: user.id,
        inviteCode,
        isActive: true,
      } as any);
      await storage.createTeamMember({
        teamId: team.id,
        userId: user.id,
        role: "owner",
        permissions: null as any,
        invitedBy: user.id,
        joinedAt: new Date(),
        status: "active",
      } as any);
      req.session.activeTeamId = team.id;
      res.status(201).json(team);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("patch", "/api/teams/:id"); app.patch("/api/teams/:id", async (req, res) => {
    try {
      const teamId = parseInt(req.params.id);
      const ctx = await requireTeamMembership(req, res, { teamId, minRole: "admin" });
      if (!ctx) return;
      const partial = insertTeamSchema.partial().parse(req.body);
      const patch: any = { ...partial };
      delete patch.ownerId;
      delete patch.inviteCode;
      const team = await storage.updateTeam(teamId, patch);
      res.json(team);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("delete", "/api/teams/:id"); app.delete("/api/teams/:id", async (req, res) => {
    try {
      const teamId = parseInt(req.params.id);
      const ctx = await requireTeamMembership(req, res, { teamId, minRole: "admin" });
      if (!ctx) return;
      await storage.deleteTeam(teamId);
      res.json({ message: "Team deleted" });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("get", "/api/teams/:teamId/members"); app.get("/api/teams/:teamId/members", async (req, res) => {
    try {
      const teamId = parseInt(req.params.teamId);
      const ctx = await requireTeamMembership(req, res, { teamId, minRole: "viewer" });
      if (!ctx) return;
      const members = await storage.getTeamMembersWithUsers(teamId) as any[];
      // Strip multi-MB base64 profile pictures; avatars come from /api/users/:id/avatar.
      res.json(members.map((m: any) => {
        if (!m?.user) return m;
        const { passwordHash, profilePicture, profile_picture, ...safeUser } = m.user;
        return { ...m, user: { ...safeUser, hasProfilePicture: !!m.user.profilePicture || !!m.user.profile_picture } };
      }));
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("post", "/api/teams/:teamId/invite"); app.post("/api/teams/:teamId/invite", async (req, res) => {
    try {
      const teamId = parseInt(req.params.teamId);
      const ctx = await requireTeamMembership(req, res, { teamId, minRole: "admin" });
      if (!ctx) return;
      const email = String(req.body?.email || "").trim().toLowerCase();
      if (!email) return res.status(400).json({ message: "Missing email" });
      const role = String(req.body?.role || "member").trim().toLowerCase();
      if (teamRoleRank(role) < 1) return res.status(400).json({ message: "Invalid role" });
      const user = await storage.getUserByEmail(email);
      if (!user) return res.status(404).json({ message: "User not found" });
      const existing = await storage.getTeamMemberByTeamAndUser(teamId, user.id);
      if (existing) return res.json(existing);
      const member = await storage.createTeamMember({
        teamId,
        userId: user.id,
        role,
        permissions: null as any,
        invitedBy: ctx.user.id,
        joinedAt: new Date(),
        status: "active",
      } as any);
      await storage.createTeamActivityLog({
        teamId,
        userId: ctx.user.id,
        action: "member_invited",
        description: `${email} invited`,
        metadata: JSON.stringify({ invitedUserId: user.id, role }),
      } as any);
      res.status(201).json(member);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("post", "/api/teams/:teamId/members"); app.post("/api/teams/:teamId/members", async (req, res) => {
    try {
      const teamId = parseInt(req.params.teamId);
      const ctx = await requireTeamMembership(req, res, { teamId, minRole: "admin" });
      if (!ctx) return;
      const validated = insertTeamMemberSchema.parse({ ...req.body, teamId });
      const member = await storage.createTeamMember(validated);
      res.status(201).json(member);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("patch", "/api/team-members/:id"); app.patch("/api/team-members/:id", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const existing = await storage.getTeamMemberById(parseInt(req.params.id));
      if (!existing) return res.status(404).json({ message: "Not found" });
      const teamId = Number(existing.teamId);
      const ctx = await requireTeamMembership(req, res, { teamId, minRole: "admin" });
      if (!ctx) return;
      const partial = insertTeamMemberSchema.partial().parse(req.body);
      const member = await storage.updateTeamMember(parseInt(req.params.id), partial);
      res.json(member);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("delete", "/api/team-members/:id"); app.delete("/api/team-members/:id", async (req, res) => {
    try {
      const existing = await storage.getTeamMemberById(parseInt(req.params.id));
      if (!existing) return res.status(404).json({ message: "Not found" });
      const teamId = Number(existing.teamId);
      const ctx = await requireTeamMembership(req, res, { teamId, minRole: "admin" });
      if (!ctx) return;
      await storage.deleteTeamMember(parseInt(req.params.id));
      res.json({ message: "Team member removed" });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("get", "/api/teams/:teamId/activity"); app.get("/api/teams/:teamId/activity", async (req, res) => {
    try {
      const teamId = parseInt(req.params.teamId);
      const ctx = await requireTeamMembership(req, res, { teamId, minRole: "viewer" });
      if (!ctx) return;
      const { limit } = parseLimitOffset(req.query);
      const logs = await storage.getTeamActivityLogs(teamId, limit);
      res.json(logs);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("post", "/api/teams/:teamId/activity"); app.post("/api/teams/:teamId/activity", async (req, res) => {
    try {
      const teamId = parseInt(req.params.teamId);
      const ctx = await requireTeamMembership(req, res, { teamId, minRole: "admin" });
      if (!ctx) return;
      const validated = insertTeamActivityLogSchema.parse({ ...req.body, teamId });
      const log = await storage.createTeamActivityLog({ ...validated, userId: ctx.user.id } as any);
      res.status(201).json(log);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  // NOTIFICATION PREFERENCES ENDPOINTS
  reg("get", "/api/users/:userId/notification-preferences"); app.get("/api/users/:userId/notification-preferences", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const targetId = parseInt(req.params.userId);
      if (!isSameUserOrAdmin(user, targetId)) return res.status(403).json({ message: "You do not have access" });
      const prefs = await storage.getNotificationPreferencesByUserId(targetId);
      res.json(prefs || {});
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("post", "/api/users/:userId/notification-preferences"); app.post("/api/users/:userId/notification-preferences", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const targetId = parseInt(req.params.userId);
      if (!isSameUserOrAdmin(user, targetId)) return res.status(403).json({ message: "You do not have access" });
      const validated = insertNotificationPreferenceSchema.parse({ ...req.body, userId: targetId });
      const prefs = await storage.createNotificationPreferences(validated);
      res.status(201).json(prefs);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("patch", "/api/users/:userId/notification-preferences"); app.patch("/api/users/:userId/notification-preferences", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const targetId = parseInt(req.params.userId);
      if (!isSameUserOrAdmin(user, targetId)) return res.status(403).json({ message: "You do not have access" });
      const partial = insertNotificationPreferenceSchema.partial().parse(req.body);
      const prefs = await storage.updateNotificationPreferences(targetId, partial);
      res.json(prefs);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  // USER NOTIFICATIONS ENDPOINTS (actual notification messages)
  reg("get", "/api/users/:userId/notifications"); app.get("/api/users/:userId/notifications", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const targetId = parseInt(req.params.userId);
      if (!isSameUserOrAdmin(user, targetId)) return res.status(403).json({ message: "You do not have access" });
      const { limit, offset } = parseLimitOffset(req.query);
      const notifications = await storage.getUserNotifications(targetId, limit, offset);
      res.json(notifications);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("get", "/api/users/:userId/notifications/unread-count"); app.get("/api/users/:userId/notifications/unread-count", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const targetId = parseInt(req.params.userId);
      if (!isSameUserOrAdmin(user, targetId)) return res.status(403).json({ message: "You do not have access" });
      const count = await storage.getUnreadNotificationCount(targetId);
      res.json({ count });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("post", "/api/users/:userId/notifications"); app.post("/api/users/:userId/notifications", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const targetId = parseInt(req.params.userId);
      if (!isSameUserOrAdmin(user, targetId)) return res.status(403).json({ message: "You do not have access" });
      const validated = insertUserNotificationSchema.parse({ ...req.body, userId: targetId });
      const notification = await storage.createUserNotification(validated);
      res.status(201).json(notification);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("patch", "/api/notifications/:id/read"); app.patch("/api/notifications/:id/read", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const notificationId = parseInt(req.params.id);
      const target = await storage.getUserNotificationById(notificationId);
      if (!target) return res.status(404).json({ message: "Notification not found" });
      if (Number(target.userId) !== Number(user.id) && !isManagerUser(user)) {
        return res.status(403).json({ message: "You do not have access" });
      }
      const notification = await storage.markNotificationAsRead(notificationId);
      res.json(notification);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("delete", "/api/notifications/:id"); app.delete("/api/notifications/:id", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const notificationId = parseInt(req.params.id);
      const target = await storage.getUserNotificationById(notificationId);
      if (!target) return res.status(404).json({ message: "Notification not found" });
      if (Number(target.userId) !== Number(user.id) && !isManagerUser(user)) {
        return res.status(403).json({ message: "You do not have access" });
      }
      await storage.deleteUserNotification(notificationId);
      res.json({ message: "Notification deleted" });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("delete", "/api/users/:userId/notifications"); app.delete("/api/users/:userId/notifications", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const targetId = parseInt(req.params.userId);
      if (!isSameUserOrAdmin(user, targetId)) return res.status(403).json({ message: "You do not have access" });
      await storage.deleteAllUserNotifications(targetId);
      res.json({ message: "All notifications deleted" });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("patch", "/api/users/:userId/notifications/read-all"); app.patch("/api/users/:userId/notifications/read-all", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const targetId = parseInt(req.params.userId);
      if (!isSameUserOrAdmin(user, targetId)) return res.status(403).json({ message: "You do not have access" });
      await storage.markAllNotificationsAsRead(targetId);
      res.json({ message: "All notifications marked as read" });
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  // INTERNAL TEAM MESSAGING (separate from external SMS)
  reg("get", "/api/messages/conversations"); app.get("/api/messages/conversations", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const rows = await storage.getInternalMessageConversations(user.id);
      res.json(rows);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("get", "/api/messages"); app.get("/api/messages", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const withUserId = req.query.withUserId ? parseInt(String(req.query.withUserId), 10) : undefined;
      const limit = Math.min(parseInt(String(req.query.limit || "100"), 10) || 100, 500);
      const offset = parseInt(String(req.query.offset || "0"), 10) || 0;
      const messages = await storage.getInternalMessages(user.id, withUserId, limit, offset);
      // Hydrate full media assets per message for gallery/video rendering.
      let mediaByMessage: Record<number, any[]> = {};
      try {
        const teamId = await getOrInitActiveTeamId(req, user.id);
        if (teamId != null) {
          mediaByMessage = await listMediaByAttachments({
            teamId,
            entityType: "internal_message",
            entityIds: (messages || []).map((m: any) => Number(m.id)),
          });
        }
      } catch (e) {
        console.error("media hydration failed (non-blocking):", e);
      }
      const enriched = (messages || []).map((m: any) => ({
        ...m,
        media: mediaByMessage[Number(m.id)] || [],
        mediaIds: (mediaByMessage[Number(m.id)] || []).map((a: any) => a.id),
      }));
      res.json(enriched);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("get", "/api/messages/unread-count"); app.get("/api/messages/unread-count", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const count = await storage.getInternalMessageUnreadCount(user.id);
      res.json({ count });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("post", "/api/messages/read"); app.post("/api/messages/read", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const withUserId = req.body?.withUserId ? parseInt(String(req.body.withUserId), 10) : undefined;
      await storage.markInternalMessagesRead(user.id, withUserId);
      res.json({ message: "Marked as read" });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("post", "/api/messages"); app.post("/api/messages", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const body = req.body || {};
      const recipientUserId = parseInt(body.recipientUserId, 10);
      if (!Number.isInteger(recipientUserId) || recipientUserId <= 0) {
        return res.status(400).json({ message: "A valid recipient is required" });
      }
      if (recipientUserId === user.id) return res.status(400).json({ message: "You cannot message yourself" });
      const messageBody = String(body.body || "").trim();
      if (!messageBody) return res.status(400).json({ message: "Message body is required" });
      if (messageBody.length > 5000) return res.status(400).json({ message: "Message is too long" });
      const recipient = await storage.getUserById(recipientUserId);
      if (!recipient) return res.status(404).json({ message: "Recipient not found" });
      const relatedType = body.relatedType ? String(body.relatedType).slice(0, 50) : null;
      const relatedId = body.relatedId ? parseInt(String(body.relatedId), 10) : null;

      // Media attachments (images/video already uploaded via /api/media/upload).
      const rawMediaIds = Array.isArray(body.mediaIds) ? body.mediaIds : [];
      const mediaIds = rawMediaIds
        .map((x: any) => parseInt(String(x), 10))
        .filter((n: number) => Number.isInteger(n) && n > 0)
        .slice(0, 10);

      const message = await storage.createInternalMessage({
        senderUserId: user.id,
        recipientUserId,
        body: messageBody,
        relatedType,
        relatedId,
        readAt: null,
      } as any);

      // Link attachments only if the sender's team owns them.
      if (mediaIds.length > 0) {
        const teamId = await getOrInitActiveTeamId(req, user.id);
        for (const id of mediaIds) {
          const asset = await getMediaAssetById(id);
          if (!asset) continue;
          if (teamId && !assertMediaTeam(asset, teamId)) continue;
          try {
            await attachMedia({
              mediaId: id,
              entityType: "internal_message",
              entityId: message.id,
              role: "attachment",
              createdByUserId: user.id,
            });
          } catch (e) {
            console.error("Internal message media attach failed (non-blocking):", e);
          }
        }
      }

      await notifyUser({
        userId: recipientUserId,
        category: "internal_message",
        title: `New internal message from ${userDisplayName(user)}`,
        description: messageBody.length > 140 ? `${messageBody.slice(0, 140)}…` : messageBody,
        relatedType: relatedType || "message",
        relatedId: relatedId ?? message.id,
        eventKey: `msg:${message.id}`,
      });
      res.status(201).json({ ...message, mediaIds: mediaIds.length ? mediaIds : undefined });
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  // CALENDAR EVENTS (internal meetings)
  reg("get", "/api/calendar-events"); app.get("/api/calendar-events", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const from = req.query.from ? new Date(String(req.query.from)) : undefined;
      const to = req.query.to ? new Date(String(req.query.to)) : undefined;
      const events = await storage.getCalendarEventsForUser(user.id, from, to);
      res.json(events);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("post", "/api/calendar-events"); app.post("/api/calendar-events", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const body = req.body || {};
      const title = String(body.title || "").trim();
      if (!title) return res.status(400).json({ message: "Title is required" });
      const startsAt = new Date(body.startsAt);
      if (Number.isNaN(startsAt.getTime())) return res.status(400).json({ message: "A valid start time is required" });
      const endsAt = body.endsAt ? new Date(body.endsAt) : null;
      if (endsAt && Number.isNaN(endsAt.getTime())) return res.status(400).json({ message: "Invalid end time" });
      if (endsAt && endsAt.getTime() <= startsAt.getTime()) return res.status(400).json({ message: "End time must be after start time" });
      const inviteeUserIds = Array.isArray(body.inviteeUserIds)
        ? body.inviteeUserIds.map((id: any) => parseInt(String(id), 10)).filter((id: number) => Number.isInteger(id) && id > 0)
        : [];
      const event = await storage.createCalendarEvent({
        title,
        description: body.description ? String(body.description).slice(0, 5000) : null,
        startsAt,
        endsAt,
        meetingLink: body.meetingLink ? String(body.meetingLink).slice(0, 500) : null,
        location: body.location ? String(body.location).slice(0, 255) : null,
        createdBy: user.id,
        relatedType: body.relatedType ? String(body.relatedType).slice(0, 50) : null,
        relatedId: body.relatedId ? parseInt(String(body.relatedId), 10) : null,
        inviteeUserIds,
      } as any);
      const invitees = [...new Set([...inviteeUserIds])].filter((id) => id !== user.id);
      for (const inviteeId of invitees) {
        await notifyUser({
          userId: inviteeId,
          category: "meeting_invite",
          title: "Meeting invitation",
          description: `${userDisplayName(user)} invited you to "${title}"${endsAt ? ` at ${endsAt.toISOString()}` : ""}.`,
          relatedType: "calendar",
          relatedId: event.id,
          eventKey: `meeting:${event.id}:invitee:${inviteeId}`,
        });
      }
      res.status(201).json(event);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("patch", "/api/calendar-events/:id"); app.patch("/api/calendar-events/:id", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const eventId = parseInt(req.params.id, 10);
      const event = await storage.getCalendarEventById(eventId);
      if (!event) return res.status(404).json({ message: "Event not found" });
      if (Number(event.createdBy) !== Number(user.id) && !isManagerUser(user)) {
        return res.status(403).json({ message: "You do not have access to edit this event" });
      }
      const body = req.body || {};
      const patch: any = {};
      if (body.title !== undefined) patch.title = String(body.title).trim() || undefined;
      if (body.description !== undefined) patch.description = String(body.description).slice(0, 5000);
      if (body.startsAt !== undefined) {
        const s = new Date(body.startsAt);
        if (Number.isNaN(s.getTime())) return res.status(400).json({ message: "Invalid start time" });
        patch.startsAt = s;
      }
      if (body.endsAt !== undefined) {
        const e = new Date(body.endsAt);
        if (Number.isNaN(e.getTime())) return res.status(400).json({ message: "Invalid end time" });
        patch.endsAt = e;
      }
      if (patch.startsAt && patch.endsAt && patch.endsAt.getTime() <= patch.startsAt.getTime()) {
        return res.status(400).json({ message: "End time must be after start time" });
      }
      if (body.meetingLink !== undefined) patch.meetingLink = body.meetingLink ? String(body.meetingLink).slice(0, 500) : null;
      if (body.inviteeUserIds !== undefined) {
        patch.inviteeUserIds = Array.isArray(body.inviteeUserIds)
          ? body.inviteeUserIds.map((id: any) => parseInt(String(id), 10)).filter((id: number) => Number.isInteger(id) && id > 0)
          : [];
      }
      const updated = await storage.updateCalendarEvent(eventId, patch);
      res.json(updated);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("delete", "/api/calendar-events/:id"); app.delete("/api/calendar-events/:id", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const eventId = parseInt(req.params.id, 10);
      const event = await storage.getCalendarEventById(eventId);
      if (!event) return res.status(404).json({ message: "Event not found" });
      if (Number(event.createdBy) !== Number(user.id) && !isManagerUser(user)) {
        return res.status(403).json({ message: "You do not have access to delete this event" });
      }
      await storage.deleteCalendarEvent(eventId);
      res.json({ message: "Event deleted" });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  function canViewTask(user: any, task: any) {
    if (isManagerUser(user)) return true;
    if (task?.isPrivate) {
      return Number(task?.createdBy) === Number(user?.id) || Number(task?.assignedToUserId) === Number(user?.id);
    }
    return true;
  }
  function canMutateTask(user: any, task: any) {
    if (isManagerUser(user)) return true;
    return Number(task?.createdBy) === Number(user?.id) || Number(task?.assignedToUserId) === Number(user?.id);
  }
  // TASKS ENDPOINTS
  // ── Notifications + speed-to-lead (0098) ──────────────────────────────────
  reg("get", "/api/notifications"); app.get("/api/notifications", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const { getUnreadNotifications, getUnreadCount } = await import("./services/notifications/speedToLead.js");
      const [items, unreadCount] = await Promise.all([
        getUnreadNotifications(user.id, 20),
        getUnreadCount(user.id),
      ]);
      res.json({ items, unreadCount });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("post", "/api/notifications/:id/read"); app.post("/api/notifications/:id/read", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const { markNotificationRead } = await import("./services/notifications/speedToLead.js");
      await markNotificationRead(user.id, parseInt(req.params.id));
      res.json({ ok: true });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("post", "/api/notifications/read-all"); app.post("/api/notifications/read-all", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const { markAllNotificationsRead } = await import("./services/notifications/speedToLead.js");
      await markAllNotificationsRead(user.id);
      res.json({ ok: true });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("get", "/api/speed-to-lead/stats"); app.get("/api/speed-to-lead/stats", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const { getSpeedToLeadStats } = await import("./services/notifications/speedToLead.js");
      const teamId = await getOrInitActiveTeamId(req, user.id);
      let memberIds: number[] = [user.id];
      try {
        if (teamId) {
          const members: any = await storage.getTeamMembers(teamId);
          memberIds = (members || []).map((m: any) => Number(m.userId)).filter(Number.isFinite);
        }
      } catch {}
      const stats = await getSpeedToLeadStats(memberIds);
      res.json(stats);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("get", "/api/tasks"); app.get("/api/tasks", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const schema = z.object({
        assignedToUserId: z.coerce.number().int().positive().optional(),
        createdByUserId: z.coerce.number().int().positive().optional(),
        status: z.string().trim().min(1).optional(),
        type: z.string().trim().min(1).optional(),
        priority: z.string().trim().min(1).optional(),
        relatedEntityType: z.string().trim().min(1).optional(),
        relatedEntityId: z.coerce.number().int().positive().optional(),
        dueFrom: z.coerce.date().optional(),
        dueTo: z.coerce.date().optional(),
        includeCompleted: z
          .enum(["true", "false"])
          .optional()
          .transform((v) => v === "true"),
        limit: z.coerce.number().int().min(1).max(200).optional(),
        offset: z.coerce.number().int().min(0).optional(),
      });
      const q = schema.parse(req.query || {});
      if (typeof q.assignedToUserId === "number") {
        const ok = await requireAssigneeInActiveTeam(req, res, user, q.assignedToUserId);
        if (!ok) return;
      }
      const out = await storage.listTasks(
        { userId: user.id, isManager: isManagerUser(user) },
        {
          assignedToUserId: q.assignedToUserId,
          createdByUserId: q.createdByUserId,
          status: q.status,
          type: q.type,
          priority: q.priority,
          relatedEntityType: q.relatedEntityType,
          relatedEntityId: q.relatedEntityId,
          dueFrom: q.dueFrom,
          dueTo: q.dueTo,
          includeCompleted: q.includeCompleted,
          limit: q.limit,
          offset: q.offset,
        },
      );
      res.json(out);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("post", "/api/tasks"); app.post("/api/tasks", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const createSchema = insertTaskSchema.omit({ createdBy: true } as any);
      const validated: any = createSchema.parse(req.body || {});
      const assignedToUserId =
        typeof validated.assignedToUserId === "number" ? validated.assignedToUserId : user.id;
      const ok = await requireAssigneeInActiveTeam(req, res, user, assignedToUserId);
      if (!ok) return;
      const task = await createTask({
        ...validated,
        assignedToUserId,
        createdBy: user.id,
      });
      res.status(201).json(task);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("patch", "/api/tasks/:id"); app.patch("/api/tasks/:id", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const id = parseInt(req.params.id);
      const task = await storage.getTaskById(id);
      if (!task) return res.status(404).json({ message: "Task not found" });
      if (!canViewTask(user, task)) return res.status(404).json({ message: "Task not found" });
      if (!canMutateTask(user, task)) return res.status(403).json({ message: "Forbidden" });
      const patchSchema = insertTaskSchema.partial().omit({ createdBy: true } as any);
      const patch: any = patchSchema.parse(req.body || {});
      if (typeof patch.assignedToUserId === "number") {
        const ok = await requireAssigneeInActiveTeam(req, res, user, patch.assignedToUserId);
        if (!ok) return;
      }
      const updated = await storage.updateTask(id, patch);
      res.json(updated);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("post", "/api/tasks/:id/complete"); app.post("/api/tasks/:id/complete", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const id = parseInt(req.params.id);
      const task = await storage.getTaskById(id);
      if (!task) return res.status(404).json({ message: "Task not found" });
      if (!canViewTask(user, task)) return res.status(404).json({ message: "Task not found" });
      if (!canMutateTask(user, task)) return res.status(403).json({ message: "Forbidden" });
      const out = await completeTaskWithRecurrence({ taskId: id, completedAt: new Date() });
      if (!out) return res.status(404).json({ message: "Task not found" });
      res.json(out);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("delete", "/api/tasks/:id"); app.delete("/api/tasks/:id", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const id = parseInt(req.params.id);
      const task = await storage.getTaskById(id);
      if (!task) return res.status(404).json({ message: "Task not found" });
      if (!canViewTask(user, task)) return res.status(404).json({ message: "Task not found" });
      if (!canMutateTask(user, task)) return res.status(403).json({ message: "Forbidden" });
      await storage.deleteTask(id);
      res.json({ ok: true });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // ============ TICKET 13: Task triage + SLA enforcement ============
  // Helper: subquery of quarantined (entityType, entityId) pairs to exclude from workload.
  function quarantinedTaskExclusion() {
    // Returns a SQL fragment: tasks whose (related_entity_type, related_entity_id)
    // is NOT in the quarantined_records table (active quarantines only).
    return sql`NOT EXISTS (
      SELECT 1 FROM quarantined_records qr
      WHERE qr.status = 'quarantined'
        AND qr.entity_type = ${tasks.relatedEntityType}
        AND qr.entity_id = ${tasks.relatedEntityId}
        AND ${tasks.relatedEntityType} IS NOT NULL
        AND ${tasks.relatedEntityId} IS NOT NULL
    )`;
  }

  reg("get", "/api/tasks/overdue"); app.get("/api/tasks/overdue", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const schema = z.object({
        assignedToUserId: z.coerce.number().int().positive().optional(),
        type: z.string().trim().min(1).optional(),
        stage: z.string().trim().min(1).optional(),
        minAgeDays: z.coerce.number().int().min(0).optional(),
        maxAgeDays: z.coerce.number().int().min(0).optional(),
        limit: z.coerce.number().int().min(1).max(500).optional(),
        offset: z.coerce.number().int().min(0).optional(),
      });
      const q = schema.parse(req.query || {});
      const now = new Date();
      const whereParts: any[] = [
        lt(tasks.dueAt, now),
        ne(tasks.status, "completed"),
        quarantinedTaskExclusion(),
      ];
      if (!isManagerUser(user)) {
        whereParts.push(
          or(eq(tasks.isPrivate, false), eq(tasks.createdBy, user.id), eq(tasks.assignedToUserId, user.id)),
        );
      }
      if (typeof q.assignedToUserId === "number") whereParts.push(eq(tasks.assignedToUserId, q.assignedToUserId));
      if (q.type) whereParts.push(eq(tasks.type, q.type));
      if (q.stage) whereParts.push(eq(tasks.relatedEntityType, q.stage));
      if (typeof q.minAgeDays === "number") {
        whereParts.push(sql`${tasks.dueAt} < ${new Date(now.getTime() - q.minAgeDays * 86400000)}`);
      }
      if (typeof q.maxAgeDays === "number") {
        whereParts.push(sql`${tasks.dueAt} >= ${new Date(now.getTime() - q.maxAgeDays * 86400000)}`);
      }
      const whereClause = and(...whereParts);
      const limit = q.limit ?? 100;
      const offset = q.offset ?? 0;
      const items = await db.select().from(tasks).where(whereClause)
        .orderBy(tasks.dueAt).limit(limit).offset(offset);
      const countRows = await db.select({ count: sql<number>`count(*)::int` }).from(tasks).where(whereClause);
      res.json({ items, total: Number((countRows as any)?.[0]?.count || 0) });
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });

  reg("post", "/api/tasks/bulk-triage"); app.post("/api/tasks/bulk-triage", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const schema = z.object({
        taskIds: z.array(z.coerce.number().int().positive()).min(1).max(200),
        action: z.enum(["complete", "reschedule", "cancel", "merge", "archive"]),
        reason: z.string().trim().min(3).max(2000),
        newDueAt: z.coerce.date().optional(),
        mergeIntoTaskId: z.coerce.number().int().positive().optional(),
        preview: z.boolean().optional(),
        confirm: z.boolean().optional(),
      });
      const body = schema.parse(req.body || {});

      // Load tasks + permission check each one.
      const targets: any[] = [];
      for (const id of body.taskIds) {
        const t = await storage.getTaskById(id);
        if (!t) return res.status(404).json({ message: `Task ${id} not found` });
        if (!canViewTask(user, t)) return res.status(404).json({ message: `Task ${id} not found` });
        if (!canMutateTask(user, t)) return res.status(403).json({ message: `Forbidden on task ${id}` });
        targets.push(t);
      }

      // Action-specific validation.
      if (body.action === "reschedule" && !body.newDueAt) {
        return res.status(400).json({ message: "newDueAt is required for reschedule" });
      }
      if (body.action === "merge" && !body.mergeIntoTaskId) {
        return res.status(400).json({ message: "mergeIntoTaskId is required for merge" });
      }

      // Preview mode: return what WOULD happen without doing it.
      if (body.preview && !body.confirm) {
        return res.json({
          preview: true,
          action: body.action,
          taskCount: targets.length,
          tasks: targets.map((t) => ({ id: t.id, title: t.title, status: t.status, dueAt: t.dueAt })),
          requiresReason: true,
          requiresConfirm: true,
        });
      }
      if (!body.confirm) {
        return res.status(400).json({ message: "Confirmation required: set confirm=true after reviewing preview" });
      }

      // Execute: one audit event per task.
      const results: any[] = [];
      for (const t of targets) {
        const oldStatus = t.status;
        let newStatus = oldStatus;
        const patch: any = { triageStatus: "triaged" };
        if (body.action === "complete") { newStatus = "completed"; patch.status = "completed"; patch.completedAt = new Date(); }
        else if (body.action === "cancel") { newStatus = "cancelled"; patch.status = "cancelled"; }
        else if (body.action === "archive") { newStatus = "archived"; patch.status = "archived"; }
        else if (body.action === "reschedule") { patch.dueAt = body.newDueAt; patch.reminderSentAt = null; patch.overdueAlertSentAt = null; }
        else if (body.action === "merge") { newStatus = "merged"; patch.status = "merged"; }

        // No conflicting open next-actions per lead: when completing/cancelling a task
        // linked to a lead, clear stale next_action references handled by caller.
        const updated = await storage.updateTask(t.id, patch);
        await db.insert(taskAudit).values({
          taskId: t.id,
          action: `bulk_${body.action}`,
          oldValue: oldStatus,
          newValue: newStatus,
          reason: body.reason,
          performedBy: user.id,
        });
        results.push({ id: t.id, action: body.action, oldStatus, newStatus });
      }
      res.json({ ok: true, action: body.action, processed: results.length, results });
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });

  reg("get", "/api/tasks/sla-dashboard"); app.get("/api/tasks/sla-dashboard", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const now = new Date();
      const baseFilter = sql`${tasks.status} <> 'completed' AND ${tasks.dueAt} < ${now} AND ${quarantinedTaskExclusion()}`;
      const visFilter = isManagerUser(user)
        ? sql`TRUE`
        : sql`(${tasks.isPrivate} = false OR ${tasks.createdBy} = ${user.id} OR ${tasks.assignedToUserId} = ${user.id})`;

      const byAssignee = await db.select({
        assignedToUserId: tasks.assignedToUserId,
        count: sql<number>`count(*)::int`,
      }).from(tasks).where(and(baseFilter, visFilter)).groupBy(tasks.assignedToUserId);

      const byType = await db.select({
        type: tasks.type,
        count: sql<number>`count(*)::int`,
      }).from(tasks).where(and(baseFilter, visFilter)).groupBy(tasks.type);

      const byStage = await db.select({
        stage: tasks.relatedEntityType,
        count: sql<number>`count(*)::int`,
      }).from(tasks).where(and(baseFilter, visFilter)).groupBy(tasks.relatedEntityType);

      // Age buckets: 0-1d, 2-7d, 8-30d, 30d+
      const ageBuckets = await db.select({
        bucket: sql<string>`CASE
          WHEN ${tasks.dueAt} >= ${new Date(now.getTime() - 86400000)} THEN '0-1d'
          WHEN ${tasks.dueAt} >= ${new Date(now.getTime() - 7 * 86400000)} THEN '2-7d'
          WHEN ${tasks.dueAt} >= ${new Date(now.getTime() - 30 * 86400000)} THEN '8-30d'
          ELSE '30d+' END`,
        count: sql<number>`count(*)::int`,
      }).from(tasks).where(and(baseFilter, visFilter)).groupBy(sql`1`);

      const totalRows = await db.select({ count: sql<number>`count(*)::int` }).from(tasks).where(and(baseFilter, visFilter));
      res.json({
        total: Number((totalRows as any)?.[0]?.count || 0),
        byAssignee, byType, byStage, ageBuckets,
        generatedAt: now.toISOString(),
      });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  reg("get", "/api/tasks/sla-rules"); app.get("/api/tasks/sla-rules", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const rules = await db.select().from(taskSlaRules).orderBy(taskSlaRules.taskType);
      res.json({ items: rules });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  reg("post", "/api/tasks/sla-rules"); app.post("/api/tasks/sla-rules", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      if (!isManagerUser(user)) return res.status(403).json({ message: "Managers only" });
      const parsed = insertTaskSlaRuleSchema.parse({ ...req.body, createdBy: user.id });
      const rows = await db.insert(taskSlaRules).values(parsed as any).returning();
      res.status(201).json(rows[0]);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });

  reg("put", "/api/tasks/sla-rules/:id"); app.put("/api/tasks/sla-rules/:id", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      if (!isManagerUser(user)) return res.status(403).json({ message: "Managers only" });
      const id = parseInt(req.params.id);
      const patch = insertTaskSlaRuleSchema.partial().parse(req.body || {});
      const rows = await db.update(taskSlaRules).set({ ...(patch as any), updatedAt: new Date() }).where(eq(taskSlaRules.id, id)).returning();
      if (!rows.length) return res.status(404).json({ message: "Rule not found" });
      res.json(rows[0]);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });

  reg("delete", "/api/tasks/sla-rules/:id"); app.delete("/api/tasks/sla-rules/:id", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      if (!isManagerUser(user)) return res.status(403).json({ message: "Managers only" });
      const id = parseInt(req.params.id);
      await db.delete(taskSlaRules).where(eq(taskSlaRules.id, id));
      res.json({ ok: true });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  reg("post", "/api/tasks/check-sla"); app.post("/api/tasks/check-sla", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      if (!isManagerUser(user)) return res.status(403).json({ message: "Managers only" });
      const now = new Date();
      const rules = await db.select().from(taskSlaRules).where(eq(taskSlaRules.isActive, true));

      let checked = 0, escalated = 0, slaSet = 0;
      // Only tasks not already escalated and not completed, excluding quarantined.
      const candidates = await db.select().from(tasks).where(and(
        ne(tasks.status, "completed"),
        isNull(tasks.escalatedAt),
        quarantinedTaskExclusion(),
      )).limit(500);

      for (const t of candidates as any[]) {
        checked++;
        const rule = rules.find((r: any) => r.taskType === (t.type || "general"))
          || rules.find((r: any) => r.taskType === "general");
        if (!rule) continue;
        // Compute SLA due from creation (or existing slaDueAt).
        if (!t.slaDueAt) {
          const slaDue = new Date(new Date(t.createdAt).getTime() + rule.slaHours * 3600000);
          await db.update(tasks).set({ slaDueAt: slaDue }).where(eq(tasks.id, t.id));
          slaSet++;
          if (slaDue > now) continue;
        } else if (new Date(t.slaDueAt) > now) {
          continue;
        }
        // SLA breached and not yet escalated -> escalate once (no duplicates: escalatedAt gate).
        const escalateTo = rule.escalationUserId || t.assignedToUserId;
        await db.update(tasks).set({
          escalatedAt: now,
          escalatedToUserId: escalateTo,
          triageStatus: "escalated",
        }).where(eq(tasks.id, t.id));
        await db.insert(taskAudit).values({
          taskId: t.id,
          action: "sla_escalated",
          oldValue: t.status,
          newValue: t.status,
          reason: `SLA breached: ${rule.name} (${rule.slaHours}h)`,
          performedBy: user.id,
        });
        escalated++;
      }
      res.json({ ok: true, checked, slaDueSet: slaSet, escalated });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  // ============ END TICKET 13 ============
  async function listEntityTasks(req: any, res: any, entity: { type: string; id: number }) {
    const user = await requireAuth(req, res);
    if (!user) return null;
    const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 50;
    const includeCompleted = String(req.query.includeCompleted || "").trim().toLowerCase() === "true";
    const out = await storage.listTasks(
      { userId: user.id, isManager: isManagerUser(user) },
      {
        relatedEntityType: entity.type,
        relatedEntityId: entity.id,
        includeCompleted,
        limit,
        offset: 0,
      },
    );
    return out;
  }
  async function createEntityTask(req: any, res: any, entity: { type: string; id: number }) {
    const user = await requireAuth(req, res);
    if (!user) return null;
    const createSchema = insertTaskSchema.omit({ createdBy: true, relatedEntityType: true, relatedEntityId: true } as any);
    const validated: any = createSchema.parse(req.body || {});
    const assignedToUserId = typeof validated.assignedToUserId === "number" ? validated.assignedToUserId : user.id;
    const task = await createTask({
      ...validated,
      relatedEntityType: entity.type,
      relatedEntityId: entity.id,
      assignedToUserId,
      createdBy: user.id,
    });
    return task;
  }
  reg("get", "/api/leads/:id/tasks"); app.get("/api/leads/:id/tasks", async (req, res) => {
    try {
      const out = await listEntityTasks(req, res, { type: "lead", id: parseInt(req.params.id) });
      if (!out) return;
      res.json(out);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("post", "/api/leads/:id/tasks"); app.post("/api/leads/:id/tasks", async (req, res) => {
    try {
      const task = await createEntityTask(req, res, { type: "lead", id: parseInt(req.params.id) });
      if (!task) return;
      res.status(201).json(task);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("get", "/api/opportunities/:id/tasks"); app.get("/api/opportunities/:id/tasks", async (req, res) => {
    try {
      const out = await listEntityTasks(req, res, { type: "opportunity", id: parseInt(req.params.id) });
      if (!out) return;
      res.json(out);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("post", "/api/opportunities/:id/tasks"); app.post("/api/opportunities/:id/tasks", async (req, res) => {
    try {
      const task = await createEntityTask(req, res, { type: "opportunity", id: parseInt(req.params.id) });
      if (!task) return;
      res.status(201).json(task);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("get", "/api/buyers/:id/tasks"); app.get("/api/buyers/:id/tasks", async (req, res) => {
    try {
      const out = await listEntityTasks(req, res, { type: "buyer", id: parseInt(req.params.id) });
      if (!out) return;
      res.json(out);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("post", "/api/buyers/:id/tasks"); app.post("/api/buyers/:id/tasks", async (req, res) => {
    try {
      const task = await createEntityTask(req, res, { type: "buyer", id: parseInt(req.params.id) });
      if (!task) return;
      res.status(201).json(task);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("get", "/api/campaigns/:id/tasks"); app.get("/api/campaigns/:id/tasks", async (req, res) => {
    try {
      const out = await listEntityTasks(req, res, { type: "campaign", id: parseInt(req.params.id) });
      if (!out) return;
      res.json(out);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("post", "/api/campaigns/:id/tasks"); app.post("/api/campaigns/:id/tasks", async (req, res) => {
    try {
      const task = await createEntityTask(req, res, { type: "campaign", id: parseInt(req.params.id) });
      if (!task) return;
      res.status(201).json(task);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("get", "/api/ai/config"); app.get("/api/ai/config", async (_req, res) => {
    try { await requireAuth(_req, res); } catch { return; }
    if (res.headersSent) return;
    const required = [
      "TELNYX_API_KEY",
      "TELNYX_CONNECTION_ID",
      "TELNYX_MESSAGING_PROFILE_ID",
      "TELNYX_PUBLIC_KEY",
      "TELNYX_DEFAULT_FROM_NUMBER",
    ];
    const missing = required.filter((k) => !process.env[k] || String(process.env[k]).trim() === "");
    const ready = missing.length === 0;
    res.json({ ready, missing });
  });
  reg("get", "/api/ai/ping"); app.get("/api/ai/ping", async (_req, res) => {
    const ok = Boolean(process.env.TELNYX_API_KEY && process.env.TELNYX_CONNECTION_ID && process.env.TELNYX_MESSAGING_PROFILE_ID);
    res.json({ ok });
  });
  // USER GOALS ENDPOINTS
  reg("get", "/api/users/:userId/goals"); app.get("/api/users/:userId/goals", async (req, res) => {
    try {
      const authCtx = await requireAuth(req, res);
      if (!authCtx) return;
      const goals = await storage.getUserGoals(parseInt(req.params.userId));
      res.json(goals);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("get", "/api/goals/:id"); app.get("/api/goals/:id", async (req, res) => {
    try {
      const authCtx = await requireAuth(req, res);
      if (!authCtx) return;
      const goal = await storage.getUserGoalById(parseInt(req.params.id));
      if (!goal) return res.status(404).json({ message: "Goal not found" });
      res.json(goal);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("post", "/api/users/:userId/goals"); app.post("/api/users/:userId/goals", async (req, res) => {
    try {
      const authCtx = await requireAuth(req, res);
      if (!authCtx) return;
      const validated = insertUserGoalSchema.parse({ ...req.body, userId: parseInt(req.params.userId) });
      const goal = await storage.createUserGoal(validated);
      res.status(201).json(goal);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("patch", "/api/goals/:id"); app.patch("/api/goals/:id", async (req, res) => {
    try {
      const authCtx = await requireAuth(req, res);
      if (!authCtx) return;
      const partial = insertUserGoalSchema.partial().parse(req.body);
      const goal = await storage.updateUserGoal(parseInt(req.params.id), partial);
      res.json(goal);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("delete", "/api/goals/:id"); app.delete("/api/goals/:id", async (req, res) => {
    try {
      const authCtx = await requireAuth(req, res);
      if (!authCtx) return;
      await storage.deleteUserGoal(parseInt(req.params.id));
      res.json({ message: "Goal deleted" });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  // OFFERS ENDPOINTS
  reg("get", "/api/offers"); app.get("/api/offers", async (req, res) => {
    try {
      const authCtx = await requireAuth(req, res);
      if (!authCtx) return;
      const userId = req.query.userId ? parseInt(req.query.userId as string) : undefined;
      const propertyId = req.query.propertyId ? parseInt(req.query.propertyId as string) : undefined;
      const { limit, offset } = parseLimitOffset(req.query);
      
      if (userId) {
        const offers = await storage.getOffersByUserId(userId, limit, offset);
        return res.json(offers);
      }
      if (propertyId) {
        const offers = await storage.getOffersByPropertyId(propertyId, limit, offset);
        return res.json(offers);
      }
      const offers = await storage.getOffers(limit, offset);
      res.json(offers);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("get", "/api/offers/:id"); app.get("/api/offers/:id", async (req, res) => {
    try {
      const authCtx = await requireAuth(req, res);
      if (!authCtx) return;
      const offer = await storage.getOfferById(parseInt(req.params.id));
      if (!offer) return res.status(404).json({ message: "Offer not found" });
      res.json(offer);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("post", "/api/offers"); app.post("/api/offers", async (req, res) => {
    try {
      const authCtx = await requireAuth(req, res);
      if (!authCtx) return;
      const validated = insertOfferSchema.parse(req.body);
      const offer = await storage.createOffer(validated);
      res.status(201).json(offer);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("patch", "/api/offers/:id"); app.patch("/api/offers/:id", async (req, res) => {
    try {
      const authCtx = await requireAuth(req, res);
      if (!authCtx) return;
      const partial = insertOfferSchema.partial().parse(req.body);
      const offer = await storage.updateOffer(parseInt(req.params.id), partial);
      res.json(offer);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("delete", "/api/offers/:id"); app.delete("/api/offers/:id", async (req, res) => {
    try {
      const authCtx = await requireAuth(req, res);
      if (!authCtx) return;
      await storage.deleteOffer(parseInt(req.params.id));
      res.json({ message: "Offer deleted" });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
// BUYER OFFERS ENDPOINTS (deal-execution offer management)
  const BUYER_OFFER_STATUSES = ["draft", "received", "countered", "accepted", "rejected", "withdrawn", "expired"];
  reg("get", "/api/opportunities/:id/offers"); app.get("/api/opportunities/:id/offers", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const opportunityId = parseInt(req.params.id, 10);
      const property = await storage.getPropertyById(opportunityId);
      if (!property) return res.status(404).json({ message: "Opportunity not found" });
      const offers = await storage.getBuyerOffersByOpportunity(opportunityId);
      res.json(offers);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("post", "/api/opportunities/:id/offers"); app.post("/api/opportunities/:id/offers", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const opportunityId = parseInt(req.params.id, 10);
      const property = await storage.getPropertyById(opportunityId);
      if (!property) return res.status(404).json({ message: "Opportunity not found" });
      const body = req.body || {};
      const amount = Number(body.amount);
      if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ message: "A valid offer amount is required" });
      const buyerInquiryId = body.buyerInquiryId ? parseInt(body.buyerInquiryId, 10) : null;
      const buyerContactId = body.buyerContactId ? parseInt(body.buyerContactId, 10) : null;
      const offer = await storage.createBuyerOffer({
        opportunityId,
        buyerInquiryId,
        buyerContactId,
        amount: String(amount),
        earnestMoney: body.earnestMoney !== undefined && body.earnestMoney !== "" ? String(Number(body.earnestMoney)) : null,
        financingType: body.financingType ? String(body.financingType).slice(0, 50) : null,
        closeBy: body.closeBy ? new Date(body.closeBy) : null,
        terms: body.terms ? String(body.terms) : null,
        assignmentTerms: body.assignmentTerms ? String(body.assignmentTerms) : null,
        notes: body.notes ? String(body.notes) : null,
        status: "received",
        version: 1,
        parentOfferId: null,
        superseded: false,
        createdBy: user.id,
      } as any);
      await logOpportunityEvent(opportunityId, "offer_created", "Offer Created", `Offer of $${amount.toLocaleString()} received${buyerInquiryId ? " from buyer inquiry" : ""}.`, user.id, "user", { offerId: offer.id, amount: String(amount) });
      await notifyOpportunityOwner({
        propertyId: opportunityId,
        category: "offer_received",
        title: "New offer received",
        description: `Offer of $${amount.toLocaleString()} received for ${(property as any)?.address || `opportunity #${opportunityId}`}.`,
        eventKey: `offer:${offer.id}:received`,
        actorUserId: user.id,
      });
      res.status(201).json(offer);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
reg("post", "/api/buyer-offers/:id/counter"); app.post("/api/buyer-offers/:id/counter", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const offerId = parseInt(req.params.id, 10);
      const existing = await storage.getBuyerOfferById(offerId);
      if (!existing) return res.status(404).json({ message: "Offer not found" });
      const body = req.body || {};
      const amount = Number(body.amount);
      if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ message: "A valid counter amount is required" });
      // Preserve history: mark prior version superseded, never overwrite its terms.
      await storage.updateBuyerOffer(offerId, { superseded: true, status: "countered" });
      const counter = await storage.createBuyerOffer({
        opportunityId: existing.opportunityId,
        buyerInquiryId: existing.buyerInquiryId,
        buyerContactId: existing.buyerContactId,
        amount: String(amount),
        earnestMoney: body.earnestMoney !== undefined && body.earnestMoney !== "" ? String(Number(body.earnestMoney)) : existing.earnestMoney,
        financingType: body.financingType ? String(body.financingType).slice(0, 50) : existing.financingType,
        closeBy: body.closeBy ? new Date(body.closeBy) : existing.closeBy,
        terms: body.terms ? String(body.terms) : existing.terms,
        assignmentTerms: body.assignmentTerms ? String(body.assignmentTerms) : existing.assignmentTerms,
        notes: body.notes ? String(body.notes) : null,
        status: "received",
        version: (existing.version || 1) + 1,
        parentOfferId: existing.id,
        superseded: false,
        createdBy: user.id,
      } as any);
      await logOpportunityEvent(existing.opportunityId, "offer_countered", "Offer Countered", `Counter-offer of $${amount.toLocaleString()} sent (v${counter.version}).`, user.id, "user", { offerId: counter.id, parentOfferId: existing.id, amount: String(amount) });
      res.status(201).json(counter);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("patch", "/api/buyer-offers/:id/status"); app.patch("/api/buyer-offers/:id/status", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const offerId = parseInt(req.params.id, 10);
      const offer = await storage.getBuyerOfferById(offerId);
      if (!offer) return res.status(404).json({ message: "Offer not found" });
      const newStatus = String(req.body?.status || "").trim();
      if (!BUYER_OFFER_STATUSES.includes(newStatus)) return res.status(400).json({ message: "Invalid offer status" });
      if (offer.status === newStatus) return res.json(offer);
      if (offer.superseded) return res.status(400).json({ message: "This offer version was superseded by a counter-offer" });
      const updated = await storage.updateBuyerOffer(offerId, { status: newStatus });
      await logOpportunityEvent(offer.opportunityId, "offer_status_changed", `Offer ${newStatus.replace("_", " ")}`, `Offer #${offer.id} ($${Number(offer.amount).toLocaleString()}) marked ${newStatus}.`, user.id, "user", { offerId: offer.id, status: newStatus });
      if (newStatus === "accepted") {
        const property = await storage.getPropertyById(offer.opportunityId);
        const currentStage = String((property as any)?.stage || "lead");
        const reservedIdx = OPPORTUNITY_STAGES.indexOf("reserved");
        const currentIdx = OPPORTUNITY_STAGES.indexOf(currentStage as OpportunityStage);
        if (currentIdx >= 0 && currentIdx < reservedIdx) {
          await storage.updateProperty(offer.opportunityId, { stage: "reserved", stageChangedAt: new Date(), lastActivityAt: new Date() });
          await logOpportunityEvent(offer.opportunityId, "stage_changed", "Stage changed to Reserved", "Opportunity moved to Reserved after offer accepted.", user.id, "user", { oldStage: currentStage, newStage: "reserved" });
        }
        // Pause published listings after acceptance.
        try {
          const listings = await storage.getPublicListingsByOpportunity(offer.opportunityId);
          for (const l of listings) {
            if (l.status === "published") await storage.updatePublicListing(l.id, { status: "paused" });
          }
        } catch {}
        const day = 24 * 60 * 60 * 1000;
        const closingDefs = [
          { title: "[Closing] Confirm buyer commitment / EMD", type: "closing", priority: "high", dueAt: new Date(Date.now() + 2 * day) },
          { title: "[Closing] Coordinate title & closing", type: "closing", priority: "high", dueAt: new Date(Date.now() + 7 * day) },
        ];
        for (const d of closingDefs) {
          await ensureOpportunityTask(offer.opportunityId, user.id, d);
        }
        // Notify the opportunity owner (preference-aware, deduped by event key).
        await notifyOpportunityOwner({
          propertyId: offer.opportunityId,
          category: "offer_accepted",
          title: "Offer accepted",
          description: `Offer #${offer.id} ($${Number(offer.amount).toLocaleString()}) was accepted. Closing tasks created and listing paused.`,
          eventKey: `offer:${offer.id}:accepted`,
          actorUserId: user.id,
        });
      }
      res.json(updated);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("get", "/api/work-categories"); app.get("/api/work-categories", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const includeInactive = String(req.query.includeInactive || "").trim() === "true";
      const rows = await storage.getWorkCategories({ includeInactive });
      res.json(rows);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("post", "/api/work-categories"); app.post("/api/work-categories", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      if (!isManagerUser(user)) return res.status(403).json({ message: "Forbidden" });
      const validated = insertWorkCategorySchema.parse(req.body);
      const created = await storage.createWorkCategory(validated);
      res.status(201).json(created);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("patch", "/api/work-categories/:id"); app.patch("/api/work-categories/:id", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      if (!isManagerUser(user)) return res.status(403).json({ message: "Forbidden" });
      const id = parseInt(req.params.id);
      const patch = insertWorkCategorySchema.partial().parse(req.body);
      const updated = await storage.updateWorkCategory(id, patch);
      res.json(updated);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("delete", "/api/work-categories/:id"); app.delete("/api/work-categories/:id", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      if (!isManagerUser(user)) return res.status(403).json({ message: "Forbidden" });
      const id = parseInt(req.params.id);
      const updated = await storage.updateWorkCategory(id, { isActive: false } as any);
      res.json(updated);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("get", "/api/timeclock/current"); app.get("/api/timeclock/current", async (req, res) => {
    try {
      if (!req.session.userId) return res.status(401).json({ message: "Not authenticated" });
      const session = await storage.getOpenTimeClockSession(req.session.userId);
      if (!session?.id) return res.json(null);
      const clockInMs = new Date(session.clockInAt as any).getTime();
      const ageHours = (Date.now() - clockInMs) / 3_600_000;
      if (ageHours > MAX_TIME_ENTRY_HOURS) {
        try {
          const result = await storage.closeOpenTimeClockSessionAndCreateEntry(req.session.userId, { clockOutAt: new Date(), tzOffsetMinutes: Number(session.tzOffsetMinutes || 0) });
          return res.json(result?.session ? null : session);
        } catch {
          return res.json(session);
        }
      }
      res.json(session);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("post", "/api/timeclock/auto-start"); app.post("/api/timeclock/auto-start", async (req, res) => {
    try {
      if (!req.session.userId) return res.status(401).json({ message: "Not authenticated" });
      const { clientNow, tzOffsetMinutes } = req.body || {};
      if (typeof clientNow !== "string" || typeof tzOffsetMinutes !== "number") {
        return res.status(400).json({ message: "clientNow and tzOffsetMinutes are required" });
      }
      const clockInAt = new Date(clientNow);
      if (Number.isNaN(clockInAt.getTime())) return res.status(400).json({ message: "Invalid clientNow" });
      const open = await storage.getOpenTimeClockSession(req.session.userId);
      if (open) return res.json(open);
      const user = await storage.getUserById(req.session.userId);
      const employee = user?.firstName || user?.lastName
        ? `${user?.firstName || ""} ${user?.lastName || ""}`.trim()
        : user?.email || "Employee";
      try {
        const created = await storage.createTimeClockSession({
          userId: req.session.userId,
          employee,
          task: "General",
          clockInAt,
          tzOffsetMinutes,
          autoStarted: true,
        } as any);
        return res.status(201).json(created);
      } catch (e) {
        const existing = await storage.getOpenTimeClockSession(req.session.userId);
        if (existing) return res.json(existing);
        throw e;
      }
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("post", "/api/timeclock/auto-stop"); app.post("/api/timeclock/auto-stop", async (req, res) => {
    try {
      if (!req.session.userId) return res.status(401).json({ message: "Not authenticated" });
      const { clientNow, tzOffsetMinutes } = req.body || {};
      if (typeof clientNow !== "string" || typeof tzOffsetMinutes !== "number") {
        return res.status(400).json({ message: "clientNow and tzOffsetMinutes are required" });
      }
      const clockOutAt = new Date(clientNow);
      if (Number.isNaN(clockOutAt.getTime())) return res.status(400).json({ message: "Invalid clientNow" });
      const result = await storage.closeOpenTimeClockSessionAndCreateEntry(req.session.userId, { clockOutAt, tzOffsetMinutes });
      if (!result) return res.json({ stopped: false });
      res.json({ stopped: true, entry: result.entry });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("patch", "/api/timeclock/current"); app.patch("/api/timeclock/current", async (req, res) => {
    try {
      if (!req.session.userId) return res.status(401).json({ message: "Not authenticated" });
      const { task } = req.body || {};
      if (typeof task !== "string" || !task.trim()) return res.status(400).json({ message: "task is required" });
      const updated = await storage.updateOpenTimeClockSession(req.session.userId, { task: task.trim() } as any);
      if (!updated) return res.status(404).json({ message: "No active session" });
      res.json(updated);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("get", "/api/timesheet"); app.get("/api/timesheet", async (req, res) => {
    try {
      if (!req.session.userId) return res.status(401).json({ message: "Not authenticated" });
      const sessionUser = await storage.getUserById(req.session.userId);
      const manager = isManagerUser(sessionUser);
      const from = typeof req.query.from === "string" ? req.query.from : undefined;
      const to = typeof req.query.to === "string" ? req.query.to : undefined;
      const userId = typeof req.query.userId === "string" ? parseInt(req.query.userId) : undefined;
      const { limit, offset } = parseLimitOffset(req.query);
      const effectiveUserId = manager ? userId : req.session.userId;
      const entries = await storage.getTimesheetEntriesFiltered({ userId: effectiveUserId, from, to, limit, offset });
      res.json(entries);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  // TIMESHEET ENTRIES ENDPOINTS
  reg("get", "/api/users/:userId/timesheet"); app.get("/api/users/:userId/timesheet", async (req, res) => {
    try {
      // P0 fix: this endpoint had no auth — anyone could read any user's hours/pay.
      const actor = await requireAuth(req, res);
      if (!actor) return;
      const targetUserId = parseInt(req.params.userId);
      if (!isSameUserOrAdmin(actor, targetUserId)) return res.status(403).json({ message: "Forbidden" });
      const { limit, offset } = parseLimitOffset(req.query);
      const entries = await storage.getTimesheetEntries(targetUserId, limit, offset);
      res.json(entries);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("get", "/api/timesheet/:id"); app.get("/api/timesheet/:id", async (req, res) => {
    try {
      // P0 fix: this endpoint had no auth — anyone could read any timesheet entry.
      const actor = await requireAuth(req, res);
      if (!actor) return;
      const entry = await storage.getTimesheetEntryById(parseInt(req.params.id)) as any;
      if (!entry) return res.status(404).json({ message: "Entry not found" });
      if (!isSameUserOrAdmin(actor, Number(entry.userId))) return res.status(403).json({ message: "Forbidden" });
      res.json(entry);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("post", "/api/users/:userId/timesheet"); app.post("/api/users/:userId/timesheet", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const targetUserId = parseInt(req.params.userId);
      if (!Number.isFinite(targetUserId)) return res.status(400).json({ message: "Invalid userId" });
      if (!isManagerUser(user) && user.id !== targetUserId) return res.status(403).json({ message: "Forbidden" });
      const raw = { ...(req.body || {}), userId: targetUserId };
      const validated: any = insertTimesheetEntrySchema.parse(raw);
      const computed = computeManualTimeEntry({ date: validated.date, startTime: validated.startTime, endTime: validated.endTime });
      if (!computed.ok) return res.status(400).json({ message: computed.error });
      const entry = await storage.createTimesheetEntry({
        ...validated,
        hours: computed.hours.toFixed(2) as any,
        status: computed.status as any,
        payableHours: computed.payableHours === null ? null : (Number(computed.payableHours.toFixed(2)) as any),
        anomalyFlags: computed.flags.length ? (computed.flags as any) : null,
        approvedByUserId: null,
        approvedAt: null,
        paidAt: null,
      } as any);
      res.status(201).json(entry);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("patch", "/api/timesheet/:id"); app.patch("/api/timesheet/:id", async (req, res) => {
    try {
      const authCtx = await requireAuth(req, res);
      if (!authCtx) return;
      const partial = insertTimesheetEntrySchema.partial().parse(req.body);
      const entry = await storage.updateTimesheetEntry(parseInt(req.params.id), partial);
      res.json(entry);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("delete", "/api/timesheet/:id"); app.delete("/api/timesheet/:id", async (req, res) => {
    try {
      const authCtx = await requireAuth(req, res);
      if (!authCtx) return;
      await storage.deleteTimesheetEntry(parseInt(req.params.id));
      res.json({ message: "Entry deleted" });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("post", "/api/timesheet/:id/submit"); app.post("/api/timesheet/:id/submit", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const id = parseInt(req.params.id);
      const entry = await storage.getTimesheetEntryById(id);
      if (!entry) return res.status(404).json({ message: "Entry not found" });
      if (!isManagerUser(user) && Number(entry.userId) !== user.id) return res.status(403).json({ message: "Forbidden" });
      const updated = await storage.updateTimesheetEntry(id, { status: "submitted" } as any);
      await storage.createApprovalEvent({ entityType: "timesheet_entry", entityId: id, action: "submitted", byUserId: user.id } as any);
      res.json(updated);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("post", "/api/timesheet/:id/approve"); app.post("/api/timesheet/:id/approve", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      if (!isManagerUser(user)) return res.status(403).json({ message: "Forbidden" });
      const id = parseInt(req.params.id);
      const updated = await storage.updateTimesheetEntry(id, { status: "approved", approvedByUserId: user.id, approvedAt: new Date() } as any);
      await storage.createApprovalEvent({ entityType: "timesheet_entry", entityId: id, action: "approved", byUserId: user.id } as any);
      res.json(updated);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("post", "/api/timesheet/:id/dispute"); app.post("/api/timesheet/:id/dispute", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      if (!isManagerUser(user)) return res.status(403).json({ message: "Forbidden" });
      const id = parseInt(req.params.id);
      const { reason } = req.body || {};
      const updated = await storage.updateTimesheetEntry(id, { status: "disputed", anomalyFlags: ["manager_disputed"], payableHours: 0 } as any);
      await storage.createApprovalEvent({ entityType: "timesheet_entry", entityId: id, action: "disputed", byUserId: user.id, notes: typeof reason === "string" ? reason : null } as any);
      res.json(updated);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("post", "/api/timesheet/:id/mark-paid"); app.post("/api/timesheet/:id/mark-paid", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      if (!isManagerUser(user)) return res.status(403).json({ message: "Forbidden" });
      const id = parseInt(req.params.id);
      const updated = await storage.updateTimesheetEntry(id, { status: "paid", paidAt: new Date() } as any);
      await storage.createApprovalEvent({ entityType: "timesheet_entry", entityId: id, action: "paid", byUserId: user.id } as any);
      res.json(updated);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("get", "/api/approvals/timesheet"); app.get("/api/approvals/timesheet", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      if (!isManagerUser(user)) return res.status(403).json({ message: "Forbidden" });
      const from = typeof req.query.from === "string" ? req.query.from : undefined;
      const to = typeof req.query.to === "string" ? req.query.to : undefined;
      if (!from || !to) return res.status(400).json({ message: "from and to are required" });
      const statuses = typeof req.query.status === "string" && req.query.status.trim()
        ? req.query.status.split(",").map((s: string) => s.trim()).filter(Boolean)
        : ["submitted", "disputed"];
      const rows = await storage.getTimesheetEntriesFiltered({ from, to, limit: 500, offset: 0 });
      res.json(rows.filter((r) => statuses.includes(String((r as any).status || "draft"))));
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("get", "/api/payroll/summary"); app.get("/api/payroll/summary", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      if (!isManagerUser(user)) return res.status(403).json({ message: "Forbidden" });
      const from = typeof req.query.from === "string" ? req.query.from : undefined;
      const to = typeof req.query.to === "string" ? req.query.to : undefined;
      if (!from || !to) return res.status(400).json({ message: "from and to are required" });
      const userId = typeof req.query.userId === "string" ? parseInt(req.query.userId) : undefined;
      const summary = await storage.getPayrollSummary({ from, to, userId });
      res.json(summary);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("get", "/api/worker-profiles"); app.get("/api/worker-profiles", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      if (!isManagerUser(user)) return res.status(403).json({ message: "Forbidden" });
      const usersRows = await storage.getUsers(500, 0);
      const profiles = await storage.listWorkerProfiles();
      const byUserId = new Map<number, any>();
      for (const p of profiles) byUserId.set(Number(p.userId), p);
      res.json(usersRows.map((u) => ({ user: u, profile: byUserId.get(Number(u.id)) || null })));
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("put", "/api/worker-profiles/:userId"); app.put("/api/worker-profiles/:userId", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      if (!isManagerUser(user)) return res.status(403).json({ message: "Forbidden" });
      const targetUserId = parseInt(req.params.userId);
      if (!Number.isFinite(targetUserId)) return res.status(400).json({ message: "Invalid userId" });
      const patch = insertWorkerProfileSchema.partial().parse(req.body);
      const upserted = await storage.upsertWorkerProfile(targetUserId, patch);
      res.json(upserted);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("get", "/api/category-rate-overrides"); app.get("/api/category-rate-overrides", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      if (!isManagerUser(user)) return res.status(403).json({ message: "Forbidden" });
      const userId = typeof req.query.userId === "string" ? parseInt(req.query.userId) : undefined;
      if (!userId) return res.status(400).json({ message: "userId is required" });
      const rows = await storage.getCategoryRateOverridesByUser(userId);
      res.json(rows);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("put", "/api/category-rate-overrides/:userId/:categoryId"); app.put("/api/category-rate-overrides/:userId/:categoryId", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      if (!isManagerUser(user)) return res.status(403).json({ message: "Forbidden" });
      const userId = parseInt(req.params.userId);
      const categoryId = parseInt(req.params.categoryId);
      if (!userId || !categoryId) return res.status(400).json({ message: "Invalid userId/categoryId" });
      const patch = insertCategoryRateOverrideSchema.partial().parse(req.body);
      const upserted = await storage.upsertCategoryRateOverride(userId, categoryId, patch);
      res.json(upserted);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("delete", "/api/category-rate-overrides/:userId/:categoryId"); app.delete("/api/category-rate-overrides/:userId/:categoryId", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      if (!isManagerUser(user)) return res.status(403).json({ message: "Forbidden" });
      const userId = parseInt(req.params.userId);
      const categoryId = parseInt(req.params.categoryId);
      if (!userId || !categoryId) return res.status(400).json({ message: "Invalid userId/categoryId" });
      await storage.deleteCategoryRateOverride(userId, categoryId);
      res.json({ ok: true });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("get", "/api/commissions/events"); app.get("/api/commissions/events", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      if (!isManagerUser(user)) return res.status(403).json({ message: "Forbidden" });
      const from = typeof req.query.from === "string" ? new Date(req.query.from) : undefined;
      const to = typeof req.query.to === "string" ? new Date(req.query.to) : undefined;
      const sourceType = typeof req.query.sourceType === "string" ? req.query.sourceType : undefined;
      const sourceId = typeof req.query.sourceId === "string" ? parseInt(req.query.sourceId) : undefined;
      const { limit, offset } = parseLimitOffset(req.query);
      const events = await storage.listCommissionEvents({ from, to, sourceType, sourceId, limit, offset });
      res.json(events);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("get", "/api/commissions/participants"); app.get("/api/commissions/participants", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      if (!isManagerUser(user)) return res.status(403).json({ message: "Forbidden" });
      const sourceType = typeof req.query.sourceType === "string" ? req.query.sourceType : "";
      const sourceId = typeof req.query.sourceId === "string" ? parseInt(req.query.sourceId) : NaN;
      if (!sourceType || !Number.isFinite(sourceId)) return res.status(400).json({ message: "sourceType and sourceId are required" });
      const rows = await storage.listDealParticipants({ sourceType, sourceId });
      res.json(rows);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("post", "/api/commissions/participants"); app.post("/api/commissions/participants", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      if (!isManagerUser(user)) return res.status(403).json({ message: "Forbidden" });
      const validated = insertDealParticipantSchema.parse(req.body);
      const row = await storage.upsertDealParticipant(validated);
      res.status(201).json(row);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("delete", "/api/commissions/participants/:id"); app.delete("/api/commissions/participants/:id", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      if (!isManagerUser(user)) return res.status(403).json({ message: "Forbidden" });
      await storage.deleteDealParticipant(parseInt(req.params.id));
      res.json({ ok: true });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("get", "/api/commissions/ledger"); app.get("/api/commissions/ledger", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      if (!isManagerUser(user)) return res.status(403).json({ message: "Forbidden" });
      const userId = typeof req.query.userId === "string" ? parseInt(req.query.userId) : undefined;
      const status = typeof req.query.status === "string" ? req.query.status : undefined;
      const eventId = typeof req.query.eventId === "string" ? parseInt(req.query.eventId) : undefined;
      const { limit, offset } = parseLimitOffset(req.query);
      const rows = await storage.listCommissionLedgerEntries({ userId, status, eventId, limit, offset });
      res.json(rows);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("post", "/api/commissions/ledger/:id/approve"); app.post("/api/commissions/ledger/:id/approve", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      if (!isManagerUser(user)) return res.status(403).json({ message: "Forbidden" });
      const id = parseInt(req.params.id);
      const updated = await storage.updateCommissionLedgerEntry(id, { status: "approved", approvedByUserId: user.id, approvedAt: new Date() } as any);
      await storage.createApprovalEvent({ entityType: "commission_ledger_entry", entityId: id, action: "approved", byUserId: user.id } as any);
      res.json(updated);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("post", "/api/commissions/ledger/:id/dispute"); app.post("/api/commissions/ledger/:id/dispute", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      if (!isManagerUser(user)) return res.status(403).json({ message: "Forbidden" });
      const id = parseInt(req.params.id);
      const { reason } = req.body || {};
      const updated = await storage.updateCommissionLedgerEntry(id, { status: "disputed", disputedReason: typeof reason === "string" ? reason : null } as any);
      await storage.createApprovalEvent({ entityType: "commission_ledger_entry", entityId: id, action: "disputed", byUserId: user.id, notes: typeof reason === "string" ? reason : null } as any);
      res.json(updated);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("post", "/api/commissions/ledger/:id/mark-paid"); app.post("/api/commissions/ledger/:id/mark-paid", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      if (!isManagerUser(user)) return res.status(403).json({ message: "Forbidden" });
      const id = parseInt(req.params.id);
      const updated = await storage.updateCommissionLedgerEntry(id, { status: "paid", paidAt: new Date() } as any);
      await storage.createApprovalEvent({ entityType: "commission_ledger_entry", entityId: id, action: "paid", byUserId: user.id } as any);
      res.json(updated);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  // TICKET 17 — BUYER QUALIFICATION WORKFLOW ENDPOINTS.
  // NOTE: /api/buyers/review-queue, /api/buyers/deal-ready, and
  // /api/buyers/qualification/dashboard MUST be registered before
  // /api/buyers/:id so Express does not treat them as an :id.
  const QUAL_STAGES = ["new", "contacted", "responded", "qualified", "deal_ready", "inactive"] as const;

  reg("get", "/api/buyers/qualification/dashboard"); app.get("/api/buyers/qualification/dashboard", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      // Funnel counts by relationship stage (all non-test buyers).
      const stageRows: any = await db.execute(sql`
        SELECT q.relationship_stage AS stage, COUNT(*)::int AS count
        FROM buyer_qualification q
        JOIN buyers b ON b.id = q.buyer_id
        WHERE b.is_suspected_test = false
        GROUP BY q.relationship_stage
      `);
      const byStage: Record<string, number> = {};
      for (const s of QUAL_STAGES) byStage[s] = 0;
      for (const r of ((stageRows as any).rows ?? [])) byStage[String(r.stage)] = Number(r.count);
      // Actionability gaps.
      const gapRows: any = await db.execute(sql`
        SELECT
          COUNT(*) FILTER (WHERE q.owner_user_id IS NULL)::int AS unassigned,
          COUNT(*) FILTER (WHERE q.next_action IS NULL OR btrim(q.next_action) = '')::int AS no_next_action,
          COUNT(*) FILTER (WHERE q.next_action_at IS NOT NULL AND q.next_action_at < now())::int AS overdue_actions
        FROM buyer_qualification q
        JOIN buyers b ON b.id = q.buyer_id
        WHERE b.is_suspected_test = false AND b.status = 'active'
          AND q.relationship_stage NOT IN ('inactive', 'deal_ready')
      `);
      const gaps = ((gapRows as any).rows ?? [])[0] || { unassigned: 0, no_next_action: 0, overdue_actions: 0 };
      // Market coverage: distinct buy-box markets vs markets with >=1 qualified/deal_ready buyer.
      const marketRows: any = await db.execute(sql`
        WITH markets AS (
          SELECT DISTINCT btrim(m) AS market
          FROM buyer_buybox bb, unnest(bb.markets) AS m
          WHERE btrim(m) <> ''
        ),
        covered AS (
          SELECT DISTINCT btrim(m) AS market
          FROM buyer_buybox bb
          JOIN buyer_qualification q ON q.buyer_id = bb.buyer_id
          JOIN buyers b ON b.id = bb.buyer_id
          CROSS JOIN unnest(bb.markets) AS m
          WHERE b.is_suspected_test = false
            AND q.relationship_stage IN ('qualified', 'deal_ready')
            AND btrim(m) <> ''
        )
        SELECT mk.market,
               (c.market IS NOT NULL) AS covered,
               (SELECT COUNT(*)::int FROM buyer_qualification q2
                 JOIN buyers b2 ON b2.id = q2.buyer_id
                 WHERE b2.is_suspected_test = false
                   AND q2.relationship_stage IN ('qualified', 'deal_ready')
                   AND EXISTS (SELECT 1 FROM buyer_buybox bb2
                               WHERE bb2.buyer_id = q2.buyer_id
                                 AND mk.market = ANY(bb2.markets))) AS qualified_count
        FROM markets mk
        LEFT JOIN covered c ON c.market = mk.market
        ORDER BY covered ASC, mk.market ASC
      `);
      const markets = (((marketRows as any).rows ?? [])).map((r: any) => ({
        market: r.market,
        covered: r.covered === true || r.covered === "t",
        qualifiedCount: Number(r.qualified_count),
      }));
      // Outreach velocity: attempts in the last 7 and 30 days.
      const velRows: any = await db.execute(sql`
        SELECT COUNT(*) FILTER (WHERE occurred_at >= now() - interval '7 days')::int AS last7,
               COUNT(*) FILTER (WHERE occurred_at >= now() - interval '30 days')::int AS last30
        FROM buyer_outreach_log
      `);
      const velocity = ((velRows as any).rows ?? [])[0] || { last7: 0, last30: 0 };
      res.json({ byStage, gaps, markets, velocity });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  reg("get", "/api/buyers/review-queue"); app.get("/api/buyers/review-queue", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const rows: any = await db.execute(sql`
        SELECT b.id, b.name, b.company, b.email, b.phone, b.created_at,
               b.is_suspected_test, b.duplicate_of, b.review_decision,
               k.name AS duplicate_of_name,
               (SELECT COUNT(*)::int FROM buyer_outreach_log o WHERE o.buyer_id = b.id) AS outreach_count
        FROM buyers b
        LEFT JOIN buyers k ON k.id = b.duplicate_of
        WHERE b.is_suspected_test = true AND b.review_decision IS NULL
        ORDER BY b.created_at DESC
        LIMIT 200
      `);
      res.json((rows as any).rows ?? []);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  reg("post", "/api/buyers/:id/review"); app.post("/api/buyers/:id/review", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const id = parseInt(req.params.id);
      const decision = String(req.body?.decision || "").toLowerCase();
      if (!["approved", "rejected", "merged"].includes(decision)) {
        return res.status(400).json({ message: "decision must be approved, rejected, or merged" });
      }
      // approved = legit buyer, clear the flag. rejected = confirmed test data (stays flagged).
      // merged = duplicate folded into duplicate_of; stays flagged but out of the queue.
      const clearFlag = decision === "approved";
      await db.execute(sql`
        UPDATE buyers
        SET review_decision = ${decision},
            reviewed_at = now(),
            reviewed_by = ${user.id},
            is_suspected_test = ${!clearFlag}
        WHERE id = ${id}
      `);
      res.json({ id, decision });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  reg("get", "/api/buyers/deal-ready"); app.get("/api/buyers/deal-ready", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      // Deal alerts target ONLY confirmed buy-box buyers. Never the full list.
      const market = String(req.query?.market || "").trim() || null;
      const maxPrice = req.query?.max_price ? Number(req.query.max_price) : null;
      const rows: any = await db.execute(sql`
        SELECT b.id, b.name, b.company, b.email, b.phone,
               b.min_budget, b.max_budget,
               bb.markets, bb.asset_types, bb.min_price, bb.max_price, bb.strategy,
               bb.buybox_confirmed, bb.proof_of_funds_verified,
               q.relationship_stage, q.owner_user_id,
               u.first_name, u.last_name
        FROM buyers b
        JOIN buyer_buybox bb ON bb.buyer_id = b.id
        LEFT JOIN buyer_qualification q ON q.buyer_id = b.id
        LEFT JOIN users u ON u.id = q.owner_user_id
        WHERE b.is_suspected_test = false
          AND b.do_not_call = false
          AND bb.buybox_confirmed = true
          AND (${market}::text IS NULL OR ${market}::text = ANY(bb.markets))
          AND (${maxPrice}::numeric IS NULL OR bb.max_price IS NULL OR bb.max_price >= ${maxPrice}::numeric)
        ORDER BY bb.proof_of_funds_verified DESC, b.name ASC
        LIMIT 500
      `);
      res.json((rows as any).rows ?? []);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  reg("get", "/api/buyers/:id/qualification"); app.get("/api/buyers/:id/qualification", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const id = parseInt(req.params.id);
      const qRows: any = await db.execute(sql`
        SELECT q.*, u.first_name AS owner_first_name, u.last_name AS owner_last_name, u.email AS owner_email
        FROM buyer_qualification q
        LEFT JOIN users u ON u.id = q.owner_user_id
        WHERE q.buyer_id = ${id}
        LIMIT 1
      `);
      let qual = ((qRows as any).rows ?? [])[0] || null;
      if (!qual) {
        const ins: any = await db.execute(sql`
          INSERT INTO buyer_qualification (buyer_id, relationship_stage)
          VALUES (${id}, 'new')
          ON CONFLICT (buyer_id) DO NOTHING
          RETURNING *
        `);
        qual = (((ins as any).rows ?? [])[0] || null);
      }
      const bbRows: any = await db.execute(sql`
        SELECT * FROM buyer_buybox WHERE buyer_id = ${id} LIMIT 1
      `);
      const buybox = (((bbRows as any).rows ?? [])[0] || null);
      const logRows: any = await db.execute(sql`
        SELECT o.*, u.first_name, u.last_name
        FROM buyer_outreach_log o
        LEFT JOIN users u ON u.id = o.user_id
        WHERE o.buyer_id = ${id}
        ORDER BY o.occurred_at DESC
        LIMIT 100
      `);
      res.json({ qualification: qual, buybox, outreachLog: ((logRows as any).rows ?? []) });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  reg("post", "/api/buyers/:id/qualify"); app.post("/api/buyers/:id/qualify", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const id = parseInt(req.params.id);
      const { relationship_stage, next_action, next_action_at, notes, buybox } = req.body || {};
      if (relationship_stage && !(QUAL_STAGES as readonly string[]).includes(String(relationship_stage))) {
        return res.status(400).json({ message: `relationship_stage must be one of: ${QUAL_STAGES.join(", ")}` });
      }
      const up: any = await db.execute(sql`
        INSERT INTO buyer_qualification (buyer_id, relationship_stage, next_action, next_action_at, notes, updated_at)
        VALUES (${id},
                ${relationship_stage || "new"},
                ${next_action ?? null},
                ${next_action_at ? new Date(next_action_at) : null},
                ${notes ?? null},
                now())
        ON CONFLICT (buyer_id) DO UPDATE SET
          relationship_stage = COALESCE(${relationship_stage || null}, buyer_qualification.relationship_stage),
          next_action = COALESCE(${next_action ?? null}, buyer_qualification.next_action),
          next_action_at = COALESCE(${next_action_at ? new Date(next_action_at) : null}, buyer_qualification.next_action_at),
          notes = COALESCE(${notes ?? null}, buyer_qualification.notes),
          updated_at = now()
        RETURNING *
      `);
      // Optional inline buy-box update.
      if (buybox && typeof buybox === "object") {
        const { markets, asset_types, min_price, max_price, strategy, buybox_confirmed, proof_of_funds_verified, notes: bbNotes } = buybox;
        // Normalize: null = "leave unchanged", value = "set".
        const marketsParam = Array.isArray(markets) ? markets : null;
        const assetTypesParam = Array.isArray(asset_types) ? asset_types : null;
        const confirmedParam = buybox_confirmed === true ? true : buybox_confirmed === false ? false : null;
        const pofParam = proof_of_funds_verified === true ? true : proof_of_funds_verified === false ? false : null;
        await db.execute(sql`
          INSERT INTO buyer_buybox (buyer_id, markets, asset_types, min_price, max_price, strategy, buybox_confirmed, proof_of_funds_verified, proof_of_funds_at, notes, updated_at)
          VALUES (${id},
                  ${marketsParam ?? []},
                  ${assetTypesParam ?? []},
                  ${min_price ?? null}, ${max_price ?? null},
                  ${strategy ?? null},
                  ${confirmedParam ?? false},
                  ${pofParam ?? false},
                  ${pofParam === true ? new Date() : null},
                  ${bbNotes ?? null},
                  now())
          ON CONFLICT (buyer_id) DO UPDATE SET
            markets = COALESCE(${marketsParam}, buyer_buybox.markets),
            asset_types = COALESCE(${assetTypesParam}, buyer_buybox.asset_types),
            min_price = COALESCE(${min_price ?? null}, buyer_buybox.min_price),
            max_price = COALESCE(${max_price ?? null}, buyer_buybox.max_price),
            strategy = COALESCE(${strategy ?? null}, buyer_buybox.strategy),
            buybox_confirmed = COALESCE(${confirmedParam}, buyer_buybox.buybox_confirmed),
            proof_of_funds_verified = COALESCE(${pofParam}, buyer_buybox.proof_of_funds_verified),
            proof_of_funds_at = CASE WHEN ${pofParam} IS NOT NULL AND ${pofParam} = true THEN now() ELSE buyer_buybox.proof_of_funds_at END,
            notes = COALESCE(${bbNotes ?? null}, buyer_buybox.notes),
            updated_at = now()
        `);
      }
      res.json((((up as any).rows ?? [])[0]));
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  reg("post", "/api/buyers/:id/log-outreach"); app.post("/api/buyers/:id/log-outreach", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const id = parseInt(req.params.id);
      const channel = String(req.body?.channel || "").toLowerCase();
      if (!["call", "sms", "email", "meeting", "other"].includes(channel)) {
        return res.status(400).json({ message: "channel must be call, sms, email, meeting, or other" });
      }
      const occurredAt = req.body?.occurred_at ? new Date(req.body.occurred_at) : new Date();
      const ins: any = await db.execute(sql`
        INSERT INTO buyer_outreach_log (buyer_id, user_id, channel, outcome, notes, occurred_at)
        VALUES (${id}, ${user.id}, ${channel}, ${req.body?.outcome ?? null}, ${req.body?.notes ?? null}, ${occurredAt})
        RETURNING *
      `);
      // Every attempt updates last contact; first-ever outreach advances new -> contacted.
      await db.execute(sql`
        INSERT INTO buyer_qualification (buyer_id, relationship_stage, last_contact_at, updated_at)
        VALUES (${id}, 'contacted', ${occurredAt}, now())
        ON CONFLICT (buyer_id) DO UPDATE SET
          last_contact_at = GREATEST(buyer_qualification.last_contact_at, ${occurredAt}),
          relationship_stage = CASE WHEN buyer_qualification.relationship_stage = 'new' THEN 'contacted' ELSE buyer_qualification.relationship_stage END,
          updated_at = now()
      `);
      await db.execute(sql`
        UPDATE buyers SET last_contact_date = GREATEST(COALESCE(last_contact_date, ${occurredAt}), ${occurredAt})
        WHERE id = ${id}
      `);
      res.status(201).json((((ins as any).rows ?? [])[0]));
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  reg("post", "/api/buyers/:id/assign-owner"); app.post("/api/buyers/:id/assign-owner", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const id = parseInt(req.params.id);
      const ownerUserId = req.body?.owner_user_id ? parseInt(req.body.owner_user_id) : null;
      if (ownerUserId !== null) {
        const uRows: any = await db.execute(sql`SELECT id FROM users WHERE id = ${ownerUserId} LIMIT 1`);
        if (((((uRows as any).rows ?? [])).length || 0) === 0) {
          return res.status(400).json({ message: "owner_user_id does not match a user" });
        }
      }
      await db.execute(sql`
        INSERT INTO buyer_qualification (buyer_id, owner_user_id, updated_at)
        VALUES (${id}, ${ownerUserId}, now())
        ON CONFLICT (buyer_id) DO UPDATE SET owner_user_id = ${ownerUserId}, updated_at = now()
      `);
      // Keep the legacy buyers.owner_user_id column in sync for existing UI.
      await db.execute(sql`UPDATE buyers SET owner_user_id = ${ownerUserId} WHERE id = ${id}`);
      res.json({ id, owner_user_id: ownerUserId });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // BUYERS ENDPOINTS
  reg("get", "/api/buyers"); app.get("/api/buyers", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const { limit, offset } = parseLimitOffset(req.query);
      // A list UI that never paginates must not silently cap: only apply the
      // server default when the caller explicitly passes ?limit=.
      const buyers = await storage.getBuyers(
        req.query?.limit ? parseLimitOffset(req.query).limit : undefined,
        req.query?.offset ? parseLimitOffset(req.query).offset : 0,
      );
      res.json(buyers);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("get", "/api/buyers/:id"); app.get("/api/buyers/:id", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const buyer = await storage.getBuyerById(parseInt(req.params.id)) as any;
      if (!buyer) return res.status(404).json({ message: "Buyer not found" });
      // P0 fix (audit IDOR): non-managers can only read buyers they own.
      if (!canAccessOwnedRecord(user, buyer)) return res.status(403).json({ message: "Forbidden" });
      res.json(buyer);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("post", "/api/buyers"); app.post("/api/buyers", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const validated = insertBuyerSchema.parse({ ...req.body, userId: user.id });
      const buyer = await storage.createBuyer(validated);
      // Hard invariant (audit C2): a create that does not return the persisted row
      // is a failure. Never report success without a real database record.
      if (!buyer || (buyer as any).id == null) {
        console.error(JSON.stringify({
          ts: new Date().toISOString(),
          event: "buyer_create_invariant",
          detail: "createBuyer resolved without a persisted row",
          userId: user.id,
        }));
        return res.status(500).json({ message: "Buyer could not be created (no record returned). Please retry." });
      }
      res.status(201).json(buyer);
    } catch (error: any) {
      console.error(JSON.stringify({
        ts: new Date().toISOString(),
        event: "buyer_create_failed",
        detail: String(error?.message || error),
        code: error?.code ? String(error.code) : null,
      }));
      res.status(400).json({ message: error?.message || "Failed to create buyer" });
    }
  });
  reg("patch", "/api/buyers/:id"); app.patch("/api/buyers/:id", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const partial = insertBuyerSchema.partial().parse(req.body) as any;
      if (Object.prototype.hasOwnProperty.call(partial, "userId")) {
        delete partial.userId;
      }
      const buyer = await storage.updateBuyer(parseInt(req.params.id), partial);
      res.json(buyer);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("delete", "/api/buyers/:id"); app.delete("/api/buyers/:id", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      await storage.deleteBuyer(parseInt(req.params.id));
      res.json({ message: "Buyer deleted" });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  // BUYER COMMUNICATIONS ENDPOINTS
  reg("get", "/api/buyers/:buyerId/communications"); app.get("/api/buyers/:buyerId/communications", async (req, res) => {
    try {
      const authCtx = await requireAuth(req, res);
      if (!authCtx) return;
      const { limit, offset } = parseLimitOffset(req.query);
      const comms = await storage.getBuyerCommunications(parseInt(req.params.buyerId), limit, offset);
      res.json(comms);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("post", "/api/buyers/:buyerId/communications"); app.post("/api/buyers/:buyerId/communications", async (req, res) => {
    try {
      const authCtx = await requireAuth(req, res);
      if (!authCtx) return;
      const validated = insertBuyerCommunicationSchema.parse({
        ...req.body,
        buyerId: parseInt(req.params.buyerId)
      });
      const comm = await storage.createBuyerCommunication(validated);
      res.status(201).json(comm);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("delete", "/api/buyer-communications/:id"); app.delete("/api/buyer-communications/:id", async (req, res) => {
    try {
      const authCtx = await requireAuth(req, res);
      if (!authCtx) return;
      await storage.deleteBuyerCommunication(parseInt(req.params.id));
      res.json({ message: "Communication deleted" });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  // ── BUYER PIPELINE STATUS ───────────────────────────────────────────
  // Validated pipeline transitions (BUYER_PIPELINE) with an audit trail.
  // DNC lock: do_not_contact cannot be lifted by a bare PATCH — use the
  // dedicated opt-in endpoint (manager-only), mirroring lead DNC policy.
  const VALID_BUYER_STATUSES = new Set<string>([
    "new", "attempting_contact", "contacted", "qualified", "active_buyer",
    "offer_submitted", "under_contract", "closed", "nurture", "do_not_contact",
  ]);
  const BUYER_STATUS_LABELS: Record<string, string> = {
    new: "New", attempting_contact: "Attempting Contact", contacted: "Contacted",
    qualified: "Qualified", active_buyer: "Active Buyer", offer_submitted: "Offer Submitted",
    under_contract: "Under Contract", closed: "Closed", nurture: "Nurture",
    do_not_contact: "Do Not Contact",
  };

  app.post("/api/buyers/:id/status", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const buyerId = parseInt(req.params.id);
      const to = String(req.body?.status || "").trim();
      if (!VALID_BUYER_STATUSES.has(to)) {
        return res.status(400).json({ message: `status must be one of: ${[...VALID_BUYER_STATUSES].join(", ")}` });
      }
      const buyer = await storage.getBuyerById(buyerId);
      if (!buyer) return res.status(404).json({ message: "Buyer not found" });
      const from = buyer.buyerStatus || "new";
      if (from !== "do_not_contact" && to === "do_not_contact") {
        // Entering DNC goes through the same lock as the disposition path.
        await storage.setBuyerDnc(buyerId, true);
      }
      if (from === "do_not_contact" && to !== "do_not_contact") {
        return res.status(403).json({ message: "Buyer is marked Do Not Contact — use the opt-in endpoint with a manager reason to re-enable contact.", code: "DNC_LOCKED" });
      }
      const updated = await storage.updateBuyer(buyerId, {
        buyerStatus: to,
        doNotCall: to === "do_not_contact" ? true : buyer.doNotCall,
        dncUpdatedAt: to === "do_not_contact" ? new Date() : buyer.dncUpdatedAt,
        updatedAt: new Date(),
      } as any);
      await storage.createGlobalActivity({
        userId: user.id,
        action: "buyer_status_changed",
        description: `Buyer ${buyer.name}: ${BUYER_STATUS_LABELS[from] || from} → ${BUYER_STATUS_LABELS[to] || to}`,
        metadata: JSON.stringify({ buyerId, from, to }),
      } as any);
      res.json(updated);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });

  // Manager-only DNC opt-in: the only path out of do_not_contact, requires a
  // written reason which is stored in the audit log.
  app.post("/api/buyers/:id/dnc-opt-in", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const isAdmin = Boolean(user.isSuperAdmin) || String(user.role || "").trim().toLowerCase() === "admin";
      if (!isAdmin) {
        return res.status(403).json({ message: "Only admins can re-enable contact for a Do-Not-Contact buyer.", code: "ADMIN_REQUIRED" });
      }
      const reason = String(req.body?.reason || "").trim();
      if (!reason) return res.status(400).json({ message: "A reason is required to opt a buyer back in." });
      const buyerId = parseInt(req.params.id);
      const buyer = await storage.getBuyerById(buyerId);
      if (!buyer) return res.status(404).json({ message: "Buyer not found" });
      await storage.setBuyerDnc(buyerId, false);
      const updated = await storage.updateBuyer(buyerId, { buyerStatus: "nurture", updatedAt: new Date() } as any);
      await storage.createGlobalActivity({
        userId: user.id,
        action: "buyer_dnc_opt_in",
        description: `Buyer ${buyer.name} opted back in by manager. Reason: ${reason}`,
        metadata: JSON.stringify({ buyerId, reason }),
      } as any);
      res.json(updated);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });

  // ── QUICK LOG CALL (manual, provider-tagged — e.g. company Google Voice) ──
  reg("post", "/api/buyers/:id/call-logs"); app.post("/api/buyers/:id/call-logs", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const result = await callSessions.logManualBuyerCall({
        buyerId: Number(req.params.id),
        userId: user.id,
        direction: String(req.body?.direction || "outbound") as "inbound" | "outbound",
        occurredAt: req.body?.occurredAt ? String(req.body.occurredAt) : undefined,
        durationSeconds: req.body?.durationSeconds != null ? Number(req.body.durationSeconds) : undefined,
        sessionProvider: req.body?.sessionProvider ? String(req.body.sessionProvider) : undefined,
        disposition: String(req.body?.disposition || ""),
        note: req.body?.note ? String(req.body.note) : undefined,
        interestLevel: req.body?.interestLevel ? String(req.body.interestLevel) : undefined,
        nextAction: req.body?.nextAction ? String(req.body.nextAction) : undefined,
        nextActionAt: req.body?.nextActionAt ? String(req.body.nextActionAt) : undefined,
        propertyId: req.body?.propertyId ? Number(req.body.propertyId) : undefined,
      });
      if (!result.ok) return res.status(result.status).json({ error: result.error, code: result.code });
      res.status(201).json({ ok: true, session: result.session });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  reg("get", "/api/buyers/:id/call-logs"); app.get("/api/buyers/:id/call-logs", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const buyerId = parseInt(req.params.id);
      const rows = await storage.listCallSessionsByBuyer(buyerId);
      res.json(rows);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  reg("get", "/api/reports/source"); app.get("/api/reports/source", async (req, res) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;
      const fromRaw = typeof req.query.from === "string" ? req.query.from : "";
      const toRaw = typeof req.query.to === "string" ? req.query.to : "";
      const from = fromRaw ? new Date(fromRaw) : null;
      const to = toRaw ? new Date(toRaw) : null;
      const fromOk = from && Number.isFinite(from.getTime()) ? from : null;
      const toOk = to && Number.isFinite(to.getTime()) ? to : null;
      const leadWhere = sql`WHERE ${
        fromOk ? sql`created_at >= ${fromOk}` : sql`TRUE`
      } AND ${
        toOk ? sql`created_at < ${toOk}` : sql`TRUE`
      }`;
      const oppWhere = sql`WHERE ${
        fromOk ? sql`p.created_at >= ${fromOk}` : sql`TRUE`
      } AND ${
        toOk ? sql`p.created_at < ${toOk}` : sql`TRUE`
      }`;
      const dealWhere = sql`WHERE ${
        fromOk ? sql`da.created_at >= ${fromOk}` : sql`TRUE`
      } AND ${
        toOk ? sql`da.created_at < ${toOk}` : sql`TRUE`
      }`;
      const leadsRows: any = await db.execute(sql`
        SELECT
          COALESCE(NULLIF(TRIM(source), ''), 'Unknown') AS source,
          COUNT(*)::int AS leads
        FROM leads
        ${leadWhere}
        GROUP BY 1
      `);
      const oppRows: any = await db.execute(sql`
        SELECT
          COALESCE(NULLIF(TRIM(COALESCE(p.lead_source, l.source)), ''), 'Unknown') AS source,
          COUNT(*)::int AS opportunities
        FROM properties p
        LEFT JOIN leads l ON l.id = p.source_lead_id
        ${oppWhere}
        GROUP BY 1
      `);
      const dealRows: any = await db.execute(sql`
        SELECT
          COALESCE(NULLIF(TRIM(COALESCE(p.lead_source, l.source)), ''), 'Unknown') AS source,
          COUNT(*)::int AS deals,
          COALESCE(SUM(COALESCE(da.payout_amount, '0')::numeric), 0)::numeric AS revenue
        FROM deal_assignments da
        JOIN properties p ON p.id = da.property_id
        LEFT JOIN leads l ON l.id = p.source_lead_id
        ${dealWhere}
        GROUP BY 1
      `);
      const merged = new Map<string, any>();
      for (const r of (leadsRows as any).rows || []) {
        merged.set(String(r.source), { source: String(r.source), leads: r.leads || 0, opportunities: 0, deals: 0, revenue: 0 });
      }
      for (const r of (oppRows as any).rows || []) {
        const key = String(r.source);
        const cur = merged.get(key) || { source: key, leads: 0, opportunities: 0, deals: 0, revenue: 0 };
        cur.opportunities = r.opportunities || 0;
        merged.set(key, cur);
      }
      for (const r of (dealRows as any).rows || []) {
        const key = String(r.source);
        const cur = merged.get(key) || { source: key, leads: 0, opportunities: 0, deals: 0, revenue: 0 };
        cur.deals = r.deals || 0;
        cur.revenue = typeof r.revenue === "string" || typeof r.revenue === "number" ? Number(r.revenue) : 0;
        merged.set(key, cur);
      }
      const sources = Array.from(merged.values()).sort((a, b) => (b.revenue || 0) - (a.revenue || 0) || (b.deals || 0) - (a.deals || 0) || (b.leads || 0) - (a.leads || 0));
      res.json({ from: fromRaw || null, to: toRaw || null, sources });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  // ===== PUBLIC LISTING ROUTES (no auth required) =====
  reg("get", "/api/public/listings/:token"); app.get("/api/public/listings/:token", async (req, res) => {
    try {
      const token = String(req.params.token || "").trim();
      if (!token) return res.status(404).json({ message: "Not found" });
      const listing = await storage.getPublicListingByToken(token);
      if (!listing) return res.status(404).json({ message: "Not found" });
      if (listing.status !== "published") return res.status(404).json({ message: "Not found" });
      if (listing.expiresAt && new Date(listing.expiresAt).getTime() < Date.now()) return res.status(410).json({ message: "Listing expired" });
      if (listing.passwordHash && String(req.query.pw || "").trim() !== "") {
        return res.json({ requiresPassword: true, listing: { id: listing.id, title: listing.title, description: listing.description } });
      }
      const property = await storage.getPropertyById(listing.opportunityId);
      if (!property) return res.status(404).json({ message: "Not found" });
      await storage.incrementListingViews(listing.id);
      // Privacy: only include fields the agent explicitly chose to expose.
      // Address/lat-long are gated behind exposeAddress; financials and the
      // internal summary behind exposeFinancials. Seller data, notes, user IDs,
      // and hidden documents are never included.
      const showAddress = Boolean(listing.exposeAddress);
      const showFinancials = Boolean(listing.exposeFinancials);
      res.json({
        listing: {
          id: listing.id,
          title: listing.title || `${property.address}, ${property.city}, ${property.state} ${property.zipCode}`,
          description: listing.description,
          slug: listing.slug,
          visibility: listing.visibility,
          viewCount: listing.viewCount,
          publishedAt: listing.publishedAt,
          exposeAddress: listing.exposeAddress,
          exposeComps: listing.exposeComps,
          exposeFinancials: listing.exposeFinancials,
          exposeDocs: listing.exposeDocs,
          contactName: listing.contactName,
          contactEmail: listing.contactEmail,
          contactPhone: listing.contactPhone,
        },
        property: {
          ...(showAddress
            ? {
                address: property.address,
                city: property.city,
                state: property.state,
                zipCode: property.zipCode,
                latitude: property.latitude,
                longitude: property.longitude,
              }
            : { city: property.city, state: property.state }),
          beds: property.beds,
          baths: property.baths,
          sqft: property.sqft,
          yearBuilt: property.yearBuilt,
          propertyType: property.propertyType,
          lotSize: property.lotSize,
          occupancy: property.occupancy,
          images: resolvePropertyImages((property as any).images || []),
          ...(showFinancials
            ? {
                price: property.price,
                arv: property.arv,
                repairCost: property.repairCost,
                askingPrice: (property as any).askingPrice,
                targetDispositionPrice: (property as any).targetDispositionPrice,
                internalSummary: (property as any).internalSummary,
              }
            : {}),
        },
      });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  reg("post", "/api/listings/:token/inquiries"); app.post("/api/listings/:token/inquiries", async (req, res) => {
    try {
      const token = String(req.params.token || "").trim();
      if (!token) return res.status(404).json({ message: "Not found" });
      const listing = await storage.getPublicListingByToken(token);
      if (!listing) return res.status(404).json({ message: "Not found" });
      if (listing.status !== "published") return res.status(404).json({ message: "Not found" });
      if (listing.passwordHash) {
        const providedPw = String(req.body?._password || "").trim();
        if (providedPw !== listing.passwordHash) {
          return res.status(401).json({ message: "Password required" });
        }
      }
      if (listing.expiresAt && new Date(listing.expiresAt).getTime() < Date.now()) return res.status(410).json({ message: "Listing expired" });
      const clientIp = String(req.ip || req.socket?.remoteAddress || req.headers["x-forwarded-for"] || "").split(",")[0]
      if (!checkInquiryRateLimit(clientIp)) {
        return res.status(429).json({ message: "Too many inquiries. Please try again later." });
      }
      const body = req.body || {};
      const name = String(body.name || "").trim().slice(0, 255);
      const email = String(body.email || "").trim().slice(0, 255);
      const phone = String(body.phone || "").trim().slice(0, 20);
      const company = String(body.company || "").trim().slice(0, 255);
      const buyerType = String(body.buyerType || "").trim().slice(0, 50);
      const message = String(body.message || "").trim().slice(0, 5000);
      const offerAmount = body.offerAmount ? Number(body.offerAmount) : null;
      const pofUrl = body.proofOfFundsUrl ? String(body.proofOfFundsUrl).trim().slice(0, 500) : null;
      if (!name || name.length < 2) return res.status(400).json({ message: "Name is required (min 2 characters)" });
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ message: "Invalid email" });
      const inquiry = await storage.createBuyerInquiry({
        listingId: listing.id,
        opportunityId: listing.opportunityId,
        name,
        email: email || null,
        phone: phone || null,
        company: company || null,
        buyerType: buyerType || null,
        message: message || null,
        offerAmount: offerAmount !== null && !Number.isNaN(offerAmount) ? String(offerAmount) : null,
        proofOfFundsUrl: pofUrl,
        status: "new",
        ip: req.ip || null,
        userAgent: String(req.headers["user-agent"] || ""),
      } as any);
      await storage.updateProperty(listing.opportunityId, { lastActivityAt: new Date() });
      await logOpportunityEvent(listing.opportunityId, "inquiry_received", "New buyer inquiry received", `${inquiry.name} submitted an inquiry${offerAmount ? ` with offer $${Number(offerAmount).toLocaleString()}` : ""}`, undefined, "buyer", { inquiryId: inquiry.id, offerAmount: offerAmount ? String(offerAmount) : null });
      try {
        const property = await storage.getPropertyById(listing.opportunityId);
        const ownerId = (property as any)?.assignedTo;
        if (ownerId) {
          await storage.createUserNotification({
            userId: ownerId,
            type: "opportunity_inquiry",
            title: "New buyer inquiry on your listing",
            message: `${inquiry.name} submitted an inquiry for ${property?.address || "your property"}.`,
            linkUrl: `/opportunities/${listing.opportunityId}/inquiry/${inquiry.id}`,
            metadata: JSON.stringify({ inquiryId: inquiry.id, listingId: listing.id, opportunityId: listing.opportunityId }),
          } as any);
        }
      } catch {}
      try {
        const property = await storage.getPropertyById(listing.opportunityId);
        const ownerId = (property as any)?.assignedTo;
        if (ownerId) {
          await createTask({
            relatedEntityType: "opportunity",
            relatedEntityId: listing.opportunityId,
            assignedToUserId: Number(ownerId),
            title: `Follow up: Buyer inquiry from ${inquiry.name}`,
            description: `New inquiry on public listing. Offer: $${offerAmount ? Number(offerAmount).toLocaleString() : "N/A"}`,
            type: "followup",
            priority: "high",
            dueAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
            createdBy: Number(ownerId),
          } as any);
        }
      } catch {}
      res.status(201).json({ inquiryId: inquiry.id, message: "Inquiry submitted successfully" });
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  reg("post", "/api/listings/:token/offer"); app.post("/api/listings/:token/offer", async (req, res) => {
    try {
      const token = String(req.params.token || "").trim();
      if (!token) return res.status(404).json({ message: "Not found" });
      const listing = await storage.getPublicListingByToken(token);
      if (!listing) return res.status(404).json({ message: "Not found" });
      if (listing.status !== "published") return res.status(404).json({ message: "Not found" });
      const body = req.body || {};
      const name = String(body.name || "").trim().slice(0, 255);
      const email = String(body.email || "").trim().slice(0, 255);
      const phone = String(body.phone || "").trim().slice(0, 20);
      const offerAmount = body.offerAmount ? Number(body.offerAmount) : null;
      const terms = String(body.terms || "").trim().slice(0, 500);
      const closingDateTarget = body.closingDateTarget ? new Date(body.closingDateTarget) : null;
      const pofUrl = body.proofOfFundsUrl ? String(body.proofOfFundsUrl).trim().slice(0, 500) : null;
      if (!name || name.length < 2) return res.status(400).json({ message: "Name is required" });
      if (!offerAmount || Number.isNaN(offerAmount)) return res.status(400).json({ message: "Valid offer amount is required" });
      const inquiry = await storage.createBuyerInquiry({
        listingId: listing.id,
        opportunityId: listing.opportunityId,
        name,
        email: email || null,
        phone: phone || null,
        buyerType: "individual",
        message: terms || null,
        offerAmount: String(offerAmount),
        proofOfFundsUrl: pofUrl,
        status: "new",
        ip: req.ip || null,
        userAgent: String(req.headers["user-agent"] || ""),
      } as any);
      try {
        const property = await storage.getPropertyById(listing.opportunityId);
        const ownerId = (property as any)?.assignedTo;
        if (ownerId) {
          await storage.createUserNotification?.({
            userId: ownerId,
            type: "buyer_offer",
            title: "New offer received!",
            message: `${inquiry.name} submitted an offer of $${Number(offerAmount).toLocaleString()}`,
            linkUrl: `/opportunities/${listing.opportunityId}/inquiry/${inquiry.id}`,
            metadata: JSON.stringify({ inquiryId: inquiry.id, offerAmount: String(offerAmount), listingId: listing.id }),
          } as any);
        }
      } catch {}
      res.status(201).json({ inquiryId: inquiry.id, message: "Offer submitted successfully" });
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });
  // Public listing view route (serves the React app with token in context)
  reg("get", "/api/public/listings/:token/view"); app.get("/api/public/listings/:token/view", async (req, res) => {
    const token = String(req.params.token || "").trim();
    if (!token) return res.status(404).json({ message: "Not found" });
    const listing = await storage.getPublicListingByToken(token);
    if (!listing) return res.status(404).json({ message: "Not found" });
    if (listing.status !== "published") return res.status(404).json({ message: "Not found" });
    res.json({ listingId: listing.id, slug: listing.slug });
  });
  // TICKET-09: Background job queue API.
  reg("get", "/api/jobs"); app.get("/api/jobs", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    try {
      const { listJobs } = await import("./jobs/queue.js");
      const result = await listJobs({
        status: typeof req.query.status === "string" ? req.query.status : undefined,
        type: typeof req.query.type === "string" ? req.query.type : undefined,
        limit: typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : undefined,
        offset: typeof req.query.offset === "string" ? parseInt(req.query.offset, 10) : undefined,
      });
      return res.json(result);
    } catch (e: any) {
      return res.status(500).json({ message: e?.message || "Failed to list jobs" });
    }
  });
  reg("get", "/api/jobs/health"); app.get("/api/jobs/health", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    try {
      const { getJobCounts, getQueueVitals, getRepeatedFailureCount } = await import("./jobs/queue.js");
      const [counts, vitals, repeatedFailures] = await Promise.all([
        getJobCounts(),
        getQueueVitals(),
        getRepeatedFailureCount(),
      ]);
      const backlogThresholdMs = 15 * 60 * 1000;
      const alerts: Array<{ kind: string; message: string }> = [];
      if (vitals.lastSuccessAt == null && (counts.succeeded > 0 || counts.failed > 0 || counts.dead_lettered > 0)) {
        alerts.push({ kind: "worker_stopped", message: "No successful job completion recorded — the worker may be stopped." });
      }
      if (vitals.oldestQueuedAgeMs != null && vitals.oldestQueuedAgeMs > backlogThresholdMs) {
        alerts.push({ kind: "backlog", message: `Oldest queued job is waiting ${Math.round(vitals.oldestQueuedAgeMs / 60000)} minutes — backlog building up.` });
      }
      if (repeatedFailures > 0) {
        alerts.push({ kind: "repeated_failures", message: `${repeatedFailures} job(s) failed 3+ times in the last 24 hours.` });
      }
      if (counts.dead_lettered > 0) {
        alerts.push({ kind: "dead_letter", message: `${counts.dead_lettered} job(s) in the dead-letter queue need attention.` });
      }
      return res.json({ counts, vitals, alerts });
    } catch (e: any) {
      return res.status(500).json({ message: e?.message || "Failed to load job health" });
    }
  });
  reg("get", "/api/jobs/dead-letters"); app.get("/api/jobs/dead-letters", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    try {
      const { listDeadLetters } = await import("./jobs/dead-letter.js");
      const result = await listDeadLetters(
        typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : 50,
        typeof req.query.offset === "string" ? parseInt(req.query.offset, 10) : 0,
      );
      return res.json(result);
    } catch (e: any) {
      return res.status(500).json({ message: e?.message || "Failed to list dead letters" });
    }
  });
  reg("post", "/api/jobs"); app.post("/api/jobs", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    try {
      const { enqueueJob } = await import("./jobs/queue.js");
      const job = await enqueueJob({
        type: String(req.body?.type || ""),
        payload: (req.body?.payload as Record<string, unknown>) || {},
        priority: typeof req.body?.priority === "number" ? req.body.priority : 0,
        scheduledAt: req.body?.scheduledAt ? new Date(String(req.body.scheduledAt)) : undefined,
        maxAttempts: typeof req.body?.maxAttempts === "number" ? req.body.maxAttempts : 5,
        idempotencyKey: typeof req.body?.idempotencyKey === "string" ? req.body.idempotencyKey : undefined,
      });
      return res.status(201).json({ job });
    } catch (e: any) {
      return res.status(400).json({ message: e?.message || "Failed to enqueue job" });
    }
  });
  reg("post", "/api/jobs/:id/retry"); app.post("/api/jobs/:id/retry", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    try {
      const { retryJob } = await import("./jobs/queue.js");
      const job = await retryJob(parseInt(String(req.params.id), 10));
      return res.json({ job });
    } catch (e: any) {
      return res.status(400).json({ message: e?.message || "Failed to retry job" });
    }
  });
  reg("post", "/api/jobs/:id/cancel"); app.post("/api/jobs/:id/cancel", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    try {
      const { cancelJob } = await import("./jobs/queue.js");
      const job = await cancelJob(parseInt(String(req.params.id), 10));
      return res.json({ job });
    } catch (e: any) {
      return res.status(400).json({ message: e?.message || "Failed to cancel job" });
    }
  });
  reg("post", "/api/jobs/dead-letters/:id/retry"); app.post("/api/jobs/dead-letters/:id/retry", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    try {
      const { retryDeadLetter } = await import("./jobs/dead-letter.js");
      const job = await retryDeadLetter(parseInt(String(req.params.id), 10));
      return res.json({ job });
    } catch (e: any) {
      return res.status(400).json({ message: e?.message || "Failed to retry dead-letter job" });
    }
  });
  reg("delete", "/api/jobs/dead-letters/:id"); app.delete("/api/jobs/dead-letters/:id", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    try {
      const { purgeDeadLetter } = await import("./jobs/dead-letter.js");
      await purgeDeadLetter(parseInt(String(req.params.id), 10));
      return res.json({ ok: true });
    } catch (e: any) {
      return res.status(400).json({ message: e?.message || "Failed to purge dead letter" });
    }
  });
  // ── Ticket 10: Business email delivery ──────────────────────────────
  // Provider readiness (no secrets exposed — config state only).
  reg("get", "/api/email/readiness"); app.get("/api/email/readiness", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    res.json(emailProviderReadiness());
  });

  // List sending identities for the current user (admins see all).
  reg("get", "/api/email/identities"); app.get("/api/email/identities", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    const admin = isAdminUser(user);
    const rows = await db.execute(sql`
      SELECT id, user_id, email, name, is_default, spf_pass, dkim_pass, dmarc_status, verified_at, created_at
      FROM email_identities
      ${admin ? sql`` : sql`WHERE user_id = ${user.id}`}
      ORDER BY is_default DESC, created_at ASC
    `);
    const items: any[] = (rows as any)?.rows ?? (rows as any) ?? [];
    res.json({ items });
  });

  // Add a sending identity (from-address) for the current user.
  reg("post", "/api/email/identities"); app.post("/api/email/identities", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    const email = String(req.body?.email || "").trim().toLowerCase();
    const name = String(req.body?.name || "").trim() || null;
    const isDefault = req.body?.is_default === true;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ message: "A valid email address is required." });
    }
    if (isDefault) {
      await db.execute(sql`UPDATE email_identities SET is_default = false WHERE user_id = ${user.id}`);
    }
    const rows = await db.execute(sql`
      INSERT INTO email_identities (user_id, email, name, is_default)
      VALUES (${user.id}, ${email}, ${name}, ${isDefault})
      ON CONFLICT (user_id, email) DO UPDATE SET name = EXCLUDED.name, is_default = EXCLUDED.is_default
      RETURNING id, user_id, email, name, is_default, spf_pass, dkim_pass, dmarc_status, verified_at, created_at
    `);
    const r: any = (rows as any)?.rows?.[0] ?? (rows as any)?.[0];
    res.status(201).json({ identity: r });
  });

  // Delete a sending identity.
  reg("delete", "/api/email/identities/:id"); app.delete("/api/email/identities/:id", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ message: "Invalid identity id." });
    const admin = isAdminUser(user);
    await db.execute(sql`
      DELETE FROM email_identities WHERE id = ${id} ${admin ? sql`` : sql`AND user_id = ${user.id}`}
    `);
    res.json({ ok: true });
  });

  // Send an email (suppression-checked, idempotent, dev-guarded).
  reg("post", "/api/email/send"); app.post("/api/email/send", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    const outcome = await sendCrmEmail({
      to: String(req.body?.to || ""),
      subject: String(req.body?.subject || ""),
      text: req.body?.text ?? null,
      html: req.body?.html ?? null,
      from: req.body?.from ?? null,
      leadId: req.body?.leadId != null ? Number(req.body.leadId) : null,
      userId: user.id,
      idempotencyKey: req.body?.idempotencyKey ?? null,
    });
    if (!outcome.ok) return res.status(422).json({ ok: false, code: outcome.code, message: outcome.message, outboxId: outcome.outboxId });
    res.json({ ok: true, outboxId: outcome.outboxId, replayed: outcome.replayed, provider: outcome.provider, providerMessageId: outcome.providerMessageId });
  });

  // Delivery event webhook (idempotent; secret-protected when configured).
  reg("post", "/api/email/webhook"); app.post("/api/email/webhook", async (req, res) => {
    if (!verifyWebhookSecret(req)) return res.status(401).json({ message: "Invalid webhook secret." });
    try {
      const result = await ingestWebhookBatch(req.body);
      res.json({ ok: true, ...result });
    } catch (e: any) {
      res.status(500).json({ ok: false, message: String(e?.message || "Webhook processing failed") });
    }
  });

  // Suppression list (admin only for writes; reads for authenticated users).
  reg("get", "/api/email/suppressions"); app.get("/api/email/suppressions", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    const limit = parseInt(String(req.query?.limit || "100"), 10);
    const offset = parseInt(String(req.query?.offset || "0"), 10);
    res.json(await listSuppressions(limit, offset));
  });
  reg("post", "/api/email/suppressions"); app.post("/api/email/suppressions", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    if (!isAdminUser(user)) return res.status(403).json({ message: "Forbidden" });
    const email = String(req.body?.email || "").trim();
    const reason = String(req.body?.reason || "optout");
    if (!["bounce", "complaint", "optout"].includes(reason)) return res.status(400).json({ message: "Invalid reason." });
    res.status(201).json({ suppression: await addSuppression(email, reason as any) });
  });
  reg("delete", "/api/email/suppressions"); app.delete("/api/email/suppressions", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    if (!isAdminUser(user)) return res.status(403).json({ message: "Forbidden" });
    const email = String(req.query?.email || req.body?.email || "").trim();
    res.json({ removed: await removeSuppression(email) });
  });

  // Delivery stats for the Settings → Email dashboard.
  reg("get", "/api/email/stats"); app.get("/api/email/stats", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    const { emailDeliveryStats } = await import("./email/sender.js");
    res.json(await emailDeliveryStats());
  });

  // ------------------------------------------------------------------
  // Business email auto-provisioning + onboarding checklist
  // ------------------------------------------------------------------
  // Forward workflow info. IONOS has no email API — forwards are created
  // manually in the IONOS Control Panel and tracked here. This endpoint
  // describes the workflow (no secrets involved).
  reg("get", "/api/onboarding/forward-info"); app.get("/api/onboarding/forward-info", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    const { IONOS_FORWARD_STEPS, BUSINESS_DOMAIN } = await import("./email-provisioning/forwards.js");
    res.json({
      workflow: "manual",
      domain: BUSINESS_DOMAIN,
      steps: IONOS_FORWARD_STEPS,
      note: "IONOS has no email API. Create each forward in the IONOS Control Panel (Email → new address → Forward), then mark it active here.",
    });
  });

  // Cross-system email dedup check. Used by both the CRM and the
  // onboarding site before requesting a forward: "does this person
  // already have an @oceanluxe.org address?" Checks the email_forwards
  // table and the legacy provisioned_emails table (by address and by
  // name). Never creates anything — read-only.
  //
  // Body: { email?: string, firstName?: string, lastName?: string }
  // Response: { exists, email, source: "forwards"|"legacy"|null, checked: [...] }
  reg("post", "/api/onboarding/check-email"); app.post("/api/onboarding/check-email", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    if (!isManagerUser(user)) return res.status(403).json({ message: "Forbidden" });
    const email = String(req.body?.email || "").trim().toLowerCase();
    const firstName = String(req.body?.firstName || "").trim();
    const lastName = String(req.body?.lastName || "").trim();
    if (!email && !(firstName && lastName)) {
      return res.status(400).json({ message: "Provide email, or firstName + lastName." });
    }
    const { candidateForwardAddresses } = await import("./email-provisioning/forwards.js");
    const store = await import("./email-provisioning/store.js");

    const checkOne = async (addr: string) => {
      const fwd = await store.getForwardByAddress(addr);
      if (fwd) return { exists: true, email: fwd.forward_address, source: "forwards" };
      const leg = await store.getProvisionByEmail(addr);
      if (leg) return { exists: true, email: leg.email_address, source: "legacy" };
      return null;
    };

    // 1. Direct address lookup.
    if (email) {
      const hit = await checkOne(email);
      if (hit) return res.json({ ...hit, checked: ["forwards", "legacy"] });
    }

    // 2. Name-based lookup: legacy table first, then probe candidate
    //    addresses (base, base-2, ...) in both tables.
    if (firstName && lastName) {
      try {
        const byName = await store.findProvisionByName(firstName, lastName);
        if (byName) {
          return res.json({
            exists: true,
            email: byName.email_address,
            source: "legacy",
            matchedUserId: byName.matched_user_id,
            checked: ["forwards", "legacy"],
          });
        }
      } catch {
        // Name lookup is best-effort — fall through to candidate probing.
      }
      for (const candidate of candidateForwardAddresses(firstName, lastName)) {
        const hit = await checkOne(candidate);
        if (hit) return res.json({ ...hit, checked: ["forwards", "legacy"] });
      }
    }

    return res.json({ exists: false, email: null, source: null, checked: ["forwards", "legacy"] });
  });

  // Request an email forward for a user (manager/admin only).
  // Generates a unique firstname.lastname@oceanluxe.org address and records
  // the request. A manager then creates the forward manually in the IONOS
  // Control Panel and marks it active. Idempotent per user.
  reg("post", "/api/onboarding/request-forward"); app.post("/api/onboarding/request-forward", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    if (!isManagerUser(user)) return res.status(403).json({ message: "Forbidden" });
    const targetUserId = Number(req.body?.userId);
    if (!targetUserId) return res.status(400).json({ message: "userId is required" });
    const target = await storage.getUserById(targetUserId);
    if (!target) return res.status(404).json({ message: "User not found" });
    const targetEmail = String(req.body?.targetEmail || (target as any).email || "").trim().toLowerCase();
    if (!targetEmail) return res.status(400).json({ message: "targetEmail is required (the personal email the forward should target)." });
    const { requestEmailForward } = await import("./email-provisioning/provisioner.js");
    const store = await import("./email-provisioning/store.js");
    const outcome = await requestEmailForward(
      {
        userId: targetUserId,
        firstName: String((target as any).firstName || (target as any).first_name || ""),
        lastName: String((target as any).lastName || (target as any).last_name || ""),
        targetEmail,
        source: "manual",
      },
      {
        addressTaken: store.forwardAddressTaken,
        getForwardByUser: store.getForwardByUser,
        getForwardByAddress: store.getForwardByAddress,
        createForwardRequest: (row) =>
          store.createForwardRequest({ ...row, requestedBy: Number((user as any).id) }),
        markChecklistEmailProvisioned: store.markChecklistEmailProvisioned,
      }
    );
    if (!outcome.ok) {
      return res.status(outcome.code === "INVALID_INPUT" ? 400 : 500).json({
        ok: false, code: outcome.code, message: outcome.message,
      });
    }
    res.json({ ok: true, forwardId: outcome.forwardId, address: outcome.address, alreadyExisted: outcome.alreadyExisted });
  });

  // Forward status for a user.
  reg("get", "/api/onboarding/forward/status/:userId"); app.get("/api/onboarding/forward/status/:userId", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    const targetUserId = Number(req.params.userId);
    if (!isSameUserOrAdmin(user, targetUserId)) return res.status(403).json({ message: "Forbidden" });
    const store = await import("./email-provisioning/store.js");
    const forward = await store.getForwardByUser(targetUserId);
    res.json({ forward });
  });

  // All forwards (manager/admin only).
  reg("get", "/api/onboarding/forwards"); app.get("/api/onboarding/forwards", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    if (!isManagerUser(user)) return res.status(403).json({ message: "Forbidden" });
    const store = await import("./email-provisioning/store.js");
    const status = typeof req.query?.status === "string" ? req.query.status : undefined;
    res.json({ items: await store.listForwards(status) });
  });

  // Forward creation queue — forwards needing manual IONOS creation (manager/admin only).
  reg("get", "/api/onboarding/forward-queue"); app.get("/api/onboarding/forward-queue", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    if (!isManagerUser(user)) return res.status(403).json({ message: "Forbidden" });
    const store = await import("./email-provisioning/store.js");
    res.json({
      queue: await store.forwardCreationQueue(),
      needing: await store.usersNeedingForward(),
    });
  });

  // Mark a forward active — the manager created it in the IONOS panel.
  // Flips the onboarding checklist's email_provisioned flag.
  reg("post", "/api/onboarding/forwards/:id/mark-active"); app.post("/api/onboarding/forwards/:id/mark-active", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    if (!isManagerUser(user)) return res.status(403).json({ message: "Forbidden" });
    const id = Number(req.params.id);
    const notes = typeof req.body?.notes === "string" ? req.body.notes.slice(0, 500) : null;
    const store = await import("./email-provisioning/store.js");
    const row = await store.markForwardActive(id, Number((user as any).id), notes);
    if (!row) return res.status(404).json({ message: "Forward not found or not in a markable state." });
    res.json({ ok: true, forward: row });
  });

  // Mark a forward pending_creation — manager acknowledged the request.
  reg("post", "/api/onboarding/forwards/:id/mark-pending"); app.post("/api/onboarding/forwards/:id/mark-pending", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    if (!isManagerUser(user)) return res.status(403).json({ message: "Forbidden" });
    const id = Number(req.params.id);
    const store = await import("./email-provisioning/store.js");
    const row = await store.markForwardPendingCreation(id);
    if (!row) return res.status(404).json({ message: "Forward not found or not in requested state." });
    res.json({ ok: true, forward: row });
  });

  // Mark a forward failed with a reason (manager/admin only).
  reg("post", "/api/onboarding/forwards/:id/mark-failed"); app.post("/api/onboarding/forwards/:id/mark-failed", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    if (!isManagerUser(user)) return res.status(403).json({ message: "Forbidden" });
    const id = Number(req.params.id);
    const reason = String(req.body?.reason || "").trim().slice(0, 500) || "No reason given";
    const store = await import("./email-provisioning/store.js");
    const row = await store.markForwardFailed(id, reason);
    if (!row) return res.status(404).json({ message: "Forward not found." });
    res.json({ ok: true, forward: row });
  });

  // Legacy: provisioned emails list (mailbox-era records, kept for dedup reference).
  reg("get", "/api/onboarding/provisioned-emails"); app.get("/api/onboarding/provisioned-emails", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    if (!isManagerUser(user)) return res.status(403).json({ message: "Forbidden" });
    const store = await import("./email-provisioning/store.js");
    const status = typeof req.query?.status === "string" ? req.query.status : undefined;
    res.json({ items: await store.listProvisions(status) });
  });

  // Get onboarding checklist for a user.
  reg("get", "/api/onboarding/checklist/:userId"); app.get("/api/onboarding/checklist/:userId", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    const targetUserId = Number(req.params.userId);
    if (!isSameUserOrAdmin(user, targetUserId)) return res.status(403).json({ message: "Forbidden" });
    const store = await import("./email-provisioning/store.js");
    const checklist = await store.ensureChecklist(targetUserId);
    const { checklistComplete } = await import("./email-provisioning/provisioner.js");
    const { complete, missing } = checklistComplete(checklist as any);
    res.json({ checklist, complete, missing });
  });

  // Update a checklist item (manager/admin only).
  reg("put", "/api/onboarding/checklist/:userId"); app.put("/api/onboarding/checklist/:userId", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    if (!isManagerUser(user)) return res.status(403).json({ message: "Forbidden" });
    const targetUserId = Number(req.params.userId);
    const item = String(req.body?.item || "");
    const value = Boolean(req.body?.value);
    const store = await import("./email-provisioning/store.js");
    const updated = await store.updateChecklistItem(targetUserId, item, value);
    if (!updated) return res.status(400).json({ message: "Invalid checklist item." });
    res.json({ checklist: updated });
  });

  // Grant live-lead access — only when every checklist item is complete.
  reg("post", "/api/onboarding/grant-lead-access/:userId"); app.post("/api/onboarding/grant-lead-access/:userId", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    if (!isManagerUser(user)) return res.status(403).json({ message: "Forbidden" });
    const targetUserId = Number(req.params.userId);
    const store = await import("./email-provisioning/store.js");
    const result = await store.grantLiveLeadAccess(targetUserId, Number((user as any).id));
    if (!result.ok) {
      return res.status(422).json({
        ok: false,
        message: `Cannot grant live-lead access — ${result.missing!.length} checklist item(s) incomplete.`,
        missing: result.missing,
      });
    }
    res.json({ ok: true });
  });

  // Revoke live-lead access (manager/admin only).
  reg("post", "/api/onboarding/revoke-lead-access/:userId"); app.post("/api/onboarding/revoke-lead-access/:userId", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    if (!isManagerUser(user)) return res.status(403).json({ message: "Forbidden" });
    const targetUserId = Number(req.params.userId);
    const store = await import("./email-provisioning/store.js");
    await store.revokeLiveLeadAccess(targetUserId);
    res.json({ ok: true });
  });
  // ------------------------------------------------------------------
  // Onboarding documents: Offer Letter, ICA, W-9
  // ------------------------------------------------------------------
  // List available templates (offer letter + ICA from contract_templates; W-9 is a form).
  reg("get", "/api/onboarding/docs/templates"); app.get("/api/onboarding/docs/templates", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    try {
      const t = await import("./onboarding-docs/templates.js");
      const [offerLetter, ica] = await Promise.all([
        t.getOnboardingTemplate("offer_letter"),
        t.getOnboardingTemplate("ica"),
      ]);
      res.json({
        templates: [
          { docType: "offer_letter", label: t.DOC_LABELS.offer_letter, sender: "company", signer: "agent", template: offerLetter },
          { docType: "ica", label: t.DOC_LABELS.ica, sender: "company", signer: "agent", template: ica },
          { docType: "w9", label: t.DOC_LABELS.w9, sender: "agent", signer: "agent", template: null, formFields: t.W9_FIELDS },
        ],
      });
    } catch (e: any) { res.status(500).json({ message: e?.message || "Failed to load templates" }); }
  });

  // Send a document to an agent (manager/admin). Offer letter + ICA render from template.
  reg("post", "/api/onboarding/docs/send/:userId"); app.post("/api/onboarding/docs/send/:userId", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    if (!isManagerUser(user)) return res.status(403).json({ message: "Forbidden" });
    try {
      const targetUserId = Number(req.params.userId);
      const { docType, mergeData } = req.body as { docType: string; mergeData?: Record<string, any> };
      if (!["offer_letter", "ica"].includes(docType)) {
        return res.status(400).json({ message: "docType must be offer_letter or ica (W-9 is agent-filled)" });
      }
      const target = await storage.getUserById(targetUserId);
      if (!target) return res.status(404).json({ message: "User not found" });
      const t = await import("./onboarding-docs/templates.js");
      const store = await import("./onboarding-docs/store.js");
      // Idempotency: don't double-send an active document.
      const existing = await store.getActiveDocument(targetUserId, docType as any);
      if (existing) return res.status(409).json({ message: "An active document of this type already exists", document: existing });
      const template = await t.getOnboardingTemplate(docType as "offer_letter" | "ica");
      if (!template) return res.status(404).json({ message: "Template not found — run migration 0092" });
      const body = await t.getTemplateBody(template.id);
      const { mergeTemplate } = await import("./services/esign/merge.js");
      const defaults = t.defaultMergeData(
        docType as "offer_letter" | "ica",
        { firstName: (target as any).firstName || "", lastName: (target as any).lastName || "", email: (target as any).email || "", phone: (target as any).phone },
        { name: `${(user as any).firstName || ""} ${(user as any).lastName || ""}`.trim() || "OceanLuxe", title: (user as any).role || "Manager" },
      );
      const merged = mergeTemplate(String(body || ""), { ...defaults, ...(mergeData || {}) });
      const doc = await store.createDocument({
        userId: targetUserId,
        docType: docType as any,
        templateId: template.id,
        templateVersion: template.version,
        mergeData: { ...defaults, ...(mergeData || {}) },
        renderedBody: merged,
        sentBy: (user as any).id,
      });
      res.json({ ok: true, document: doc });
    } catch (e: any) { res.status(500).json({ message: e?.message || "Failed to send document" }); }
  });

  // List documents for a user (agent sees own; managers see anyone's).
  reg("get", "/api/onboarding/docs/:userId"); app.get("/api/onboarding/docs/:userId", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    const targetUserId = Number(req.params.userId);
    if (targetUserId !== (user as any).id && !isManagerUser(user)) return res.status(403).json({ message: "Forbidden" });
    try {
      const store = await import("./onboarding-docs/store.js");
      const docs = await store.listDocumentsForUser(targetUserId);
      // Never expose full TIN to non-managers; mask for the agent view too after submit.
      const safe = docs.map((d: any) => {
        if (d.doc_type === "w9" && d.form_data?.tin && !isManagerUser(user)) {
          return { ...d, form_data: { ...d.form_data, tin: "***-**-" + String(d.form_data.tin).slice(-4) } };
        }
        return d;
      });
      res.json({ documents: safe });
    } catch (e: any) { res.status(500).json({ message: e?.message || "Failed to list documents" }); }
  });

  // Agent: get a single document to view/sign (marks viewed).
  reg("get", "/api/onboarding/docs/view/:docId"); app.get("/api/onboarding/docs/view/:docId", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    try {
      const store = await import("./onboarding-docs/store.js");
      const doc = await store.getDocument(Number(req.params.docId));
      if (!doc) return res.status(404).json({ message: "Not found" });
      if (doc.user_id !== (user as any).id && !isManagerUser(user)) return res.status(403).json({ message: "Forbidden" });
      if (doc.user_id === (user as any).id && ["sent", "viewed"].includes(doc.status)) {
        await store.markViewed(doc.id);
        doc.status = "viewed" as any;
      }
      res.json({ document: doc });
    } catch (e: any) { res.status(500).json({ message: e?.message || "Failed to load document" }); }
  });

  // Agent: sign a document (offer letter / ICA) or submit W-9.
  reg("post", "/api/onboarding/docs/:docId/sign"); app.post("/api/onboarding/docs/:docId/sign", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    try {
      const store = await import("./onboarding-docs/store.js");
      const t = await import("./onboarding-docs/templates.js");
      const doc = await store.getDocument(Number(req.params.docId));
      if (!doc) return res.status(404).json({ message: "Not found" });
      if (doc.user_id !== (user as any).id) return res.status(403).json({ message: "Only the assigned agent can sign" });
      if (!["sent", "viewed"].includes(doc.status)) return res.status(409).json({ message: `Document is ${doc.status}, cannot sign` });
      const { signatureType, signatureData, formData } = req.body as { signatureType: string; signatureData: string; formData?: Record<string, any> };
      if (!["typed", "drawn", "uploaded"].includes(signatureType)) return res.status(400).json({ message: "signatureType must be typed, drawn, or uploaded" });
      if (!signatureData || String(signatureData).trim().length < 2) return res.status(400).json({ message: "Signature is required" });
      if (doc.doc_type === "w9") {
        const v = t.validateW9FormData(formData || {});
        if (!v.ok) return res.status(422).json({ message: "W-9 is incomplete", missing: v.missing });
        if (v && (formData as any)?.certification !== true) return res.status(422).json({ message: "You must certify under penalties of perjury" });
      }
      const signed = await store.markSigned({
        id: doc.id,
        signatureType: signatureType as any,
        signatureData: String(signatureData).slice(0, 20000),
        formData: doc.doc_type === "w9" ? formData : undefined,
        ip: (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || (req as any).ip || null,
        userAgent: req.headers["user-agent"] || null,
      });
      res.json({ ok: true, document: signed });
    } catch (e: any) { res.status(500).json({ message: e?.message || "Failed to sign document" }); }
  });

  // Manager: mark a signed document as completed (updates checklist automatically).
  reg("post", "/api/onboarding/docs/:docId/complete"); app.post("/api/onboarding/docs/:docId/complete", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    if (!isManagerUser(user)) return res.status(403).json({ message: "Forbidden" });
    try {
      const store = await import("./onboarding-docs/store.js");
      const doc = await store.getDocument(Number(req.params.docId));
      if (!doc) return res.status(404).json({ message: "Not found" });
      if (doc.status !== "signed") return res.status(409).json({ message: `Document is ${doc.status}; must be signed first` });
      const completed = await store.markCompleted(doc.id, (user as any).id);
      res.json({ ok: true, document: completed });
    } catch (e: any) { res.status(500).json({ message: e?.message || "Failed to complete document" }); }
  });

  // Agent: pending documents needing action (for the dashboard banner).
  reg("get", "/api/onboarding/docs/pending/mine"); app.get("/api/onboarding/docs/pending/mine", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    try {
      const store = await import("./onboarding-docs/store.js");
      const docs = await store.getPendingForUser((user as any).id);
      res.json({ pending: docs.map((d: any) => ({ id: d.id, doc_type: d.doc_type, status: d.status, sent_at: d.sent_at })) });
    } catch (e: any) { res.status(500).json({ message: e?.message || "Failed to load pending documents" }); }
  });
  // ------------------------------------------------------------------
  // Ticket 12 — Lead assignment & routing rules
  // ------------------------------------------------------------------
  reg("get", "/api/assignment/rules"); app.get("/api/assignment/rules", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    try {
      const { assignmentRules } = await import("./shared-schema.js");
      const { asc } = await import("drizzle-orm");
      const rows = await db.select().from(assignmentRules)
        .orderBy(asc(assignmentRules.priorityOrder), asc(assignmentRules.id));
      res.json({ rules: rows });
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  reg("post", "/api/assignment/rules"); app.post("/api/assignment/rules", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    if (!isManagerUser(user)) return res.status(403).json({ message: "Managers only" });
    try {
      const { assignmentRules } = await import("./shared-schema.js");
      const { validateRuleConfig, ASSIGNMENT_RULE_TYPES } = await import("./assignment/rules.js");
      const { name, ruleType, config, priorityOrder } = req.body || {};
      if (!name || !ruleType) return res.status(400).json({ message: "name and ruleType are required" });
      if (!ASSIGNMENT_RULE_TYPES.includes(ruleType)) {
        return res.status(400).json({ message: `Invalid ruleType. Must be one of: ${ASSIGNMENT_RULE_TYPES.join(", ")}` });
      }
      const v = validateRuleConfig(ruleType, config || {});
      if (!v.ok) return res.status(400).json({ message: v.error });
      const [row] = await db.insert(assignmentRules).values({
        name: String(name).slice(0, 255),
        ruleType,
        config: config || {},
        priorityOrder: Number.isInteger(priorityOrder) ? priorityOrder : 0,
        createdBy: user.id,
      }).returning();
      res.status(201).json({ rule: row });
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  reg("put", "/api/assignment/rules/:id"); app.put("/api/assignment/rules/:id", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    if (!isManagerUser(user)) return res.status(403).json({ message: "Managers only" });
    try {
      const { assignmentRules } = await import("./shared-schema.js");
      const { validateRuleConfig, ASSIGNMENT_RULE_TYPES } = await import("./assignment/rules.js");
      const { eq, sql } = await import("drizzle-orm");
      const id = Number(req.params.id);
      const { name, ruleType, config, priorityOrder, isActive } = req.body || {};
      const existing = await db.select().from(assignmentRules).where(eq(assignmentRules.id, id)).limit(1);
      if (!existing.length) return res.status(404).json({ message: "Rule not found" });
      const nextType = ruleType || existing[0].ruleType;
      if (!ASSIGNMENT_RULE_TYPES.includes(nextType)) {
        return res.status(400).json({ message: `Invalid ruleType. Must be one of: ${ASSIGNMENT_RULE_TYPES.join(", ")}` });
      }
      const v = validateRuleConfig(nextType, config !== undefined ? config : existing[0].config);
      if (!v.ok) return res.status(400).json({ message: v.error });
      const [row] = await db.update(assignmentRules).set({
        name: name !== undefined ? String(name).slice(0, 255) : existing[0].name,
        ruleType: nextType,
        config: config !== undefined ? config : existing[0].config,
        priorityOrder: Number.isInteger(priorityOrder) ? priorityOrder : existing[0].priorityOrder,
        isActive: typeof isActive === "boolean" ? isActive : existing[0].isActive,
        // Versioned: every edit bumps the version so audits can pin which version fired.
        version: sql`${assignmentRules.version} + 1`,
        updatedAt: new Date(),
      }).where(eq(assignmentRules.id, id)).returning();
      res.json({ rule: row });
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  reg("delete", "/api/assignment/rules/:id"); app.delete("/api/assignment/rules/:id", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    if (!isManagerUser(user)) return res.status(403).json({ message: "Managers only" });
    try {
      const { assignmentRules } = await import("./shared-schema.js");
      const { eq } = await import("drizzle-orm");
      const id = Number(req.params.id);
      await db.delete(assignmentRules).where(eq(assignmentRules.id, id));
      res.json({ ok: true });
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  // Manual assignment — always logged, history preserved on reassign.
  reg("post", "/api/leads/:id/assign"); app.post("/api/leads/:id/assign", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    try {
      const { leads, users, userCapacity, assignmentLog } = await import("./shared-schema.js");
      const { eq } = await import("drizzle-orm");
      const leadId = Number(req.params.id);
      const { userId, reason } = req.body || {};
      if (!Number.isInteger(userId) || userId <= 0) {
        return res.status(400).json({ message: "userId is required" });
      }
      const leadRows = await db.select().from(leads).where(eq(leads.id, leadId)).limit(1);
      if (!leadRows.length) return res.status(404).json({ message: "Lead not found" });
      const target = await db.select().from(users).where(eq(users.id, userId)).limit(1);
      if (!target.length || !target[0].isActive) {
        return res.status(400).json({ message: "Cannot assign to an inactive or missing user" });
      }
      await db.update(leads).set({ assignedTo: userId }).where(eq(leads.id, leadId));
      await db.insert(assignmentLog).values({
        leadId,
        assignedToUserId: userId,
        ruleId: null,
        ruleName: "manual",
        reason: `Manual assignment by ${user.email}${reason ? `: ${String(reason).slice(0, 500)}` : ""}`,
        assignedBy: user.id,
      });
      res.json({ ok: true, leadId, assignedTo: userId });
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  // Unassign (kept in history as an assignment_log row with null user).
  reg("post", "/api/leads/:id/unassign"); app.post("/api/leads/:id/unassign", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    try {
      const { leads, assignmentLog } = await import("./shared-schema.js");
      const { eq } = await import("drizzle-orm");
      const leadId = Number(req.params.id);
      const { reason } = req.body || {};
      await db.update(leads).set({ assignedTo: null }).where(eq(leads.id, leadId));
      await db.insert(assignmentLog).values({
        leadId,
        assignedToUserId: null,
        ruleId: null,
        ruleName: "manual-unassign",
        reason: `Unassigned by ${user.email}${reason ? `: ${String(reason).slice(0, 500)}` : ""}`,
        assignedBy: user.id,
      });
      res.json({ ok: true, leadId, assignedTo: null });
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  reg("get", "/api/leads/:id/assignment-history"); app.get("/api/leads/:id/assignment-history", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    try {
      const { assignmentLog } = await import("./shared-schema.js");
      const { eq, desc } = await import("drizzle-orm");
      const leadId = Number(req.params.id);
      const rows = await db.select().from(assignmentLog)
        .where(eq(assignmentLog.leadId, leadId))
        .orderBy(desc(assignmentLog.assignedAt))
        .limit(50);
      res.json({ history: rows });
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  // Dry-run: which rule WOULD fire for a lead, without persisting.
  reg("post", "/api/assignment/dry-run"); app.post("/api/assignment/dry-run", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    try {
      const { leads } = await import("./shared-schema.js");
      const { eq } = await import("drizzle-orm");
      const { evaluateAssignment } = await import("./assignment/engine.js");
      const leadId = Number(req.body?.leadId);
      if (!leadId) return res.status(400).json({ message: "leadId is required" });
      const rows = await db.select({ id: leads.id, state: leads.state, assignedTo: leads.assignedTo })
        .from(leads).where(eq(leads.id, leadId)).limit(1);
      if (!rows.length) return res.status(404).json({ message: "Lead not found" });
      const decision = await evaluateAssignment({ id: rows[0].id, state: rows[0].state, assignedTo: rows[0].assignedTo });
      // Resolve winner email for display.
      let winnerEmail: string | null = null;
      if (decision.assignedToUserId) {
        const { users } = await import("./shared-schema.js");
        const u = await db.select({ email: users.email }).from(users)
          .where(eq(users.id, decision.assignedToUserId)).limit(1);
        winnerEmail = u[0]?.email || null;
      }
      res.json({ leadId, decision: { ...decision, winnerEmail }, persisted: false });
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  // Auto-assign: run the engine over unassigned leads.
  reg("post", "/api/assignment/auto-assign"); app.post("/api/assignment/auto-assign", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    if (!isManagerUser(user)) return res.status(403).json({ message: "Managers only" });
    try {
      const { evaluateAssignment, persistAssignment, getUnassignedLeads } = await import("./assignment/engine.js");
      const limit = Math.min(Math.max(Number(req.body?.limit) || 100, 1), 1000);
      const unassigned = await getUnassignedLeads(limit);
      let assigned = 0;
      let skipped = 0;
      const results: Array<{ leadId: number; assignedTo: number | null; ruleName: string | null }> = [];
      for (const lead of unassigned) {
        const decision = await evaluateAssignment(lead);
        if (decision.assignedToUserId != null) {
          await persistAssignment(lead.id, decision, null);
          assigned++;
        } else {
          skipped++;
        }
        results.push({ leadId: lead.id, assignedTo: decision.assignedToUserId, ruleName: decision.ruleName });
      }
      res.json({ ok: true, scanned: unassigned.length, assigned, skipped, results: results.slice(0, 100) });
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  // Unassigned leads + alert count for the dashboard/settings panel.
  reg("get", "/api/assignment/unassigned"); app.get("/api/assignment/unassigned", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    try {
      const { leads } = await import("./shared-schema.js");
      const { eq, isNull, and, sql, asc } = await import("drizzle-orm");
      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
      const rows = await db.select({
        id: leads.id, address: leads.address, city: leads.city, state: leads.state,
        ownerName: leads.ownerName, status: leads.status, createdAt: leads.createdAt,
      }).from(leads)
        .where(and(isNull(leads.assignedTo), isNull(leads.archivedAt)))
        .orderBy(asc(leads.id))
        .limit(limit);
      const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(leads)
        .where(and(isNull(leads.assignedTo), isNull(leads.archivedAt)));
      res.json({ count: Number(count) || 0, leads: rows });
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  // Per-agent capacity / availability / markets.
  reg("get", "/api/assignment/capacity"); app.get("/api/assignment/capacity", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    if (!isManagerUser(user)) return res.status(403).json({ message: "Managers only" });
    try {
      const { users, userCapacity, leads } = await import("./shared-schema.js");
      const { eq, sql } = await import("drizzle-orm");
      const agents = await db.select({
        id: users.id, email: users.email, firstName: users.firstName,
        lastName: users.lastName, isActive: users.isActive, role: users.role,
      }).from(users).where(eq(users.isActive, true));
      const caps = await db.select().from(userCapacity);
      const capByUser = new Map(caps.map((c) => [c.userId, c]));
      const counts = await db.select({
        userId: leads.assignedTo, count: sql<number>`count(*)::int`,
      }).from(leads)
        .where(sql`${leads.assignedTo} IS NOT NULL AND ${leads.archivedAt} IS NULL`)
        .groupBy(leads.assignedTo);
      const countByUser = new Map<number, number>();
      for (const r of counts) if (r.userId != null) countByUser.set(r.userId, Number(r.count) || 0);
      res.json({
        agents: agents.map((a) => {
          const cap = capByUser.get(a.id);
          return {
            ...a,
            maxLeads: cap?.maxLeads ?? 50,
            isAvailable: cap?.isAvailable ?? true,
            markets: cap?.markets ?? [],
            currentLeads: countByUser.get(a.id) ?? 0,
          };
        }),
      });
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  reg("put", "/api/assignment/capacity/:userId"); app.put("/api/assignment/capacity/:userId", async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    if (!isManagerUser(user)) return res.status(403).json({ message: "Managers only" });
    try {
      const { userCapacity } = await import("./shared-schema.js");
      const targetId = Number(req.params.userId);
      if (!targetId) return res.status(400).json({ message: "Invalid user id" });
      const { maxLeads, isAvailable, markets } = req.body || {};
      const values: Record<string, unknown> = { userId: targetId, updatedAt: new Date() };
      if (maxLeads !== undefined) {
        const m = Number(maxLeads);
        if (!Number.isInteger(m) || m < 0 || m > 10000) return res.status(400).json({ message: "maxLeads must be 0–10000" });
        values.maxLeads = m;
      }
      if (isAvailable !== undefined) {
        if (typeof isAvailable !== "boolean") return res.status(400).json({ message: "isAvailable must be boolean" });
        values.isAvailable = isAvailable;
      }
      if (markets !== undefined) {
        if (!Array.isArray(markets) || !markets.every((m) => typeof m === "string")) {
          return res.status(400).json({ message: "markets must be an array of state codes" });
        }
        values.markets = markets.map((m: string) => m.trim().toUpperCase()).filter(Boolean);
      }
      const { userId: _uid, ...setValues } = values;
      await db.insert(userCapacity).values(values as any)
        .onConflictDoUpdate({ target: userCapacity.userId, set: setValues as any });
      res.json({ ok: true });
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  await registerMediaRoutes(app, { requireAuth, requireActiveTeam });

  if (mode === "serverless") return null;
  const httpServer = createServer(app);
  initTelephonyWs(httpServer);
  return httpServer;
}
