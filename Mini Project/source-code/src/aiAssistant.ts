import { GoogleGenAI, Type, ThinkingLevel, GenerateContentResponse } from '@google/genai';
import {
  getCustomers,
  getCustomerById,
  getInteractions,
  getCustomerInteractions,
  getFollowups,
  getCustomerFollowups,
  getReportsData,
  getSettings
} from './models.js';

export type AssistantMode =
  | 'general'
  | 'insights'
  | 'message'
  | 'followups'
  | 'analytics'
  | 'history';

export type AssistantSpeed = 'standard' | 'fast';

export interface DraftMessage {
  channel: string;
  tone: string;
  subject: string;
  body: string;
}

export interface SuggestedFollowup {
  customerId: number;
  customerName: string;
  reason: string;
  followUpDate: string;
  priority: 'Low' | 'Medium' | 'High';
}

export interface ChatTurn {
  role: 'user' | 'model';
  text: string;
  mode?: AssistantMode;
  draftMessage?: DraftMessage | null;
  suggestedFollowups?: SuggestedFollowup[] | null;
  timestamp: string;
}

export interface AssistantReply {
  reply: string;
  modelUsed: string;
  draftMessage: DraftMessage | null;
  suggestedFollowups: SuggestedFollowup[];
}

export class AiServiceError extends Error {
  statusCode: number;

  constructor(message: string, statusCode = 500) {
    super(message);
    this.name = 'AiServiceError';
    this.statusCode = statusCode;
  }
}

function getClient(): GoogleGenAI {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) {
    throw new AiServiceError(
      'Gemini API key is not configured. Please select or add your API key in Settings > Secrets.',
      500
    );
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build'
      }
    }
  });
}

function todayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function daysBetween(olderIso: string, newerIso: string): number | null {
  if (!olderIso) return null;
  const a = new Date(`${olderIso}T00:00:00Z`).getTime();
  const b = new Date(`${newerIso}T00:00:00Z`).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / (1000 * 60 * 60 * 24));
}

function buildCrmContextSnapshot(focusedCustomerId?: number | null) {
  const today = todayIso();
  const settings = getSettings();
  const reports = getReportsData();
  const allCustomers = getCustomers();
  const allInteractions = getInteractions();
  const allFollowups = getFollowups();

  const interactionCounts = new Map<number, number>();
  for (const inter of allInteractions) {
    interactionCounts.set(inter.customer_id, (interactionCounts.get(inter.customer_id) || 0) + 1);
  }

  const pendingFollowupCounts = new Map<number, number>();
  for (const fu of allFollowups) {
    if (fu.status === 'Pending') {
      pendingFollowupCounts.set(fu.customer_id, (pendingFollowupCounts.get(fu.customer_id) || 0) + 1);
    }
  }

  const customersSummary = allCustomers.map(c => ({
    id: c.id,
    name: c.name,
    company: c.company || 'Direct Client',
    email: c.email,
    phone: c.phone,
    status: c.status,
    created_at: c.created_at,
    last_contact: c.last_contact,
    days_since_last_contact: daysBetween(c.last_contact, today),
    interaction_count: interactionCounts.get(c.id) || 0,
    pending_followups: pendingFollowupCounts.get(c.id) || 0,
    notes: c.notes
  }));

  const followupsSummary = allFollowups.map(f => ({
    id: f.id,
    customer_id: f.customer_id,
    customer_name: f.customer_name,
    reason: f.reason,
    follow_up_date: f.follow_up_date,
    priority: f.priority,
    status: f.status,
    is_overdue: f.status === 'Pending' && f.follow_up_date < today
  }));

  const recentInteractions = allInteractions.slice(0, 40).map(i => ({
    id: i.id,
    customer_id: i.customer_id,
    customer_name: i.customer_name,
    type: i.type,
    interaction_date: i.interaction_date,
    follow_up_date: i.follow_up_date,
    description: i.description
  }));

  let focusedCustomer: Record<string, unknown> | null = null;
  if (focusedCustomerId) {
    const cust = getCustomerById(focusedCustomerId);
    if (cust) {
      focusedCustomer = {
        customer: cust,
        days_since_last_contact: daysBetween(cust.last_contact, today),
        interactions: getCustomerInteractions(cust.id),
        followups: getCustomerFollowups(cust.id)
      };
    }
  }

  return {
    today,
    business_name: settings.business_name,
    currency: settings.currency,
    reports_summary: reports,
    customers: customersSummary,
    followups: followupsSummary,
    recent_interactions: recentInteractions,
    focused_customer: focusedCustomer
  };
}

