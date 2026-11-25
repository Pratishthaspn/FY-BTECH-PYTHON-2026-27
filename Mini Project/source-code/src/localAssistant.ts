import {
  getCustomers,
  getCustomerById,
  getInteractions,
  getCustomerInteractions,
  getFollowups,
  getCustomerFollowups,
  getReportsData,
  getSettings,
  Customer,
  Interaction,
  Followup
} from './models.js';
import type {
  AssistantMode,
  DraftMessage,
  SuggestedFollowup,
  ChatTurn,
  AssistantReply
} from './aiAssistant.js';

function todayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDaysIso(baseIso: string, days: number): string {
  const d = new Date(`${baseIso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(olderIso: string, newerIso: string): number | null {
  if (!olderIso) return null;
  const a = new Date(`${olderIso}T00:00:00Z`).getTime();
  const b = new Date(`${newerIso}T00:00:00Z`).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / (1000 * 60 * 60 * 24));
}

function findMentionedCustomer(
  message: string,
  history: ChatTurn[],
  explicitCustomerId?: number | null
): Customer | undefined {
  if (explicitCustomerId) {
    const direct = getCustomerById(explicitCustomerId);
    if (direct) return direct;
  }

  const allCustomers = getCustomers();
  const lowerMsg = message.toLowerCase();

  // Check current prompt for full name, first name (if unambiguous >= 3 chars), email, or company
  for (const cust of allCustomers) {
    if (cust.name && lowerMsg.includes(cust.name.toLowerCase())) return cust;
    if (cust.company && cust.company.length >= 3 && lowerMsg.includes(cust.company.toLowerCase())) return cust;
    if (cust.email && lowerMsg.includes(cust.email.toLowerCase())) return cust;
  }

  const firstNameMatches = allCustomers.filter(cust => {
    const first = (cust.name || '').trim().split(/\s+/)[0]?.toLowerCase() || '';
    return first.length >= 3 && new RegExp(`\\b${first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(message);
  });
  if (firstNameMatches.length === 1) {
    return firstNameMatches[0];
  }

  // Fallback: check recent chat turns for a customer name reference
  for (let i = history.length - 1; i >= 0; i--) {
    const turnText = (history[i].text || '').toLowerCase();
    for (const cust of allCustomers) {
      if (cust.name && turnText.includes(cust.name.toLowerCase())) return cust;
    }
  }

  return undefined;
}