function getRoleInstruction(mode: AssistantMode, tone?: string, channel?: string): string {
  const baseRoles: Record<AssistantMode, string> = {
    general:
      'You are the CRM AI Copilot. You assist admins and staff with Customer Insights, Follow-up Message Drafting, Smart Follow-up Prioritization, Business Analytics Summaries, and Customer History Briefings.',
    insights:
      'You are the Customer Insights Analyst. Highlight most active customers (by interaction count, Active status, and recent contact), surface inactive/neglected contacts by days_since_last_contact, and list customers with pending follow-ups.',
    message: `You are the Follow-up Message Generator. Draft crisp, ready-to-send customer communications (Email, WhatsApp, or query replies). Requested channel: ${channel || 'Email'}. Requested tone: ${tone || 'Friendly'}. Populate the structured draftMessage object with channel, tone, subject, and body whenever drafting a message.`,
    followups:
      'You are the Smart Follow-up Assistant. Identify overdue follow-ups (is_overdue=true), prioritize customers needing urgent attention, recommend specific next contact dates (YYYY-MM-DD on or after today), and populate suggestedFollowups ONLY with valid existing customerId and customerName pairs so an admin can review and approve creating those tasks.',
    analytics:
      'You are the Business Analytics Assistant. Answer metric questions accurately from reports_summary (active counts, status breakdown, interaction channels, this month interactions, completed vs pending follow-ups) and produce clear executive summaries.',
    history:
      'You are the Customer History Briefing Specialist. Summarize previous calls, emails, and meetings for the focused or mentioned customer, highlight the latest interaction, call out unresolved queries or pending follow-ups, and provide actionable pre-contact context.'
  };

  return [
    baseRoles[mode] || baseRoles.general,
    'Always ground every fact, count, customer name, date, and ID strictly in the live CRM_DATA JSON below. Do not invent customers, interactions, or metrics.',
    'Keep replies concise, scannable, and practical using plain text or simple bullet lines (avoid excessive markdown markup).',
    'Never claim you already created a follow-up task in the database; instead populate suggestedFollowups so an administrator can approve creation.'
  ].join('\n');
}

function selectModel(mode: AssistantMode, speed: AssistantSpeed): string {
  if (speed === 'fast') {
    return 'gemini-3.1-flash-lite';
  }
  if (mode === 'message' && speed !== 'standard') {
    return 'gemini-3.1-flash-lite';
  }
  return 'gemini-4-hydrogen';
}

function sanitizeSuggestedFollowups(raw: unknown): SuggestedFollowup[] {
  if (!Array.isArray(raw)) return [];
  const valid: SuggestedFollowup[] = [];
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  const fallbackDate = (() => {
    const d = new Date();
    d.setDate(d.getDate() + 2);
    return d.toISOString().slice(0, 10);
  })();

  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const cid = Number(obj.customerId);
    const customer = Number.isInteger(cid) ? getCustomerById(cid) : undefined;
    if (!customer) continue;
    const reason = String(obj.reason || '').trim();
    if (!reason) continue;
    const rawDate = String(obj.followUpDate || '').trim();
    const followUpDate = datePattern.test(rawDate) ? rawDate : fallbackDate;
    const rawPriority = String(obj.priority || 'Medium').trim();
    const priority: 'Low' | 'Medium' | 'High' =
      rawPriority === 'High' || rawPriority === 'Low' ? rawPriority : 'Medium';

    valid.push({
      customerId: customer.id,
      customerName: customer.name,
      reason: reason.slice(0, 220),
      followUpDate,
      priority
    });
    if (valid.length >= 5) break;
  }
  return valid;
}

function sanitizeDraftMessage(raw: unknown): DraftMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const body = String(obj.body || '').trim();
  if (!body) return null;
  return {
    channel: String(obj.channel || 'Email').trim(),
    tone: String(obj.tone || 'Friendly').trim(),
    subject: String(obj.subject || 'Follow-up').trim(),
    body
  };
}

function mapGeminiError(err: unknown): AiServiceError {
  if (err instanceof AiServiceError) return err;
  const errObj = err && typeof err === 'object' ? (err as { status?: unknown; statusCode?: unknown; message?: unknown }) : null;
  const rawMessage =
    err instanceof Error
      ? err.message
      : errObj && typeof errObj.message === 'string'
        ? errObj.message
        : String(err || 'Unknown AI service error');
  const numericStatus =
    typeof errObj?.status === 'number'
      ? errObj.status
      : typeof errObj?.statusCode === 'number'
        ? errObj.statusCode
        : null;
  const statusMatch = rawMessage.match(/\b(400|401|403|404|429|500|502|503|504)\b/);
  const code = numericStatus ?? (statusMatch ? parseInt(statusMatch[1], 10) : 500);
  const sanitizedMsg = rawMessage.replace(/AIza[0-9A-Za-z_-]{10,}/g, '[REDACTED]');
  console.error('[AI Assistant] Gemini API error:', code, sanitizedMsg);

  if (
    rawMessage.includes('API_KEY_INVALID') ||
    rawMessage.includes('PERMISSION_DENIED') ||
    code === 401 ||
    code === 403
  ) {
    return new AiServiceError(
      'The Gemini API key could not be authorized. Please check or select a valid GEMINI_API_KEY in AI Studio Settings > Secrets.',
      400
    );
  }
  if (rawMessage.includes('RESOURCE_EXHAUSTED') || code === 429) {
    return new AiServiceError(
      'AI request quota reached for the moment. Please retry shortly or check AI Studio Settings > Secrets.',
      429
    );
  }
  if (rawMessage.includes('NOT_FOUND') || code === 404) {
    return new AiServiceError('Selected AI model is currently unavailable. Please retry in Fast Drafts mode.', 404);
  }
  return new AiServiceError(`Unable to generate AI response right now: ${sanitizedMsg}`, 500);
}

export async function runCrmAssistantTurn(params: {
  message: string;
  history: ChatTurn[];
  mode: AssistantMode;
  speed?: AssistantSpeed;
  customerId?: number | null;
  tone?: string;
  channel?: string;
}): Promise<AssistantReply> {
  const userMessage = params.message.trim();
  if (!userMessage) {
    throw new AiServiceError('Please enter a message or question for the CRM assistant.', 400);
  }

  const ai = getClient();
  const mode: AssistantMode = params.mode || 'general';
  const speed: AssistantSpeed = params.speed === 'fast' ? 'fast' : 'standard';
  const model = selectModel(mode, speed);
  const crmSnapshot = buildCrmContextSnapshot(params.customerId);

  const systemInstruction = [
    getRoleInstruction(mode, params.tone, params.channel),
    '',
    'CRM_DATA:',
    JSON.stringify(crmSnapshot)
  ].join('\n');

  const priorHistory = params.history.slice(-16).map(turn => ({
    role: turn.role,
    parts: [{ text: turn.text }]
  }));

  const chat = ai.chats.create({
    model,
    history: priorHistory,
    config: {
      systemInstruction,
      ...(model === 'gemini-4-hydrogen'
        ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } }
        : {}),
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        required: ['reply'],
        properties: {
          reply: {
            type: Type.STRING,
            description: 'Helpful, accurate response grounded in CRM_DATA.'
          },
          draftMessage: {
            type: Type.OBJECT,
            description: 'Populate only when drafting a follow-up Email, WhatsApp message, or customer query reply.',
            required: ['channel', 'tone', 'subject', 'body'],
            properties: {
              channel: { type: Type.STRING },
              tone: { type: Type.STRING },
              subject: { type: Type.STRING },
              body: { type: Type.STRING }
            }
          },
          suggestedFollowups: {
            type: Type.ARRAY,
            description: 'Populate only when recommending new follow-up tasks for admin approval.',
            items: {
              type: Type.OBJECT,
              required: ['customerId', 'customerName', 'reason', 'followUpDate', 'priority'],
              properties: {
                customerId: { type: Type.INTEGER },
                customerName: { type: Type.STRING },
                reason: { type: Type.STRING },
                followUpDate: { type: Type.STRING },
                priority: { type: Type.STRING }
              }
            }
          }
        }
      }
    }
  });

  let response: GenerateContentResponse;
  try {
    response = await chat.sendMessage({ message: userMessage });
  } catch (err) {
    throw mapGeminiError(err);
  }

  const rawText = (response.text ?? '').trim();
  if (!rawText) {
    throw new AiServiceError('Received an empty response from the AI service. Please try again.', 500);
  }

  try {
    const parsed = JSON.parse(rawText) as {
      reply?: string;
      draftMessage?: unknown;
      suggestedFollowups?: unknown;
    };
    return {
      reply: String(parsed.reply || rawText).trim(),
      modelUsed: model,
      draftMessage: sanitizeDraftMessage(parsed.draftMessage),
      suggestedFollowups: sanitizeSuggestedFollowups(parsed.suggestedFollowups)
    };
  } catch {
    return {
      reply: rawText,
      modelUsed: model,
      draftMessage: null,
      suggestedFollowups: []
    };
  }
}