function inferIntentMode(message: string, selectedMode: AssistantMode): AssistantMode {
  if (selectedMode !== 'general') return selectedMode;
  const q = message.toLowerCase();

  if (/\b(draft|write|compose|whatsapp|email message|reply|send message|template|script)\b/.test(q)) {
    return 'message';
  }
  if (/\b(overdue|follow[\s-]?up|followups|prioritize|when to contact|remind|schedule|create task)\b/.test(q) && !/\bwith pending follow/.test(q)) {
    return 'followups';
  }
  if (/\b(how many|summary|summarize|analytics|report|status has the most|this month|stats|breakdown|percentage|metric)\b/.test(q)) {
    if (/\b(history|call|calls|meeting|meetings|unresolved|previous|before contacting|latest interaction)\b/.test(q)) {
      return 'history';
    }
    return 'analytics';
  }
  if (/\b(history|previous|latest interaction|unresolved|calls?|meetings?|pre-contact|context)\b/.test(q)) {
    return 'history';
  }
  if (/\b(active|inactive|recent|recently|neglected|haven't been contacted|pending follow|most active|customers?|list)\b/.test(q)) {
    return 'insights';
  }
  return 'insights';
}

function buildInsightsReply(message: string): { reply: string; suggestedFollowups: SuggestedFollowup[] } {
  const q = message.toLowerCase();
  const today = todayIso();
  const customers = getCustomers();
  const interactions = getInteractions();
  const followups = getFollowups();

  if (customers.length === 0) {
    return { reply: 'There are currently no customers in your CRM.', suggestedFollowups: [] };
  }

  const interCountByCustomer = new Map<number, number>();
  for (const item of interactions) {
    interCountByCustomer.set(item.customer_id, (interCountByCustomer.get(item.customer_id) || 0) + 1);
  }

  const pendingByCustomer = new Map<number, Followup[]>();
  for (const fu of followups) {
    if (fu.status === 'Pending') {
      const list = pendingByCustomer.get(fu.customer_id) || [];
      list.push(fu);
      pendingByCustomer.set(fu.customer_id, list);
    }
  }

  if (/\b(haven't|havent|not been|neglected|stale|oldest|longest|inactive|no contact)\b/.test(q)) {
    const stale = [...customers]
      .map(c => ({
        customer: c,
        daysAgo: daysBetween(c.last_contact, today)
      }))
      .sort((a, b) => (b.daysAgo ?? 9999) - (a.daysAgo ?? 9999))
      .slice(0, 6);

    const lines = stale.map(({ customer, daysAgo }) => {
      const agoLabel = daysAgo === null ? 'No contact recorded' : `${daysAgo} day(s) ago (${customer.last_contact})`;
      return `- ${customer.name}${customer.company ? ` (${customer.company})` : ''} [${customer.status}] — Last contact: ${agoLabel}`;
    });

    const suggestions: SuggestedFollowup[] = stale.slice(0, 3).map(({ customer }, idx) => ({
      customerId: customer.id,
      customerName: customer.name,
      reason: `Check in after ${daysBetween(customer.last_contact, today) ?? 'extended'} days without contact`,
      followUpDate: addDaysIso(today, idx + 1),
      priority: customer.status === 'Active' ? 'High' : 'Medium'
    }));

    return {
      reply: [
        `Customers needing recent outreach (${stale.length} shown):`,
        ...lines,
        '',
        'You can approve any suggested follow-up task below.'
      ].join('\n'),
      suggestedFollowups: suggestions
    };
  }

  if (/\b(pending|follow[\s-]?up|followups)\b/.test(q)) {
    const withPending = customers.filter(c => (pendingByCustomer.get(c.id) || []).length > 0);
    if (withPending.length === 0) {
      return { reply: 'No customers currently have pending follow-ups.', suggestedFollowups: [] };
    }
    const lines = withPending.map(c => {
      const tasks = pendingByCustomer.get(c.id) || [];
      const earliest = [...tasks].sort((a, b) => a.follow_up_date.localeCompare(b.follow_up_date))[0];
      const overdueTag = earliest.follow_up_date < today ? ' [OVERDUE]' : '';
      return `- ${c.name}${c.company ? ` (${c.company})` : ''}: ${tasks.length} pending — next ${earliest.follow_up_date}${overdueTag} (${earliest.priority}: ${earliest.reason})`;
    });
    return {
      reply: [`Customers with pending follow-ups (${withPending.length}):`, ...lines].join('\n'),
      suggestedFollowups: []
    };
  }

  // Active customers / most active customers
  const activeCustomers = customers.filter(c => c.status === 'Active');
  const pool = activeCustomers.length > 0 ? activeCustomers : customers;
  const ranked = [...pool]
    .map(c => ({
      customer: c,
      count: interCountByCustomer.get(c.id) || 0,
      pending: (pendingByCustomer.get(c.id) || []).length
    }))
    .sort((a, b) => b.count - a.count || b.customer.last_contact.localeCompare(a.customer.last_contact));

  const lines = ranked.map(
    ({ customer, count, pending }) =>
      `- ${customer.name}${customer.company ? ` (${customer.company})` : ''} — ${count} interaction(s), last contact ${customer.last_contact || 'N/A'}${pending > 0 ? `, ${pending} pending follow-up(s)` : ''}`
  );

  return {
    reply: [
      `Active Customers (${activeCustomers.length} Active out of ${customers.length} total, ranked by activity):`,
      ...lines
    ].join('\n'),
    suggestedFollowups: []
  };
}

function buildAnalyticsReply(message: string): string {
  const q = message.toLowerCase();
  const reports = getReportsData();
  const customers = getCustomers();
  const interactions = getInteractions();
  const followups = getFollowups();
  const today = todayIso();
  const monthPrefix = today.slice(0, 7);

  const statusEntries = Object.entries(reports.customer_status);
  const topStatus = [...statusEntries].sort((a, b) => b[1] - a[1])[0];

  const thisMonthInteractions = interactions.filter(i => (i.interaction_date || '').startsWith(monthPrefix));
  const monthChannels: Record<string, number> = {};
  for (const i of thisMonthInteractions) {
    monthChannels[i.type] = (monthChannels[i.type] || 0) + 1;
  }

  const overdueCount = followups.filter(f => f.status === 'Pending' && f.follow_up_date < today).length;
  const pendingCount = reports.followup_status.Pending || 0;
  const completedCount = reports.followup_status.Completed || 0;

  if (/\bmonth\b/.test(q) && !/\bstatus\b/.test(q) && !/\breport\b/.test(q)) {
    const channelSummary =
      Object.entries(monthChannels)
        .map(([k, v]) => `${k}: ${v}`)
        .join(', ') || 'None recorded yet';
    return [
      `This Month's Interactions Summary (${monthPrefix}):`,
      `- Total interactions this month: ${thisMonthInteractions.length} (out of ${interactions.length} all-time)`,
      `- Channels this month: ${channelSummary}`,
      ...thisMonthInteractions.slice(0, 5).map(
        i => `- ${i.interaction_date} · ${i.customer_name} (${i.type}): ${i.description}`
      )
    ].join('\n');
  }

  const totalCustomers = customers.length;
  const activeCount = reports.customer_status.Active || 0;
  const channelAllSummary =
    Object.entries(reports.interaction_types)
      .map(([k, v]) => `${k}: ${v}`)
      .join(', ') || 'None';

  return [
    'CRM Business Analytics Summary:',
    `- Customers: ${totalCustomers} total — Active: ${activeCount}, Pending: ${reports.customer_status.Pending || 0}, Inactive: ${reports.customer_status.Inactive || 0}`,
    `- Top Customer Status: ${topStatus ? `${topStatus[0]} (${topStatus[1]} customers)` : 'N/A'}`,
    `- Interactions: ${interactions.length} total (${thisMonthInteractions.length} this month) — ${channelAllSummary}`,
    `- Follow-ups: ${pendingCount} Pending (${overdueCount} overdue), ${completedCount} Completed — High priority: ${reports.followup_priority.High || 0}, Medium: ${reports.followup_priority.Medium || 0}, Low: ${reports.followup_priority.Low || 0}`
  ].join('\n');
}

function buildSmartFollowupsReply(message: string): { reply: string; suggestedFollowups: SuggestedFollowup[] } {
  const today = todayIso();
  const customers = getCustomers();
  const followups = getFollowups();

  const overdue = followups
    .filter(f => f.status === 'Pending' && f.follow_up_date < today)
    .sort((a, b) => a.follow_up_date.localeCompare(b.follow_up_date));

  const upcoming = followups
    .filter(f => f.status === 'Pending' && f.follow_up_date >= today)
    .sort((a, b) => a.follow_up_date.localeCompare(b.follow_up_date));

  const customerHasPending = new Set(followups.filter(f => f.status === 'Pending').map(f => f.customer_id));
  const neglectedWithoutTask = customers
    .filter(c => !customerHasPending.has(c.id))
    .map(c => ({ c, days: daysBetween(c.last_contact, today) ?? 999 }))
    .sort((a, b) => b.days - a.days)
    .slice(0, 3);

  const lines: string[] = [];
  if (overdue.length > 0) {
    lines.push(`Overdue Follow-ups (${overdue.length}) — Immediate Priority:`);
    overdue.slice(0, 6).forEach(f => {
      lines.push(`- ${f.customer_name} [${f.priority}] due ${f.follow_up_date}: ${f.reason}`);
    });
  } else {
    lines.push('No overdue follow-ups found.');
  }

  if (upcoming.length > 0) {
    lines.push('');
    lines.push(`Upcoming Pending Follow-ups (${upcoming.length}):`);
    upcoming.slice(0, 4).forEach(f => {
      lines.push(`- ${f.customer_name} [${f.priority}] on ${f.follow_up_date}: ${f.reason}`);
    });
  }

  const suggestedFollowups: SuggestedFollowup[] = [];
  for (const item of neglectedWithoutTask) {
    suggestedFollowups.push({
      customerId: item.c.id,
      customerName: item.c.name,
      reason: `Schedule check-in (${item.days} days since last contact on ${item.c.last_contact || 'record'})`,
      followUpDate: addDaysIso(today, item.c.status === 'Active' ? 1 : 3),
      priority: item.c.status === 'Active' ? 'High' : 'Medium'
    });
  }

  if (suggestedFollowups.length === 0 && overdue.length > 0) {
    const firstOverdue = overdue[0];
    suggestedFollowups.push({
      customerId: firstOverdue.customer_id,
      customerName: firstOverdue.customer_name,
      reason: `Rescheduled check-in: ${firstOverdue.reason}`,
      followUpDate: addDaysIso(today, 1),
      priority: firstOverdue.priority
    });
  }

  if (suggestedFollowups.length > 0) {
    lines.push('');
    lines.push('Recommended new follow-up tasks (review and click Approve & Create below):');
    suggestedFollowups.forEach(s => {
      lines.push(`- ${s.customerName} on ${s.followUpDate} (${s.priority}): ${s.reason}`);
    });
  }

  if (/\bsuggest|when|propose|attention\b/i.test(message) && neglectedWithoutTask.length > 0) {
    lines.push('');
    lines.push('Recommended contact cadence: reach out to High-priority Active accounts within 1-2 days, and Pending/Inactive leads within 3-5 days.');
  }

  return { reply: lines.join('\n'), suggestedFollowups };
}

function buildCustomerHistoryReply(customer: Customer | undefined): string {
  if (!customer) {
    const recent = getInteractions().slice(0, 6);
    if (recent.length === 0) {
      return 'Select a customer in "Customer Context" (or mention a customer name) to view their full call/meeting history.';
    }
    return [
      'No specific customer was selected or named. Here is the latest activity across your CRM (pick a customer in Customer Context for a detailed briefing):',
      ...recent.map(i => `- ${i.interaction_date} · ${i.customer_name} (${i.type}): ${i.description}`)
    ].join('\n');
  }

  const interactions: Interaction[] = getCustomerInteractions(customer.id);
  const followups: Followup[] = getCustomerFollowups(customer.id);
  const pending = followups.filter(f => f.status === 'Pending');
  const today = todayIso();

  const lines: string[] = [
    `Customer History Briefing — ${customer.name}${customer.company ? ` (${customer.company})` : ''} [${customer.status}]`,
    `Contact: ${customer.email} · ${customer.phone} | Last contact: ${customer.last_contact || 'N/A'}`
  ];

  if (customer.notes) {
    lines.push(`Account Notes: ${customer.notes}`);
  }

  if (interactions.length > 0) {
    const latest = interactions[0];
    lines.push('');
    lines.push(`Latest Interaction: ${latest.interaction_date} via ${latest.type} — ${latest.description}`);

    const callsAndMeetings = interactions.filter(i => i.type === 'Call' || i.type === 'Meeting');
    if (callsAndMeetings.length > 0) {
      lines.push('');
      lines.push(`Calls & Meetings Summary (${callsAndMeetings.length}):`);
      callsAndMeetings.slice(0, 5).forEach(i => {
        lines.push(`- ${i.interaction_date} (${i.type}): ${i.description}`);
      });
    } else {
      lines.push('');
      lines.push(`Recent Interactions (${interactions.length}):`);
      interactions.slice(0, 4).forEach(i => {
        lines.push(`- ${i.interaction_date} (${i.type}): ${i.description}`);
      });
    }
  } else {
    lines.push('');
    lines.push('No prior interactions recorded yet.');
  }

  const queryKeywords = /\b(issue|problem|pending|question|query|waiting|requested|pricing|quote|approval|bug|delay|open)\b/i;
  const unresolvedFromLogs = interactions.filter(i => queryKeywords.test(i.description || ''));

  lines.push('');
  if (pending.length > 0 || unresolvedFromLogs.length > 0) {
    lines.push('Unresolved Queries & Open Items:');
    pending.forEach(f => {
      const overdueTag = f.follow_up_date < today ? ' [OVERDUE]' : '';
      lines.push(`- Follow-up (${f.follow_up_date}${overdueTag}, ${f.priority}): ${f.reason}`);
    });
    unresolvedFromLogs.slice(0, 3).forEach(i => {
      lines.push(`- From ${i.interaction_date} ${i.type}: ${i.description}`);
    });
  } else {
    lines.push('No unresolved queries or pending follow-ups flagged.');
  }

  return lines.join('\n');
}

function buildMessageDraftReply(params: {
  message: string;
  customer?: Customer;
  channel?: string;
  tone?: string;
}): { reply: string; draftMessage: DraftMessage } {
  const settings = getSettings();
  const businessName = settings.business_name || 'Our Team';
  const q = params.message.toLowerCase();

  let channel = params.channel || 'Email';
  if (/\bwhatsapp\b/i.test(q)) channel = 'WhatsApp';
  else if (/\breply|response|query\b/i.test(q) && !/\bemail\b/i.test(q)) channel = 'Reply';
  else if (/\bemail\b/i.test(q)) channel = 'Email';

  let tone = params.tone || 'Friendly';
  if (/\bformal|professional\b/i.test(q)) tone = 'Formal';
  else if (/\bpersuasive|convincing|sales\b/i.test(q)) tone = 'Persuasive';
  else if (/\bfriendly|warm|casual\b/i.test(q)) tone = 'Friendly';

  const targetCustomer = params.customer || getCustomers()[0];
  const custName = targetCustomer ? targetCustomer.name : 'Valued Customer';
  const firstName = custName.split(/\s+/)[0] || custName;
  const companyTag = targetCustomer?.company ? ` (${targetCustomer.company})` : '';

  const latestInter = targetCustomer ? getCustomerInteractions(targetCustomer.id)[0] : undefined;
  const pendingFu = targetCustomer
    ? getCustomerFollowups(targetCustomer.id).find(f => f.status === 'Pending')
    : undefined;

  const contextTopic = pendingFu
    ? pendingFu.reason
    : latestInter
      ? latestInter.description
      : 'your recent inquiry and next steps';

  let subject = `Following up — ${businessName}`;
  if (channel === 'WhatsApp') {
    subject = `WhatsApp Message for ${custName}`;
  } else if (pendingFu) {
    subject = `Follow-up: ${pendingFu.reason.slice(0, 55)}`;
  }

  let greeting = `Hi ${firstName},`;
  let opening = `Hope you're doing well! I wanted to follow up regarding ${contextTopic}.`;
  let valueLine = `Let me know if you have any questions or if there's a convenient time for a quick chat this week.`;
  let signOff = `Best regards,\n${businessName}`;

  if (tone === 'Formal') {
    greeting = `Dear ${custName},`;
    opening = `I hope this message finds you well. I am writing to follow up regarding ${contextTopic}.`;
    valueLine = `Please let us know your availability or if you require any additional details from our side so we may proceed smoothly.`;
    signOff = `Sincerely,\n${businessName}`;
  } else if (tone === 'Persuasive') {
    greeting = `Hi ${firstName},`;
    opening = `Following up on ${contextTopic} — we'd love to help ${targetCustomer?.company || 'your team'} move forward without delay.`;
    valueLine = `If we align on the next step this week, we can prioritize onboarding and share a tailored plan right away. What time works for a brief 10-minute call?`;
    signOff = `Warm regards,\n${businessName}`;
  }

  if (channel === 'WhatsApp') {
    const waBody =
      tone === 'Formal'
        ? `Hello ${custName}, this is ${businessName} following up regarding ${contextTopic}. Please let us know a convenient time to connect.`
        : tone === 'Persuasive'
          ? `Hi ${firstName}! Quick follow-up from ${businessName} on ${contextTopic}. Ready to help you get started this week — shall we schedule a quick 10-min call?`
          : `Hi ${firstName}! 👋 Checking in from ${businessName} regarding ${contextTopic}. Let us know if you need anything or would like to catch up!`;

    return {
      reply: `Drafted a ${tone.toLowerCase()} WhatsApp message for ${custName}${companyTag} grounded in their CRM context. You can copy it directly below.`,
      draftMessage: {
        channel,
        tone,
        subject,
        body: waBody
      }
    };
  }

  const fullBody = `${greeting}\n\n${opening}\n\n${valueLine}\n\n${signOff}`;
  return {
    reply: `Drafted a ${tone.toLowerCase()} ${channel === 'Reply' ? 'query reply' : 'email'} for ${custName}${companyTag} using their latest CRM context. Use the Copy button below.`,
    draftMessage: {
      channel,
      tone,
      subject,
      body: fullBody
    }
  };
}

export function runLocalCrmAssistantTurn(params: {
  message: string;
  history: ChatTurn[];
  mode: AssistantMode;
  customerId?: number | null;
  tone?: string;
  channel?: string;
}): AssistantReply {
  const message = params.message.trim();
  const effectiveMode = inferIntentMode(message, params.mode || 'general');
  const customer = findMentionedCustomer(message, params.history || [], params.customerId);

  if (effectiveMode === 'message') {
    const { reply, draftMessage } = buildMessageDraftReply({
      message,
      customer,
      channel: params.channel,
      tone: params.tone
    });
    return {
      reply,
      modelUsed: 'built-in-crm-bot',
      draftMessage,
      suggestedFollowups: []
    };
  }

  if (effectiveMode === 'followups') {
    const { reply, suggestedFollowups } = buildSmartFollowupsReply(message);
    return {
      reply,
      modelUsed: 'built-in-crm-bot',
      draftMessage: null,
      suggestedFollowups
    };
  }

  if (effectiveMode === 'analytics') {
    return {
      reply: buildAnalyticsReply(message),
      modelUsed: 'built-in-crm-bot',
      draftMessage: null,
      suggestedFollowups: []
    };
  }

  if (effectiveMode === 'history') {
    return {
      reply: buildCustomerHistoryReply(customer),
      modelUsed: 'built-in-crm-bot',
      draftMessage: null,
      suggestedFollowups: []
    };
  }

  const { reply, suggestedFollowups } = buildInsightsReply(message);
  return {
    reply,
    modelUsed: 'built-in-crm-bot',
    draftMessage: null,
    suggestedFollowups
  };
}
