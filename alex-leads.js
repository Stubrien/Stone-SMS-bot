// alex-leads.js
// Alex <-> Airtable Sales Leads integration.
// - Nurture: drafts the day's nurture texts each weekday morning (max 5 per agent), texts each agent ONE midday
//   preview, and sends at 2pm unless the agent replies CHANGE <code> … or CANCEL <code> (no per-text approval)
// - Track 8 (listed with another agency): monthly check-ins, one offer of help around when their agreement ends,
//   stops when Market Sales shows it sold, moves back to Qualifying when the agreement ends unsold
// - Agents text Alex to update their cards ("Booked Sarah Thu 2pm") – applied with UNDO, or confirmed first if unclear
// - New leads: in business hours (8am–7pm Mon–Sat) the agent gets "Reply CALL or ALEX" with hourly reminders and an
//   end-of-day move to No Contact; outside business hours Alex engages straight away (opener, details, qualify,
//   appraisal or call time) and asks the agent ALEX / CALL at 8am if there's no reply
// - One 9:30am check-in text per agent (No Contact days 1/3/5, tasks due, lost reasons) and after-appraisal / after-meeting questions
// - Listed (Won): texts Fiona and the agent; chases the agent if Fiona says the authority hasn't arrived
// - Lost cards: 3-month check-in for "selling privately", Track 6 after 6 months for "not selling"
// - GoHighLevel social-media leads texted in as "NEW LEAD / Name: … / Mobile: …" create or update the card
//   (env GHL_LEAD_NUMBERS = the number(s) GoHighLevel sends from)
// - Qualifying calls (Call At): morning-of text to the contact, a brief to the agent 15 min before, "how did it go?"
//   an hour after; "no answer" → Alex texts the contact for a better time and books it from their reply
// - Appraisal / listing meeting booked: offers the agent a confirmation text the day before and a thank-you 3h after
//   (YES / EDIT / NO + code), handles "can we move it?" via the agent, tells Fiona if the card hasn't moved 2 business days on
// - Qualifying 14 days, Decision Pending 21 days and cards with no next step come up in the 9:30 check-in;
//   a sent price update gets an "Any reaction?" task 3 business days out
// - Team texts go to a tool-using assistant: it searches/opens/lists/updates/creates cards, follows the editable
//   playbook (zAlex Playbook table), remembers the conversation (Team → zAlex Chat) and asks when unsure
//   (env ALEX_ASSISTANT=off for the older one-shot reader; ALEX_ASSISTANT_MODEL to pick the model)
// - Agents add new contacts by text (name, mobile, address, source) – duplicates are caught, UNDO removes it
// - Every confirmation to a contact (appraisal / meeting times, call times, day-before reminders, thank-yous) is
//   drafted for the agent first: YES / EDIT / NO + code; approved after hours, it goes at 8am
// - Appraisal times without calendar access: Alex asks the contact what suits, texts the agent up to 3 times that
//   fit and don't clash with their Airtable bookings, and drafts the contact's confirmation once the agent picks one. One reminder to the agent after 2 hours. Agents add it to Outlook.
// - Outlook (optional, dormant – env MS_TENANT_ID / MS_CLIENT_ID / MS_CLIENT_SECRET): would offer real free times
//   and add bookings to the agent's calendar (Team → Email)
// (The 7:45 / 12:30 / 5pm email digests and the Monday lost list are Airtable automations.)
// - Replies from vendors: logged, Key Facts / track / follow-up updated, reply drafted for Stu's approval
// - Creates new vendor enquiries in Airtable (Entered Via = Alex) instead of Pipedrive
// Parked cards (Parked for test) are ignored.
//
// Env vars: AIRTABLE_TOKEN, AIRTABLE_BASE (default below), APPROVER_MOBILE, APPROVER_NAME (default Stu),
//           ALEX_PHONE_NUMBER, ANTHROPIC_API_KEY, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN,
//           ALEX_LEADS_ENABLED ("true" to run the sweep; anything else = off), ALEX_MODEL (optional)

const Anthropic = require('@anthropic-ai/sdk');
const twilio = require('twilio');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const BASE = process.env.AIRTABLE_BASE || 'apphczJpEh8x2EwQL';
const MODEL = process.env.ALEX_MODEL || 'claude-sonnet-4-6';
const TZ = 'Australia/Melbourne';
const SWEEP_MINUTES = 15;
const MIN_DAYS_BETWEEN_TEXTS = 5;

const T = {
  leads: 'tblrFYa8aQsLJkW13',
  team: 'tbl1aNcrdwmamMyEF',
  activity: 'tblMcqHGJSqCevRaP',
  messages: 'tbl78WnIpym0PEutf'
};

const L = {
  name: 'fldb5kwwfLmfF7Sqp', address: 'fldHjG3VIzePec6rR', phone: 'fld5NRekiK1Cb7hv9', email: 'fldMGaKgIuosJHBrx',
  stage: 'fldIHUJYiPGHuR0WZ', agent: 'fldDF3RmFK2CFjXc0', nextAction: 'fldXoyCWonj5IidZl', nextActionDate: 'fldbYKvYS1cxIPssp',
  keyFacts: 'fldXkemyAdKOMduEO', background: 'fldcVPpXHcVQAEpe6', nurtureReason: 'fldwouDPfX6TcWPnu',
  interval: 'flddzzAoY8pZooOSq', followUp: 'fldk7KxcmipmgwqCo', apptType: 'fldybud7oFTNi2HSm',
  doNotContact: 'fld6sb3HQyCZqRjzC', pauseAlex: 'fldn1Mn8KGPMyblm3', source: 'fldxyNzQzMKJ08wMw',
  sourceDetail: 'flduDl2hpSydx2vH8', enteredVia: 'fldTIyMoiysNEFHb2', alexLastContact: 'fldDdLadhfB3yTdSJ',
  activity: 'fldR1Cxzj1hZ9vxKE', marketingConsent: 'fldS9HaPbovHxT4Kc'
};
const TM = { name: 'fldWZzjCL3xoU0l82', firstName: 'fldbxwqujqA0rygi9', mobile: 'fldUZ1RQT4BNOo41n', alexActive: 'fld1LSnoBvGGdO2VJ' };
const A = {
  summary: 'fldBSXLvtiGrLDlBB', lead: 'fldR7UavJmh0OWsDI', kind: 'fldfKAWZQWXe00nz7', type: 'fldP8or1OJQgK4jrg',
  detail: 'fldhFWP8aFaaRV3nV', internal: 'fld0zVTRAnXEPlDjD', author: 'fld9GdJ7yWaVdBE9z', loggedAt: 'fldkHdOEI2S99kdw3'
};
const M = {
  code: 'fldjLvmqFNFdlve4K', lead: 'fldt7fbHHdWrLn5UP', direction: 'fldAvlSCuVXNmw4AV', purpose: 'fldTZu3VVcNGVAoNf',
  status: 'fldItYMA0uRs9PGfg', draft: 'fldIXNAwcqOEqFpgT', finalText: 'fldlp8M5nnCECbygV', reasoning: 'fldJbwD7ZTChzFsUi',
  number: 'fld7buRBoFF8uw2E2', approverReply: 'fldRGjJkaHxIkkEuF', approvedBy: 'fldy47BHujwPffocQ',
  approvedAt: 'fldjLGjboCUBenuAB', sentAt: 'fldD2PFGg841BiaQK', sid: 'fldNI4kd6kQB11mJM', error: 'fld5pF9AtokFDQVev',
  created: 'fldRowPux9k4y7f7f'
};

// ---------------------------------------------------------------- helpers

function enabled() { return !!process.env.AIRTABLE_TOKEN; }
function sweepEnabled() { return enabled() && String(process.env.ALEX_LEADS_ENABLED).toLowerCase() === 'true'; }

function normalisePhone(raw) {
  if (!raw) return null;
  let d = String(raw).replace(/[^\d+]/g, '');
  if (d.startsWith('+')) return d;
  if (d.startsWith('61')) return '+' + d;
  if (d.startsWith('0')) return '+61' + d.slice(1);
  if (d.length === 9 && d.startsWith('4')) return '+61' + d;
  return d;
}
// An Australian mobile Alex can text: +614 followed by 8 digits
function isTextableMobile(raw) { return /^\+614\d{8}$/.test(normalisePhone(raw) || ''); }
function samePhone(a, b) { const x = normalisePhone(a), y = normalisePhone(b); return !!x && x === y; }

function melbNow() {
  const parts = new Intl.DateTimeFormat('en-AU', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false
  }).formatToParts(new Date());
  const p = t => (parts.find(x => x.type === t) || {}).value;
  return { date: `${p('year')}-${p('month')}-${p('day')}`, hour: parseInt(p('hour'), 10) % 24, weekday: p('weekday') };
}
function inSendWindow() {
  const n = melbNow();
  return !['Sat', 'Sun'].includes(n.weekday) && n.hour >= 9 && n.hour < 18;
}
function addDays(iso, days) { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); }
function dmy(iso) { return iso ? iso.slice(8, 10) + '/' + iso.slice(5, 7) : ''; }
function sel(v) { return v && typeof v === 'object' ? v.name : (v || ''); }
function firstName(full) { return (full || '').trim().split(/\s+/)[0] || ''; }

// ---------------------------------------------------------------- Airtable REST

async function at(method, path, body) {
  const res = await fetch('https://api.airtable.com/v0/' + BASE + '/' + path, {
    method,
    headers: { Authorization: 'Bearer ' + process.env.AIRTABLE_TOKEN, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('Airtable ' + method + ' ' + path + ' ' + res.status + ': ' + JSON.stringify(json));
  return json;
}
async function listAll(table, params) {
  let out = [], offset;
  do {
    const q = new URLSearchParams(Object.assign({ returnFieldsByFieldId: 'true', pageSize: '100' }, params || {}));
    if (offset) q.set('offset', offset);
    const r = await at('GET', table + '?' + q.toString());
    out = out.concat(r.records || []);
    offset = r.offset;
  } while (offset);
  return out;
}
async function getRecord(table, id) { return at('GET', table + '/' + id + '?returnFieldsByFieldId=true'); }
async function createRecord(table, fields) {
  const r = await at('POST', table + '?returnFieldsByFieldId=true', { records: [{ fields }], typecast: true });
  return r.records[0];
}
async function updateRecord(table, id, fields) {
  return at('PATCH', table + '?returnFieldsByFieldId=true', { records: [{ id, fields }], typecast: true });
}

async function logActivity(leadId, { summary, detail, type, kind, internal }) {
  try {
    await createRecord(T.activity, {
      [A.summary]: summary, [A.lead]: [leadId], [A.kind]: kind || 'Note', [A.type]: type || 'SMS',
      [A.detail]: detail || '', [A.internal]: !!internal, [A.author]: 'Alex'
    });
  } catch (e) { console.error('Alex leads: activity log failed', e.message); }
}

// ---------------------------------------------------------------- context for Claude

async function leadContext(lead) {
  const f = lead.fields;
  const actIds = (f[L.activity] || []).slice(-40);
  let history = [];
  if (actIds.length) {
    const formula = 'OR(' + actIds.map(id => `RECORD_ID()='${id}'`).join(',') + ')';
    const acts = await listAll(T.activity, { filterByFormula: formula });
    history = acts
      .map(a => ({
        at: a.fields[A.loggedAt] || a.createdTime, kind: sel(a.fields[A.kind]), type: sel(a.fields[A.type]),
        summary: a.fields[A.summary] || '', detail: a.fields[A.detail] || '', internal: !!a.fields[A.internal], author: a.fields[A.author] || ''
      }))
      .sort((x, y) => (x.at < y.at ? -1 : 1));
  }
  const agentIds = f[L.agent] || [];
  let agent = null;
  if (agentIds.length) { try { agent = await getRecord(T.team, agentIds[0]); } catch (e) { /* ignore */ } }
  return {
    card: {
      contactName: f[L.name] || '', firstName: firstName(f[L.name]), address: f[L.address] || '', stage: sel(f[L.stage]),
      nextAction: f[L.nextAction] || '', nextActionDate: f[L.nextActionDate] || '', keyFacts: f[L.keyFacts] || '',
      background: f[L.background] || '', nurtureReason: sel(f[L.nurtureReason]), followUpInterval: sel(f[L.interval]),
      followUpDate: f[L.followUp] || '', appraisalType: sel(f[L.apptType]), source: sel(f[L.source])
    },
    agent: agent ? { name: agent.fields[TM.name], firstName: agent.fields[TM.firstName] || firstName(agent.fields[TM.name]), mobile: agent.fields[TM.mobile] } : null,
    history
  };
}

function historyText(history) {
  if (!history.length) return '(no notes yet)';
  return history.map(h => {
    const tag = h.internal ? ' [INTERNAL – never mention to the vendor]' : '';
    return `- ${String(h.at).slice(0, 10)} ${h.kind}/${h.type} by ${h.author || 'team'}: ${h.summary}${h.detail ? ' – ' + h.detail : ''}${tag}`;
  }).join('\n');
}

// Soft opt-out added to the end of the first text Alex sends anyone, and to EVERY nurture text (Stu, 27 Oct 2026).
// Any reply asking to be left alone is treated as an opt-out (see handleVendorSMS).
const OPT_OUT_LINE = "If it's not the right time or you'd rather be left alone, just let me know.";
// Plain SMS characters only: one curly quote or long dash switches the whole text to Unicode (70 chars a segment).
function plainSMS(t) {
  return String(t || '').replace(/[\u2018\u2019\u201B\u2032]/g, "'").replace(/[\u201C\u201D\u2033]/g, '"')
    .replace(/\s*[\u2013\u2014\u2015]\s*/g, ' - ').replace(/\u2026/g, '...').replace(/[\u00A0\u2009\u202F]/g, ' ')
    .replace(/[\u2022\u00B7]/g, '-').replace(/ {2,}/g, ' ').trim();
}
// Every nurture text ends with the soft opt-out line (added again at send time in case an edit removed it).
function withOptOut(t) { t = String(t || '').trim(); return t.includes(OPT_OUT_LINE) ? t : t + ' ' + OPT_OUT_LINE; }
const OPT_OUT_ACK = "No worries at all, I'll leave it there. Thanks for letting me know. – Alex, Stone Ballarat";

const VOICE = "You write SMS messages as Alex from Stone Ballarat, writing on behalf of one of our sales agents. " +
  "Tone: warm, local, plain Australian English, like a real person in a real estate office - never salesy. " +
  "Rules: 1-3 short sentences. One question at most. No exclamation marks unless clearly warranted. Never start with filler (Great, Absolutely, Hope you're well is fine only if natural). " +
  "Never give a price opinion, valuation or commission. Never mention you are an AI unless asked directly. " +
  "Never write 'Reply STOP' or any opt-out wording - that is added automatically when needed. Never repeat or hint at anything marked INTERNAL, or anything in Background Notes the vendor would not have told us themselves. " +
  "Refer to the agent by first name (e.g. 'Stu asked me to check in'). Do not invent facts that are not on the card.";

async function claudeJSON(system, user, maxTokens) {
  const r = await anthropic.messages.create({ model: MODEL, max_tokens: maxTokens || 600, system, messages: [{ role: 'user', content: user }] });
  const text = r.content.map(c => c.text || '').join('');
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('No JSON from Claude: ' + text.slice(0, 200));
  return JSON.parse(m[0]);
}

// ---------------------------------------------------------------- approvals

async function nextCode() {
  const recent = await listAll(T.messages, { maxRecords: '50', 'sort[0][field]': M.created, 'sort[0][direction]': 'desc', [`fields[]`]: M.code });
  let max = 0;
  for (const r of recent) { const m = String(r.fields[M.code] || '').match(/^A(\d+)$/i); if (m) max = Math.max(max, parseInt(m[1], 10)); }
  // never reuse a code that is still waiting, scheduled or previewed
  const live = new Set((await activeDrafts()).map(r => String(r.fields[M.code] || '').toUpperCase()));
  let n = max >= 99 ? 1 : max + 1;
  for (let i = 0; i < 99 && live.has('A' + n); i++) n = n >= 99 ? 1 : n + 1;
  return 'A' + n;
}

async function sendSMS(to, body) {
  const msg = await twilioClient.messages.create({ from: process.env.ALEX_PHONE_NUMBER, to: normalisePhone(to), body });
  return msg.sid;
}

function approverMobile() { return normalisePhone(process.env.APPROVER_MOBILE); }
function isApprover(from) { return !!approverMobile() && samePhone(from, approverMobile()); }

async function queueDraft({ lead, ctx, purpose, draft, reasoning, extraLines, content, trackLabel }) {
  const code = await nextCode();
  await createRecord(T.messages, {
    [M.code]: code, [M.lead]: [lead.id], [M.direction]: 'To vendor', [M.purpose]: purpose, [M.status]: 'Awaiting approval',
    [M.draft]: draft, [M.reasoning]: reasoning || '', [M.number]: normalisePhone(lead.fields[L.phone]), [M_CONTENT]: content || ''
  });
  const c = ctx.card;
  const head = `${code} · ${c.contactName}${c.address && c.address !== c.contactName ? ', ' + c.address : ''} (${c.stage}${trackLabel ? '' : c.followUpInterval ? ', ' + c.followUpInterval : ''})`;
  const shownReason = String(reasoning || '').replace(/\s*PREV_FOLLOW_UP=\S+/, '').trim();
  const why = shownReason ? `\nWhy: ${shownReason}` : '';
  const extra = extraLines && extraLines.length ? '\n' + extraLines.map(x => x.replace('<code>', code)).join('\n') : '';
  const text = `${head}${why}${extra}\n\nDraft: "${draft}"\n\nReply YES ${code} · CHANGE ${code} what to change · EDIT ${code} full wording · NO ${code}`;
  await sendSMS(approverMobile(), text);
  console.log('Alex leads: draft ' + code + ' sent for approval');
  return code;
}

async function sendApproved(msgRec) {
  const f = msgRec.fields;
  const leadId = (f[M.lead] || [])[0];
  let text = plainSMS(f[M.finalText] || f[M.draft]);
  if (text && sel(f[M.purpose]) === 'Nurture check-in') text = withOptOut(text);
  // Use the card's current Phone (it may have been fixed after the draft was written); fall back to the number saved on the draft
  const leadNow = leadId ? await getRecord(T.leads, leadId) : null;
  const to = leadNow && isTextableMobile(leadNow.fields[L.phone]) ? normalisePhone(leadNow.fields[L.phone]) : f[M.number];
  if (!leadId || !text || !isTextableMobile(to)) {
    const why = !leadId ? 'no lead linked' : !text ? 'no text' : 'no valid mobile on the card';
    await updateRecord(T.messages, msgRec.id, { [M.status]: 'Failed', [M.error]: 'Not sent – ' + why });
    return 'NOT sent – ' + why + (why.includes('mobile') ? ' (fix the Phone field on the card)' : '');
  }
  const lead = leadNow;
  if (sel(f[M.purpose]) === 'Nurture check-in' && (sel(lead.fields[L.stage]) !== 'Nurture' || lead.fields[L.pauseAlex] || lead.fields[L_PARKED])) {
    await updateRecord(T.messages, msgRec.id, { [M.status]: 'Rejected', [M.error]: 'Not sent – card no longer in Nurture (or paused / parked)' });
    return 'not sent – the card has moved on';
  }
  if (lead.fields[L.doNotContact]) {
    await updateRecord(T.messages, msgRec.id, { [M.status]: 'Rejected', [M.error]: 'Do Not Contact ticked before sending' });
    return 'blocked (Do Not Contact)';
  }
  try {
    const sid = await sendSMS(to, text);
    await updateRecord(T.messages, msgRec.id, { [M.status]: 'Sent', [M.sentAt]: new Date().toISOString(), [M.sid]: sid, [M.finalText]: text });
    const leadUpd = { [L.alexLastContact]: new Date().toISOString() };
    // A nurture check-in counts as contact: roll the follow-up forward by the interval
    if (sel(f[M.purpose]) === 'Nurture check-in') {
      const st = nurtureState(lead.fields, await leadMessages(lead.fields));
      leadUpd[L.followUp] = addDays(melbNow().date, st.days);
      const content = String(f[M_CONTENT] || '');
      if (content.startsWith('sale:')) {
        try {
          const saleId = content.slice(5);
          const sale = await getRecord(MS_TABLE, saleId);
          const quoted = (sale.fields[MS.quotedTo] || []).concat(leadId);
          await updateRecord(MS_TABLE, saleId, { [MS.quotedTo]: Array.from(new Set(quoted)) });
        } catch (e) { console.error('Alex leads: Quoted To link failed', e.message); }
      }
    }
    await updateRecord(T.leads, leadId, leadUpd);
    await logActivity(leadId, { summary: 'Alex texted the vendor (' + sel(f[M.purpose]).toLowerCase() + ')', detail: text, type: 'SMS' });
    return 'sent';
  } catch (e) {
    await updateRecord(T.messages, msgRec.id, { [M.status]: 'Failed', [M.error]: e.message });
    throw e;
  }
}

async function waitingDrafts() {
  return listAll(T.messages, { filterByFormula: `{${M.status}}='Awaiting approval'` });
}
// Drafts that are still in play: waiting for Stu's approval, or nurture texts scheduled / previewed for today
// ("On hold" = paused by hand in Airtable: not sent, and no fresh text is drafted for that card while it sits there)
async function activeDrafts() {
  return listAll(T.messages, { filterByFormula: `OR({${M.status}}='Awaiting approval',{${M.status}}='Scheduled',{${M.status}}='Previewed',{${M.status}}='On hold')` });
}

// Returns true when the SMS was an approver command (so the normal Alex chat flow is skipped)
// An EDIT reply that starts like an instruction is treated as a request to change the draft, not as the new text.
function looksLikeInstruction(t) {
  return /^(please\s+)?(remove|delete|drop|take\s+out|cut|add|include|mention|make|change|shorten|lengthen|soften|swap|replace|rewrite|reword|don'?t|do\s+not|no\s+need|less|more|without|leave\s+out|use|say)\b/i.test(t);
}

// Understands the ways people actually reply on a phone:
//   "YES A21", "Yes a21", "Yes, A21", "yes A21.", "A21 yes", "Yep A21", "OK A21", "Send A21", "Approve A21", "👍 A21"
//   "NO A21", "nope A21", "A21 no", "EDIT A21 <wording>", "CHANGE A21 <instruction>", "KEEP A21", "LIST"
const CMD_WORDS = {
  YES: /^(yes|y|yep|yeah|yup|ya|ok|okay|k|send|send it|approve|approved|go|go ahead|sure|good|perfect|👍|✅)$/i,
  NO: /^(no|n|nope|nah|bin|bin it|reject|don'?t send|dont send|skip|cancel|❌)$/i,
  EDIT: /^edit$/i, CHANGE: /^change$/i, KEEP: /^keep$/i, LIST: /^list$/i, SHOW: /^show$/i
};
function cmdOf(word) { for (const [k, re] of Object.entries(CMD_WORDS)) if (re.test(word)) return k; return null; }
function parseApproverCommand(text) {
  const t = String(text || '').trim().replace(/[\u2018\u2019]/g, "'");
  if (!t) return null;
  const codeRe = /\bA\s?(\d{1,2})\b/i;
  const cm = t.match(codeRe);
  const code = cm ? 'A' + parseInt(cm[1], 10) : '';
  // Split around the code: words before it and text after it
  const before = cm ? t.slice(0, cm.index) : t;
  const after = cm ? t.slice(cm.index + cm[0].length) : '';
  const clean = s => s.replace(/^[\s.,:;!\-–—]+|[\s.,:;!\-–—]+$/g, '');
  const b = clean(before);
  // Command first ("YES A21 …", "Yes, A21", "Go ahead A21")
  let cmd = b ? cmdOf(b) : null;
  const lead = s => s.replace(/^[\s.,:;!\-–—]+/, '').trim(); // keep the wording's own ending punctuation
  let rest = lead(after);
  if (!cmd && !b && code) {
    // Code first ("A21 yes", "A21 edit Hey Sonya…")
    const w = rest.match(/^(\S+(?:\s+(?:it|ahead))?)\s*([\s\S]*)$/);
    if (w && cmdOf(clean(w[1]))) { cmd = cmdOf(clean(w[1])); rest = lead(w[2] || ''); }
  }
  if (!cmd && !code) {
    // No code at all: the whole message must be a command word (e.g. "Yes", "LIST"), or EDIT/CHANGE + text
    const w = t.match(/^(\S+)\s*([\s\S]*)$/);
    const c = w && cmdOf(clean(w[1]));
    if (!c) return null;
    const tail = clean(w[2] || '');
    if (['YES', 'NO', 'KEEP', 'LIST', 'SHOW'].includes(c) && tail && !/^(please|pls|thanks|thank you|thx|cheers|mate|ta)$/i.test(tail)) return null; // a sentence, not a command
    return { cmd: c, code: '', rest: ['EDIT', 'CHANGE'].includes(c) ? lead(w[2] || '') : '' };
  }
  if (!cmd) return null;
  return { cmd, code, rest };
}

const QUICK_PURPOSES = ['Appraisal confirmation', 'Thank-you', 'Call confirmation']; // offers the agent approves: sent in business hours (8am–7pm Mon–Sat)
// replyTo / byName: an agent approving an offer on their own card (appraisal confirmation, thank-you)
async function handleApproverSMS(body, replyTo, byName) {
  const text = (body || '').trim();
  const to = replyTo || approverMobile();
  const parsed = parseApproverCommand(text);
  if (!parsed) return false;
  const { cmd } = parsed;
  let code = parsed.code;
  const rest = parsed.rest;
  const waiting = await waitingDrafts();

  if (cmd === 'LIST') {
    await sendSMS(to, waiting.length ? 'Waiting: ' + waiting.map(w => w.fields[M.code]).join(', ') : 'Nothing waiting for approval.');
    return true;
  }
  if (!code) {
    if (waiting.length === 1) code = String(waiting[0].fields[M.code]).toUpperCase();
    else {
      await sendSMS(to, waiting.length ? `Which one? Waiting: ${waiting.map(w => w.fields[M.code]).join(', ')}. e.g. YES ${waiting[0].fields[M.code]}` : 'Nothing waiting for approval.');
      return true;
    }
  }

  if (cmd === 'KEEP') {
    // Undo a follow-up date change Alex made while reading a vendor reply
    const all = await listAll(T.messages, { filterByFormula: `AND(UPPER({${M.code}})='${code}',{${M.direction}}='To vendor')`, maxRecords: '5', 'sort[0][field]': M.created, 'sort[0][direction]': 'desc' });
    const rec = all[0];
    const m2 = rec && String(rec.fields[M.reasoning] || '').match(/PREV_FOLLOW_UP=(\d{4}-\d{2}-\d{2}|none)/);
    if (!rec || !m2) { await sendSMS(to, `No follow-up change to undo on ${code}.`); return true; }
    const leadId = (rec.fields[M.lead] || [])[0];
    await updateRecord(T.leads, leadId, { [L.followUp]: m2[1] === 'none' ? null : m2[1] });
    await logActivity(leadId, { summary: 'Follow-up date change undone (KEEP)', type: 'Follow-up date changed', kind: 'History' });
    await sendSMS(to, `Done – follow-up date on ${code} put back${m2[1] === 'none' ? '' : ' to ' + dmy(m2[1])}.`);
    return true;
  }

  const rec = waiting.find(w => String(w.fields[M.code]).toUpperCase() === code);
  if (!rec) { await sendSMS(to, `${code} isn't waiting for approval.`); return true; }
  const by = byName || process.env.APPROVER_NAME || 'Stu';

  if (cmd === 'NO' || cmd === 'N') {
    await updateRecord(T.messages, rec.id, { [M.status]: 'Rejected', [M.approverReply]: text, [M.approvedBy]: by, [M.approvedAt]: new Date().toISOString() });
    // A binned nurture check-in skips this round: roll the follow-up date on by the track so Alex
    // doesn't draft a fresh one at the next sweep (it used to re-draft within 15 minutes).
    let next = '';
    if (sel(rec.fields[M.purpose]) === 'Nurture check-in') {
      try { next = await skipNurtureRound((rec.fields[M.lead] || [])[0], code); } catch (e) { console.error('Alex leads: skip round failed', e.message); }
    }
    await sendSMS(to, `${code} binned – nothing sent.` + (next ? ` Next check-in ${dmy(next)}.` : ''));
    return true;
  }
  if ((cmd === 'EDIT' || cmd === 'CHANGE') && !rest) { await sendSMS(to, `Send the new wording after the code (EDIT ${code} Hey Sonya…) or an instruction (CHANGE ${code} make it shorter).`); return true; }

  // CHANGE, or an EDIT that reads like an instruction ("remove the opt out line"), is never sent as-is:
  // Alex rewrites the draft and sends it back for approval.
  if (cmd === 'CHANGE' || (cmd === 'EDIT' && looksLikeInstruction(rest))) {
    const current = rec.fields[M.finalText] || rec.fields[M.draft];
    const out = await claudeJSON(VOICE, `CURRENT DRAFT SMS: "${current}"\n\nTHE AGENT WANTS THIS CHANGE: "${rest}"\n\n` +
      'Rewrite the SMS applying exactly that change and nothing else. Keep the greeting and introduction unless asked to change them. ' +
      'Return JSON only: {"sms": "..."}', 400);
    const revised = String(out.sms || '').trim();
    if (!revised) { await sendSMS(to, `Couldn't apply that to ${code} – try EDIT ${code} followed by the full wording.`); return true; }
    await updateRecord(T.messages, rec.id, { [M.draft]: revised, [M.approverReply]: text });
    await sendSMS(to, `${code} revised:\n\nDraft: "${revised}"\n\nReply YES ${code} · CHANGE ${code} what to change · EDIT ${code} full wording · NO ${code}`);
    return true;
  }

  const fields = { [M.status]: cmd === 'EDIT' ? 'Edited & approved' : 'Approved', [M.approverReply]: text, [M.approvedBy]: by, [M.approvedAt]: new Date().toISOString() };
  if (cmd === 'EDIT') fields[M.finalText] = rest;
  await updateRecord(T.messages, rec.id, fields);

  // Appraisal confirmations and thank-yous go straight away in business hours; everything else Mon–Fri 9–6
  const quick = QUICK_PURPOSES.includes(sel(rec.fields[M.purpose]));
  if (quick ? !isBH() : !inSendWindow()) {
    await sendSMS(to, `${code} approved – it will go out at ${quick ? '8am' : '9am'} (outside ${quick ? 'business hours' : 'Mon–Fri 9–6'}).`);
    return true;
  }
  const fresh = await getRecord(T.messages, rec.id);
  try {
    const result = await sendApproved(fresh);
    await sendSMS(to, `${code} ${result}.`);
  } catch (e) {
    await sendSMS(to, `${code} failed to send: ${e.message.slice(0, 120)}`);
  }
  return true;
}

// ---------------------------------------------------------------- nurture cadence
// Each Nurture lead is on a track set by its Nurture Reason. The track decides how often Alex texts
// and what each text is about, rotating so nothing repeats and asks only come every few messages.
//   sale    – one recent nearby sale from the Market Sales table (never the same sale twice to a lead)
//   suburb  – a short wrap of recent sales in their suburb
//   tip     – a selling-prep tip from TIPS (never the same tip twice)
//   ask     – a light question about timing, or an offer of a free updated appraisal

const MS_TABLE = 'tblPfQKGokVJfPuN3';
const MS = {
  address: 'fld6Ya3TVCiy6EvM5', street: 'fldzC1MdamEiK1qQY', suburb: 'fldm2P7xaGkfOqtAk', type: 'fldexdbLviVOb4i1w',
  beds: 'flds3mgStHeDoTjJy', baths: 'fld5QO7IVIGLPESWY', cars: 'fldVQG0B5Pr7HLKl7', land: 'fldaVoYVw9WLCONL0',
  price: 'fldo7tVsAVAqamo4l', date: 'fldQ2NjHox6dH56az', dom: 'fldp15VbuAGxoFiCF', usable: 'fldcvXXIAYMNPBn9b',
  stone: 'fldzUlscPR8lmxPeg', quotedTo: 'fldWJEXHFpU1lxqHN'
};
const M_CONTENT = 'fldsb2ITupyCZ67y2';      // Alex Messages → Nurture Content
const L_MESSAGES = 'fldZjakyGET3iL1An';     // Leads → Alex Messages (inverse link)
const SALE_MAX_AGE_DAYS = 92;
const L_AUTH_ENDS = 'fldK9PEbayGAWN58s';   // Leads → Authority Ends (Track 8)
const L_SOLD = { date: 'fldZgX338TKAQcw24', price: 'fldZVXw0itDG4JGE5', agency: 'fldnkloI5sKozRTYi' };
const L_PARKED = 'fldneHAgicjDiwSGo';      // Leads → Parked for test (Alex ignores parked cards)
const L_LOST_REASON = 'fldBQPieV4jPtzHt9';
const UNANSWERED_LIMIT = 3;

// Agreed 20 Oct 2026 (Pipeline redesign doc). Track 1 (selling in 1–2 months) is no longer a nurture track: those cards move
// to Qualifying with a weekly agent follow-up (the Airtable 'card changed' automation does the move). No track pauses for
// silence any more – the time-on-track review decides. Day counts must match the Airtable automations.
const TRACKS = {
  2: { label: 'Track 2 · fortnightly', days: 14, seq: ['sale', 'tip', 'ask'], ask: 'soft' },
  3: { label: 'Track 3 · monthly', days: 30, seq: ['sale', 'tip', 'ask'], ask: 'full' },
  4: { label: 'Track 4 · every 2 months', days: 61, seq: ['sale', 'tip', 'suburb', 'ask'], ask: 'full' },
  // Cold / no contact: every 3 months, market news first, an in-person price update offer every 4th text
  5: { label: 'Track 5 · cold, every 3 months', days: 91, seq: ['market', 'sale', 'tip', 'ask'], ask: 'price', neverPause: true },
  // Annual check-in: recently moved in / settled, or a light touch to stay front of mind. A friendly text every 6 months
  // (alternating a check-in with a price-update offer and a plain local market update); the agent reviews the card each year.
  6: { label: 'Track 6 · annual check-in, 6-monthly text', days: 182, seq: ['annual', 'annual-market'], ask: null, neverPause: true,
       goal: 'This person has recently bought/moved in or settled, or simply gets a friendly text from us every six months so we stay front of mind. They are not selling. Keep it light and neighbourly - no selling tips and no pressure.' },
  // Rental providers / landlords whose property Stone manages: quarterly, investor angle, never property-management matters.
  7: { label: 'Track 7 · rental provider, 6-monthly', days: 182, seq: ['sale', 'market', 'ask'], ask: 'investor', neverPause: true,
       goal: 'This person is a rental provider (landlord) - the property on the card is their investment property, leased through Stone Ballarat\'s property management team. Talk about it as their investment property, never as their home. The aim is to stay front of mind as their local sales contact for a price update or appraisal, market advice, or help if they ever want to sell or buy another investment property. Never mention rent, tenants, the lease, repairs or anything the property management team handles, and never give financial or tax advice.' },
  // Listed with another agency: monthly. A friendly check-in, a recent nearby sale or market note for context, and - once,
  // around when their agreement ends - an offer of help. No selling tips or presentation advice (that is their agent's job).
  8: { label: 'Track 8 · listed elsewhere, monthly', days: 30, seq: ['checkin8', 'sale', 'checkin8', 'market'], ask: null, neverPause: true,
       goal: 'This person has listed their property for sale with ANOTHER agency. Stay a friendly, useful local contact so that if their agreement ends without a sale they think of us. Never criticise or compare their agent or agency, never give selling tips or presentation advice, never suggest ending their agreement early, never ask about their price or offers in detail.' }
};
function trackFor(fields) {
  const r = sel(fields[L.nurtureReason]);
  if (/listed|another agent/i.test(r)) return 8;
  if (/annual/i.test(r)) return 6;
  if (/rental provider|landlord/i.test(r)) return 7;
  if (/3 months|stalled|1.2 months/i.test(r)) return 2; // 1–2 months cards are moved to Qualifying by Airtable
  if (/no contact|cold|quiet/i.test(r)) return 5;
  if (/12 months/i.test(r)) return 4;
  return 3; // ~6 months, or not set
}

const TIPS = [
  ['declutter', 'Start decluttering early, one room or cupboard at a time - buyers open everything, and it makes moving easier too.'],
  ['small-repairs', 'Knock off the small fixes now - dripping taps, sticky doors, blown globes. Buyers add them up in their heads.'],
  ['street-appeal', 'First impressions start at the street: mow, trim, clean the front door and letterbox.'],
  ['paint', 'A fresh coat of neutral paint in the main living areas is one of the best-value prep jobs.'],
  ['paperwork', 'Pull the paperwork together early - rates notices, permits for any work done, warranties. It speeds up the vendor statement.'],
  ['section-32', 'In Victoria you need a vendor statement (Section 32) before going to market - worth lining up a conveyancer early.'],
  ['heating-energy', 'Ballarat buyers always ask about heating and insulation - keep a note of any upgrades (solar, split systems, insulation) and a recent bill.'],
  ['reno-check', 'Before spending on bigger renovations, have a quick chat with the agent about which jobs buyers actually pay for.'],
  ['light', 'Light and bright sells: clean windows, open blinds and swap any dim globes before photos and inspections.'],
  ['garden', 'A cheap garden refresh goes a long way - fresh mulch, a prune and a couple of pots by the front door.'],
  ['kitchen-bathroom', 'Kitchens and bathrooms sell homes - regrouting, new tapware or handles is a cheap facelift.'],
  ['next-move', 'Worth thinking early about the next move - buying first or selling first changes the timing, and the agent can talk it through.'],
  ['building-inspection', 'Some sellers get a pre-sale building inspection so there are no surprises once buyers start looking.'],
  ['inspection-ready', 'For inspections: fresh air, a quick tidy and keeping pets and their gear out of sight makes a real difference.']
];

// Neighbouring suburbs (used when there is no recent sale in their own suburb)
const NEIGHBOURS = {
  'Alfredton': ['Lake Gardens', 'Wendouree', 'Delacombe', 'Cardigan', 'Lucas', 'Lake Wendouree'],
  'Lucas': ['Alfredton', 'Delacombe', 'Cardigan'],
  'Delacombe': ['Sebastopol', 'Bonshaw', 'Alfredton', 'Lucas', 'Smythes Creek', 'Redan', 'Winter Valley'],
  'Bonshaw': ['Delacombe', 'Sebastopol', 'Smythes Creek', 'Winter Valley'],
  'Sebastopol': ['Redan', 'Delacombe', 'Bonshaw', 'Mount Pleasant', 'Mount Clear'],
  'Redan': ['Sebastopol', 'Ballarat Central', 'Lake Wendouree', 'Delacombe', 'Mount Pleasant'],
  'Winter Valley': ['Delacombe', 'Bonshaw', 'Smythes Creek', 'Cardigan'],
  'Smythes Creek': ['Bonshaw', 'Delacombe', 'Winter Valley'],
  'Cardigan': ['Lucas', 'Alfredton', 'Winter Valley', 'Cardigan Village'],
  'Wendouree': ['Lake Wendouree', 'Alfredton', 'Invermay Park', 'Miners Rest', 'Mitchell Park', 'Lake Gardens', 'Ballarat North', 'Soldiers Hill'],
  'Lake Wendouree': ['Wendouree', 'Ballarat Central', 'Soldiers Hill', 'Alfredton', 'Redan', 'Lake Gardens'],
  'Lake Gardens': ['Alfredton', 'Wendouree', 'Lake Wendouree'],
  'Ballarat Central': ['Lake Wendouree', 'Soldiers Hill', 'Bakery Hill', 'Golden Point', 'Redan', 'Black Hill', 'Ballarat North'],
  'Soldiers Hill': ['Ballarat North', 'Ballarat Central', 'Black Hill', 'Lake Wendouree', 'Wendouree'],
  'Ballarat North': ['Soldiers Hill', 'Invermay Park', 'Black Hill', 'Wendouree', 'Invermay', 'Nerrina'],
  'Invermay Park': ['Ballarat North', 'Wendouree', 'Invermay', 'Miners Rest'],
  'Black Hill': ['Ballarat North', 'Soldiers Hill', 'Ballarat Central', 'Brown Hill', 'Ballarat East', 'Nerrina'],
  'Brown Hill': ['Ballarat East', 'Black Hill', 'Nerrina', 'Warrenheip'],
  'Nerrina': ['Brown Hill', 'Black Hill', 'Ballarat North', 'Invermay'],
  'Ballarat East': ['Bakery Hill', 'Brown Hill', 'Black Hill', 'Golden Point', 'Canadian', 'Eureka', 'Warrenheip'],
  'Bakery Hill': ['Ballarat Central', 'Ballarat East', 'Golden Point'],
  'Golden Point': ['Ballarat Central', 'Bakery Hill', 'Ballarat East', 'Canadian', 'Mount Pleasant', 'Redan'],
  'Canadian': ['Golden Point', 'Ballarat East', 'Mount Pleasant', 'Mount Clear', 'Mount Helen', 'Eureka'],
  'Mount Pleasant': ['Golden Point', 'Canadian', 'Mount Clear', 'Sebastopol', 'Redan'],
  'Mount Clear': ['Mount Pleasant', 'Canadian', 'Mount Helen', 'Sebastopol', 'Buninyong'],
  'Mount Helen': ['Mount Clear', 'Canadian', 'Buninyong', 'Scotsburn'],
  'Buninyong': ['Mount Helen', 'Mount Clear', 'Scotsburn', 'Durham Lead', 'Navigators'],
  'Scotsburn': ['Buninyong', 'Mount Helen'],
  'Miners Rest': ['Invermay Park', 'Wendouree', 'Mitchell Park', 'Cardigan Village', 'Ascot'],
  'Ascot': ['Miners Rest', 'Invermay', 'Coghills Creek'],
  'Warrenheip': ['Brown Hill', 'Ballarat East', 'Dunnstown'],
  'Eureka': ['Ballarat East', 'Canadian'],
  'Invermay': ['Nerrina', 'Ballarat North', 'Invermay Park']
};
(function makeSymmetric() {
  for (const [a, list] of Object.entries(NEIGHBOURS)) for (const b of list) {
    NEIGHBOURS[b] = NEIGHBOURS[b] || [];
    if (!NEIGHBOURS[b].includes(a)) NEIGHBOURS[b].push(a);
  }
})();
const SUBURB_ALIASES = [[/\bmt\.?\s/gi, 'Mount '], [/\bnth\b/gi, 'North'], [/\bsth\b/gi, 'South'], [/\bsebas\b/gi, 'Sebastopol'], [/\bsoilders\b/gi, 'Soldiers']];

const STREET_SUFFIX = { rd: 'road', st: 'street', ct: 'court', crt: 'court', dr: 'drive', ave: 'avenue', av: 'avenue', pl: 'place', cres: 'crescent', cr: 'crescent', tce: 'terrace', pde: 'parade', hwy: 'highway', ln: 'lane', bvd: 'boulevard', blvd: 'boulevard', cl: 'close', gr: 'grove', wy: 'way' };
function streetKey(s) {
  const words = String(s || '').toLowerCase().replace(/[^a-z0-9/ ]/g, ' ').split(/\s+/).filter(Boolean);
  while (words.length && (/\d/.test(words[0]) || ['lot', 'unit', 'u'].includes(words[0]))) words.shift();
  return words.map(w => STREET_SUFFIX[w] || w).join(' ');
}
function numberKey(s) { const m = String(s || '').match(/^\s*(?:lot\s*)?([\d/a-z-]+)/i); return m ? m[1].toLowerCase() : ''; }

function suburbOf(address, knownSuburbs) {
  let a = ' ' + String(address || '') + ' ';
  for (const [re, rep] of SUBURB_ALIASES) a = a.replace(re, rep);
  const lower = a.toLowerCase();
  const hit = knownSuburbs.filter(s => lower.includes(' ' + s.toLowerCase())).sort((x, y) => y.length - x.length)[0];
  if (!hit) return { suburb: '', street: '' };
  const before = a.slice(0, lower.lastIndexOf(' ' + hit.toLowerCase())).replace(/,\s*$/, '').trim();
  return { suburb: hit, street: before };
}

let salesCache = { at: 0, rows: [] };
async function recentSales() {
  if (Date.now() - salesCache.at < 30 * 60000) return salesCache.rows;
  const cutoff = addDays(melbNow().date, -SALE_MAX_AGE_DAYS);
  const rows = await listAll(MS_TABLE, { filterByFormula: `AND({${MS.usable}}, IS_AFTER({${MS.date}}, '${cutoff}'))` });
  salesCache = { at: Date.now(), rows };
  return rows;
}
function fmtPrice(n) { return '$' + Math.round(n).toLocaleString('en-AU'); }
function monthName(iso) { return new Date(iso + 'T00:00:00Z').toLocaleString('en-AU', { month: 'long', timeZone: 'UTC' }); }

async function pickSale(leadId, address, alreadyUsed) {
  const sales = await recentSales();
  const known = Array.from(new Set(sales.map(s => s.fields[MS.suburb]).filter(Boolean).concat(Object.keys(NEIGHBOURS))));
  const { suburb, street } = suburbOf(address, known);
  if (!suburb) return null;
  const myStreet = streetKey(street), myNum = numberKey(street);
  const wantUnit = /\//.test(street) || /unit/i.test(street);
  const near = new Set(NEIGHBOURS[suburb] || []);
  const scored = [];
  for (const s of sales) {
    const f = s.fields;
    if ((f[MS.quotedTo] || []).includes(leadId) || alreadyUsed.has('sale:' + s.id)) continue;
    const sStreet = streetKey(f[MS.street]);
    if (sStreet === myStreet && numberKey(f[MS.street]) === myNum && f[MS.suburb] === suburb) continue; // their own home
    let tier;
    if (f[MS.suburb] === suburb && myStreet && sStreet === myStreet) tier = 0;
    else if (f[MS.suburb] === suburb) tier = 1;
    else if (near.has(f[MS.suburb])) tier = 2;
    else continue;
    const isUnit = /^unit/i.test(f[MS.type] || '');
    scored.push({ s, tier, typeMiss: isUnit === wantUnit ? 0 : 1, stone: f[MS.stone] ? 0 : 1, date: f[MS.date] || '' });
  }
  scored.sort((a, b) => a.tier - b.tier || a.typeMiss - b.typeMiss || a.stone - b.stone || (a.date < b.date ? 1 : -1));
  if (!scored.length) return null;
  const { s, tier } = scored[0];
  const f = s.fields;
  const bits = [f[MS.beds] ? f[MS.beds] + ' bed' : '', /^unit/i.test(f[MS.type] || '') ? 'unit' : 'house'].filter(Boolean).join(' ');
  return {
    key: 'sale:' + s.id, saleId: s.id, suburb, tier,
    fact: `${f[MS.address]} – ${bits}, sold ${fmtPrice(f[MS.price])} in ${monthName(f[MS.date])}` +
      (f[MS.dom] ? `, ${f[MS.dom]} days on market` : '') + (f[MS.stone] ? ' (sold by Stone Ballarat - you may say our team sold it)' : ''),
    where: tier === 0 ? 'in their street' : tier === 1 ? 'in their suburb' : 'in a neighbouring suburb (' + f[MS.suburb] + ')',
    plain: `Thought you might find this handy - ${f[MS.stone] ? 'our team sold ' : ''}${f[MS.address]}${f[MS.stone] ? ', a ' + bits + ',' : ' (' + bits + ')'} ${f[MS.stone] ? 'for' : 'sold for'} ${fmtPrice(f[MS.price])} in ${monthName(f[MS.date])}` +
      (f[MS.dom] ? `, ${f[MS.dom]} day${f[MS.dom] == 1 ? '' : 's'} on market` : '') + '. Just keeping you in the loop with what\'s moving locally.'
  };
}

async function suburbWrap(address, alreadyUsed) {
  const sales = await recentSales();
  const known = Array.from(new Set(sales.map(s => s.fields[MS.suburb]).filter(Boolean)));
  const { suburb } = suburbOf(address, known);
  if (!suburb) return null;
  const key = 'suburb:' + suburb + ':' + melbNow().date.slice(0, 7);
  if (alreadyUsed.has(key)) return null;
  const houses = sales.filter(s => s.fields[MS.suburb] === suburb && !/^unit/i.test(s.fields[MS.type] || '') && s.fields[MS.price]);
  if (houses.length < 2) return null;
  const prices = houses.map(s => s.fields[MS.price]).sort((a, b) => a - b);
  return { key, fact: `${houses.length} houses sold in ${suburb} over the last 3 months, from ${fmtPrice(prices[0])} to ${fmtPrice(prices[prices.length - 1])}` };
}

// Ballarat-wide wrap from Market Sales (once a month at most per lead)
async function ballaratWrap(alreadyUsed) {
  const key = 'market:' + melbNow().date.slice(0, 7);
  if (alreadyUsed.has(key)) return null;
  const sales = await recentSales();
  const houses = sales.filter(s => !/^unit/i.test(s.fields[MS.type] || '') && s.fields[MS.price]).map(s => s.fields[MS.price]).sort((a, b) => a - b);
  if (houses.length < 10) return null;
  const mid = houses.length % 2 ? houses[(houses.length - 1) / 2] : (houses[houses.length / 2 - 1] + houses[houses.length / 2]) / 2;
  const top = {};
  for (const s of sales) top[s.fields[MS.suburb]] = (top[s.fields[MS.suburb]] || 0) + 1;
  const busiest = Object.entries(top).sort((a, b) => b[1] - a[1]).slice(0, 3).map(x => x[0]).join(', ');
  return { key, fact: `across Ballarat, ${houses.length} houses with a disclosed price sold over the last 3 months at a middle price of about ${fmtPrice(Math.round(mid / 5000) * 5000)}; the busiest suburbs were ${busiest}` };
}

// The lead's past Alex messages (newest last)
async function leadMessages(leadFields) {
  const ids = (leadFields[L_MESSAGES] || []).slice(-40);
  if (!ids.length) return [];
  const recs = await listAll(T.messages, { filterByFormula: 'OR(' + ids.map(id => `RECORD_ID()='${id}'`).join(',') + ')' });
  return recs.sort((a, b) => String(a.fields[M.created] || a.createdTime) < String(b.fields[M.created] || b.createdTime) ? -1 : 1);
}
function unansweredCount(msgs) {
  let n = 0;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const dir = sel(msgs[i].fields[M.direction]);
    if (dir === 'From vendor') break;
    if (dir === 'To vendor' && sel(msgs[i].fields[M.status]) === 'Sent') n++;
  }
  return n;
}
function nurtureState(leadFields, msgs) {
  const track = trackFor(leadFields);
  const sentNurture = msgs.filter(m => sel(m.fields[M.purpose]) === 'Nurture check-in' && sel(m.fields[M.status]) === 'Sent');
  const used = new Set(msgs.map(m => m.fields[M_CONTENT]).filter(Boolean));
  const unanswered = unansweredCount(msgs);
  const t = TRACKS[track];
  const days = t.days;
  const askCount = sentNurture.filter(m => String(m.fields[M_CONTENT] || '').startsWith('ask:')).length;
  return { track, t, n: sentNurture.length, askCount, used, unanswered, days, recentTexts: sentNurture.slice(-4).map(m => m.fields[M.finalText] || m.fields[M.draft]) };
}

// Decide what this nurture text is about. Falls back sale → suburb → tip so there is always something useful.
async function planNurture(lead, st) {
  const address = lead.fields[L.address] || '';
  let type = st.t.seq[st.n % st.t.seq.length];
  if (st.track === 8) {
    // Once only, around when their agreement with the other agency ends (or after two texts if we don't know the date)
    const ends = lead.fields[L_AUTH_ENDS] || '';
    const today = melbNow().date;
    const offerDue = !st.used.has('offer8') && (ends ? ends <= addDays(today, 21) : st.n >= 2);
    if (offerDue) return {
      key: 'offer8', label: 'offer of help if their agreement ends',
      brief: 'Check in on how the sale is going, then say in one easy sentence that if their agreement finishes and they would like a fresh set of eyes, the agent is happy to help - no pressure at all. ' +
        'Never suggest ending their current agreement early, never criticise their agent, and keep it short and kind.'
    };
    if (type === 'checkin8') return {
      key: 'checkin8:' + today.slice(0, 7), label: 'how is the sale going',
      brief: 'Ask, in a friendly way, how the sale is going and whether they have had any enquiries that look promising. One easy question they can answer in a few words. No tips, no advice, never mention their agent or agency by name.'
    };
  }
  if (type === 'annual-market') {
    const wrap = (await suburbWrap(address, st.used)) || (await ballaratWrap(st.used));
    return {
      key: 'annual-market:' + melbNow().date.slice(0, 7), label: '6-monthly market update',
      brief: 'Write a short, friendly half-yearly hello' + (wrap ? ` sharing this local market snapshot in plain words: ${wrap.fact}.` : ' letting them know the agent is around if they ever have a property question.') +
        ' No offer, no questions they have to answer, zero pressure.'
    };
  }
  if (type === 'annual') {
    const wrap = (await suburbWrap(address, st.used)) || (await ballaratWrap(st.used));
    return {
      key: 'annual:' + melbNow().date.slice(0, 7), label: 'annual check-in',
      brief: 'Write their half-yearly check-in. Hope they are enjoying the place/the area' + (wrap ? `, share this quick local market snapshot in plain words: ${wrap.fact},` : ',') +
        ' and mention in one easy sentence that if they are ever curious what their place is worth, the agent is happy to pop out for a no-obligation price update (an accurate figure needs a visit - never give a price by text). No questions they have to answer, zero pressure.'
    };
  }
  if (type === 'ask' && st.t.ask === 'investor') {
    const kind = st.askCount % 2 === 0 ? 'investor-value' : 'investor-plans';
    return {
      key: 'ask:' + kind, label: kind === 'investor-value' ? 'investment price update offer' : 'investment plans check-in',
      brief: kind === 'investor-value'
        ? 'Offer, in one easy sentence, a free no-obligation price update on their investment property - handy for reviewing their portfolio, finance or insurance. The agent pops out to look; never give a price by text. Zero pressure.'
        : 'Ask one light question about whether their investment plans have changed - e.g. thinking of adding another property, or ever weighing up selling - and say the agent is always happy to talk the market through. Easy to reply in a few words, zero pressure.'
    };
  }
  if (type === 'ask') {
    const kind = st.t.ask === 'soft' ? 'timing' : st.t.ask === 'price' ? 'price-update' : (st.askCount % 2 === 0 ? 'timing' : 'appraisal');
    if (kind === 'price-update') return {
      key: 'ask:price-update', label: 'price update offer',
      brief: 'Lightly suggest that if they are ever curious what their place might be worth in today\'s market, the agent is happy to pop out for a quick, no-obligation look and give them an up-to-date price guide - an accurate figure needs a visit. Never offer a price over the phone, by text or online. One sentence for the offer, zero pressure, easy to ignore.'
    };
    return {
      key: 'ask:' + kind, label: kind === 'timing' ? 'timing check' : 'appraisal offer',
      brief: kind === 'timing'
        ? 'Ask one light, no-pressure question about whether their timing or plans have changed. Make it easy to reply in a few words.'
        : 'Offer a free, no-obligation updated market appraisal - the agent pops out to the property whenever it suits them (never offer a price over the phone, by text or online). One sentence, zero pressure, easy to ignore.'
    };
  }
  if (type === 'market') {
    const wrap = await ballaratWrap(st.used);
    if (wrap) return { key: wrap.key, label: 'Ballarat market update', brief: `Share this as a short Ballarat market update, in plain words: ${wrap.fact}. You may add one general, factual observation, but never forecast prices, never say what their home is worth and do not ask them for anything.` };
    type = 'sale';
  }
  if (type === 'sale') {
    const sale = await pickSale(lead.id, address, st.used);
    if (sale) return { key: sale.key, saleId: sale.saleId, label: 'recent sale ' + sale.where, fallback: sale.plain, brief: `Share this recent sale ${sale.where} as a helpful local update: ${sale.fact}. Use the address EXACTLY as written here - never change, shorten or invent an address. Do not say what their own home is worth and do not ask them for anything. Never name the selling agency unless it was Stone Ballarat.` };
    type = 'suburb';
  }
  if (type === 'suburb') {
    const wrap = await suburbWrap(address, st.used);
    if (wrap) return { key: wrap.key, label: 'suburb sales wrap', brief: `Share this as a quick local market update: ${wrap.fact}. Do not say what their own home is worth and do not ask them for anything.` };
  }
  if (st.track >= 6) {
    // no selling-prep tips for annual / rental-provider tracks - fall back to a Ballarat market update or a simple hello
    const wrap = await ballaratWrap(st.used);
    if (wrap) return { key: wrap.key, label: 'Ballarat market update', brief: `Share this as a short Ballarat market update, in plain words: ${wrap.fact}. Never forecast prices, never say what their property is worth and do not ask them for anything.` };
    return { key: 'hello:' + melbNow().date.slice(0, 7), label: 'friendly check-in', brief: 'Send a short, friendly check-in letting them know the agent is around if they ever want a price update or a chat about the market. Do not ask them for anything.' };
  }
  const tip = TIPS.find(([k]) => !st.used.has('tip:' + k)) || TIPS[st.n % TIPS.length];
  return { key: 'tip:' + tip[0], label: 'tip – ' + tip[0].replace(/-/g, ' '), brief: `Share this selling-prep tip in your own words, tied to their situation if the notes allow: ${tip[1]} Do not ask them for anything.` };
}

// (Pausing after unanswered texts was removed on 20 Oct 2026 – the time-on-track review decides instead.)

// ---------------------------------------------------------------- outbound sweep

async function alexActiveAgentIds() {
  const team = await listAll(T.team, { filterByFormula: `{${TM.alexActive}}` });
  return new Set(team.map(t => t.id));
}

// After a nurture draft is binned, move the card's next check-in on by its track so the round is skipped.
async function skipNurtureRound(leadId, code) {
  if (!leadId) return '';
  const lead = await getRecord(T.leads, leadId);
  if (sel(lead.fields[L.stage]) !== 'Nurture') return '';
  const st = nurtureState(lead.fields, await leadMessages(lead.fields));
  const next = addDays(melbNow().date, st.days);
  await updateRecord(T.leads, leadId, { [L.followUp]: next });
  await logActivity(leadId, { summary: `Alex draft ${code} binned – next check-in ${dmy(next)}`, type: 'Follow-up date changed', kind: 'History' });
  return next;
}

// Leads whose nurture draft was rejected or expired in the last 7 days - don't draft them again straight away
// (covers drafts rejected on the Airtable page, where the follow-up date isn't moved).
async function recentlyBinnedLeadIds() {
  const since = addDays(melbNow().date, -7);
  const recs = await listAll(T.messages, { filterByFormula: `AND(OR({${M.status}}='Rejected',{${M.status}}='Expired'),{${M.direction}}='To vendor',IS_AFTER({${M.created}},'${since}'))` });
  return new Set(recs.map(r => (r.fields[M.lead] || [])[0]).filter(Boolean));
}

async function eligibleLeads() {
  const agents = await alexActiveAgentIds();
  if (!agents.size) return [];
  const leads = await listAll(T.leads, {
    filterByFormula: `AND(OR({${L.stage}}='Nurture',{${L.stage}}='Qualifying'),NOT({${L.doNotContact}}),NOT({${L.pauseAlex}}),NOT({${L_PARKED}}),{${L.phone}}!='')`
  });
  const today = melbNow().date;
  const cutoff = Date.now() - MIN_DAYS_BETWEEN_TEXTS * 86400000;
  const waiting = await activeDrafts();
  const waitingLeadIds = new Set(waiting.map(w => (w.fields[M.lead] || [])[0]));
  const binnedLeadIds = await recentlyBinnedLeadIds();
  return leads.filter(l => {
    const f = l.fields;
    if (!(f[L.agent] || []).some(id => agents.has(id))) return false;
    if (!isTextableMobile(f[L.phone])) return false; // e.g. an email or landline typed into Phone
    if (waitingLeadIds.has(l.id)) return false;
    if (binnedLeadIds.has(l.id)) return false; // a draft was just binned - wait for the next round
    if (f[L.alexLastContact] && new Date(f[L.alexLastContact]).getTime() > cutoff) return false;
    const stage = sel(f[L.stage]);
    if (stage === 'Nurture') return !!f[L.followUp] && f[L.followUp] <= today;
    if (stage === 'Qualifying') return /^alex\b/i.test(f[L.nextAction] || '') && (!f[L.nextActionDate] || f[L.nextActionDate] <= today);
    return false;
  });
}

// Fixed opening so every text starts the same way:
// first text  -> "Hey Sonya, this is Alex from Stone Ballarat on behalf of Stu Brien."
// later texts -> "Hey Sonya, it's Alex from Stone."
// Street addresses like "14 Somewhere Street" or "160 Cuthberts Rd"
const ADDRESS_RE = /\b\d+[A-Za-z]?(?:\/\d+[A-Za-z]?)?\s+(?:[A-Z][\w'-]*\s+){1,3}(?:Street|St|Road|Rd|Drive|Dr|Court|Ct|Crt|Avenue|Ave|Lane|Ln|Place|Pl|Crescent|Cres|Way|Close|Cl|Boulevard|Blvd|Bvd|Terrace|Tce|Highway|Hwy|Parade|Pde|Grove|Gr|Circuit|Cct|Rise|Track)\b/g;
function addrKey(a) {
  const m = String(a).match(/(\d+[A-Za-z]?)(?:\/(\d+[A-Za-z]?))?\s+([A-Za-z'-]+)/);
  return m ? (m[1] + (m[2] ? '/' + m[2] : '') + ' ' + m[3]).toLowerCase() : '';
}
function unknownAddresses(text, allowedSources) {
  const allowedText = allowedSources.filter(Boolean).join(' \n ');
  const ok = new Set((allowedText.match(ADDRESS_RE) || []).map(addrKey));
  // also allow "160 Cuthberts" written without the street type
  const loose = allowedText.toLowerCase();
  return (String(text).match(ADDRESS_RE) || []).filter(a => !ok.has(addrKey(a)) && !loose.includes(addrKey(a)));
}

function smsOpening(ctx, firstContact) {
  const n = ctx.card.firstName;
  const usable = n && !/^(\d|lot\b)/i.test(n) && !/\d/.test(ctx.card.contactName.split(',')[0].split(' ')[0]);
  const hey = usable ? `Hey ${n},` : 'Hey there,';
  if (!firstContact) return `${hey} it's Alex from Stone.`; // every text says who it's from
  const agent = ctx.agent ? ctx.agent.name : 'our sales team';
  return `${hey} this is Alex from Stone Ballarat on behalf of ${agent}.`;
}

async function draftOutbound(lead) {
  const ctx = await leadContext(lead);
  const stage = ctx.card.stage;
  const purpose = stage === 'Nurture' ? 'Nurture check-in' : 'Appraisal booking';
  let goal, plan = null, st = null;
  if (purpose === 'Nurture check-in') {
    st = nurtureState(lead.fields, await leadMessages(lead.fields));
    plan = await planNurture(lead, st);
    goal = 'Write a nurture text. ' + plan.brief + ' ' + (st.t.goal || 'Keep it warm and useful - this person is not ready yet, so the aim is simply to be helpful and let them know we are here if they have questions.') +
      (st.recentTexts.length ? '\nRECENT TEXTS ALEX ALREADY SENT THEM (do not repeat their wording, openers or ideas):\n' + st.recentTexts.map(t => '- ' + t).join('\n') : '');
  } else {
    goal = `Write a message offering to book a free market appraisal${ctx.card.appraisalType ? ' (' + ctx.card.appraisalType + ')' : ''} with the agent, asking what days or times generally suit them. Do not offer specific times.`;
  }
  const firstContact = !ctx.history.some(h => h.author === 'Alex');
  const opening = smsOpening(ctx, firstContact);
  const user =
    `AGENT: ${ctx.agent ? ctx.agent.name : 'the agent'}\n` +
    `LEAD CARD: ${JSON.stringify(ctx.card)}\n\nNOTES & HISTORY (oldest first):\n${historyText(ctx.history)}\n\n` +
    `TASK: ${goal}\n\nThe message will automatically start with: "${opening}" - write ONLY what comes after that. ` +
    'Do not greet them again, do not introduce Alex again and do not sign off.\n\n' +
    'Return JSON only: {"sms": "...", "reasoning": "one short sentence for the agent on what you picked up from the card"}';
  const tidy = sms => {
    let b = String(sms || '').trim()
      .replace(/^(hey|hi|hello)\b[^,.!]*[,.!]\s*/i, '')            // drop a repeated greeting
      .replace(/^(this is|it's|it is|i'm)\s+alex\b[^.!?]*[.!?]\s*/i, ''); // drop a repeated intro
    return b.charAt(0).toUpperCase() + b.slice(1);
  };
  // Guard against made-up addresses: every street address in the text must be one we gave it
  const allowed = [goal, ctx.card.address, ctx.card.contactName];
  let out = await claudeJSON(VOICE, user, 500);
  let body = tidy(out.sms);
  let bad = unknownAddresses(body, allowed);
  if (bad.length) {
    console.warn('Alex leads: draft had an address not in the brief (' + bad.join(', ') + ') – retrying');
    out = await claudeJSON(VOICE, user + `\n\nIMPORTANT: your last attempt mentioned "${bad.join('", "')}", which is not a real address from the brief. Only mention addresses exactly as given above.`, 500);
    body = tidy(out.sms);
    bad = unknownAddresses(body, allowed);
  }
  if (bad.length) {
    console.warn('Alex leads: still an unknown address – using the plain fallback text');
    body = plan && plan.fallback ? plan.fallback : body.replace(ADDRESS_RE, 'a nearby home');
  }
  let draft = plainSMS(opening + ' ' + body);
  if ((firstContact || purpose === 'Nurture check-in') && !draft.includes(OPT_OUT_LINE)) draft += ' ' + OPT_OUT_LINE;
  const reasoning = (plan ? `${st.t.label}, text ${st.n + 1}: ${plan.label}. ` : '') + String(out.reasoning || '').trim();
  return { ctx, purpose, draft, reasoning, content: plan ? plan.key : '', trackLabel: st ? st.t.label : '' };
}

// ---------------------------------------------------------------- nurture: schedule → midday preview → 2pm send
// Agreed 20 Oct 2026: no approval text for each nurture message. Alex drafts the day's nurture texts in the morning
// (status Scheduled), at 12pm texts each agent ONE preview of what is going out, and sends at 2pm unless the agent
// replies CHANGE <code> … or CANCEL <code>. A cancelled text skips that round; it is not redrafted.
const DAILY_NURTURE_CAP = 5;      // nurture texts per agent per day
const PREVIEW_HOUR = 12;
const SEND_HOUR = 14;
const MIN_PREVIEW_LEAD_MINUTES = 90; // a text always goes at least 90 min after its preview

let teamCache = { at: 0, rows: [] };
async function teamRows() {
  if (Date.now() - teamCache.at < 10 * 60000) return teamCache.rows;
  teamCache = { at: Date.now(), rows: await listAll(T.team) };
  return teamCache.rows;
}
async function teamByPhone(from) {
  return (await teamRows()).find(t => samePhone(t.fields[TM.mobile], from)) || null;
}
async function teamById(id) { return (await teamRows()).find(t => t.id === id) || null; }

async function leadsByIds(ids) {
  const out = [];
  const list = Array.from(new Set(ids.filter(Boolean)));
  for (let i = 0; i < list.length; i += 40) {
    const chunk = list.slice(i, i + 40);
    out.push(...await listAll(T.leads, { filterByFormula: 'OR(' + chunk.map(id => `RECORD_ID()='${id}'`).join(',') + ')' }));
  }
  return out;
}

// Short description of a drafted nurture text for the preview, e.g. "recent sale in their suburb"
function planLabel(rec) {
  const m = String(rec.fields[M.reasoning] || '').match(/text \d+: ([^.]+)\./);
  return m ? m[1] : 'check-in';
}

// How many nurture texts each agent already has today (scheduled, previewed or sent)
async function nurtureCountsToday() {
  const today = melbNow().date;
  const recs = await listAll(T.messages, { filterByFormula: `AND({${M.purpose}}='Nurture check-in',OR({${M.status}}='Scheduled',{${M.status}}='Previewed',{${M.status}}='Sent'),DATETIME_FORMAT(SET_TIMEZONE({${M.created}},'${TZ}'),'YYYY-MM-DD')='${today}')` });
  const leads = await leadsByIds(recs.map(r => (r.fields[M.lead] || [])[0]));
  const agentOf = Object.fromEntries(leads.map(l => [l.id, (l.fields[L.agent] || [])[0]]));
  const counts = {};
  for (const r of recs) { const a = agentOf[(r.fields[M.lead] || [])[0]]; if (a) counts[a] = (counts[a] || 0) + 1; }
  return counts;
}

async function scheduleNurtureDrafts() {
  const due = (await eligibleLeads()).filter(l => sel(l.fields[L.stage]) === 'Nurture');
  if (!due.length) return;
  const counts = await nurtureCountsToday();
  let made = 0;
  // oldest follow-up date first, so anyone overdue goes before someone due today
  due.sort((a, b) => String(a.fields[L.followUp] || '') < String(b.fields[L.followUp] || '') ? -1 : 1);
  for (const lead of due) {
    if (made >= 8) break; // keep each sweep short; the next sweep carries on
    const agentId = (lead.fields[L.agent] || [])[0];
    if ((counts[agentId] || 0) >= DAILY_NURTURE_CAP) continue;
    try {
      const d = await draftOutbound(lead);
      if (!d || !d.draft) continue;
      const code = await nextCode();
      await createRecord(T.messages, {
        [M.code]: code, [M.lead]: [lead.id], [M.direction]: 'To vendor', [M.purpose]: 'Nurture check-in', [M.status]: 'Scheduled',
        [M.draft]: d.draft, [M.reasoning]: d.reasoning || '', [M.number]: normalisePhone(lead.fields[L.phone]), [M_CONTENT]: d.content || ''
      });
      counts[agentId] = (counts[agentId] || 0) + 1;
      made++;
      console.log('Alex leads: nurture text ' + code + ' scheduled for ' + lead.id);
    } catch (e) { console.error('Alex leads: nurture draft failed for ' + lead.id, e.message); }
  }
}

// One preview text per agent at 12pm listing the texts going out at 2pm
async function sendMiddayPreviews() {
  const recs = await listAll(T.messages, { filterByFormula: `{${M.status}}='Scheduled'` });
  if (!recs.length) return;
  const leads = await leadsByIds(recs.map(r => (r.fields[M.lead] || [])[0]));
  const leadById = Object.fromEntries(leads.map(l => [l.id, l]));
  const byAgent = {};
  for (const r of recs) {
    const lead = leadById[(r.fields[M.lead] || [])[0]];
    const agentId = lead ? (lead.fields[L.agent] || [])[0] || 'none' : 'none';
    (byAgent[agentId] = byAgent[agentId] || []).push({ r, lead });
  }
  const sendAt = melbNow().hour >= SEND_HOUR ? 'in about 90 minutes' : 'at 2pm';
  for (const [agentId, items] of Object.entries(byAgent)) {
    const agent = agentId === 'none' ? null : await teamById(agentId);
    const to = agent && isTextableMobile(agent.fields[TM.mobile]) ? normalisePhone(agent.fields[TM.mobile]) : approverMobile();
    const lines = items.map(({ r, lead }) => `${r.fields[M.code]} – ${lead ? lead.fields[L.name] : 'unknown card'}: ${planLabel(r)}`);
    const first = items[0].r.fields[M.code];
    const text = `Alex – nurture texts going ${sendAt}:\n${lines.join('\n')}\n\nReply SHOW ${first} to see one, CHANGE ${first} [what to change] or CANCEL ${first}, or edit them on the Alex's Texts page in Airtable. No reply needed otherwise.`;
    try {
      await sendSMS(to, text);
      for (const { r } of items) await updateRecord(T.messages, r.id, { [M.status]: 'Previewed', [M.approvedAt]: new Date().toISOString(), [M.approvedBy]: 'Midday preview' });
      console.log(`Alex leads: midday preview sent (${items.length} texts) to ${agent ? agent.fields[TM.name] : 'approver'}`);
    } catch (e) { console.error('Alex leads: preview failed', e.message); }
  }
}

async function sendPreviewedTexts() {
  const recs = await listAll(T.messages, { filterByFormula: `{${M.status}}='Previewed'` });
  const cutoff = Date.now() - MIN_PREVIEW_LEAD_MINUTES * 60000;
  for (const r of recs) {
    const at = r.fields[M.approvedAt] ? new Date(r.fields[M.approvedAt]).getTime() : 0;
    if (at > cutoff) continue;
    try { const res = await sendApproved(r); console.log('Alex leads: sent ' + r.fields[M.code] + ' ' + res); }
    catch (e) { console.error('Alex leads: send failed', e.message); }
  }
}

// ---------------------------------------------------------------- Track 8 housekeeping (once a day)
// Listed elsewhere: stop when Market Sales shows the property sold; when their agreement has ended unsold,
// move the card back to Qualifying with a call task for the agent.
function ownSale(address, sales) {
  const known = Array.from(new Set(sales.map(s => s.fields[MS.suburb]).filter(Boolean).concat(Object.keys(NEIGHBOURS))));
  const { suburb, street } = suburbOf(address, known);
  if (!suburb || !street) return null;
  const k = streetKey(street), n = numberKey(street);
  if (!k || !n) return null;
  return sales.find(s => s.fields[MS.suburb] === suburb && streetKey(s.fields[MS.street]) === k && numberKey(s.fields[MS.street]) === n) || null;
}
async function textAgentOf(lead, text) {
  const agent = await teamById((lead.fields[L.agent] || [])[0]);
  const to = agent && isTextableMobile(agent.fields[TM.mobile]) ? normalisePhone(agent.fields[TM.mobile]) : approverMobile();
  try { await sendSMS(to, text); } catch (e) { console.error('Alex leads: agent text failed', e.message); }
}
let lastHousekeepDate = null;
async function track8Housekeeping() {
  const today = melbNow().date;
  if (lastHousekeepDate === today) return;
  lastHousekeepDate = today;
  const agents = await alexActiveAgentIds();
  const leads = (await listAll(T.leads, { filterByFormula: `AND({${L.stage}}='Nurture',NOT({${L_PARKED}}),NOT({${L.pauseAlex}}),FIND('another agent',{${L.nurtureReason}}&''))` }))
    .filter(l => (l.fields[L.agent] || []).some(id => agents.has(id)));
  if (!leads.length) return;
  const sales = await recentSales();
  for (const lead of leads) {
    const f = lead.fields;
    const first = firstName(f[L.name]) || f[L.name];
    const sale = ownSale(f[L.address], sales);
    try {
      if (sale) {
        const sf = sale.fields;
        await updateRecord(T.leads, lead.id, {
          [L.pauseAlex]: true, [L_SOLD.date]: sf[MS.date] || null, [L_SOLD.price]: sf[MS.price] || null,
          [L.nextAction]: `${first}'s property sold through another agency – move to the Annual check-in track or close the card`, [L.nextActionDate]: today
        });
        await logActivity(lead.id, { summary: `Market Sales shows ${f[L.address]} sold${sf[MS.price] ? ' for ' + fmtPrice(sf[MS.price]) : ''}${sf[MS.date] ? ' (' + dmy(sf[MS.date]) + ')' : ''} – Alex has stopped Track 8 texts`, type: 'General', kind: 'History' });
        await textAgentOf(lead, `${f[L.name]}, ${f[L.address]} has sold through another agency${sf[MS.price] ? ' (' + fmtPrice(sf[MS.price]) + ')' : ''}. I've stopped the Track 8 texts. Suggest moving them to the Annual check-in track (or a buyer chat if they're buying next) – it's a task on the card.`);
      } else if (f[L_AUTH_ENDS] && f[L_AUTH_ENDS] < today) {
        await updateRecord(T.leads, lead.id, {
          [L.stage]: 'Qualifying',
          [L.nextAction]: `Call ${first} – their agreement with the other agency has ended`, [L.nextActionDate]: today
        });
        await logActivity(lead.id, { summary: `Authority with the other agency ended ${dmy(f[L_AUTH_ENDS])} with no sale showing – moved to Qualifying`, type: 'General', kind: 'History' });
        await textAgentOf(lead, `${f[L.name]}'s agreement with the other agency ended ${dmy(f[L_AUTH_ENDS])} and Market Sales doesn't show a sale. I've moved the card to Qualifying with a call task for today.`);
      }
    } catch (e) { console.error('Alex leads: track 8 housekeeping failed for ' + lead.id, e.message); }
  }
}

let lastDigestDate = null;
async function sweep() {
  if (!sweepEnabled()) return;
  if (!inSendWindow()) return;
  const now = melbNow();
  try {
    // 1. send anything Stu approved outside hours (replies to vendors and appraisal-booking texts still go via approval)
    const approved = await listAll(T.messages, { filterByFormula: `OR({${M.status}}='Approved',{${M.status}}='Edited & approved')` });
    for (const r of approved) {
      try { const res = await sendApproved(r); console.log('Alex leads: sent approved ' + r.fields[M.code] + ' ' + res); }
      catch (e) { console.error('Alex leads: send failed', e.message); }
    }

    // 2. morning digest of drafts still waiting from earlier days; expire after 3 days
    const today = now.date;
    const waiting = await waitingDrafts();
    const old = waiting.filter(w => String(w.fields[M.created] || w.createdTime).slice(0, 10) < today);
    for (const w of old) {
      const ageDays = (Date.now() - new Date(w.fields[M.created] || w.createdTime).getTime()) / 86400000;
      if (ageDays > 3) await updateRecord(T.messages, w.id, { [M.status]: 'Expired' });
    }
    if (lastDigestDate !== today) {
      const stillWaiting = (await waitingDrafts()).filter(w => String(w.fields[M.created] || w.createdTime).slice(0, 10) < today);
      if (stillWaiting.length) {
        await sendSMS(approverMobile(), `Morning – ${stillWaiting.length} Alex draft(s) still waiting: ${stillWaiting.map(w => w.fields[M.code]).join(', ')}. Reply YES/EDIT/NO with the code, or LIST.`);
      }
      lastDigestDate = today;
    }

    // 3. Track 8 housekeeping (sold / agreement ended) and lost-card follow-ups, once a day
    await track8Housekeeping();
    await lostHousekeeping();

    // 4. nurture texts: draft in the morning, preview at 12, send from 2pm
    if (now.hour < PREVIEW_HOUR) await scheduleNurtureDrafts();
    else await sendMiddayPreviews();
    if (now.hour >= SEND_HOUR) await sendPreviewedTexts();

    // 5. appraisal-booking drafts for Qualifying cards whose task starts with "Alex" – still approved by Stu
    const qual = (await eligibleLeads()).filter(l => sel(l.fields[L.stage]) === 'Qualifying').slice(0, 3);
    for (const lead of qual) {
      try {
        const d = await draftOutbound(lead);
        if (d && d.draft) await queueDraft({ lead, ctx: d.ctx, purpose: d.purpose, draft: d.draft, reasoning: d.reasoning, content: d.content, trackLabel: d.trackLabel });
      } catch (e) { console.error('Alex leads: draft failed for ' + lead.id, e.message); }
    }
  } catch (e) {
    console.error('Alex leads: sweep error', e.message);
  }
}

// ---------------------------------------------------------------- inbound from vendors

async function findLeadByPhone(from) {
  const digits = normalisePhone(from).replace('+61', '');
  // Airtable phone fields are free text: strip spaces and compare the last 9 digits
  const formula = `RIGHT(REGEX_REPLACE({${L.phone}}&'','[^0-9]',''),9)='${digits.slice(-9)}'`;
  const found = await listAll(T.leads, { filterByFormula: formula, maxRecords: '5' });
  if (!found.length) return null;
  // prefer an active / nurture card over closed ones
  const rank = s => (['Lost', 'Lost / Not Progressing', 'Listed (Won)', 'Authority Signed'].includes(s) ? 1 : 0);
  return found.sort((a, b) => rank(sel(a.fields[L.stage])) - rank(sel(b.fields[L.stage])))[0];
}

async function isPilotLead(lead) {
  if (!lead) return false;
  const agents = await alexActiveAgentIds();
  return (lead.fields[L.agent] || []).some(id => agents.has(id));
}

// Returns true when handled (pilot lead); false to let the normal Alex chat flow run
async function handleVendorSMS(from, body) {
  if (!enabled()) return false;
  const lead = await findLeadByPhone(from);
  if (!(await isPilotLead(lead))) return false;
  const f = lead.fields;
  const text = (body || '').trim();

  await createRecord(T.messages, {
    [M.lead]: [lead.id], [M.direction]: 'From vendor', [M.status]: 'Received', [M.finalText]: text, [M.number]: normalisePhone(from), [M.purpose]: 'Other'
  });
  await logActivity(lead.id, { summary: `${firstName(f[L.name]) || 'Vendor'} replied to Alex`, detail: text, type: 'SMS' });

  if (/^(STOP|UNSUBSCRIBE|QUIT|CANCEL|END|STOPALL)$/i.test(text)) {
    await updateRecord(T.leads, lead.id, { [L.doNotContact]: true });
    await logActivity(lead.id, { summary: 'Vendor opted out by SMS – Do Not Contact ticked', type: 'General', kind: 'History' });
    await sendSMS(from, OPT_OUT_ACK);
    await sendSMS(approverMobile(), `${f[L.name]} replied STOP – Do Not Contact is now ticked.`);
    return true;
  }
  if (f[L.doNotContact]) return true; // log only, never reply

  // New-lead conversation (Alex engaging): reply straight away within firm limits – no approval
  const nl = getState(lead);
  if (nl.flow === 'newlead' && ['engaging', 'noreply_asked', 'chasing', 'conversing'].includes(nl.phase)) {
    await handleNewLeadReply(lead, from, text);
    return true;
  }
  // Replying with a better time after the agent's missed call
  if (nl.awaitingCallTime) {
    try { if (await handleCallTimeReply(lead, from, text)) return true; } catch (e) { console.error('Alex leads: call time reply failed', e.message); }
  }
  const booked = ['Appraisal Booked', 'Listing Meeting Booked'].includes(sel(f[L.stage]));

  const ctx = await leadContext(await getRecord(T.leads, lead.id));
  const today = melbNow().date;
  const user =
    `TODAY: ${today}\nAGENT: ${ctx.agent ? ctx.agent.name : 'the agent'}\nLEAD CARD: ${JSON.stringify(ctx.card)}\n\nNOTES & HISTORY (oldest first):\n${historyText(ctx.history)}\n\n` +
    `THE VENDOR JUST TEXTED: "${text}"\n\n` +
    (/rental provider|landlord/i.test(sel(f[L.nurtureReason])) ? 'NOTE: this person is a rental provider - the card property is their investment property, managed by Stone Ballarat\'s property management team. If they raise rent, tenants, the lease, repairs, maintenance or anything else property management handles, do not try to answer it: reply that you\'ll pass it straight to our property management team, and set urgent_for_agent true with the details in reasoning.\n\n' : '') +
    'Work out what this means for the agent and draft Alex\'s reply. Return JSON only:\n' +
    '{"reply_sms": "Alex\'s reply (or empty string if no reply is needed)",\n' +
    ' "reasoning": "one short sentence for the agent",\n' +
    ' "key_fact": "a short new fact worth adding to Key Facts, or empty",\n' +
    ' "new_follow_up_date": "YYYY-MM-DD if their timing changed (e.g. call me in March) else empty",\n' +
    ' "wants_appraisal": true/false, "appraisal_type": "Face to face|Desktop|", "preferred_times": "what they said about days/times, or empty",\n' +
    ' "urgent_for_agent": true/false (true if they want to talk to the agent now, are ready to list, or are upset),\n' +
    ' "wants_agent_contact": true/false - true ONLY if they ask for the agent to call/contact them, ask to talk to someone, or say they are ready to sell/list now,\n' +
    ' "new_timeframe": if they told us a new selling timeframe, EXACTLY one of "Selling in 1–2 months" | "Not quite ready (~3 months)" | "Too early (~6 months)" | "Curious (12 months+)", else empty,\n' +
    ' "listed_elsewhere": true/false - true ONLY if they say they have listed or signed with another agent/agency. If so, reply_sms must be gracious and short, e.g. "No worries at all – best of luck with the sale." Never criticise the other agency,\n' +
    (booked ? ' "wants_reschedule": true/false - true ONLY if they ask to move, change or cancel their booked ' + (sel(f[L.stage]) === 'Appraisal Booked' ? 'appraisal' : 'listing meeting') + ' (Alex then checks with the agent; reply_sms can be empty),\n' : '') +
    ' "wants_no_contact": true/false - true ONLY if they clearly ask us to stop texting / leave them alone / take them off the list, or say they are no longer selling and do not want to hear from us. "Not yet" or "try me in March" is NOT an opt-out - move the follow-up date instead. If unsure, false and set urgent_for_agent}';
  const out = await claudeJSON(VOICE + ' You also extract facts for the agent accurately and conservatively.', user, 700);

  if (out.wants_no_contact === true) {
    await updateRecord(T.leads, lead.id, { [L.doNotContact]: true });
    await logActivity(lead.id, { summary: 'Vendor asked to be left alone – Do Not Contact ticked by Alex', detail: text, type: 'General', kind: 'History' });
    await sendSMS(from, OPT_OUT_ACK);
    await sendSMS(approverMobile(), `${f[L.name]} asked to be left alone: "${text.slice(0, 200)}"\nDo Not Contact is now ticked and Alex replied: "${OPT_OUT_ACK}"\nIf Alex misread this, untick Do Not Contact on the card.`);
    return true;
  }

  if (booked && out.wants_reschedule === true) { await startReschedule(lead, from, text); return true; }

  // Appraisal request or "can someone call me": hand the card straight to its agent.
  if (out.wants_appraisal === true || out.wants_agent_contact === true) {
    await handoffToAgent({ lead, ctx, out, text, from });
    return true;
  }

  const extra = [];
  const leadUpd = {};
  if (out.listed_elsewhere === true) {
    const st = sel(f[L.stage]);
    if (st === 'Nurture') leadUpd[L.nurtureReason] = 'Listed with another agent (Track 8)';
    else if (!['Lost / Not Progressing', 'Listed (Won)'].includes(st)) { leadUpd[L.stage] = 'Lost / Not Progressing'; leadUpd[L_LOST_REASON] = 'Listed with competitor'; }
    extra.push('Listed with another agency – moved to Track 8 · Listed elsewhere. If you know when their agreement ends, add it to Authority Ends on the card.');
    out.new_timeframe = '';
    out.new_follow_up_date = '';
  }
  if (out.key_fact) {
    const stamp = dmy(today) + '/' + today.slice(2, 4);
    leadUpd[L.keyFacts] = ((f[L.keyFacts] || '').trim() + `\n• ${out.key_fact} (${stamp}, via Alex)`).trim();
    extra.push('Key fact added: ' + out.key_fact);
  }
  const TIMEFRAMES = ['Selling in 1–2 months', 'Not quite ready (~3 months)', 'Too early (~6 months)', 'Curious (12 months+)'];
  if (out.new_timeframe && TIMEFRAMES.includes(out.new_timeframe) && out.new_timeframe !== sel(f[L.nurtureReason])) {
    leadUpd[L.nurtureReason] = out.new_timeframe;
    extra.push(`Timeframe now "${out.new_timeframe}" – Alex's nurture rhythm adjusts to match`);
  }
  let prevFollowUp = null;
  if (out.new_follow_up_date && /^\d{4}-\d{2}-\d{2}$/.test(out.new_follow_up_date) && out.new_follow_up_date !== f[L.followUp]) {
    prevFollowUp = f[L.followUp] || 'none';
    leadUpd[L.followUp] = out.new_follow_up_date;
    extra.push(`Follow-up moved ${f[L.followUp] ? dmy(f[L.followUp]) : '(none)'} → ${dmy(out.new_follow_up_date)}`);
  }
  if (out.wants_appraisal) {
    leadUpd[L.nextAction] = 'Book appraisal' + (out.preferred_times ? ' – vendor said: ' + out.preferred_times : '');
    leadUpd[L.nextActionDate] = today;
    if (out.appraisal_type) leadUpd[L.apptType] = out.appraisal_type;
    extra.push('Wants an appraisal' + (out.preferred_times ? ': ' + out.preferred_times : '') + ' – Next Action set to book it');
  }
  if (Object.keys(leadUpd).length) {
    await updateRecord(T.leads, lead.id, leadUpd);
    // A Nurture Reason change makes the Airtable "card changed" automation reset the follow-up date to the
    // new track. If the vendor also named a date, put their date back once the automation has run.
    if (leadUpd[L.nurtureReason] && leadUpd[L.followUp]) {
      const keep = leadUpd[L.followUp];
      setTimeout(() => updateRecord(T.leads, lead.id, { [L.followUp]: keep }).catch(e => console.error('Alex leads: re-set follow-up failed', e.message)), 45000);
    }
    if (out.key_fact) await logActivity(lead.id, { summary: 'Key Facts updated by Alex', detail: out.key_fact, type: 'Key Facts updated', kind: 'History' });
    if (prevFollowUp) await logActivity(lead.id, { summary: `Follow-up date changed to ${dmy(out.new_follow_up_date)} by Alex`, detail: text, type: 'Follow-up date changed', kind: 'History' });
  }
  if (out.urgent_for_agent) extra.unshift('⚠ Needs the agent: they may want to talk now.');

  const reply = String(out.reply_sms || '').trim();
  if (reply) {
    const code = await queueDraft({
      lead, ctx, purpose: out.wants_appraisal ? 'Appraisal booking' : 'Reply to vendor', draft: reply,
      reasoning: (out.reasoning || '') + (prevFollowUp ? ` PREV_FOLLOW_UP=${prevFollowUp}` : ''),
      extraLines: [`They said: "${text.slice(0, 300)}"`].concat(extra, prevFollowUp ? ['Reply KEEP <code> to undo the date change.'] : [])
    });
    console.log('Alex leads: reply draft ' + code + ' for ' + lead.id);
  } else if (extra.length) {
    await sendSMS(approverMobile(), `${f[L.name]} replied: "${text.slice(0, 300)}"\n${extra.join('\n')}`);
  }
  return true;
}

// ---------------------------------------------------------------- handoff to the agent
// The vendor asked for an appraisal or to talk to someone. Alex:
//  1. moves the card to Qualifying with "Call <name> – asked for an appraisal" due today (shows in the agent's My Day),
//  2. stops nurture texts (card is no longer in Nurture; any nurture drafts waiting for approval are binned),
//  3. replies to the vendor straight away naming the agent ("I'll ask Jamie to give you a call"),
//  4. texts the card's agent only (falls back to the approver if the agent has no mobile in Team).
async function handoffToAgent({ lead, ctx, out, text, from }) {
  const f = lead.fields;
  const name = f[L.name] || 'Vendor';
  const first = firstName(f[L.name]);
  const agentFirst = ctx.agent ? ctx.agent.firstName : '';
  const appraisal = out.wants_appraisal === true;
  const today = melbNow().date;
  const stage = sel(f[L.stage]);
  const reason = appraisal ? 'asked for an appraisal' : 'asked for a call';
  const times = String(out.preferred_times || '').trim();

  const upd = {
    [L.nextAction]: `Call ${first || name} – ${reason}` + (times ? ` (${times})` : ''),
    [L.nextActionDate]: today
  };
  if (['Nurture', 'New', ''].includes(stage)) upd[L.stage] = 'Qualifying';
  if (appraisal && out.appraisal_type) upd[L.apptType] = out.appraisal_type;
  if (out.key_fact) {
    const stamp = dmy(today) + '/' + today.slice(2, 4);
    upd[L.keyFacts] = ((f[L.keyFacts] || '').trim() + `\n• ${out.key_fact} (${stamp}, via Alex)`).trim();
  }
  await updateRecord(T.leads, lead.id, upd);

  // Bin any nurture drafts still waiting for approval on this card
  try {
    const pending = await listAll(T.messages, { filterByFormula: `AND({${M.status}}='Awaiting approval',{${M.direction}}='To vendor',FIND('${lead.id}',ARRAYJOIN({${M.lead}})))` });
    for (const p of pending) await updateRecord(T.messages, p.id, { [M.status]: 'Rejected', [M.error]: 'Superseded – vendor asked for the agent' });
  } catch (e) { console.error('Alex leads: could not clear pending drafts', e.message); }

  // Immediate, fixed-wording acknowledgement to the vendor
  const hi = first ? `Thanks ${first}` : 'Thanks';
  const who = agentFirst || 'one of our agents';
  const ack = appraisal
    ? `${hi}, I'll ask ${who} to give you a call to find a time for the appraisal. – Alex, Stone Ballarat`
    : `${hi}, I'll ask ${who} to give you a call. – Alex, Stone Ballarat`;
  let ackSent = false;
  try {
    const sid = await sendSMS(from, ack);
    ackSent = true;
    await createRecord(T.messages, {
      [M.lead]: [lead.id], [M.direction]: 'To vendor', [M.status]: 'Sent', [M.purpose]: appraisal ? 'Appraisal booking' : 'Reply to vendor',
      [M.finalText]: ack, [M.number]: normalisePhone(from), [M.sentAt]: new Date().toISOString(), [M.sid]: sid,
      [M.reasoning]: 'Automatic handoff reply – vendor ' + reason
    });
    await updateRecord(T.leads, lead.id, { [L.alexLastContact]: new Date().toISOString() });
  } catch (e) { console.error('Alex leads: handoff reply failed', e.message); }

  // Text the card's agent (only)
  const agentMobile = ctx.agent && ctx.agent.mobile ? normalisePhone(ctx.agent.mobile) : '';
  const to = agentMobile || approverMobile();
  const addr = f[L.address] && f[L.address] !== f[L.name] ? `, ${f[L.address]}` : '';
  const lines = [
    `${agentMobile ? (agentFirst ? 'Hi ' + agentFirst + ' – ' : '') : '(No mobile for this card\'s agent in Team – sent to you instead) '}${name}${addr} ${reason}.`,
    `They said: "${text.slice(0, 300)}"`,
    times ? `Times they mentioned: ${times}` : '',
    `Phone: ${f[L.phone] || from}`,
    `The card is now in ${upd[L.stage] || stage} with "Call ${first || name}" due today in your My Day.`,
    ackSent ? `Alex has told them you'll call and has stopped nurture texts.` : `Alex could NOT send them a reply – please call them.`
  ].filter(Boolean);
  try { await sendSMS(to, lines.join('\n')); } catch (e) { console.error('Alex leads: agent alert failed', e.message); }

  await logActivity(lead.id, {
    summary: `Handed to ${ctx.agent ? ctx.agent.name : 'the agent'} – vendor ${reason}`,
    detail: `Vendor said: "${text}"` + (ackSent ? `\nAlex replied: "${ack}"` : ''),
    type: 'General', kind: 'History'
  });
  console.log('Alex leads: handoff for ' + lead.id + ' to ' + (agentMobile ? 'agent' : 'approver'));
}

// ---------------------------------------------------------------- Part 2: new leads, CALL / ALEX, check-ins
// Agreed in the Pipeline Stages & Tasks redesign (20 Oct 2026):
//  • Business hours (BH) are 8am–7pm Mon–Sat. Agents only get texts in BH (a final 7pm wrap-up at most).
//  • New lead in BH: Alex texts the agent "Reply CALL or ALEX", reminds hourly, and at the end of the day moves the card
//    to No Contact – Agent Follow Up. Alex never engages the contact unless the agent says ALEX.
//  • New lead outside BH: Alex engages straight away (opener, details, qualify, appraisal or call time). If the contact
//    hasn't replied by 8am next business day, Alex asks the agent: ALEX (two more texts over two days) or CALL.
//  • No Contact check-ins on business days 1, 3 and 5, and every due task, go in ONE 9:30am check-in text per agent.
//  • Two hours after an appraisal Alex asks how it went (numbered outcomes).
const L_STATE = 'fldSHAb8MY49ZfOIM';      // zAlex State (JSON)
const L_ALEX_STATUS = 'fldR1tGl0HQFry4C5';
const L_FIRST_CONTACT = 'fldTHHofRh1kwNrGA';
const L_RECEIVED = 'fldrhtKYw1u54QouD';
const L_STAGE_ENTERED = 'fldijoAJ3uyzWxWgw';
const PROP = {
  beds: 'fldHzzWQ0fFEw6xzh', baths: 'fldWTGEZaIoy2Vcll', living: 'fldDzl2digHaFYlSs', study: 'fldNvcSOPgjdMcTeN', block: 'fldpszgwRMlPggUue',
  outdoor: 'fldybsfYNSeXzhYfi', parking: 'fldDdYLI47xlTeQn2', shedding: 'fld8SbcFx3YR5OJg0', yearBuilt: 'fldR8TUdf07Uk1DIu',
  renos: 'fld2J4SMg3mJbopbb', yearsOwned: 'fldanH1mccCJVTTSW', motivation: 'fldqY7Rt6IsUwtBu1', timing: 'fldnzDA6bVxUWZNKZ', other: 'fld8zF3Exrjgrlltf',
  otherAgents: 'fldtCDVYN6mKcZRWn', buySell: 'fldxQ4FLkBgveovgq', vendorPrice: 'fldBlNocu8vql1N2T', agentGuide: 'fldOcPRELQgH8O4EG', decisionMakers: 'fldZ321WQVLyeb9FV'
};
const NO_CONTACT = 'No Contact – Agent Follow Up';
const NEW_LEAD_MAX_AGE_DAYS = 3;   // older cards sitting in New are not blasted when this goes live
const CHASE_TEXTS = 2;

function melbClock() {
  const parts = new Intl.DateTimeFormat('en-AU', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false }).formatToParts(new Date());
  const p = t => (parts.find(x => x.type === t) || {}).value;
  return { date: `${p('year')}-${p('month')}-${p('day')}`, hour: parseInt(p('hour'), 10) % 24, minute: parseInt(p('minute'), 10), weekday: p('weekday') };
}
function isBH(c) { c = c || melbClock(); return c.weekday !== 'Sun' && c.hour >= 8 && c.hour < 19; }
function isBizDay(iso) { const wd = new Date(iso + 'T00:00:00Z').getUTCDay(); return wd !== 0 && wd !== 6; }
function bizDaysBetween(fromIso, toIso) { let n = 0, d = fromIso; while (d < toIso) { d = addDays(d, 1); if (isBizDay(d)) n++; } return n; }
function nextBizDay(iso) { let d = addDays(iso, 1); while (!isBizDay(d)) d = addDays(d, 1); return d; }
function minutesSince(iso) { return iso ? (Date.now() - new Date(iso).getTime()) / 60000 : Infinity; }

function getState(lead) { try { return JSON.parse(lead.fields[L_STATE] || '{}') || {}; } catch (e) { return {}; } }
async function setState(leadId, state, extra) {
  await updateRecord(T.leads, leadId, Object.assign({ [L_STATE]: JSON.stringify(state) }, extra || {}));
}

async function agentOfLead(lead) { return teamById((lead.fields[L.agent] || [])[0]); }
async function textAgent(agent, text) {
  const to = agent && isTextableMobile(agent.fields[TM.mobile]) ? normalisePhone(agent.fields[TM.mobile]) : approverMobile();
  try { await sendSMS(to, text); } catch (e) { console.error('Alex leads: agent text failed', e.message); }
}
function leadLabel(f) { return `${f[L.name] || 'New contact'}${f[L.address] && f[L.address] !== f[L.name] ? ' (' + f[L.address] + ')' : ''}`; }

async function logOut(lead, text, purpose, sid) {
  await createRecord(T.messages, {
    [M.lead]: [lead.id], [M.direction]: 'To vendor', [M.status]: 'Sent', [M.purpose]: purpose || 'New lead', [M.finalText]: text,
    [M.number]: normalisePhone(lead.fields[L.phone]), [M.sentAt]: new Date().toISOString(), [M.sid]: sid || ''
  });
  await updateRecord(T.leads, lead.id, { [L.alexLastContact]: new Date().toISOString() });
  await logActivity(lead.id, { summary: 'Alex texted the contact (' + String(purpose || 'new lead').toLowerCase() + ')', detail: text, type: 'SMS' });
}

function twentyFourHourNote(c) { return c.hour >= 23 || c.hour < 5; }

async function sendOpener(lead, agent) {
  const f = lead.fields;
  const first = firstName(f[L.name]);
  const usable = first && !/\d/.test(first);
  const agentName = agent ? agent.fields[TM.name] : 'our sales team';
  const prop = f[L.address] && f[L.address] !== f[L.name] ? f[L.address] : 'your property';
  const c = melbClock();
  const text = `${usable ? 'Hey ' + first : 'Hi there'}, this is Alex from Stone Ballarat on behalf of ${agentName}. It looks like you might be curious to get some feedback on the value of ${prop}. ` +
    `We'd love to help – what can you tell me about the property, block size, beds, bathrooms, living spaces etc?` +
    (twentyFourHourNote(c) ? " (We're a 24-hour service, so no need to wait till morning.)" : '') + ' ' + OPT_OUT_LINE;
  const sid = await sendSMS(f[L.phone], text);
  await logOut(lead, text, 'New lead', sid);
  if (!f[L_FIRST_CONTACT]) await updateRecord(T.leads, lead.id, { [L_FIRST_CONTACT]: new Date().toISOString() });
}

async function sendChase(lead, agent, n) {
  const f = lead.fields;
  const first = firstName(f[L.name]);
  const agentFirst = agent ? firstName(agent.fields[TM.name]) : 'our agent';
  const prop = f[L.address] && f[L.address] !== f[L.name] ? f[L.address] : 'your place';
  const text = n === 1
    ? `Hi ${first || 'there'}, just following up on your enquiry about ${prop}. Happy to help with a value update whenever suits – is there a good time for ${agentFirst} to give you a quick call?`
    : `Hi ${first || 'there'}, last one from me – if you'd still like an update on ${prop}, just reply with a time that suits and ${agentFirst} will call. No worries at all if now's not the time.`;
  const sid = await sendSMS(f[L.phone], text);
  await logOut(lead, text, 'New lead', sid);
}

// Move a card to No Contact – Agent Follow Up (the Airtable automation adds the "Call … try a few times" task)
async function toNoContact(lead, state, why) {
  state.phase = 'done'; state.ncBase = melbClock().date;
  await setState(lead.id, state, { [L.stage]: NO_CONTACT, [L_ALEX_STATUS]: 'Agent calling' });
  await logActivity(lead.id, { summary: 'Moved to No Contact – Agent Follow Up', detail: why || '', type: 'General', kind: 'History' });
}

// ---- runs every 2 minutes, day and night
async function newLeadTick() {
  if (!sweepEnabled()) return;
  const c = melbClock();
  const agents = await alexActiveAgentIds();
  if (!agents.size) return;
  const leads = (await listAll(T.leads, { filterByFormula: `AND(OR({${L.stage}}='New',{${L.stage}}='${NO_CONTACT}',{${L.stage}}='Qualifying'),NOT({${L_PARKED}}),NOT({${L.doNotContact}}),NOT({${L.pauseAlex}}))` }))
    .filter(l => (l.fields[L.agent] || []).some(id => agents.has(id)));
  for (const lead of leads) {
    try { await newLeadStep(lead, c); } catch (e) { console.error('Alex leads: new lead step failed for ' + lead.id, e.message); }
  }
}

async function newLeadStep(lead, c) {
  const f = lead.fields;
  const stage = sel(f[L.stage]);
  const state = getState(lead);
  const agent = await agentOfLead(lead);
  const label = leadLabel(f);
  const nowIso = new Date().toISOString();

  // A brand-new card in New
  if (!state.flow) {
    if (stage !== 'New') return;
    const via = sel(f[L.enteredVia]);
    const old = f[L_RECEIVED] && f[L_RECEIVED] < addDays(c.date, -NEW_LEAD_MAX_AGE_DAYS);
    if (['Agent form', 'Agent by text'].includes(via) || f[L_FIRST_CONTACT] || old || !isTextableMobile(f[L.phone])) {
      await setState(lead.id, { flow: 'newlead', phase: 'skip', why: !isTextableMobile(f[L.phone]) ? 'no mobile' : old ? 'older card' : 'agent already in contact' });
      return;
    }
    if (isBH(c)) {
      const text = `New lead: ${label}${f[L.sourceDetail] || f[L.source] ? ' – ' + (f[L.sourceDetail] || sel(f[L.source])) : ''}. ${f[L.phone]}.\nReply CALL if you'll ring them yourself, or ALEX for me to engage.`;
      await textAgent(agent, text);
      await setState(lead.id, { flow: 'newlead', phase: 'alerted', alertedAt: nowIso, alertHour: c.hour, lastReminderAt: nowIso, reminders: 0 }, { [L_ALEX_STATUS]: 'Waiting for agent' });
      await logActivity(lead.id, { summary: `New lead sent to ${agent ? agent.fields[TM.name] : 'the agent'} (CALL or ALEX)`, type: 'General', kind: 'History' });
    } else {
      await sendOpener(lead, agent);
      await setState(lead.id, { flow: 'newlead', phase: 'engaging', openerAt: nowIso, overnight: true }, { [L_ALEX_STATUS]: 'Engaging' });
    }
    return;
  }
  if (state.flow !== 'newlead') return;

  if (state.phase === 'alerted') {
    if (stage !== 'New') { state.phase = 'done'; await setState(lead.id, state); return; } // the agent moved the card themselves
    const alertedOn = new Date(state.alertedAt).toLocaleDateString('en-CA', { timeZone: TZ });
    const finalHour = (state.alertHour || 0) >= 17 ? 19 : 18;
    const wrapUp = alertedOn < c.date ? isBH(c) : c.hour >= finalHour;
    if (wrapUp) {
      await textAgent(agent, `No reply on ${label} today, so I've moved the card to No Contact – Agent Follow Up with a call task.`);
      await toNoContact(lead, state, 'No CALL / ALEX reply by the end of the day');
    } else if (isBH(c) && minutesSince(state.lastReminderAt) >= 60) {
      await textAgent(agent, `Reminder: new lead ${label}, ${f[L.phone]}. Reply CALL or ALEX.`);
      state.lastReminderAt = nowIso; state.reminders = (state.reminders || 0) + 1;
      await setState(lead.id, state);
    }
    return;
  }

  if (state.phase === 'conversing' && state.lastReplyAt && minutesSince(state.lastReplyAt) >= 24 * 60 && isBH(c)) {
    // They chatted with Alex, then went quiet before an appraisal or call time was agreed
    const first = firstName(f[L.name]) || f[L.name];
    state.phase = 'done';
    await setState(lead.id, state, { [L.stage]: 'Qualifying', [L.nextAction]: `Call ${first} – chatted with Alex but went quiet before booking`, [L.nextActionDate]: c.date, [L_ALEX_STATUS]: 'Waiting for agent' });
    await textAgent(agent, `${label} chatted with me but went quiet before we booked anything. I've moved the card to Qualifying with a call task for today – the conversation is on the card.`);
    return;
  }

  if (state.phase === 'engaging' && !state.replied) {
    // No reply to the opener: next business day from 8am, ask the agent
    const openedOn = new Date(state.openerAt).toLocaleDateString('en-CA', { timeZone: TZ });
    if (isBH(c) && openedOn < c.date) {
      await textAgent(agent, `${label} enquired ${openedOn === addDays(c.date, -1) ? 'last night' : 'recently'} but hasn't replied to me yet. Reply ALEX for me to keep trying, or CALL if you'll handle it.`);
      state.phase = 'noreply_asked'; state.askedAt = nowIso;
      await setState(lead.id, state, { [L_ALEX_STATUS]: 'Waiting for agent' });
    }
    return;
  }

  if (state.phase === 'noreply_asked') {
    if (c.hour >= 18 && isBH(c)) {
      await textAgent(agent, `No reply on ${label}, so I've moved the card to No Contact – Agent Follow Up with a call task.`);
      await toNoContact(lead, state, 'Contact never replied and no ALEX / CALL from the agent');
    }
    return;
  }

  if (state.phase === 'chasing' && !state.replied) {
    const n = state.chases || 0;
    const friendly = c.weekday !== 'Sun' && c.hour >= 9 && c.hour < 19;
    if (n < CHASE_TEXTS && friendly && minutesSince(state.lastChaseAt) >= 22 * 60) {
      await sendChase(lead, agent, n + 1);
      state.chases = n + 1; state.lastChaseAt = nowIso;
      await setState(lead.id, state);
    } else if (n >= CHASE_TEXTS && minutesSince(state.lastChaseAt) >= 24 * 60 && isBH(c)) {
      await textAgent(agent, `Still no reply from ${label} after ${CHASE_TEXTS} more texts, so I've moved the card to No Contact – Agent Follow Up with a call task.`);
      await toNoContact(lead, state, 'No reply after Alex followed up');
    }
    return;
  }

  // Overnight lead that reached an outcome: tell the agent from 8am (moves to the morning email in part 3)
  if (state.overnight && state.outcomeSummary && !state.summarySent && isBH(c)) {
    await textAgent(agent, `New lead overnight: ${state.outcomeSummary}`);
    state.summarySent = true;
    await setState(lead.id, state);
  }
}

// ---- the contact's replies while Alex is running the new-lead conversation (no approval – firm limits)
async function newLeadConversationHistory(lead) {
  const msgs = await leadMessages(lead.fields);
  return msgs.filter(m => ['New lead', 'Other'].includes(sel(m.fields[M.purpose])))
    .slice(-16).map(m => `${sel(m.fields[M.direction]) === 'From vendor' ? 'CONTACT' : 'ALEX'}: ${m.fields[M.finalText] || m.fields[M.draft] || ''}`).join('\n');
}

async function handleNewLeadReply(lead, from, text, ctx) {
  const f = lead.fields;
  const state = getState(lead);
  const agent = await agentOfLead(lead);
  const agentName = agent ? agent.fields[TM.name] : 'the agent';
  const agentFirst = firstName(agentName);
  const c = melbClock();
  const convo = await newLeadConversationHistory(await getRecord(T.leads, lead.id));
  const known = Object.fromEntries(Object.entries(PROP).map(([k, id]) => [k, f[id] === undefined ? '' : sel(f[id])]));
  // With Outlook connected, offer two real free times for an appraisal
  let slots = [];
  if (calendarEnabled() && agent && agent.fields[TM_EMAIL]) {
    try { slots = await freeSlots(agent.fields[TM_EMAIL], 2); } catch (e) { console.error('Alex leads: free slots failed', e.message); }
  }
  let bookings = [];
  if (!slots.length && agent) { try { bookings = await agentBookings(agent.id); } catch (e) { console.error('Alex leads: bookings failed', e.message); } }
  const user =
    `NOW: ${c.weekday} ${c.date} ${String(c.hour).padStart(2, '0')}:${String(c.minute).padStart(2, '0')} Melbourne. AGENT: ${agentName}.\n` +
    `CARD: ${JSON.stringify({ name: f[L.name] || '', address: f[L.address] || '', source: sel(f[L.source]), sourceDetail: f[L.sourceDetail] || '' })}\n` +
    `PROPERTY DETAILS SO FAR: ${JSON.stringify(known)}\n\nCONVERSATION SO FAR:\n${convo}\nCONTACT (just now): ${text}\n\n` +
    'You are running the first conversation with a new enquiry, on behalf of the agent, with no one approving each text. Goals, in order: ' +
    '1) chat naturally and pick up property details (beds, bathrooms, living spaces, study, block size, outdoor area, parking, shedding, age, renovations, years owned) – ask ONE follow-up at a time, only for the gaps that matter most (beds, baths, block size, motivation, timing), never a questionnaire; ' +
    '2) qualify: "Are you thinking of making a move, or just keen to get an update on value?" and note any timing; ' +
    (slots.length
      ? `3) if they are thinking of moving, offer an appraisal at one of ${agentFirst}'s free times: ${slots.map(x => `${x.label} (${x.local})`).join(' or ')}. If they accept one of these, outcome "book_at" with book_at set to it; if neither suits, ask what days/times generally suit and use outcome "appraisal" (the agent will confirm); `
      : `3) if they are thinking of moving, offer an appraisal and ask what days and times generally suit over the next week or so. Once they've said, outcome "appraisal": your reply thanks them and says you'll check with ${agentFirst} and confirm a time ${isBH(c) && c.hour < 17 ? 'shortly' : 'in the morning'} (never promise a time yourself); fill options with up to 3 specific times (YYYY-MM-DDTHH:MM, Mon–Sat 9:00–17:00, on the hour or half hour) that match what they said and avoid ${agentFirst}'s booked times: ${bookingsText(bookings)}; `) +
    '4) if they only want an update or an appraisal does not suit, agree a day and time for the agent to call. ' +
    'FIRM LIMITS: never give a price, valuation, range or commission (an accurate figure needs a visit); anything outside this script (legal, tenancy, complaints, upset, buying questions) → outcome "handover"; any request to stop or be left alone → outcome "opt_out". ' +
    'Keep replies to 1–3 short sentences, warm plain Australian English, no exclamation marks, never mention you are an AI unless asked. Do not greet again or re-introduce yourself. ' +
    (twentyFourHourNote(c) ? 'It is late at night: mention once, lightly, that we are a 24-hour service so no need to wait till morning. ' : '') +
    'Return JSON only: {"reply": "Alex\'s next text (empty only for opt_out)", ' +
    '"details": {"beds": null, "baths": null, "living": null, "study": null, "block": null, "outdoor": "", "parking": "", "shedding": "", "yearBuilt": "", "renos": "", "yearsOwned": null, "other": ""}, ' +
    '"motivation": "Making a move|Just an update|Unsure|", "timing": "their words or empty", ' +
    '"outcome": "continue|appraisal|book_at|call_time|nurture|handover|opt_out", "book_at": "YYYY-MM-DDTHH:MM local appraisal time they accepted, or empty", "preferred_times": "days/times they offered for an appraisal, or empty", "options": ["YYYY-MM-DDTHH:MM", "…up to 3, only for outcome appraisal"], ' +
    '"call_at": "YYYY-MM-DDTHH:MM local time agreed for the agent to call, or empty", "nurture_reason": "if they are clearly not moving for 3+ months: one of ' + NURTURE_REASONS.slice(0, 5).join(' | ') + '", ' +
    '"handover_reason": "", "summary": "one line for the agent: what we learned and what happens next"}';
  const out = await claudeJSON(VOICE + ' You also extract facts accurately and conservatively.', user, 900);

  // property details
  const upd = {};
  const d = out.details || {};
  const num = v => (v === null || v === undefined || v === '' || isNaN(Number(v))) ? null : Number(v);
  for (const k of ['beds', 'baths', 'living', 'block', 'yearsOwned']) { const v = num(d[k]); if (v !== null && !f[PROP[k]]) upd[PROP[k]] = v; }
  if (d.study === true && !f[PROP.study]) upd[PROP.study] = true;
  for (const k of ['outdoor', 'parking', 'shedding', 'yearBuilt', 'renos', 'other']) if (d[k] && String(d[k]).trim()) upd[PROP[k]] = f[PROP[k]] ? (f[PROP[k]] + '; ' + d[k]) : d[k];
  if (['Making a move', 'Just an update', 'Unsure'].includes(out.motivation)) upd[PROP.motivation] = out.motivation;
  if (out.timing) upd[PROP.timing] = out.timing;

  if (out.outcome === 'opt_out') {
    await updateRecord(T.leads, lead.id, Object.assign(upd, { [L.doNotContact]: true, [L_ALEX_STATUS]: 'Done' }));
    const sid = await sendSMS(from, OPT_OUT_ACK); await logOut(lead, OPT_OUT_ACK, 'New lead', sid);
    state.phase = 'done'; state.replied = true; await setState(lead.id, state);
    await logActivity(lead.id, { summary: 'Contact asked to be left alone – Do Not Contact ticked by Alex', detail: text, type: 'General', kind: 'History' });
    return;
  }

  const reply = String(out.reply || '').trim();
  if (reply) { const sid = await sendSMS(from, reply); await logOut(lead, reply, 'New lead', sid); }
  state.replied = true; state.lastReplyAt = new Date().toISOString();
  if (['noreply_asked', 'chasing', 'engaging'].includes(state.phase)) state.phase = 'conversing';

  const first = firstName(f[L.name]) || f[L.name] || 'them';
  const today = c.date;
  const dueNext = isBH(c) && c.hour < 17 ? today : nextBizDay(today);
  let outcome = '';
  let bookedIso = null;
  let apptOptions = [];
  if (out.outcome === 'book_at' && melbToISO(out.book_at)) {
    bookedIso = melbToISO(out.book_at);
    Object.assign(upd, { [L.stage]: 'Appraisal Booked', [L_APPT_AT]: bookedIso, [L_ALEX_STATUS]: 'Done' });
    outcome = `appraisal booked ${melbWhen(bookedIso)}`;
  } else if (out.outcome === 'appraisal') {
    Object.assign(upd, { [L.stage]: 'Qualifying', [L.nextAction]: `Confirm the appraisal time with ${first}` + (out.preferred_times ? ` – they suggested: ${out.preferred_times}` : ''), [L.nextActionDate]: dueNext, [L_ALEX_STATUS]: 'Done' });
    try { if (agent) apptOptions = await cleanOptions(agent.id, Array.isArray(out.options) ? out.options : []); } catch (e) { console.error('Alex leads: options failed', e.message); }
    outcome = `wants an appraisal${out.preferred_times ? ' (' + out.preferred_times + ')' : ''}` + (apptOptions.length ? ' – pick a time below and I\'ll confirm it with them' : ' – please call to confirm the time');
  } else if (out.outcome === 'call_time') {
    const iso = melbToISO(out.call_at);
    const when = iso ? melbWhen(iso) : 'the time they asked';
    Object.assign(upd, { [L.stage]: 'Qualifying', [L.nextAction]: `Call ${first} – ${when}`, [L.nextActionDate]: iso ? new Date(iso).toLocaleDateString('en-CA', { timeZone: TZ }) : dueNext, [L_ALEX_STATUS]: 'Done' });
    if (iso) upd[L_CALL_AT] = iso;
    outcome = `call booked ${when}`;
  } else if (out.outcome === 'nurture' && NURTURE_REASONS.includes(out.nurture_reason)) {
    Object.assign(upd, { [L.stage]: 'Nurture', [L.nurtureReason]: out.nurture_reason, [L_ALEX_STATUS]: 'Done' });
    outcome = `not moving yet – on the nurture track "${out.nurture_reason}"`;
  } else if (out.outcome === 'handover') {
    Object.assign(upd, { [L.stage]: 'Qualifying', [L.nextAction]: `Call ${first} – ${out.handover_reason || 'needs you'}`, [L.nextActionDate]: today, [L_ALEX_STATUS]: 'Waiting for agent' });
    outcome = `needs you: ${out.handover_reason || 'see the conversation'}`;
  }
  if (Object.keys(upd).length) await updateRecord(T.leads, lead.id, upd);
  if (bookedIso) { const cal = (await addToCalendar(agent, await getRecord(T.leads, lead.id), bookedIso, 'Appraisal')).replace(/\.$/, ''); if (cal) outcome += '.' + cal; }
  if (outcome) {
    state.phase = 'done';
    state.outcomeSummary = `${leadLabel(f)} – ${out.summary || outcome}. ${outcome.charAt(0).toUpperCase() + outcome.slice(1)}.`;
    await logActivity(lead.id, { summary: `New-lead conversation: ${outcome}`, detail: out.summary || '', type: 'General', kind: 'History' });
    // Appraisal time options: one text to the agent with the summary and the options (now in BH, otherwise from 8am)
    if (apptOptions.length) {
      await setState(lead.id, Object.assign(state, { summarySent: true }));
      await offerTimesToAgent(await getRecord(T.leads, lead.id), apptOptions, 'appraisal', `${leadLabel(f)} wants an appraisal${out.preferred_times ? ' – they said ' + out.preferred_times : ''}. ${f[L.phone]}${out.summary ? '\n' + out.summary : ''}`);
      return;
    }
    // In BH (or a handover) tell the agent now; otherwise it goes in the 8am summary
    if (isBH(c) || out.outcome === 'handover') { await textAgent(agent, (out.outcome === 'handover' ? '⚠ ' : '') + `${state.outcomeSummary} ${f[L.phone]}`); state.summarySent = true; }
  }
  await setState(lead.id, state);
}

// ---- agent replies CALL / ALEX to a new-lead alert or a no-reply question
async function handleCallAlex(member, from, text, reply) {
  const m = text.match(/^(call|alex)\b\s*(\d+)?/i);
  if (!m) return false;
  const word = m[1].toUpperCase();
  const agentName = String(member.fields[TM.name] || '').replace(/'/g, "\\'");
  const leads = (await listAll(T.leads, { filterByFormula: `AND(FIND('${agentName}',ARRAYJOIN({${L.agent}})),FIND('"flow":"newlead"',{${L_STATE}}&''),OR(FIND('"phase":"alerted"',{${L_STATE}}&''),FIND('"phase":"noreply_asked"',{${L_STATE}}&'')))` }))
    .sort((a, b) => String(a.createdTime) < String(b.createdTime) ? -1 : 1);
  if (!leads.length) return false;
  let lead = leads.length === 1 ? leads[0] : null;
  if (!lead && m[2]) lead = leads[parseInt(m[2], 10) - 1] || null;
  if (!lead) {
    await reply(`Which one? ${leads.map((l, i) => `${i + 1} – ${leadLabel(l.fields)}`).join(' · ')}. Reply ${word} 1, ${word} 2…`);
    return true;
  }
  const state = getState(lead);
  if (word === 'CALL') {
    await toNoContact(lead, state, `${member.fields[TM.name]} replied CALL`);
    await reply(`Thanks – ${leadLabel(lead.fields)} is in No Contact – Agent Follow Up with a call task. I'll check in tomorrow.`);
  } else if (state.phase === 'alerted') {
    await sendOpener(lead, member);
    await setState(lead.id, Object.assign(state, { phase: 'engaging', openerAt: new Date().toISOString() }), { [L_ALEX_STATUS]: 'Engaging' });
    await reply(`On it – I've texted ${firstName(lead.fields[L.name]) || 'them'}. I'll let you know what happens.`);
  } else {
    await setState(lead.id, Object.assign(state, { phase: 'chasing', chases: 0, lastChaseAt: null }), { [L_ALEX_STATUS]: 'Engaging' });
    await reply(`Will do – I'll try ${firstName(lead.fields[L.name]) || 'them'} up to ${CHASE_TEXTS} more times over the next two days.`);
  }
  return true;
}

// ---- 9:30am check-in text (one per agent, business days) and the after-appraisal question
const checkinsByPhone = new Map(); // phone -> { date, items: [{ n, leadId, question }] } – questions Alex asked today
function rememberQuestions(agent, date, items) {
  const key = normalisePhone(agent.fields[TM.mobile]);
  const cur = checkinsByPhone.get(key);
  const keep = cur && cur.date === date ? cur.items.filter(x => !items.some(y => y.leadId === x.leadId)) : [];
  checkinsByPhone.set(key, { date, items: keep.concat(items) });
}
let lastCheckinDate = null;

async function checkinTick() {
  if (!sweepEnabled()) return;
  const c = melbClock();
  if (!isBizDay(c.date) || !isBH(c)) return;
  const agents = await alexActiveAgentIds();
  if (!agents.size) return;
  // After-appraisal question, 2 hours after the appraisal time
  const appr = (await listAll(T.leads, { filterByFormula: `AND({${L.stage}}='Appraisal Booked',NOT({${L_PARKED}}),{${L_APPT_AT}}!='')` }))
    .filter(l => (l.fields[L.agent] || []).some(id => agents.has(id)));
  for (const lead of appr) {
    const at = lead.fields[L_APPT_AT];
    const state = getState(lead);
    if (state.apptAsked === at || minutesSince(at) < 120 || minutesSince(at) > 3 * 24 * 60) continue;
    const agent = await agentOfLead(lead);
    const first = firstName(lead.fields[L.name]) || lead.fields[L.name];
    const q = `How did the appraisal with ${first} go? 1 – Price update / desktop required · 2 – Prepare listing presentation · 3 – Listing meeting booked (tell me when) · 4 – Presentation sent · 5 – Something else. ` +
      `Add anything worth noting: their price expectation, your price guide, decision makers, other agents.`;
    await textAgent(agent, q);
    state.apptAsked = at; await setState(lead.id, state);
    if (agent) rememberQuestions(agent, c.date, [{ n: 0, leadId: lead.id, question: `${lead.fields[L.name]} – AFTER-APPRAISAL (numbers 1–5 in the reply are these options): ${q}` }]);
  }
  // Price update sent (task ticked off, card still in Price Update): follow it up in 3 business days
  const pu = (await listAll(T.leads, { filterByFormula: `AND({${L.stage}}='Price Update / Desktop Required',NOT({${L_PARKED}}),{${L.nextAction}}='')` }))
    .filter(l => (l.fields[L.agent] || []).some(id => agents.has(id)));
  for (const lead of pu) {
    let d = c.date; for (let n = 0; n < 3;) { d = addDays(d, 1); if (isBizDay(d)) n++; }
    await updateRecord(T.leads, lead.id, { [L.nextAction]: `Any reaction from ${firstName(lead.fields[L.name]) || lead.fields[L.name]} to the price update?`, [L.nextActionDate]: d });
  }
  // After-listing-meeting question, 2 hours after the meeting
  const mtgs = (await listAll(T.leads, { filterByFormula: `AND({${L.stage}}='Listing Meeting Booked',NOT({${L_PARKED}}),{${L_MTG_AT}}!='')` }))
    .filter(l => (l.fields[L.agent] || []).some(id => agents.has(id)));
  for (const lead of mtgs) {
    const at = lead.fields[L_MTG_AT];
    const state = getState(lead);
    if (state.mtgAsked === at || minutesSince(at) < 120 || minutesSince(at) > 3 * 24 * 60) continue;
    const agent = await agentOfLead(lead);
    const first = firstName(lead.fields[L.name]) || lead.fields[L.name];
    const q = `How did the listing meeting with ${first} go? 1 – Going ahead · 2 – Thinking it over · 3 – Delayed / on hold (till when?) · 4 – Not going ahead (why?) · 5 – Something else`;
    await textAgent(agent, q);
    state.mtgAsked = at; await setState(lead.id, state);
    if (agent) rememberQuestions(agent, c.date, [{ n: 0, leadId: lead.id, question: `${lead.fields[L.name]} – AFTER-MEETING (1 → "Approved / Accepted"; 2 → "Decision Pending"; 3 → "Delayed / On Hold" + next_action_date; 4 → "Lost / Not Progressing" + lost_reason, or Nurture if they're just not ready; 5 → read what they said): ${q}` }]);
  }
  // The 9:30 check-in, once a day
  if (lastCheckinDate === c.date || c.hour < 9 || (c.hour === 9 && c.minute < 30)) return;
  lastCheckinDate = c.date;
  const cards = (await listAll(T.leads, { filterByFormula: `AND(NOT({${L_PARKED}}),{${L.stage}}!='Nurture',{${L.stage}}!='Listed (Won)',{${L.stage}}!='New')` }))
    .filter(l => (l.fields[L.agent] || []).some(id => agents.has(id)));
  const byAgent = {};
  for (const lead of cards) {
    const f = lead.fields;
    const stage = sel(f[L.stage]);
    const first = firstName(f[L.name]) || f[L.name];
    const state = getState(lead);
    let q = '';
    if (stage === NO_CONTACT) {
      const base = state.ncBase || f[L_STAGE_ENTERED] || c.date;
      const bd = bizDaysBetween(base, c.date);
      const asked = state.ncAsked || {};
      if (bd >= 5 && !asked[base + ':5']) { q = `Still no luck with ${first}? a – move to Nurture (Cold track) · b – keep trying another week · c – something else (tell me what happened)`; asked[base + ':5'] = true; }
      else if (bd >= 3 && bd < 5 && !asked[base + ':3']) { q = `Any luck reaching ${first}?`; asked[base + ':3'] = true; }
      else if (bd >= 1 && bd < 3 && !asked[base + ':1']) { q = `How did you go with ${first}?`; asked[base + ':1'] = true; }
      if (q) { state.ncAsked = asked; await setState(lead.id, state); }
    } else if (f[L.nextAction] && f[L.nextActionDate] && f[L.nextActionDate] <= c.date && stage !== 'Appraisal Booked') {
      const key = f[L.nextAction] + '|' + f[L.nextActionDate];
      if (state.taskAsked !== key || (state.taskAskedOn && bizDaysBetween(state.taskAskedOn, c.date) >= 2)) {
        q = /^Add the lost reason/.test(f[L.nextAction])
          ? `Why didn't ${first} go ahead? (listed with competitor, selling privately, not selling, not interested, no contact, or bogus/duplicate)`
          : `${f[L.nextAction]} – done? Or tell me what's happened.`;
        state.taskAsked = key; state.taskAskedOn = c.date; await setState(lead.id, state);
      }
    }
    // stage age prompts and cards with no next step
    const entered = f[L_STAGE_ENTERED] || '';
    const daysIn = entered ? Math.floor((Date.parse(c.date) - Date.parse(entered.slice(0, 10))) / 86400000) : 0;
    if (!q && stage === 'Qualifying' && daysIn >= 14 && state.qual14 !== entered) {
      q = `${first} has been in Qualifying for ${Math.floor(daysIn / 7)} weeks – what's next? a – appraisal booked (tell me when) · b – Nurture (tell me how far off) · c – something else`;
      state.qual14 = entered; await setState(lead.id, state);
    } else if (!q && stage === 'Decision Pending' && daysIn >= 21 && state.dp21 !== entered) {
      q = `${first} has been deciding for ${Math.floor(daysIn / 7)} weeks – any news? a – going ahead (Approved / Accepted) · b – Nurture (Proposal or decision stalled) · c – something else`;
      state.dp21 = entered; await setState(lead.id, state);
    } else if (!q && !f[L.nextAction] && !['Appraisal Booked', 'Listing Meeting Booked', NO_CONTACT, 'Lost / Not Progressing', 'Price Update / Desktop Required'].includes(stage)
      && (!state.noTaskAskedOn || bizDaysBetween(state.noTaskAskedOn, c.date) >= 5)) {
      q = `What's the next step with ${first} (${stage})?`;
      state.noTaskAskedOn = c.date; await setState(lead.id, state);
    }
    if (q) { const a = (f[L.agent] || [])[0]; (byAgent[a] = byAgent[a] || []).push({ leadId: lead.id, question: `${f[L.name]}: ${q}` }); }
  }
  for (const [agentId, items] of Object.entries(byAgent)) {
    const agent = await teamById(agentId);
    const list = items.slice(0, 10).map((it, i) => Object.assign(it, { n: i + 1 }));
    const text = `Morning ${agent ? firstName(agent.fields[TM.name]) : ''} – quick check-ins:\n${list.map(it => `${it.n} – ${it.question}`).join('\n')}\n\nReply in one go, e.g. "1 booked Thu 2pm, 2 sent, 3b".`;
    await textAgent(agent, text);
    if (agent) rememberQuestions(agent, c.date, list);
  }
}

let fastTimer = null;

// ---------------------------------------------------------------- Part 3: signed-up handover to Fiona, lost-card follow-ups
// When a card reaches Listed (Won) the Airtable automation creates the listing in Listing Onboarding (0. Awaiting Authority).
// Alex then texts Fiona and confirms to the agent. If Fiona replies that the authority hasn't arrived, Alex chases the agent
// and keeps a task on the card until the listing's Authority Signed Date is filled in (or Fiona says she has it).
const LISTINGS = 'tbl7rq0yT4S55joAJ';
const LST = { address: 'fldSRLtRIu0xYW1O3', authDate: 'fldnvCHHO6Doclbib' };
const L_LISTING = 'fldzRjMIf6xgaD3kE';
const FIONA_FALLBACK_MOBILE = '+61412185313';

async function fionaRow() { return (await teamRows()).find(t => /^fiona\b/i.test(String(t.fields[TM.name] || ''))) || null; }
async function textFiona(text) {
  const f = await fionaRow();
  const to = f && isTextableMobile(f.fields[TM.mobile]) ? normalisePhone(f.fields[TM.mobile]) : FIONA_FALLBACK_MOBILE;
  await sendSMS(to, text);
}

async function wonTick() {
  if (!sweepEnabled()) return;
  const c = melbClock();
  const agents = await alexActiveAgentIds();
  if (!agents.size) return;
  const won = (await listAll(T.leads, { filterByFormula: `AND({${L.stage}}='Listed (Won)',NOT({${L_PARKED}}))` }))
    .filter(l => (l.fields[L.agent] || []).some(id => agents.has(id)));
  for (const lead of won) {
    const f = lead.fields;
    const state = getState(lead);
    if (state.authorityReceived) continue;
    const agent = await agentOfLead(lead);
    const agentFirst = agent ? firstName(agent.fields[TM.name]) : 'the agent';
    const address = f[L.address] || f[L.name];
    try {
      // the listing's Authority Signed Date filled in = Fiona has the authority
      const listingId = (f[L_LISTING] || [])[0];
      if (listingId) {
        const listing = await getRecord(LISTINGS, listingId).catch(() => null);
        if (listing && listing.fields[LST.authDate]) {
          state.authorityReceived = true;
          const upd = /signed authority/i.test(f[L.nextAction] || '') ? { [L.nextAction]: '', [L.nextActionDate]: null } : {};
          await setState(lead.id, state, upd);
          continue;
        }
      }
      const enteredRecently = !f[L_STAGE_ENTERED] || f[L_STAGE_ENTERED] >= addDays(c.date, -3);
      if (!state.fionaTexted && enteredRecently && isBH(c)) {
        if (!listingId) { // give the Airtable automation a few minutes to create the listing
          if (!state.wonSeenAt) { state.wonSeenAt = new Date().toISOString(); await setState(lead.id, state); continue; }
          if (minutesSince(state.wonSeenAt) < 4) continue;
        }
        await textFiona(`Hey Fiona, it looks like ${agentFirst} has signed up ${address}. I've sent this to the onboarding pipeline while you await the authority hard copy/email. If you don't have it in the next few hours, let me know and I'll follow up ${agentFirst} for you.`);
        await textAgent(agent, `Done – ${address} is with Fiona for onboarding (0. Awaiting Authority). If you haven't already, email the signed authority to Fiona or drop the hard copy on her desk.`);
        state.fionaTexted = new Date().toISOString();
        await setState(lead.id, state, { [L_ALEX_STATUS]: 'Done' });
        await logActivity(lead.id, { summary: 'Alex told Fiona the vendor signed up – listing is in Listing Onboarding (0. Awaiting Authority)', type: 'General', kind: 'History' });
      }
    } catch (e) { console.error('Alex leads: won handover failed for ' + lead.id, e.message); }
  }
}

// Fiona's replies about authorities
async function handleFionaSMS(member, text, reply) {
  const pending = (await listAll(T.leads, { filterByFormula: `AND({${L.stage}}='Listed (Won)',FIND('"fionaTexted"',{${L_STATE}}&''),NOT(FIND('"authorityReceived":true',{${L_STATE}}&'')))` }));
  if (!pending.length) return false;
  const words = text.toLowerCase();
  let lead = pending.length === 1 ? pending[0] : pending.find(l => {
    const a = String(l.fields[L.address] || '').toLowerCase().split(/[\s,]+/).filter(w => w.length > 2 && !/^\d+$/.test(w));
    return a.some(w => words.includes(w));
  });
  const notYet = /(not|haven'?t|hasn'?t|no|nothing|still)\b.*\b(received|got|arrived|come|in|here|yet)|not here|chase|no authority|missing/i.test(text);
  const gotIt = !notYet && /\b(got it|received|have it|arrived|all good|it'?s here|thanks)\b/i.test(text);
  if (!notYet && !gotIt) return false;
  if (!lead) { await reply(`Which one? ${pending.map(l => l.fields[L.address] || l.fields[L.name]).join(' · ')}`); return true; }
  const state = getState(lead);
  const agent = await agentOfLead(lead);
  const agentFirst = agent ? firstName(agent.fields[TM.name]) : 'the agent';
  const address = lead.fields[L.address] || lead.fields[L.name];
  if (gotIt) {
    state.authorityReceived = true;
    await setState(lead.id, state, /signed authority/i.test(lead.fields[L.nextAction] || '') ? { [L.nextAction]: '', [L.nextActionDate]: null } : {});
    await reply(`Thanks Fiona – noted that you have the authority for ${address}.`);
    return true;
  }
  await textAgent(agent, `Fiona hasn't received the authority for ${address} yet – can you email it or drop it to her desk?`);
  await updateRecord(T.leads, lead.id, { [L.nextAction]: `Get the signed authority for ${address} to Fiona`, [L.nextActionDate]: melbClock().date });
  await logActivity(lead.id, { summary: `Fiona hasn't received the authority – ${agentFirst} asked to send it`, type: 'General', kind: 'History' });
  await reply(`Thanks Fiona – I've asked ${agentFirst} to get it to you, and it's a task on the card until you have it.`);
  return true;
}

// Lost cards: "Selling privately" gets one friendly check-in after 3 months (goes out with the midday preview);
// "Not selling" moves to Track 6 · Annual check-in after 6 months. Runs once a day.
let lastLostDate = null;
async function lostHousekeeping() {
  const today = melbNow().date;
  if (lastLostDate === today) return;
  lastLostDate = today;
  const agents = await alexActiveAgentIds();
  const lost = (await listAll(T.leads, { filterByFormula: `AND({${L.stage}}='Lost / Not Progressing',NOT({${L_PARKED}}),NOT({${L.doNotContact}}),{${L.followUp}}!='',IS_BEFORE({${L.followUp}},DATEADD(TODAY(),1,'days')))` }))
    .filter(l => (l.fields[L.agent] || []).some(id => agents.has(id)));
  for (const lead of lost) {
    const f = lead.fields;
    const reason = sel(f[L_LOST_REASON]);
    try {
      if (/not selling/i.test(reason)) {
        await updateRecord(T.leads, lead.id, { [L.stage]: 'Nurture', [L.nurtureReason]: 'Annual check-in (recently settled / yearly touch)' });
        // the Airtable automation sets the first check-in 6 months out; this one is due now
        setTimeout(() => updateRecord(T.leads, lead.id, { [L.followUp]: today }).catch(e => console.error('Alex leads: annual follow-up reset failed', e.message)), 60000);
        await logActivity(lead.id, { summary: 'Not selling 6 months ago – moved to Track 6 · Annual check-in', type: 'General', kind: 'History' });
      } else if (/privately/i.test(reason) && isTextableMobile(f[L.phone])) {
        const ctx = await leadContext(lead);
        const opening = smsOpening(ctx, false);
        const out = await claudeJSON(VOICE, `AGENT: ${ctx.agent ? ctx.agent.name : 'the agent'}\nLEAD CARD: ${JSON.stringify(ctx.card)}\n\nNOTES & HISTORY:\n${historyText(ctx.history)}\n\n` +
          `TASK: About three months ago they told us they were selling privately. Write ONE friendly check-in: ask how the sale went, and say in one easy sentence that if it's still on the market or they'd like a hand, the agent is happy to help – no pressure. ` +
          `The message will automatically start with: "${opening}" - write ONLY what comes after that. Return JSON only: {"sms": "..."}`, 400);
        let body = String(out.sms || '').trim().replace(/^(hey|hi|hello)\b[^,.!]*[,.!]\s*/i, '');
        if (/^[A-Z][a-z]/.test(body) && !/^I\b/.test(body)) body = body.charAt(0).toLowerCase() + body.slice(1);
        if (body) {
          const code = await nextCode();
          await createRecord(T.messages, {
            [M.code]: code, [M.lead]: [lead.id], [M.direction]: 'To vendor', [M.purpose]: 'Other', [M.status]: 'Scheduled',
            [M.draft]: opening + ' ' + body, [M.reasoning]: 'Lost – selling privately, text 1: 3-month check-in on their private sale.', [M.number]: normalisePhone(f[L.phone])
          });
        }
        await updateRecord(T.leads, lead.id, { [L.followUp]: null });
      } else {
        await updateRecord(T.leads, lead.id, { [L.followUp]: null });
      }
    } catch (e) { console.error('Alex leads: lost housekeeping failed for ' + lead.id, e.message); }
  }
}

// ---------------------------------------------------------------- GoHighLevel social-media leads by text
// GoHighLevel texts each new social-media lead to Alex's number in a fixed layout:
//   NEW LEAD
//   Name: … / Mobile: … / Email: … / Address: … / Agent: … / Campaign: … / Notes: …
// Only texts from the numbers in GHL_LEAD_NUMBERS (Railway env, comma-separated) – or from Stu, for testing – are read.
//  • No card yet (matched on mobile, then address): create it in New (Source Social Media, Entered Via GoHighLevel) and
//    start the new-lead flow straight away (BH: CALL / ALEX to the agent; outside BH: Alex texts the opener).
//  • Card already exists: add a note that they responded to a social media ad, keep the card's agent (whatever GHL
//    allocated), and follow the protocols – Nurture / Lost cards go back to New and into the new-lead flow; cards
//    already in play stay put and the agent is told (straight away in business hours, otherwise from 8am).
const GHL_LABELS = { name: 'name', 'full name': 'name', mobile: 'mobile', phone: 'mobile', email: 'email', address: 'address',
  'property address': 'address', suburb: 'suburb', city: 'suburb', agent: 'agent', 'assigned to': 'agent', campaign: 'campaign',
  source: 'campaign', form: 'campaign', ad: 'campaign', notes: 'notes', note: 'notes', message: 'notes', comments: 'notes' };

function ghlSenderOK(from) {
  const list = String(process.env.GHL_LEAD_NUMBERS || '').split(',').map(s => s.trim()).filter(Boolean);
  return list.some(n => samePhone(n, from)) || isApprover(from);
}
function parseGhlLead(text) {
  const t = String(text || '').replace(/\r/g, '');
  if (!/^\s*new\s+lead\b/i.test(t)) return null;
  const labels = Object.keys(GHL_LABELS).sort((a, b) => b.length - a.length).map(l => l.replace(/ /g, '\\s+'));
  const re = new RegExp(`(?:^|\\n|\\s)(${labels.join('|')})\\s*:`, 'gi');
  const hits = []; let m;
  while ((m = re.exec(t))) hits.push({ key: GHL_LABELS[m[1].toLowerCase().replace(/\s+/g, ' ')], start: m.index, valueStart: re.lastIndex });
  const out = {};
  hits.forEach((h, i) => {
    const v = t.slice(h.valueStart, i + 1 < hits.length ? hits[i + 1].start : t.length).replace(/\s+/g, ' ').trim()
      .replace(/^(null|undefined|n\/a|-|\{\{.*\}\})$/i, '');
    if (v && !out[h.key]) out[h.key] = v;
  });
  if (out.suburb && out.address && !out.address.toLowerCase().includes(out.suburb.toLowerCase())) out.address = out.address.replace(/,?\s*$/, '') + ', ' + out.suburb;
  if (!out.address && out.suburb) out.address = out.suburb;
  return out;
}
function sameAddress(a, b) {
  const ka = addrKey(a), kb = addrKey(b);
  if (!ka || ka !== kb) return false;
  const lastWord = s => (String(s).toLowerCase().match(/[a-z]{4,}/g) || []).pop() || '';
  const wa = lastWord(a), wb = lastWord(b);
  return !wa || !wb || String(b).toLowerCase().includes(wa) || String(a).toLowerCase().includes(wb);
}
async function findExistingCard(lead) {
  if (lead.mobile) { const byPhone = await findLeadByPhone(lead.mobile); if (byPhone) return byPhone; }
  if (lead.address && /\d/.test(lead.address)) {
    const all = await listAll(T.leads, { filterByFormula: `{${L.address}}!=''`, 'fields[]': L.address });
    const hit = all.find(r => sameAddress(r.fields[L.address], lead.address));
    if (hit) return getRecord(T.leads, hit.id);
  }
  return null;
}
async function matchAgent(name) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return null;
  const team = await teamRows();
  const exact = team.find(t => String(t.fields[TM.name] || '').toLowerCase() === n);
  if (exact) return exact;
  const byFirst = team.filter(t => String(t.fields[TM.name] || '').toLowerCase().split(' ')[0] === n.split(' ')[0]);
  return byFirst.length === 1 ? byFirst[0] : null;
}

// Start the new-lead flow on a card in New right now (used for GoHighLevel leads and returning contacts)
async function startNewLeadFlow(leadId, returning) {
  const lead = await getRecord(T.leads, leadId);
  const f = lead.fields;
  const agents = await alexActiveAgentIds();
  if (!(f[L.agent] || []).some(id => agents.has(id))) return 'agent not on Alex – normal allocation email only';
  if (f[L.doNotContact] || !isTextableMobile(f[L.phone])) return 'no text (Do Not Contact or no mobile)';
  const c = melbClock();
  const agent = await agentOfLead(lead);
  const nowIso = new Date().toISOString();
  const label = leadLabel(f);
  if (isBH(c)) {
    const text = `${returning ? 'Returning contact – they just responded to a social media ad' : 'New lead'}: ${label}${f[L.sourceDetail] ? ' – ' + f[L.sourceDetail] : ''}. ${f[L.phone]}.` +
      (returning ? `\n${returning}` : '') + `\nReply CALL if you'll ring them yourself, or ALEX for me to engage.`;
    await textAgent(agent, text);
    await setState(lead.id, { flow: 'newlead', phase: 'alerted', alertedAt: nowIso, alertHour: c.hour, lastReminderAt: nowIso, reminders: 0, returning: !!returning }, { [L_ALEX_STATUS]: 'Waiting for agent' });
    return 'agent alerted (CALL / ALEX)';
  }
  await sendOpener(lead, agent);
  await setState(lead.id, { flow: 'newlead', phase: 'engaging', openerAt: nowIso, overnight: true, returning: !!returning }, { [L_ALEX_STATUS]: 'Engaging' });
  return 'opener sent to the contact';
}

// Queue a message for the card's agent: now in business hours, otherwise from 8am (noticeTick)
async function noticeAgent(lead, text) {
  if (isBH(melbClock())) { await textAgent(await agentOfLead(lead), text); return 'agent texted'; }
  const state = getState(lead);
  state.notices = (state.notices || []).concat(text);
  await setState(lead.id, state);
  return 'agent will be texted from 8am';
}
async function noticeTick() {
  if (!sweepEnabled() || !isBH(melbClock())) return;
  const leads = await listAll(T.leads, { filterByFormula: `FIND('"notices":["',{${L_STATE}}&'')` });
  for (const lead of leads) {
    const state = getState(lead);
    const agent = await agentOfLead(lead);
    for (const n of state.notices || []) await textAgent(agent, n);
    delete state.notices;
    await setState(lead.id, state);
  }
}

async function handleGhlLead(from, body) {
  if (!/^\s*new\s+lead\b/i.test(String(body || '')) || !ghlSenderOK(from)) return false;
  const g = parseGhlLead(body);
  if (!g || (!g.mobile && !g.address && !g.name)) { await sendSMS(approverMobile(), `A GoHighLevel lead text came in but I couldn't read it:\n"${String(body).slice(0, 300)}"`); return true; }
  const today = melbClock().date;
  const ghlAgent = await matchAgent(g.agent);
  const detail = [g.campaign && `Campaign: ${g.campaign}`, g.agent && `GHL allocated: ${g.agent}`, g.notes && `Notes: ${g.notes}`, g.email && `Email: ${g.email}`].filter(Boolean).join('\n');
  const existing = await findExistingCard(g);

  if (!existing) {
    const fields = {
      [L.name]: g.name || g.address || g.mobile, [L.phone]: g.mobile ? normalisePhone(g.mobile) : undefined, [L.email]: g.email || undefined,
      [L.address]: g.address || undefined, [L.source]: 'Social Media', [L.sourceDetail]: g.campaign || 'GoHighLevel social media lead',
      [L.enteredVia]: 'GoHighLevel', [L.stage]: 'New', [L_RECEIVED]: today, [PROP.other]: g.notes || undefined,
      [L_STATE]: '{"flow":"newlead","phase":"starting"}' // stops the 2-minute tick double-handling it
    };
    if (ghlAgent) fields[L.agent] = [ghlAgent.id];
    const rec = await createRecord(T.leads, fields);
    await logActivity(rec.id, { summary: 'New social media lead from GoHighLevel', detail, type: 'General', kind: 'History' });
    if (!ghlAgent) {
      await sendSMS(approverMobile(), `New social media lead: ${g.name || ''} ${g.address || ''} ${g.mobile || ''}. GoHighLevel's agent "${g.agent || 'none'}" doesn't match anyone in Team – please allocate it in the Admin Inbox.`);
      return true;
    }
    const res = await startNewLeadFlow(rec.id, '');
    console.log('Alex leads: GHL lead created ' + rec.id + ' – ' + res);
    return true;
  }

  // Existing card: note it, keep the card's agent, follow the protocol for its stage
  const f = existing.fields;
  const stage = sel(f[L.stage]);
  const cardAgent = await agentOfLead(existing);
  const differentAgent = ghlAgent && !(f[L.agent] || []).includes(ghlAgent.id);
  const upd = {};
  if (g.mobile && !isTextableMobile(f[L.phone])) upd[L.phone] = normalisePhone(g.mobile);
  if (g.email && !f[L.email]) upd[L.email] = g.email;
  if (g.address && !f[L.address]) upd[L.address] = g.address;
  await logActivity(existing.id, {
    summary: `Responded to a social media advertisement${g.campaign ? ' (' + g.campaign + ')' : ''}`,
    detail: detail + (differentAgent ? `\nGoHighLevel allocated ${ghlAgent.fields[TM.name]} – kept ${cardAgent ? cardAgent.fields[TM.name] : 'the card\'s agent'} as the agent.` : ''),
    type: 'General', kind: 'Note'
  });
  const label = leadLabel(f);
  const agentLine = differentAgent ? ` (GoHighLevel allocated ${ghlAgent.fields[TM.name]}; you stay the agent)` : '';
  if (f[L_PARKED]) {
    if (Object.keys(upd).length) await updateRecord(T.leads, existing.id, upd);
    await sendSMS(approverMobile(), `${label} just responded to a social media ad, but their card is parked for the test – I've added a note and done nothing else.`);
    return true;
  }
  if (f[L.doNotContact]) {
    if (Object.keys(upd).length) await updateRecord(T.leads, existing.id, upd);
    await noticeAgent(existing, `${label} just responded to a social media ad${agentLine}, but Do Not Contact is ticked on their card, so I haven't texted them. Untick it if you'd like me to follow up, or give them a call.`);
    return true;
  }
  if (['Nurture', 'Lost / Not Progressing', 'Lost', 'Not to Progress'].includes(stage)) {
    // A fresh enquiry from a nurture / lost contact: back to New and into the new-lead flow
    upd[L.stage] = 'New';
    await updateRecord(T.leads, existing.id, Object.assign(upd, { [L_STATE]: '{"flow":"newlead","phase":"starting"}' }));
    const res = await startNewLeadFlow(existing.id, `They were in ${stage}${sel(f[L.nurtureReason]) ? ' (' + sel(f[L.nurtureReason]) + ')' : ''}${agentLine}. The card is back in New.`);
    if (/opener/.test(res)) await noticeAgent(existing, `${label} (was in ${stage}) responded to a social media ad overnight${agentLine}. I've moved them back to New and texted them – I'll let you know how it goes.`);
    return true;
  }
  if (Object.keys(upd).length) await updateRecord(T.leads, existing.id, upd);
  const task = f[L.nextAction] ? ` Current task: ${f[L.nextAction]}${f[L.nextActionDate] ? ' (due ' + dmy(f[L.nextActionDate]) + ')' : ''}.` : '';
  await noticeAgent(existing, `${label} (${stage}) just responded to a social media ad${agentLine}.${task} Worth a call while they're keen.`);
  return true;
}

// ---------------------------------------------------------------- texts from the team
// Agents (and Stu) text Alex's number. In order, Alex:
//  1. handles UNDO / YES for its last card change,
//  2. handles preview commands on nurture texts (SHOW / CHANGE / EDIT / CANCEL <code>) – the card's agent or Stu,
//  3. passes Stu's approval commands (YES / EDIT / NO / KEEP / LIST) to the approval flow,
//  4. reads anything else from an Alex-active agent as an update to one of their cards ("Booked Sarah Thu 2pm",
//     "Sent the price update to 14 Main St", "Spoke to Tom, not till next year") and changes the card.
//     Clear updates are made straight away with UNDO; unclear ones are confirmed first.

const pendingByPhone = new Map(); // phone -> { kind: 'undo' | 'confirm', leadId, upd, prev, summary, at }
const PENDING_MINUTES = 120;
const L_COMPLETE = 'fldRlScLUcb3ly6wF';
const L_APPT_AT = 'flddxWuZLNPYmuiFM';
const L_MTG_AT = 'fldGLVhG1pa7jXwuB';
const L_PRIORITY = 'fldtEqiFM1c8rjFG6';

const STAGE_LIST = ['New', 'No Contact – Agent Follow Up', 'Qualifying', 'Appraisal Booked', 'Price Update / Desktop Required',
  'Prepare Listing Presentation', 'Listing Meeting Booked', 'Presentation Sent', 'Decision Pending', 'Delayed / On Hold',
  'Approved / Accepted', 'Authority Sent – Awaiting Signatures', 'Listed (Won)', 'Nurture', 'Lost / Not Progressing'];
const NURTURE_REASONS = ['Proposal or decision stalled', 'Not quite ready (~3 months)', 'Too early (~6 months)', 'Curious (12 months+)',
  'Cold / gone quiet', 'Annual check-in (recently settled / yearly touch)', 'Rental provider / landlord', 'Listed with another agent (Track 8)', 'Selling in 1–2 months'];
const LOST_REASONS = ['Listed with competitor', 'Selling privately', 'Not selling', 'Not interested', 'No contact', 'Bogus or duplicate'];

// "2026-10-23T14:00" in Melbourne time -> ISO UTC
function melbToISO(local) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local || '')) return null;
  const guess = new Date(local + ':00Z');
  const shown = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
    .format(guess).replace(', ', 'T').replace(/T24/, 'T00');
  const diff = guess.getTime() - new Date(shown + ':00Z').getTime();
  return new Date(guess.getTime() + diff).toISOString();
}
function melbWhen(iso) {
  return new Intl.DateTimeFormat('en-AU', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
}

async function findActiveByCode(code) {
  const recs = await listAll(T.messages, { filterByFormula: `AND(UPPER({${M.code}})='${code}',OR({${M.status}}='Awaiting approval',{${M.status}}='Scheduled',{${M.status}}='Previewed',{${M.status}}='On hold'))` });
  return recs[0] || null;
}

async function handlePreviewCommand({ parsed, rec, member, approver, reply }) {
  const { cmd, code, rest } = parsed;
  const leadId = (rec.fields[M.lead] || [])[0];
  const lead = leadId ? await getRecord(T.leads, leadId) : null;
  if (!approver && !(lead && member && (lead.fields[L.agent] || []).includes(member.id))) {
    await reply(`${code} isn't one of your cards.`); return;
  }
  const name = lead ? lead.fields[L.name] : 'the contact';
  const current = rec.fields[M.finalText] || rec.fields[M.draft];
  const when = sel(rec.fields[M.status]) === 'Scheduled' ? 'with the rest at 2pm' : 'at 2pm';
  const who = member ? member.fields[TM.name] : (process.env.APPROVER_NAME || 'Stu');
  if (cmd === 'SHOW') { await reply(`${code} to ${name}: "${current}"`); return; }
  if (cmd === 'NO') {
    await updateRecord(T.messages, rec.id, { [M.status]: 'Rejected', [M.approverReply]: parsed.raw, [M.approvedBy]: who });
    let next = '';
    try { next = await skipNurtureRound(leadId, code); } catch (e) { console.error('Alex leads: skip round failed', e.message); }
    await reply(`${code} cancelled – nothing will go to ${name}.` + (next ? ` Next check-in ${dmy(next)}.` : ''));
    return;
  }
  if (cmd === 'YES') { await reply(`${code} is set to go ${when}.`); return; }
  if ((cmd === 'EDIT' || cmd === 'CHANGE') && !rest) { await reply(`Tell me what to change, e.g. CHANGE ${code} make it shorter.`); return; }
  if (cmd === 'CHANGE' || (cmd === 'EDIT' && looksLikeInstruction(rest))) {
    const out = await claudeJSON(VOICE, `CURRENT SMS: "${current}"\n\nTHE AGENT WANTS THIS CHANGE: "${rest}"\n\n` +
      'Rewrite the SMS applying exactly that change and nothing else. Keep the greeting and introduction unless asked to change them. Return JSON only: {"sms": "..."}', 400);
    const revised = String(out.sms || '').trim();
    if (!revised) { await reply(`Couldn't apply that to ${code} – try EDIT ${code} followed by the full wording.`); return; }
    await updateRecord(T.messages, rec.id, { [M.draft]: revised, [M.finalText]: null, [M.approverReply]: parsed.raw });
    await reply(`${code} changed – it goes ${when}:\n"${revised}"\nReply CANCEL ${code} to stop it.`);
    return;
  }
  if (cmd === 'EDIT') {
    await updateRecord(T.messages, rec.id, { [M.draft]: rest, [M.finalText]: null, [M.approverReply]: parsed.raw });
    await reply(`${code} updated – your wording goes ${when}.`);
    return;
  }
  await reply(`For ${code} reply SHOW, CHANGE [what to change], EDIT [new wording] or CANCEL.`);
}

async function agentCards(member) {
  const name = String(member.fields[TM.name] || '').replace(/'/g, "\\'");
  return listAll(T.leads, { filterByFormula: `AND(FIND('${name}',ARRAYJOIN({${L.agent}})),NOT({${L_PARKED}}),{${L.stage}}!='Listed (Won)')` });
}

function cardLine(l) {
  const f = l.fields;
  const st = sel(f[L.stage]);
  const bits = [l.id, f[L.name] || '', f[L.address] || '', st];
  if (st === 'Nurture') bits.push(sel(f[L.nurtureReason]) || 'no track');
  else if (f[L.nextAction]) bits.push(`task: ${f[L.nextAction]}${f[L.nextActionDate] ? ' (due ' + dmy(f[L.nextActionDate]) + ')' : ''}`);
  if (f[L_APPT_AT]) bits.push('appraisal ' + melbWhen(f[L_APPT_AT]));
  const offer = getState(l).offer;
  if (offer && offer.options) bits.push(`${offer.kind} time options offered: ${offer.options.map((iso, i) => `${i + 1}) ${iso.slice(0, 16)}Z = ${melbWhen(iso)}`).join(', ')}`);
  return bits.join(' | ');
}

async function applyCardChange(leadId, upd, note, authorName, rawText, statePatch) {
  const lead = await getRecord(T.leads, leadId);
  const prev = {};
  for (const k of Object.keys(upd)) prev[k] = lead.fields[k] === undefined ? null : lead.fields[k];
  for (const k of Object.keys(prev)) if (prev[k] && typeof prev[k] === 'object' && !Array.isArray(prev[k]) && prev[k].name) prev[k] = prev[k].name;
  const write = Object.assign({}, upd);
  if (statePatch) write[L_STATE] = JSON.stringify(Object.assign(getState(lead), statePatch));
  if (Object.keys(write).length) await updateRecord(T.leads, leadId, write);
  await logActivity(leadId, { summary: `${authorName} updated the card by text`, detail: (note ? note + '\n' : '') + `Text: "${rawText}"`, type: 'SMS', kind: 'Note' });
  return prev;
}

// Turn one interpreted update into Airtable fields
function fieldsFor(card, c) {
  const upd = {};
  if (c.stage && STAGE_LIST.includes(c.stage) && c.stage !== sel(card.fields[L.stage])) upd[L.stage] = c.stage;
  if (c.next_action) upd[L.nextAction] = c.next_action;
  if (/^\d{4}-\d{2}-\d{2}$/.test(c.next_action_date || '')) upd[L.nextActionDate] = c.next_action_date;
  const appt = melbToISO(c.appraisal_at); if (appt) upd[L_APPT_AT] = appt;
  const mtg = melbToISO(c.listing_meeting_at); if (mtg) upd[L_MTG_AT] = mtg;
  if (c.source && SOURCE_LIST.includes(c.source)) upd[L.source] = c.source;
  if (c.source_detail && String(c.source_detail).trim()) upd[L.sourceDetail] = String(c.source_detail).trim();
  const call = melbToISO(c.call_at);
  if (call) {
    upd[L_CALL_AT] = call;
    if (!c.next_action) { upd[L.nextAction] = `Call ${firstName(card.fields[L.name]) || card.fields[L.name]} – ${melbWhen(call)}`; upd[L.nextActionDate] = new Date(call).toLocaleDateString('en-CA', { timeZone: TZ }); }
  }
  if (c.nurture_reason && NURTURE_REASONS.includes(c.nurture_reason)) upd[L.nurtureReason] = c.nurture_reason;
  if (c.lost_reason && LOST_REASONS.includes(c.lost_reason)) upd[L_LOST_REASON] = c.lost_reason;
  if (/^\d{4}-\d{2}-\d{2}$/.test(c.authority_ends || '')) upd[L_AUTH_ENDS] = c.authority_ends;
  if (c.priority === true) upd[L_PRIORITY] = true;
  for (const [k, fid] of [['vendor_price_expectation', PROP.vendorPrice], ['agent_price_guide', PROP.agentGuide], ['decision_makers', PROP.decisionMakers], ['other_agents', PROP.otherAgents]])
    if (c[k] && String(c[k]).trim()) upd[fid] = String(c[k]).trim();
  if (c.complete_task === true && !upd[L.stage] && card.fields[L.nextAction]) upd[L_COMPLETE] = '✓ Done';
  return upd;
}

// Mobiles in a text that aren't on any of the agent's cards → the agent is telling Alex about someone new
const MOBILE_RE = /(?:\+?61\s?|0)4(?:[\s-]?\d){8}/g;
function unknownMobiles(text, cards) {
  const mine = new Set(cards.map(c => normalisePhone(c.fields[L.phone] || '')).filter(Boolean));
  const out = [];
  for (const m of String(text).match(MOBILE_RE) || []) {
    const n = normalisePhone(m.replace(/[\s-]/g, ''));
    if (n && !out.includes(n) && !mine.has(n)) out.push(n);
  }
  return out;
}
// A focused read of a new contact's details (one job only, so it isn't confused with updating a card)
async function extractNewContact(text, prev) {
  const now = melbNow();
  const user = `TODAY: ${now.weekday} ${now.date} (Melbourne).\n` +
    (prev ? `DETAILS SO FAR (from the agent's earlier texts: "${prev.raw || ''}"): ${JSON.stringify(prev.draft || {})}\n` : '') +
    `THE AGENT TEXTED: "${text}"\n\nThe agent is adding a NEW contact (not an existing card). Pull out everything they said, merging with the details so far.\n` +
    `SOURCES: ${SOURCE_LIST.join('; ')}\nSTAGES: ${STAGE_LIST.join('; ')}\nNURTURE REASONS: ${NURTURE_REASONS.join('; ')}\n` +
    'Rules: times as 24h local "YYYY-MM-DDTHH:MM" ("this afternoon at 1:30 pm" = today 13:30; a weekday = the NEXT such date). An appraisal time → stage "Appraisal Booked" + appraisal_at. A call agreed → "Qualifying" + call_at. Not moving for a while → "Nurture" + nurture_reason. Otherwise "Qualifying". ' +
    'source only if they said where the lead came from (one of SOURCES), source_detail for specifics. Keep the address as written. Never invent anything.\n' +
    'Return JSON only: {"name": "", "mobile": "", "address": "", "email": "", "source": "", "source_detail": "", "stage": "", "appraisal_at": "", "call_at": "", "next_action": "", "next_action_date": "", "nurture_reason": "", "details": {"beds": null, "baths": null, "block": null}, "motivation": "Making a move|Just an update|Unsure|", "timing": "", "notes": ""}';
  const out = await claudeJSON('You are Alex, the sales assistant at Stone Real Estate Ballarat. You extract a new contact\'s details from an agent\'s text, accurately and conservatively.', user, 700);
  console.log('Alex leads: new contact read as ' + JSON.stringify(out).slice(0, 400));
  return out;
}

async function addNewContact(member, from, text, reply, pendingCard, nc, cards) {
  const key0 = normalisePhone(from);
  nc = Object.assign({ name: '', mobile: '', address: '', source: '' }, nc || {});
  if (pendingCard) { for (const [k, v] of Object.entries(pendingCard.draft || {})) if (v && !nc[k]) nc[k] = v; }
  const out = { question: '' };
  const missing = [];
  if (!String(nc.name || '').trim()) missing.push('name');
  if (!isTextableMobile(nc.mobile || '')) missing.push('mobile');
  if (!String(nc.address || '').trim()) missing.push('address');
  if (missing.length) {
    const parts = missing.map(m => m === 'source' ? 'where you met them' : m === 'address' ? 'the property address' : m);
    const what = (parts.length > 1 ? parts.slice(0, -1).join(', ') + ' and ' + parts.at(-1) : parts[0]) + (missing.includes('source') ? ' (open home, referral, door knock…)' : '');
    const question = (missing.length >= 3 ? `Great – what's their ${what}?` : null) || (out.question && String(out.question).trim()) || `Happy to add ${nc.name || 'them'} – what's their ${missing.map(m => m === 'source' ? 'lead source' : m).join(', ').replace(/, ([^,]*)$/, ' and $1')}?${missing.includes('source') ? ' (open home, referral, door knock…)' : ''}`;
    pendingByPhone.set(key0, { kind: 'newcard', draft: nc, question, raw: [(pendingCard && pendingCard.raw) || '', text].filter(Boolean).join(' / '), at: Date.now() });
    await reply(question);
    return;
  }
  const res = await createCardFromText(member, nc, [(pendingCard && pendingCard.raw) || '', text].filter(Boolean).join(' / '));
  if (res.createdId && !SOURCE_LIST.includes(nc.source)) {
    const q = `Where did the lead come from (open home, referral, door knock, past client…)? I'll add it to ${firstName(nc.name) || 'their'}'s card.`;
    res.reply += '\n' + q;
    rememberQuestions(member, melbNow().date, [{ n: 0, leadId: res.createdId, question: `${nc.name} – LEAD SOURCE for this new card (set source to one of SOURCES, source_detail for anything more specific): ${q}` }]);
  }
  if (res.createdId) pendingByPhone.set(key0, { kind: 'undo', items: [], created: res.createdId, summary: `${nc.name} added`, at: Date.now() });
  if (res.existingId) {
    const ex = cards.find(c => c.id === res.existingId) || await getRecord(T.leads, res.existingId);
    await reply(`${leadLabel(ex.fields)} is already one of your cards (${sel(ex.fields[L.stage])}) – I've added your text as a note. Tell me what to change on it.`);
    return;
  }
  await reply(res.reply + (res.createdId ? '\nReply UNDO to remove it.' : ''));
  return;
}

async function handleAgentUpdate(member, from, text, reply, pendingCard) {
  const cards = await agentCards(member);
  // New contact first: said so, answering Alex's question about one, or a mobile that's on no card
  const saysNew = /\bnew\s+(contact|client|lead|vendor|person|customer|card)\b/i.test(text) || /^\s*(it'?s\s+)?(a\s+)?new\b/i.test(text);
  if (pendingCard || saysNew || unknownMobiles(text, cards).length) {
    return addNewContact(member, from, text, reply, pendingCard, await extractNewContact(text, pendingCard), cards);
  }
  const now = melbNow();
  const key = normalisePhone(from);
  const asked = checkinsByPhone.get(key);
  const questions = asked && asked.date === now.date ? asked.items : [];
  const user =
    `TODAY: ${now.weekday} ${now.date} (Melbourne). AGENT: ${member.fields[TM.name]}\n\n` +
    `THE AGENT'S CARDS (id | contact | address | stage | task or track):\n${cards.map(cardLine).join('\n')}\n\n` +
    (questions.length ? `QUESTIONS ALEX ASKED THE AGENT TODAY (the agent may answer by number, e.g. "1 booked Thu 2pm, 2 sent, 3b"):\n${questions.map(q => `${q.n ? q.n + ' – ' : ''}[${q.leadId}] ${q.question}`).join('\n')}\n\n` : '') +
    (pendingCard ? `A NEW CONTACT THE AGENT IS ADDING – details so far: ${JSON.stringify(pendingCard.draft)}. The agent's earlier text: "${pendingCard.raw || ''}". Alex asked: "${pendingCard.question}". The agent's text below most likely answers that – merge it into new_card.\n\n` : '') +
    `THE AGENT TEXTED ALEX: "${text}"\n\n` +
    `SOURCES (for a new contact): ${SOURCE_LIST.join('; ')}\n` +
    `STAGES: ${STAGE_LIST.join('; ')}\nNURTURE REASONS: ${NURTURE_REASONS.join('; ')}\nLOST REASONS: ${LOST_REASONS.join('; ')}\n\n` +
    'Work out which card(s) this is about and what to change on each. Rules: change only what the agent clearly said. ' +
    'An appraisal booked → stage "Appraisal Booked" with appraisal_at. A listing meeting booked → "Listing Meeting Booked" with listing_meeting_at. ' +
    'After-appraisal answers: 1 → "Price Update / Desktop Required", 2 → "Prepare Listing Presentation", 3 → "Listing Meeting Booked" (+ listing_meeting_at if given), 4 → "Presentation Sent"; ' +
    'capture vendor_price_expectation, agent_price_guide, decision_makers, other_agents if mentioned. Cancelled / no-show → "Qualifying" with a rebooking next_action. ' +
    'A price update sent → "Presentation Sent" is wrong – instead keep the stage and complete_task true, unless they say the presentation/proposal was sent ("Presentation Sent"). ' +
    '"They want to go ahead / verbal yes" → "Approved / Accepted". "Authority sent" → "Authority Sent – Awaiting Signatures". "Signed up / signed the authority" → "Listed (Won)". ' +
    '"Not ready / next year / later" → "Nurture" with the matching nurture_reason. "On hold / delayed" → "Delayed / On Hold" with next_action_date when to check back. ' +
    '"Listed with another agent" → "Lost / Not Progressing" with lost_reason "Listed with competitor". A lost reason given for a Lost card → lost_reason only. ' +
    'No Contact answers: "spoke/booked" → the matching stage; "no answer / no luck" → no change (note only); "a" → "Nurture" with nurture_reason "Cold / gone quiet"; "b" or "keep trying" → restart_no_contact true; "c" → read what they said. ' +
    'A task question answered "done/sent/yes" → complete_task true. ' +
    'Options in a question (a/b/c or 1–5) map to the actions written next to them in that question. ' +
    'If a card shows "time options offered" and the agent picks one (by number with the name, by the time, or a bare number when only that card has options), set appraisal_at (or listing_meeting_at) to that time in local "YYYY-MM-DDTHH:MM" and stage "Appraisal Booked" (or "Listing Meeting Booked"); another time they give works the same way. ' +
    '"CALL" / "I\'ll ring them" about a card with time options → next_action "Call <first name> to book the appraisal" due today, and clear_offer true. ' +
    'A call time agreed with a contact → call_at (and stage "Qualifying" if the card is New or No Contact). "No answer" to an after-call question → no_answer true. ' +
    'NEW CONTACTS: "new contact", "new client", "new lead", "new vendor", or a booking with someone whose name, mobile and address match none of THE AGENT\'S CARDS, is a new contact even if no details are given yet ("Booked an appraisal with a new client Thu 10am") – set new_contact true and fill new_card with whatever is known (empty strings for the rest); never answer "which card?" for a new contact. ' +
    'If the agent is telling Alex about someone who is NOT one of their cards ("New contact: Jo Smith 0412 345 678, 5 High St Sebastopol, met at open home, appraisal Tue 10am"), fill new_card instead of updates: ' +
    'name, mobile and address are required; source = one of SOURCES only if the agent said where the lead came from (else empty; Alex asks after creating the card), source_detail for anything more specific; email if given; stage = "Appraisal Booked" if an appraisal time is given, "Nurture" (+ nurture_reason) if they are not moving for a while, otherwise "Qualifying"; ' +
    'list anything required that is missing in missing[] (use "source" if no source was given) and put ONE short question asking for all of it in question. ' +
    'Use 24h local times "YYYY-MM-DDTHH:MM"; resolve weekdays to the NEXT such date. ' +
    'If you cannot tell which card or what they mean, set question and return no updates. confidence "high" only when every card and change is unambiguous.\n' +
    'new_card shape: {"name": "", "mobile": "", "address": "", "email": "", "source": "", "source_detail": "", "stage": "", "appraisal_at": "", "call_at": "", "next_action": "", "next_action_date": "", "nurture_reason": "", "details": {"beds": null, "baths": null, "block": null}, "motivation": "Making a move|Just an update|Unsure|", "timing": "", "notes": ""} or null; missing: [].\n' +
    'Return JSON only: {"updates": [{"lead_id": "rec...", "changes": {"stage": "", "next_action": "", "next_action_date": "", "appraisal_at": "", "listing_meeting_at": "", "nurture_reason": "", "lost_reason": "", "authority_ends": "", "priority": false, "complete_task": false, "restart_no_contact": false, "call_at": "", "no_answer": false, "clear_offer": false, "source": "", "source_detail": "", "vendor_price_expectation": "", "agent_price_guide": "", "decision_makers": "", "other_agents": ""}, "note": "fact worth logging, or empty", "summary": "e.g. Sarah Jones → Appraisal Booked, Thu 23 Oct 2pm (say if you tick off a task)"}], "new_contact": false, "new_card": null, "missing": [], "confidence": "high|low", "question": ""}';
  const out = await claudeJSON('You are Alex, the sales assistant at Stone Real Estate Ballarat. You read short texts from agents and update their lead cards accurately and conservatively.', user, 1400);
  const updates = (out.updates || []).filter(u => cards.some(c => c.id === u.lead_id));
  const key0 = normalisePhone(from);
  // A new contact added by text
  console.log('Alex leads: agent update read as ' + JSON.stringify(out).slice(0, 500));
  if (out.new_contact === true || (out.new_card && typeof out.new_card === 'object' && (out.new_card.name || out.new_card.mobile || out.new_card.address))) {
    return addNewContact(member, from, text, reply, pendingCard, await extractNewContact(text, pendingCard), cards);
  }
  if (!cards.length) { await reply(out.question || "I couldn't find any cards for you yet – to add someone, text me their name, mobile, address and where the lead came from."); return; }
  if (!updates.length || out.question) {
    await reply(out.question || "Sorry, I couldn't tell which card that's about – can you include the name or address?");
    return;
  }
  const authorName = firstName(member.fields[TM.name]) || member.fields[TM.name];
  const today = melbNow().date;
  const plan = [];
  const notesOnly = [];
  for (const u of updates) {
    const card = cards.find(c => c.id === u.lead_id);
    const ch = u.changes || {};
    const upd = fieldsFor(card, ch);
    const statePatch = ch.restart_no_contact === true ? { ncBase: today, ncAsked: {} } : null;
    const after = { noAnswer: ch.no_answer === true, clearOffer: ch.clear_offer === true };
    if (statePatch && sel(card.fields[L.stage]) === NO_CONTACT) { upd[L.nextActionDate] = upd[L.nextActionDate] || addBizDays5(today); }
    const note = String(u.note || '').trim();
    const summary = String(u.summary || '').trim() || `${card.fields[L.name]} updated`;
    if (!Object.keys(upd).length && !statePatch && !after.noAnswer && !after.clearOffer) { notesOnly.push({ card, note, summary }); continue; }
    plan.push({ leadId: card.id, upd, note, summary, statePatch, after });
  }
  for (const n of notesOnly) if (n.note) await logActivity(n.card.id, { summary: `${authorName}: ${n.note}`, detail: `Text: "${text}"`, type: 'SMS', kind: 'Note' });
  const noteLines = notesOnly.map(n => n.note ? `Noted on ${n.card.fields[L.name]}: ${n.note}` : `${n.card.fields[L.name]}: nothing to change`);
  if (!plan.length) { await reply(noteLines.join('\n') || 'Nothing to change.'); return; }
  const summaryText = plan.map(p => p.summary).join('\n');
  if (out.confidence !== 'high') {
    pendingByPhone.set(key, { kind: 'confirm', plan, raw: text, author: authorName, at: Date.now() });
    await reply(`${summaryText}\nOK? Reply YES, or tell me what's different.` + (noteLines.length ? '\n' + noteLines.join('\n') : ''));
    return;
  }
  await applyPlan(key, plan, authorName, text, reply, noteLines);
}
function addBizDays5(iso) { let d = iso, n = 0; while (n < 5) { d = addDays(d, 1); if (isBizDay(d)) n++; } return d; }

async function applyPlan(key, plan, authorName, rawText, reply, noteLines) {
  const undo = [];
  for (const p of plan) {
    const prev = await applyCardChange(p.leadId, p.upd, p.note, authorName, rawText, p.statePatch);
    delete prev[L_COMPLETE];
    if (Object.keys(prev).length) undo.push({ leadId: p.leadId, prev });
    try { p.extra = (await afterCardChange(p.leadId, p.upd, p.after, null)).trim(); } catch (e) { console.error('Alex leads: after card change failed', e.message); }
  }
  const summaryText = plan.map(p => p.summary + (p.extra ? ' ' + p.extra : '')).join('\n');
  pendingByPhone.set(key, { kind: 'undo', items: undo, summary: summaryText, at: Date.now() });
  await reply(`Done:\n${summaryText}` + (noteLines && noteLines.length ? '\n' + noteLines.join('\n') : '') + (undo.length ? '\nReply UNDO to reverse.' : ''));
}

// Returns true when the text came from the team and was handled here
async function handleTeamSMS(from, body) {
  if (!enabled()) return false;
  // GoHighLevel social-media lead texts ("NEW LEAD …" from a GHL_LEAD_NUMBERS number)
  if (await handleGhlLead(from, body)) return true;
  const approver = isApprover(from);
  const member = await teamByPhone(from);
  if (!member && !approver) return false;
  const text = String(body || '').trim();
  const reply = msg => { console.log('Alex leads → ' + from + ': ' + String(msg).replace(/\n/g, ' / ')); return sendSMS(from, msg); };
  console.log('Alex leads: team text from ' + (member ? member.fields[TM.name] : 'approver') + (member && !member.fields[TM.alexActive] ? ' (not Alex Active)' : ''));
  const key = normalisePhone(from);

  // 1. UNDO / confirmation of the last card change
  let pend = pendingByPhone.get(key);
  if (pend && Date.now() - pend.at > PENDING_MINUTES * 60000) { pendingByPhone.delete(key); pend = null; }
  if (/^undo\b/i.test(text)) {
    const createdIds = pend && pend.kind === 'undo' ? [].concat(pend.created || []) : [];
    if (createdIds.length && !(pend.items || []).length) {
      for (const id of createdIds) await at('DELETE', T.leads + '/' + id);
      pendingByPhone.delete(key);
      if (typeof leadsChanged === 'function') leadsChanged();
      await reply(`Undone – ${pend.summary.replace(/ added$/, '').replace(/^created /, '')} removed.`);
      if (member) await rememberTurn(member, 'UNDO', 'Undone: ' + pend.summary);
      return true;
    }
    if (!pend || pend.kind !== 'undo' || !(pend.items || []).length) { await reply('Nothing to undo (a ticked-off task can be set again on the card).'); return true; }
    for (const it of pend.items) {
      await updateRecord(T.leads, it.leadId, it.prev);
      await logActivity(it.leadId, { summary: 'Card change by text undone', detail: pend.summary, type: 'General', kind: 'History' });
    }
    for (const id of createdIds) await at('DELETE', T.leads + '/' + id);
    pendingByPhone.delete(key);
    leadsChanged();
    await reply(`Undone:\n${pend.summary}`);
    if (member) await rememberTurn(member, 'UNDO', 'Undone: ' + pend.summary);
    return true;
  }
  if (pend && pend.kind === 'confirm') {
    if (/^(yes|y|yep|yeah|ok|okay|sure|go|go ahead|correct|👍)\b/i.test(text) && !/\bA\s?\d{1,2}\b/i.test(text)) {
      await applyPlan(key, pend.plan, pend.author, pend.raw, reply);
      return true;
    }
    if (/^(no|n|nope|nah|cancel)$/i.test(text)) { pendingByPhone.delete(key); await reply("OK, I've left the card as it was."); return true; }
    pendingByPhone.delete(key); // anything else is a fresh message
  }
  let pendingCard = null;
  if (pend && pend.kind === 'newcard') {
    pendingByPhone.delete(key);
    if (/^(no|nah|cancel|forget it|never mind)\b/i.test(text)) { await reply("OK, I haven't added them."); return true; }
    pendingCard = pend;
  }

  // 2. CALL / ALEX for a new lead
  if (member && /^(call|alex)\b/i.test(text) && await handleCallAlex(member, from, text, reply)) return true;

  // 3. preview / approval commands with a code
  const parsed = parseApproverCommand(text);
  if (parsed) parsed.raw = text;
  if (parsed && parsed.code) {
    const rec = await findActiveByCode(parsed.code);
    if (rec && ['Scheduled', 'Previewed'].includes(sel(rec.fields[M.status]))) {
      await handlePreviewCommand({ parsed, rec, member, approver, reply });
      return true;
    }
    // an offer to the card's agent (appraisal confirmation, thank-you): YES / EDIT / NO with the code
    if (rec && !approver && member && sel(rec.fields[M.status]) === 'Awaiting approval' && ['YES', 'NO', 'EDIT', 'CHANGE'].includes(parsed.cmd)) {
      const offerLead = (rec.fields[M.lead] || [])[0] ? await getRecord(T.leads, rec.fields[M.lead][0]) : null;
      if (offerLead && (offerLead.fields[L.agent] || []).includes(member.id)) { await handleApproverSMS(text, from, member.fields[TM.name]); return true; }
      await reply(`${parsed.code} isn't one of your cards.`);
      return true;
    }
  }
  // 4. Stu's approval flow. A bare "yes"/"no" with no code goes to the assistant instead when it asked something in the
  //    last 2 hours, or when no draft is waiting for approval.
  const assistantAsked = member && assistantOn() && (() => { const c = chatOf(member).at(-1); return c && c.r === 'alex' && /\?/.test(c.t) && minutesSince(c.at) < 120; })();
  const bareReply = parsed && !parsed.code && ['YES', 'NO'].includes(parsed.cmd);
  if (approver && parsed && !(bareReply && (assistantAsked || !(await waitingDrafts()).length)) && await handleApproverSMS(text)) return true;

  // 5. Fiona replying about an authority
  if (member && /^fiona\b/i.test(String(member.fields[TM.name] || '')) && await handleFionaSMS(member, text, reply)) return true;

  // 6. a card update from an Alex-active agent (including answers to the 9:30 check-in)
  if (member && member.fields[TM.alexActive]) {
    if (assistantOn()) {
      // answered in the background (several AI steps can take longer than Twilio waits); one person's texts stay in order
      const job = enqueueAssistant(key, () => runAssistant(member, from, text, reply));
      if (process.env.ALEX_ASSISTANT_WAIT) await job;
      return true;
    }
    try { await handleAgentUpdate(member, from, text, reply, pendingCard); }
    catch (e) { console.error('Alex leads: agent update failed', e.message); await reply("Sorry, I couldn't process that – please update the card in Airtable."); }
    return true;
  }
  return false;
}

// ---------------------------------------------------------------- Outlook calendars (Microsoft Graph)
// Switched on by three Railway variables from an Azure app registration with the Calendars.ReadWrite application
// permission (admin consent): MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET. Each agent's calendar is their Team email.
// Without them Alex works as before: it collects preferred times and the agent confirms.
const L_CALL_AT = 'fldiAZOtTEmOpVZN5';
const TM_EMAIL = 'fldCwH4gZpNqZKmU1';
const APPRAISAL_MINUTES = 60;
const SLOT_TIMES = ['09:30', '11:00', '13:30', '15:30'];

function calendarEnabled() { return !!(process.env.MS_TENANT_ID && process.env.MS_CLIENT_ID && process.env.MS_CLIENT_SECRET); }
let graphTok = { at: 0, token: '' };
async function graphToken() {
  if (graphTok.token && Date.now() - graphTok.at < 50 * 60000) return graphTok.token;
  const res = await fetch(`https://login.microsoftonline.com/${process.env.MS_TENANT_ID}/oauth2/v2.0/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: process.env.MS_CLIENT_ID, client_secret: process.env.MS_CLIENT_SECRET, scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' })
  });
  const j = await res.json();
  if (!res.ok) throw new Error('Graph token: ' + JSON.stringify(j).slice(0, 200));
  graphTok = { at: Date.now(), token: j.access_token };
  return j.access_token;
}
async function graph(method, path, body) {
  const res = await fetch('https://graph.microsoft.com/v1.0' + path, {
    method, headers: { Authorization: 'Bearer ' + await graphToken(), 'Content-Type': 'application/json', Prefer: 'outlook.timezone="UTC"' },
    body: body ? JSON.stringify(body) : undefined
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('Graph ' + method + ' ' + path + ' ' + res.status + ': ' + JSON.stringify(j).slice(0, 200));
  return j;
}
const utcStamp = iso => new Date(iso).toISOString().slice(0, 19);
async function busyTimes(email, fromIso, toIso) {
  const j = await graph('POST', `/users/${encodeURIComponent(email)}/calendar/getSchedule`, {
    schedules: [email], startTime: { dateTime: utcStamp(fromIso), timeZone: 'UTC' }, endTime: { dateTime: utcStamp(toIso), timeZone: 'UTC' }, availabilityViewInterval: 30
  });
  return ((j.value || [])[0] || {}).scheduleItems?.filter(i => i.status !== 'free').map(i => ({ start: i.start.dateTime + 'Z', end: i.end.dateTime + 'Z', subject: i.subject || 'busy' })) || [];
}
const overlaps = (aS, aE, b) => new Date(aS) < new Date(b.end) && new Date(aE) > new Date(b.start);
// Two free appraisal times on different days over the next week (business days, Mon–Fri)
async function freeSlots(email, count) {
  const c = melbClock();
  const days = []; let d = c.date;
  while (days.length < 6) { d = addDays(d, 1); if (isBizDay(d)) days.push(d); }
  const from = melbToISO(days[0] + 'T00:00'), to = melbToISO(addDays(days[days.length - 1], 1) + 'T00:00');
  const busy = await busyTimes(email, from, to);
  const out = [];
  for (const day of days) {
    for (const t of SLOT_TIMES) {
      const s = melbToISO(day + 'T' + t); const e = new Date(new Date(s).getTime() + APPRAISAL_MINUTES * 60000).toISOString();
      if (!busy.some(b => overlaps(s, e, b))) { out.push({ local: day + 'T' + t, iso: s, label: melbWhen(s) }); break; } // one per day
    }
    if (out.length >= (count || 2)) break;
  }
  return out;
}
async function clashes(email, startIso, minutes) {
  const end = new Date(new Date(startIso).getTime() + (minutes || APPRAISAL_MINUTES) * 60000).toISOString();
  return (await busyTimes(email, startIso, end)).filter(b => overlaps(startIso, end, b));
}
async function addToCalendar(agent, lead, startIso, kind) {
  const email = agent && agent.fields[TM_EMAIL];
  if (!calendarEnabled() || !email) return '';
  try {
    const f = lead.fields;
    const clash = await clashes(email, startIso);
    const end = new Date(new Date(startIso).getTime() + APPRAISAL_MINUTES * 60000).toISOString();
    const prop = [f[PROP.beds] && f[PROP.beds] + ' bed', f[PROP.baths] && f[PROP.baths] + ' bath', f[PROP.block] && f[PROP.block] + 'm²'].filter(Boolean).join(', ');
    await graph('POST', `/users/${encodeURIComponent(email)}/events`, {
      subject: `${kind} – ${f[L.name] || ''}${f[L.address] ? ', ' + f[L.address] : ''}`,
      start: { dateTime: utcStamp(startIso), timeZone: 'UTC' }, end: { dateTime: utcStamp(end), timeZone: 'UTC' },
      location: { displayName: f[L.address] || '' },
      body: { contentType: 'text', content: [`${f[L.name] || ''} · ${f[L.phone] || ''}`, prop, sel(f[PROP.motivation]) && 'Motivation: ' + sel(f[PROP.motivation]), f[PROP.timing] && 'Timing: ' + f[PROP.timing], 'Booked by Alex – card in Airtable Sales Leads.'].filter(Boolean).join('\n') }
    });
    return clash.length ? ` Added to your Outlook calendar – heads-up, it overlaps "${clash[0].subject}".` : ' Added to your Outlook calendar.';
  } catch (e) { console.error('Alex leads: calendar add failed', e.message); return ' (Couldn\'t add it to your Outlook calendar – please add it.)'; }
}

// ---------------------------------------------------------------- appointment options for the agent (no calendar access)
// Alex can't see Outlook, so it uses the bookings already on the agent's cards in Airtable (appraisals, listing
// meetings, calls) to avoid clashes, offers the agent up to 3 times that fit what the contact said, and confirms
// with the contact once the agent picks one (in business hours).
async function agentBookings(agentId) {
  const nowIso = new Date(Date.now()).toISOString();
  const recs = await listAll(T.leads, { filterByFormula: `OR({${L_APPT_AT}}!='',{${L_MTG_AT}}!='',{${L_CALL_AT}}!='')` });
  const out = [];
  for (const r of recs) {
    if (!(r.fields[L.agent] || []).includes(agentId) || r.fields[L_PARKED]) continue;
    for (const [fid, mins, kind] of [[L_APPT_AT, APPRAISAL_MINUTES, 'appraisal'], [L_MTG_AT, APPRAISAL_MINUTES, 'listing meeting'], [L_CALL_AT, 20, 'call']]) {
      const st = r.fields[fid];
      if (!st || st < nowIso) continue;
      out.push({ start: st, end: new Date(new Date(st).getTime() + mins * 60000).toISOString(), subject: `${kind} – ${r.fields[L.name] || ''}`, leadId: r.id });
    }
  }
  return out.sort((a, b) => a.start < b.start ? -1 : 1);
}
// Keep options that are in the future, Mon–Sat 8am–6pm, and clear of the agent's bookings (30 min travel buffer)
async function cleanOptions(agentId, locals, skipLeadId) {
  const busy = (await agentBookings(agentId)).filter(b => b.leadId !== skipLeadId)
    .map(b => ({ start: new Date(new Date(b.start).getTime() - 30 * 60000).toISOString(), end: new Date(new Date(b.end).getTime() + 30 * 60000).toISOString() }));
  const seen = new Set(); const out = [];
  for (const loc of locals || []) {
    const iso = melbToISO(loc);
    if (!iso || seen.has(iso) || Date.parse(iso) < Date.now() + 2 * 3600000) continue;
    const day = loc.slice(0, 10), hhmm = loc.slice(11);
    if (new Date(day + 'T00:00:00Z').getUTCDay() === 0 || hhmm < '08:00' || hhmm > '18:00') continue;
    const end = new Date(new Date(iso).getTime() + APPRAISAL_MINUTES * 60000).toISOString();
    if (busy.some(b => overlaps(iso, end, b))) continue;
    seen.add(iso); out.push(iso);
    if (out.length >= 3) break;
  }
  return out;
}
function bookingsText(list) { return list.slice(0, 15).map(b => `${melbWhen(b.start)} (${b.subject})`).join('; ') || 'none'; }
function optionsText(isos) { return isos.map((iso, i) => `${i + 1} – ${melbWhen(iso)}`).join(' · '); }
// Text the agent the options (now in business hours, otherwise from 8am) and keep them on the card for their reply
async function offerTimesToAgent(lead, isos, kind, intro) {
  const state = getState(lead);
  state.offer = { kind: kind || 'appraisal', options: isos, at: new Date(Date.now()).toISOString(), reminded: false };
  await setState(lead.id, state);
  const text = `${intro}\nTimes that suit them and are clear in Airtable: ${optionsText(isos)}.\nReply with the number (e.g. "${firstName(lead.fields[L.name]) || 'them'} 2"), another time, or CALL if you'll ring them.`;
  return noticeAgent(await getRecord(T.leads, lead.id), text);
}
// Once the agent has picked a time, Alex drafts the contact's confirmation and the agent approves it (YES / EDIT / NO + code)
async function confirmToContact(lead, iso, kind) {
  const f = lead.fields;
  if (f[L.doNotContact] || !isTextableMobile(f[L.phone])) return '';
  const agent = await agentOfLead(lead);
  const agentFirst = agent ? firstName(agent.fields[TM.name]) : 'our agent';
  const first = firstName(f[L.name]);
  const draft = `All set${first ? ' ' + first : ''} – ${agentFirst} will see you ${melbWhen(iso)}${f[L.address] ? ' at ' + f[L.address] : ''}${kind === 'listing meeting' ? ' for the listing meeting' : ''}. If anything changes, just reply here. – Alex, Stone Ballarat`;
  const o = await offerDraft(lead, 'Appraisal confirmation', draft, `Want me to send ${first || 'them'} this confirmation?`);
  return '\n' + o.text;
}
// Every few minutes in business hours: send held confirmations; remind the agent once if options are 2h unanswered
async function offerTick() {
  if (!sweepEnabled() || !isBH()) return;
  // offers the agent approved outside business hours go out from 8am
  const approved = (await listAll(T.messages, { filterByFormula: `OR({${M.status}}='Approved',{${M.status}}='Edited & approved')` }))
    .filter(r => QUICK_PURPOSES.includes(sel(r.fields[M.purpose])));
  for (const r of approved) { try { await sendApproved(r); } catch (e) { console.error('Alex leads: approved offer send failed', e.message); } }
  const leads = await listAll(T.leads, { filterByFormula: `OR(FIND('"pendingConfirm":',{${L_STATE}}&''),FIND('"offer":',{${L_STATE}}&''))` });
  for (const lead of leads) {
    const f = lead.fields;
    const state = getState(lead);
    try {
      if (state.pendingConfirm && isTextableMobile(f[L.phone]) && !f[L.doNotContact]) {
        const sid = await sendSMS(f[L.phone], state.pendingConfirm.text); await logOut(lead, state.pendingConfirm.text, 'Other', sid);
        delete state.pendingConfirm; await setState(lead.id, state);
      } else if (state.pendingConfirm) { delete state.pendingConfirm; await setState(lead.id, state); }
      if (state.offer && !state.offer.reminded && minutesSince(state.offer.at) >= 120) {
        const live = state.offer.options.filter(iso => Date.parse(iso) > Date.now() + 3600000);
        if (!live.length) { delete state.offer; await setState(lead.id, state); continue; }
        await textAgent(await agentOfLead(lead), `Reminder – ${leadLabel(f)} is waiting on ${state.offer.kind === 'appraisal' ? 'an' : 'a'} ${state.offer.kind} time: ${optionsText(live)}. Reply with the number, another time, or CALL.`);
        state.offer.reminded = true; await setState(lead.id, state);
      }
    } catch (e) { console.error('Alex leads: offer tick failed for ' + lead.id, e.message); }
  }
}

// ---------------------------------------------------------------- Qualifying: the agreed call
// Morning of the call Alex texts the contact; 15 minutes before it briefs the agent; an hour after it asks how it went.
function minutesUntil(iso) { return (new Date(iso).getTime() - Date.now()) / 60000; }
async function recentContactLines(lead, n) {
  const msgs = await leadMessages(lead.fields);
  return msgs.filter(m => sel(m.fields[M.direction]) === 'From vendor').slice(-(n || 2)).map(m => `"${String(m.fields[M.finalText] || '').slice(0, 160)}"`);
}
function propLine(f) {
  return [f[PROP.beds] && f[PROP.beds] + ' bed', f[PROP.baths] && f[PROP.baths] + ' bath', f[PROP.living] && f[PROP.living] + ' living', f[PROP.block] && f[PROP.block] + 'm²', f[PROP.renos]].filter(Boolean).join(', ');
}
async function callTick() {
  if (!sweepEnabled()) return;
  const c = melbClock();
  if (c.weekday === 'Sun' || c.hour < 8 || c.hour >= 20) return;
  const agents = await alexActiveAgentIds();
  if (!agents.size) return;
  const leads = (await listAll(T.leads, { filterByFormula: `AND({${L_CALL_AT}}!='',NOT({${L_PARKED}}),{${L.stage}}!='Nurture',{${L.stage}}!='Listed (Won)',{${L.stage}}!='Lost / Not Progressing')` }))
    .filter(l => (l.fields[L.agent] || []).some(id => agents.has(id)));
  for (const lead of leads) {
    const f = lead.fields;
    const at = f[L_CALL_AT];
    const state = getState(lead);
    const agent = await agentOfLead(lead);
    const agentFirst = agent ? firstName(agent.fields[TM.name]) : 'our agent';
    const first = firstName(f[L.name]) || f[L.name] || 'them';
    const until = minutesUntil(at);
    const callDay = new Date(at).toLocaleDateString('en-CA', { timeZone: TZ });
    const time = new Intl.DateTimeFormat('en-AU', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }).format(new Date(at));
    try {
      // morning-of text to the contact (only for calls from 9am, and at least 45 minutes ahead)
      if (callDay === c.date && state.callMorning !== at && until >= 45 && new Date(at).toLocaleTimeString('en-GB', { timeZone: TZ }) >= '09:00' && !f[L.doNotContact] && isTextableMobile(f[L.phone])) {
        const text = `Hi ${first}, just a heads-up that ${agentFirst} will give you a call around ${time} today${f[L.address] ? ' about ' + f[L.address] : ''}. – Alex, Stone Ballarat`;
        const sid = await sendSMS(f[L.phone], text); await logOut(lead, text, 'Other', sid);
        state.callMorning = at; await setState(lead.id, state);
      }
      // brief to the agent 15 minutes before
      if (state.callBrief !== at && until <= 15 && until > -10) {
        const said = await recentContactLines(lead, 2);
        const lines = [
          `Call ${f[L.name]} at ${time} – ${f[L.phone] || ''}`,
          f[L.address] && `Property: ${f[L.address]}${propLine(f) ? ' – ' + propLine(f) : ''}`,
          (sel(f[PROP.motivation]) || f[PROP.timing]) && `Motivation / timing: ${[sel(f[PROP.motivation]), f[PROP.timing]].filter(Boolean).join(' – ')}`,
          f[PROP.otherAgents] && `Other agents: ${f[PROP.otherAgents]}`,
          said.length && `They said: ${said.join(' · ')}`,
          `Suggested opener: "Hi ${first}, it's ${agentFirst} from Stone – thanks for chatting with Alex about ${f[L.address] || 'your place'}. Have you got a few minutes?"`
        ].filter(Boolean);
        await textAgent(agent, lines.join('\n'));
        state.callBrief = at; await setState(lead.id, state);
      }
      // an hour after: how did it go?
      if (state.callAsked !== at && until <= -60 && until > -24 * 60 && isBH(c)) {
        const q = `How did the call with ${first} go? 1 – Booked appraisal (tell me when) · 2 – Wants a desktop appraisal · 3 – Not ready · 4 – No answer · 5 – Something else`;
        await textAgent(agent, q);
        state.callAsked = at; await setState(lead.id, state);
        if (agent) rememberQuestions(agent, c.date, [{ n: 0, leadId: lead.id, question: `${f[L.name]} – AFTER-CALL (1 → Appraisal Booked + appraisal_at; 2 → "Price Update / Desktop Required"; 3 → Nurture with a matching nurture_reason; 4 → no_answer true; 5 → read what they said): ${q}` }]);
      }
    } catch (e) { console.error('Alex leads: call tick failed for ' + lead.id, e.message); }
  }
}

// After the agent says "no answer": Alex texts the contact for a better time, and books the new call time from their reply
async function missedCallText(lead, agent) {
  const f = lead.fields;
  if (f[L.doNotContact] || !isTextableMobile(f[L.phone])) return '';
  const first = firstName(f[L.name]) || 'there';
  const agentFirst = agent ? firstName(agent.fields[TM.name]) : 'our agent';
  const text = `Hi ${first}, ${agentFirst} just tried to give you a call – when's a better time to chat? – Alex, Stone Ballarat`;
  const sid = await sendSMS(f[L.phone], text); await logOut(lead, text, 'Other', sid);
  const state = getState(lead); state.awaitingCallTime = true;
  await setState(lead.id, state, { [L_CALL_AT]: null });
  return ` I've texted ${first} for a better time.`;
}
async function handleCallTimeReply(lead, from, text) {
  const f = lead.fields;
  const agent = await agentOfLead(lead);
  const agentFirst = agent ? firstName(agent.fields[TM.name]) : 'our agent';
  const c = melbClock();
  const out = await claudeJSON('You read a short text reply and extract a call time. Be conservative.',
    `NOW: ${c.weekday} ${c.date} ${c.hour}:${String(c.minute).padStart(2, '0')} Melbourne. We asked "${agentFirst} just tried to give you a call – when's a better time to chat?" The contact replied: "${text}".\n` +
    'Return JSON only: {"call_at": "YYYY-MM-DDTHH:MM local, or empty if no clear time", "other": true/false (true if the reply is about something else or they do not want a call)}', 200);
  const iso = melbToISO(out.call_at);
  if (!iso || out.other) return false; // let the normal reply handling deal with it
  const when = melbWhen(iso);
  const first = firstName(f[L.name]) || f[L.name];
  const draft = `Thanks${firstName(f[L.name]) ? ' ' + firstName(f[L.name]) : ''} – ${agentFirst} will call you ${when}. – Alex, Stone Ballarat`;
  const state = getState(lead); delete state.awaitingCallTime;
  await setState(lead.id, state, { [L_CALL_AT]: iso, [L.nextAction]: `Call ${first} – ${when}`, [L.nextActionDate]: new Date(iso).toLocaleDateString('en-CA', { timeZone: TZ }) });
  const o = await offerDraft(lead, 'Call confirmation', draft, `${leadLabel(f)} replied "${String(text).slice(0, 120)}" – I've put a call on the card for ${when} and I'll remind you 15 minutes before. Want me to confirm it with ${first}?`);
  await noticeAgent(await getRecord(T.leads, lead.id), o.text + `\n(Or text me a different time, e.g. "${first} Mon 10am".)`);
  return true;
}

// ---------------------------------------------------------------- Appraisal Booked: confirmation, thank-you, escalation
// Offers go to the agent with a code: YES A12 sends it, EDIT A12 [wording] sends their wording, NO A12 skips it.
async function offerDraft(lead, purpose, draft, intro) {
  const code = await nextCode();
  await createRecord(T.messages, {
    [M.code]: code, [M.lead]: [lead.id], [M.direction]: 'To vendor', [M.purpose]: purpose, [M.status]: 'Awaiting approval',
    [M.draft]: draft, [M.reasoning]: intro, [M.number]: normalisePhone(lead.fields[L.phone])
  });
  return { code, text: `${intro}\n"${draft}"\nReply YES ${code} · EDIT ${code} [your wording] · NO ${code}` };
}
async function offerText(lead, agent, purpose, draft, intro) {
  const o = await offerDraft(lead, purpose, draft, intro);
  await textAgent(agent, o.text);
  return o.code;
}
let lastEscalateDate = null;
async function appraisalTick() {
  if (!sweepEnabled()) return;
  const c = melbClock();
  if (!isBH(c)) return;
  const agents = await alexActiveAgentIds();
  if (!agents.size) return;
  const leads = (await listAll(T.leads, { filterByFormula: `AND(OR({${L.stage}}='Appraisal Booked',{${L.stage}}='Listing Meeting Booked'),NOT({${L_PARKED}}))` }))
    .filter(l => (l.fields[L.agent] || []).some(id => agents.has(id)));
  for (const lead of leads) {
    const f = lead.fields;
    const stage = sel(f[L.stage]);
    const at = stage === 'Appraisal Booked' ? f[L_APPT_AT] : f[L_MTG_AT];
    if (!at) continue;
    const kind = stage === 'Appraisal Booked' ? 'appraisal' : 'listing meeting';
    const state = getState(lead);
    const agent = await agentOfLead(lead);
    const agentFirst = agent ? firstName(agent.fields[TM.name]) : 'our agent';
    const first = firstName(f[L.name]) || f[L.name];
    const day = new Date(at).toLocaleDateString('en-CA', { timeZone: TZ });
    const time = new Intl.DateTimeFormat('en-AU', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }).format(new Date(at));
    const weekday = new Intl.DateTimeFormat('en-AU', { timeZone: TZ, weekday: 'long' }).format(new Date(at));
    const textable = !f[L.doNotContact] && isTextableMobile(f[L.phone]);
    try {
      // day before, from 10am: offer a confirmation text
      if (textable && day === addDays(c.date, 1) && c.hour >= 10 && state.confirmOffered !== at) {
        const draft = `Hi ${first}, just confirming ${agentFirst} will see you tomorrow (${weekday}) at ${time}${f[L.address] ? ' at ' + f[L.address] : ''}. If anything changes, just reply here. – Alex, Stone Ballarat`;
        await offerText(lead, agent, 'Appraisal confirmation', draft, `Want me to send ${first} a quick confirmation of tomorrow's ${kind}?`);
        state.confirmOffered = at; await setState(lead.id, state);
      }
      // same afternoon, 3 hours after the appraisal: offer a thank-you
      if (textable && stage === 'Appraisal Booked' && day === c.date && minutesSince(at) >= 180 && state.thanksOffered !== at) {
        const draft = `Thanks for having ${agentFirst} through today, ${first} – your proposal will be with you shortly. – Alex, Stone Ballarat`;
        await offerText(lead, agent, 'Thank-you', draft, `Want me to send ${first} a thank-you for today?`);
        state.thanksOffered = at; await setState(lead.id, state);
      }
      // 2 business days after the appraisal and the card hasn't moved: tell Fiona (once)
      if (stage === 'Appraisal Booked' && day < c.date && bizDaysBetween(day, c.date) >= 2 && state.fionaEscalated !== at && lastEscalateDate !== c.date + lead.id) {
        await textFiona(`Hi Fiona – ${leadLabel(f)}: ${agentFirst}'s appraisal was ${weekday} ${dmy(day)} and the card hasn't moved since. Could you check in with ${agentFirst} about the proposal?`);
        state.fionaEscalated = at; await setState(lead.id, state);
        lastEscalateDate = c.date + lead.id;
      }
    } catch (e) { console.error('Alex leads: appraisal tick failed for ' + lead.id, e.message); }
  }
}

// The contact asked to move their appraisal: Alex acknowledges and asks the agent for the new time.
async function startReschedule(lead, from, text) {
  const f = lead.fields;
  const agent = await agentOfLead(lead);
  const agentFirst = agent ? firstName(agent.fields[TM.name]) : 'our agent';
  const first = firstName(f[L.name]) || '';
  const stage = sel(f[L.stage]);
  const at = stage === 'Listing Meeting Booked' ? f[L_MTG_AT] : f[L_APPT_AT];
  const ack = `No problem${first ? ' ' + first : ''} – I'll check with ${agentFirst} and come back to you ${isBH() && melbClock().hour < 17 ? 'shortly' : 'in the morning'} with a new time. – Alex, Stone Ballarat`;
  const sid = await sendSMS(from, ack); await logOut(lead, ack, 'Other', sid);
  const state = getState(lead); state.reschedule = true; await setState(lead.id, state);
  let options = '';
  if (calendarEnabled() && agent && agent.fields[TM_EMAIL]) {
    try { const s = await freeSlots(agent.fields[TM_EMAIL], 2); if (s.length) options = ` Your next free times: ${s.map(x => x.label).join(' or ')}.`; } catch (e) { /* ignore */ }
  } else if (agent) {
    try {
      const c = melbClock();
      const out = await claudeJSON('You read a short text and suggest appointment times. Be conservative.',
        `NOW: ${c.weekday} ${c.date} Melbourne. The contact wants to move their ${stage === 'Listing Meeting Booked' ? 'listing meeting' : 'appraisal'} and said: "${text}". ` +
        `The agent is already booked: ${bookingsText(await agentBookings(agent.id))}. Suggest up to 3 times (Mon–Sat 9:00–17:00, on the hour or half hour, from tomorrow) that fit what they said. ` +
        'Return JSON only: {"options": ["YYYY-MM-DDTHH:MM"]} (empty if they gave no clue about timing)', 200);
      const isos = await cleanOptions(agent.id, out.options || [], lead.id);
      if (isos.length) {
        const st = getState(await getRecord(T.leads, lead.id));
        st.offer = { kind: stage === 'Listing Meeting Booked' ? 'listing meeting' : 'appraisal', options: isos, at: new Date(Date.now()).toISOString(), reminded: false };
        await setState(lead.id, st);
        options = ` Times that might suit and are clear in Airtable: ${optionsText(isos)}.`;
      }
    } catch (e) { console.error('Alex leads: reschedule options failed', e.message); }
  }
  const q = `${leadLabel(f)} wants to move the ${stage === 'Listing Meeting Booked' ? 'listing meeting' : 'appraisal'}${at ? ' (' + melbWhen(at) + ')' : ''}: "${text.slice(0, 200)}".${options}` +
    (/Times that might suit/.test(options) ? `\nReply with the number (e.g. "${first || 'them'} 2"), another time, or CALL if you'll ring them.` : ` Reply with the new time (e.g. "${first || 'them'} Fri 2pm") and I'll confirm with them, or tell me if you'll call.`);
  await noticeAgent(await getRecord(T.leads, lead.id), q);
  if (agent) rememberQuestions(agent, melbClock().date, [{ n: 0, leadId: lead.id, question: `RESCHEDULE (a time in the reply → appraisal_at or listing_meeting_at for this card): ${q}` }]);
  await logActivity(lead.id, { summary: 'Contact asked to reschedule – agent asked for a new time', detail: text, type: 'General', kind: 'History' });
}
// Called after a card change by text: confirm a rescheduled time to the contact, add bookings to Outlook
async function afterCardChange(leadId, upd, after, agent) {
  const lead = await getRecord(T.leads, leadId);
  const f = lead.fields;
  const state = getState(lead);
  agent = agent || await agentOfLead(lead);
  let note = '';
  const newAppt = upd[L_APPT_AT] || upd[L_MTG_AT];
  const kind = upd[L_MTG_AT] ? 'listing meeting' : 'appraisal';
  if (newAppt) {
    const cal = await addToCalendar(agent, lead, newAppt, upd[L_MTG_AT] ? 'Listing meeting' : 'Appraisal');
    note += cal;
    if (state.reschedule || state.offer) {
      delete state.reschedule; delete state.offer; delete state.confirmOffered;
      await setState(lead.id, state);
      note += await confirmToContact(await getRecord(T.leads, lead.id), newAppt, kind);
      if (!cal) note += ' Please add it to your Outlook calendar.';
    }
  }
  if (after && after.clearOffer && state.offer) { delete state.offer; await setState(lead.id, state); }
  if (after && after.noAnswer) note += await missedCallText(lead, agent);
  return note;
}

// ---------------------------------------------------------------- agents add new contacts by text
const SOURCE_LIST = ['Social Media', 'Rental Dept', 'Walk/Phone In', 'Open Home', 'Referral', 'Radio', 'Letterbox Drop', 'Stone Website', 'Portal/s', 'Agent Prospecting Call', 'Door Knock', 'Email Campaign', 'For Sale Sign', 'Past Client', 'Stone Office Referral', 'Other'];
async function createCardFromText(member, nc, rawText) {
  const mobile = normalisePhone(nc.mobile || '');
  const existing = await findExistingCard({ mobile, address: nc.address });
  const authorName = firstName(member.fields[TM.name]) || member.fields[TM.name];
  if (existing) {
    const theirs = (existing.fields[L.agent] || []).includes(member.id);
    await logActivity(existing.id, { summary: `${authorName} texted Alex about this contact`, detail: rawText, type: 'SMS', kind: 'Note' });
    if (!theirs) {
      const other = await agentOfLead(existing);
      return { reply: `${leadLabel(existing.fields)} is already on ${other ? other.fields[TM.name] + "'s" : 'another'} card (${sel(existing.fields[L.stage])}), so I haven't made a new one – I've added a note there. Have a word with ${other ? firstName(other.fields[TM.name]) : 'them'}${other && isApprover(other.fields[TM.mobile]) ? '' : ' or ' + (process.env.APPROVER_NAME || 'Stu')}.` };
    }
    return { existingId: existing.id, reply: '' };
  }
  const stage = STAGE_LIST.includes(nc.stage) ? nc.stage : (melbToISO(nc.appraisal_at) ? 'Appraisal Booked' : 'Qualifying');
  const d = nc.details || {};
  const num = v => (v === null || v === undefined || v === '' || isNaN(Number(v))) ? undefined : Number(v);
  const fields = {
    [L.name]: nc.name, [L.phone]: mobile || undefined, [L.address]: nc.address || undefined, [L.agent]: [member.id],
    [L.email]: /\S+@\S+\.\S+/.test(nc.email || '') ? String(nc.email).trim() : undefined,
    [L.source]: SOURCE_LIST.includes(nc.source) ? nc.source : 'Other', [L.sourceDetail]: nc.source_detail || undefined, [L.enteredVia]: 'Agent by text',
    [L.stage]: stage, [L_RECEIVED]: melbClock().date, [L_STATE]: '{"flow":"newlead","phase":"skip","why":"agent added by text"}',
    [L_APPT_AT]: melbToISO(nc.appraisal_at) || undefined, [L_CALL_AT]: melbToISO(nc.call_at) || undefined,
    [L.nurtureReason]: stage === 'Nurture' && NURTURE_REASONS.includes(nc.nurture_reason) ? nc.nurture_reason : undefined,
    [L.nextAction]: nc.next_action || undefined, [L.nextActionDate]: /^\d{4}-\d{2}-\d{2}$/.test(nc.next_action_date || '') ? nc.next_action_date : undefined,
    [PROP.beds]: num(d.beds), [PROP.baths]: num(d.baths), [PROP.block]: num(d.block), [PROP.motivation]: ['Making a move', 'Just an update', 'Unsure'].includes(nc.motivation) ? nc.motivation : undefined,
    [PROP.timing]: nc.timing || undefined, [PROP.other]: nc.notes || undefined
  };
  for (const k of Object.keys(fields)) if (fields[k] === undefined) delete fields[k];
  const rec = await createRecord(T.leads, fields);
  await logActivity(rec.id, { summary: `${authorName} added this contact by text`, detail: rawText, type: 'SMS', kind: 'Note' });
  const card = await getRecord(T.leads, rec.id);
  let extra = '';
  if (fields[L_APPT_AT]) extra += await addToCalendar(member, card, fields[L_APPT_AT], 'Appraisal');
  const when = fields[L_APPT_AT] ? ', ' + melbWhen(fields[L_APPT_AT]) : fields[L_CALL_AT] ? ', call ' + melbWhen(fields[L_CALL_AT]) : '';
  const track = fields[L.nurtureReason] ? ` (track: ${fields[L.nurtureReason]} – tell me if another fits better)` : '';
  return { createdId: rec.id, reply: `Done: ${nc.name}${nc.address ? ', ' + nc.address : ''} → ${stage}${when}${track}.${extra}` };
}


// ---------------------------------------------------------------- team assistant (tool-using)
// Texts from Alex-active team members that aren't a command (CALL / ALEX, a code, UNDO, Fiona's authority replies) go to
// the assistant. It works in steps with tools – search, open, list, update and create cards, add notes – reads the
// playbook (zAlex Playbook table: glossary, tracks, rules), remembers the last 20 messages with each person (Team →
// zAlex Chat), and asks when it isn't sure. Guard rails are in code: valid values only, agents change only their own
// cards (Stu any), big changes need the person's yes first, and nothing is ever texted to a contact from here.
// ALEX_ASSISTANT=off falls back to the older one-shot reader.
const PLAYBOOK_TABLE = 'tblZtfnktcD2SzhKL';
const PB = { title: 'fldcj6s3mBZMQbyzx', kind: 'fldnEfcnvTxuNl4Qd', text: 'fldBtf9Mtemdm6Y6y', active: 'fldTSqqnNfEneMfR8', order: 'fld4eZkWoTWT66PGh' };
const TM_CHAT = 'fldSxqIRmD1WsmJfF';
const CHAT_KEEP = 20;
const ASSIST_MAX_STEPS = 8;

function assistantOn() { return String(process.env.ALEX_ASSISTANT || 'on').toLowerCase() !== 'off'; }
async function assistantCall(params) { return anthropic.messages.create(params); }

let playbookCache = { at: 0, text: '' };
async function playbookText() {
  if (Date.now() - playbookCache.at < 10 * 60000 && playbookCache.text) return playbookCache.text;
  try {
    const rows = (await listAll(PLAYBOOK_TABLE, {})).filter(r => r.fields[PB.active])
      .sort((a, b) => (a.fields[PB.order] || 999) - (b.fields[PB.order] || 999));
    playbookCache = { at: Date.now(), text: rows.map(r => `• [${sel(r.fields[PB.kind]) || 'Note'}] ${r.fields[PB.title] || ''}: ${r.fields[PB.text] || ''}`).join('\n') };
  } catch (e) { console.error('Alex leads: playbook load failed', e.message); }
  return playbookCache.text;
}

let leadsCache = { at: 0, rows: [] };
async function allLeads() {
  if (Date.now() - leadsCache.at < 60000) return leadsCache.rows;
  leadsCache = { at: Date.now(), rows: await listAll(T.leads, {}) };
  return leadsCache.rows;
}
function leadsChanged() { leadsCache.at = 0; }

function digits(s) { return String(s || '').replace(/\D/g, ''); }
function briefCard(l, team) {
  const f = l.fields;
  const agent = (f[L.agent] || []).map(id => (team.find(t => t.id === id) || { fields: {} }).fields[TM.name] || '').filter(Boolean).join(', ') || 'no agent';
  const st = sel(f[L.stage]);
  const bits = [l.id, f[L.name] || '(no name)', f[L.address] || '', f[L.phone] || '', 'agent: ' + agent, st];
  if (st === 'Nurture') bits.push('track: ' + (sel(f[L.nurtureReason]) || 'not set'));
  if (f[L.nextAction]) bits.push(`task: ${f[L.nextAction]}${f[L.nextActionDate] ? ' (due ' + f[L.nextActionDate] + ')' : ''}`);
  if (f[L_APPT_AT]) bits.push('appraisal ' + melbWhen(f[L_APPT_AT]));
  if (f[L_MTG_AT]) bits.push('listing meeting ' + melbWhen(f[L_MTG_AT]));
  if (f[L_CALL_AT]) bits.push('call ' + melbWhen(f[L_CALL_AT]));
  if (f[L_LOST_REASON]) bits.push('lost: ' + sel(f[L_LOST_REASON]));
  const flags = [f[L_PRIORITY] && 'Priority', f[L.doNotContact] && 'Do Not Contact', f[L.pauseAlex] && 'Alex paused', f[L_PARKED] && 'Parked for test'].filter(Boolean);
  if (flags.length) bits.push(flags.join(', '));
  const offer = getState(l).offer;
  if (offer && offer.options) bits.push(`${offer.kind} time options offered: ${offer.options.map((iso, i) => `${i + 1}) ${melbWhen(iso)} [${new Date(iso).toLocaleString('sv-SE', { timeZone: TZ }).slice(0, 16).replace(' ', 'T')}]`).join(', ')}`);
  return bits.join(' | ');
}

// ---- conversation memory (Team → zAlex Chat)
function chatOf(member) { try { return JSON.parse(member.fields[TM_CHAT] || '[]') || []; } catch (e) { return []; } }
async function saveChat(member, turns) {
  member.fields[TM_CHAT] = JSON.stringify(turns.slice(-CHAT_KEEP));
  try { await updateRecord(T.team, member.id, { [TM_CHAT]: member.fields[TM_CHAT] }); } catch (e) { console.error('Alex leads: chat save failed', e.message); }
}
async function rememberTurn(member, userText, alexText) {
  if (!member) return;
  const now = new Date(Date.now()).toISOString();
  await saveChat(member, chatOf(member).concat([{ r: 'user', t: userText, at: now }, { r: 'alex', t: alexText, at: now }]));
}

// ---- the tools Alex can use
const ASSIST_TOOLS = [
  { name: 'search_cards', description: 'Find lead cards by name, address, suburb or phone, across all agents and all stages (including Nurture, Lost and Parked). Use this whenever a person or property is mentioned.',
    input_schema: { type: 'object', properties: { query: { type: 'string', description: 'A name, part of an address, suburb or phone number' } }, required: ['query'] } },
  { name: 'get_card', description: 'Open one card: all its details, recent history notes and recent texts.',
    input_schema: { type: 'object', properties: { card_id: { type: 'string' } }, required: ['card_id'] } },
  { name: 'list_cards', description: 'List cards to answer questions like "what\'s on my plate today", "who is in Decision Pending", "my overdue tasks", "Leanne\'s cold nurture contacts".',
    input_schema: { type: 'object', properties: {
      agent: { type: 'string', description: '"me" (default), "all", or an agent\'s name' },
      stage: { type: 'string', description: 'A stage name, or empty' },
      nurture_reason: { type: 'string', description: 'A nurture reason, or empty' },
      due: { type: 'string', enum: ['', 'overdue', 'today', 'this_week'], description: 'Filter by task due date' },
      priority_only: { type: 'boolean' }, limit: { type: 'number' } } } },
  { name: 'update_card', description: 'Change a card. Only set what the person asked for. Times are Melbourne local "YYYY-MM-DDTHH:MM", dates "YYYY-MM-DD". Big changes (Lost, Listed (Won), Do Not Contact, changing the agent, someone else\'s card) need confirmed=true, which you may only set after the person has said yes to exactly that change.',
    input_schema: { type: 'object', properties: {
      card_id: { type: 'string' },
      changes: { type: 'object', properties: {
        stage: { type: 'string' }, nurture_reason: { type: 'string' }, lost_reason: { type: 'string' },
        next_action: { type: 'string' }, next_action_date: { type: 'string' }, complete_task: { type: 'boolean' },
        appraisal_at: { type: 'string' }, listing_meeting_at: { type: 'string' }, call_at: { type: 'string' }, no_answer: { type: 'boolean', description: 'The agent called at the agreed time and got no answer' },
        authority_ends: { type: 'string' }, priority: { type: 'boolean' }, do_not_contact: { type: 'boolean' }, pause_alex: { type: 'boolean' },
        vendor_price_expectation: { type: 'string' }, agent_price_guide: { type: 'string' }, decision_makers: { type: 'string' }, other_agents: { type: 'string' },
        source: { type: 'string' }, source_detail: { type: 'string' }, name: { type: 'string' }, mobile: { type: 'string' }, email: { type: 'string' }, address: { type: 'string' },
        key_fact: { type: 'string', description: 'A short fact to add to Key Facts' }, agent: { type: 'string', description: 'Reassign to this agent (Stu only)' } } },
      note: { type: 'string', description: 'Anything worth logging on the card' },
      confirmed: { type: 'boolean' } }, required: ['card_id', 'changes'] } },
  { name: 'add_note', description: 'Log a note on a card without changing anything else.',
    input_schema: { type: 'object', properties: { card_id: { type: 'string' }, note: { type: 'string' } }, required: ['card_id', 'note'] } },
  { name: 'create_card', description: 'Add a new contact (someone not already on a card – search first). Needs name, mobile and address; ask for anything missing before calling.',
    input_schema: { type: 'object', properties: {
      name: { type: 'string' }, mobile: { type: 'string' }, address: { type: 'string' }, email: { type: 'string' },
      source: { type: 'string' }, source_detail: { type: 'string' }, stage: { type: 'string' }, appraisal_at: { type: 'string' }, call_at: { type: 'string' },
      next_action: { type: 'string' }, next_action_date: { type: 'string' }, nurture_reason: { type: 'string' },
      details: { type: 'object', properties: { beds: { type: 'number' }, baths: { type: 'number' }, block: { type: 'number' } } },
      motivation: { type: 'string', enum: ['', 'Making a move', 'Just an update', 'Unsure'] }, timing: { type: 'string' }, notes: { type: 'string' },
      agent: { type: 'string', description: 'Whose card it is, if not the sender\'s (Stu only)' } }, required: ['name'] } }
];

const BIG_STAGES = ['Lost / Not Progressing', 'Listed (Won)'];
async function runTool(name, input, ctx) {
  const team = await teamRows();
  const mine = l => (l.fields[L.agent] || []).includes(ctx.member.id);
  const canChange = l => ctx.admin || mine(l);
  if (name === 'search_cards') {
    const q = String(input.query || '').toLowerCase().trim();
    if (!q) return 'Give me something to search for.';
    const qd = digits(q).replace(/^61/, '0');
    const words = q.split(/[\s,]+/).filter(w => w.length > 1);
    const hits = (await allLeads()).filter(l => {
      const f = l.fields;
      const hay = `${f[L.name] || ''} ${f[L.address] || ''} ${f[L.email] || ''}`.toLowerCase();
      if (qd.length >= 6 && digits(f[L.phone]).replace(/^61/, '0').includes(qd)) return true;
      return words.length && words.every(w => hay.includes(w));
    }).slice(0, 12);
    return hits.length ? hits.map(l => briefCard(l, team)).join('\n') : 'No cards match "' + input.query + '".';
  }
  if (name === 'get_card') {
    let l; try { l = await getRecord(T.leads, input.card_id); } catch (e) { return 'No card with id ' + input.card_id; }
    const f = l.fields;
    const pick = {};
    for (const [k, id] of Object.entries(L)) if (f[id] !== undefined && !['activity', 'agent'].includes(k)) pick[k] = sel(f[id]);
    for (const [k, id] of Object.entries(PROP)) if (f[id] !== undefined) pick[k] = sel(f[id]);
    for (const [k, id] of [['appraisalAt', L_APPT_AT], ['listingMeetingAt', L_MTG_AT], ['callAt', L_CALL_AT], ['lostReason', L_LOST_REASON], ['authorityEnds', L_AUTH_ENDS], ['priority', L_PRIORITY], ['parked', L_PARKED], ['stageEntered', L_STAGE_ENTERED]])
      if (f[id] !== undefined) pick[k] = /At$/.test(k) ? melbWhen(f[id]) : sel(f[id]);
    let history = '';
    const actIds = (f[L.activity] || []).slice(-8);
    if (actIds.length) {
      try {
        const acts = await listAll(T.activity, { filterByFormula: 'OR(' + actIds.map(id => `RECORD_ID()='${id}'`).join(',') + ')' });
        history = acts.sort((a, b) => String(a.fields[A.loggedAt] || a.createdTime) < String(b.fields[A.loggedAt] || b.createdTime) ? -1 : 1)
          .map(a => `${String(a.fields[A.loggedAt] || a.createdTime).slice(0, 10)} ${a.fields[A.summary] || ''}${a.fields[A.detail] ? ' – ' + String(a.fields[A.detail]).slice(0, 160) : ''}`).join('\n');
      } catch (e) { /* ignore */ }
    }
    let texts = '';
    try { texts = (await leadMessages(f)).slice(-6).map(m => `${sel(m.fields[M.direction]) === 'From vendor' ? 'CONTACT' : 'ALEX'}: ${String(m.fields[M.finalText] || m.fields[M.draft] || '').slice(0, 200)}`).join('\n'); } catch (e) { /* ignore */ }
    return `${briefCard(l, team)}\nDETAILS: ${JSON.stringify(pick)}\nHISTORY:\n${history || '(none)'}\nRECENT TEXTS:\n${texts || '(none)'}`;
  }
  if (name === 'list_cards') {
    const who = String(input.agent || 'me').toLowerCase();
    const today = melbNow().date;
    let rows = (await allLeads()).filter(l => !l.fields[L_PARKED]);
    if (who === 'me' || !who) rows = rows.filter(mine);
    else if (who !== 'all') { const a = await matchAgent(input.agent); rows = a ? rows.filter(l => (l.fields[L.agent] || []).includes(a.id)) : []; }
    if (input.stage) rows = rows.filter(l => sel(l.fields[L.stage]).toLowerCase() === String(input.stage).toLowerCase());
    if (input.nurture_reason) rows = rows.filter(l => sel(l.fields[L.nurtureReason]).toLowerCase() === String(input.nurture_reason).toLowerCase());
    if (input.priority_only) rows = rows.filter(l => l.fields[L_PRIORITY]);
    const d = l => l.fields[L.nextActionDate] || '';
    if (input.due === 'overdue') rows = rows.filter(l => d(l) && d(l) < today);
    if (input.due === 'today') rows = rows.filter(l => d(l) && d(l) <= today);
    if (input.due === 'this_week') rows = rows.filter(l => d(l) && d(l) <= addDays(today, 7));
    if (input.due) rows.sort((a, b) => d(a) < d(b) ? -1 : 1);
    const n = rows.length;
    return n ? `${n} card${n === 1 ? '' : 's'}${n > (input.limit || 25) ? ' (first ' + (input.limit || 25) + ')' : ''}:\n` + rows.slice(0, input.limit || 25).map(l => briefCard(l, team)).join('\n') : 'No cards match.';
  }
  if (name === 'add_note') {
    let l; try { l = await getRecord(T.leads, input.card_id); } catch (e) { return 'No card with id ' + input.card_id; }
    if (!canChange(l)) return `That's ${briefCard(l, team).split(' | ')[4]}'s card – only they or Stu can add to it.`;
    await logActivity(l.id, { summary: `${ctx.author}: ${String(input.note).slice(0, 200)}`, detail: `Text: "${ctx.text}"`, type: 'SMS', kind: 'Note' });
    ctx.done.push(`noted on ${l.fields[L.name]}`);
    return 'Noted.';
  }
  if (name === 'update_card') {
    let l; try { l = await getRecord(T.leads, input.card_id); } catch (e) { return 'No card with id ' + input.card_id; }
    if (!canChange(l)) return `REFUSED: that's ${briefCard(l, team).split(' | ')[4].replace('agent: ', '')}'s card – only they or Stu can change it. Tell the person.`;
    const c = Object.assign({}, input.changes || {});
    const errs = [];
    if (c.stage && !STAGE_LIST.includes(c.stage)) errs.push(`stage "${c.stage}" isn't one of: ${STAGE_LIST.join('; ')}`);
    if (c.nurture_reason && !NURTURE_REASONS.includes(c.nurture_reason)) errs.push(`nurture_reason "${c.nurture_reason}" isn't one of: ${NURTURE_REASONS.join('; ')}`);
    if (c.lost_reason && !LOST_REASONS.includes(c.lost_reason)) errs.push(`lost_reason "${c.lost_reason}" isn't one of: ${LOST_REASONS.join('; ')}`);
    if (c.source && !SOURCE_LIST.includes(c.source)) errs.push(`source "${c.source}" isn't one of: ${SOURCE_LIST.join('; ')}`);
    for (const k of ['appraisal_at', 'listing_meeting_at', 'call_at']) if (c[k] && !melbToISO(c[k])) errs.push(`${k} must be "YYYY-MM-DDTHH:MM"`);
    for (const k of ['next_action_date', 'authority_ends']) if (c[k] && !/^\d{4}-\d{2}-\d{2}$/.test(c[k])) errs.push(`${k} must be "YYYY-MM-DD"`);
    if (c.agent && !ctx.admin) errs.push('only Stu can change the agent on a card');
    if (c.stage === 'Lost / Not Progressing' && !c.lost_reason && !l.fields[L_LOST_REASON]) errs.push('a lost card needs lost_reason – ask why');
    if (c.stage === 'Nurture' && !c.nurture_reason && !l.fields[L.nurtureReason]) errs.push('Nurture needs a nurture_reason (the track)');
    if (errs.length) return 'NOT CHANGED: ' + errs.join('; ');
    const big = BIG_STAGES.includes(c.stage) || c.do_not_contact === true || !!c.agent || !mine(l);
    if (big && input.confirmed !== true) return 'NOT CHANGED: this is a big change – tell the person exactly what will change and ask them to confirm; call again with confirmed=true only after they say yes.';
    const upd = fieldsFor(l, c);
    if (c.stage === 'Nurture' && c.nurture_reason) upd[L.nurtureReason] = c.nurture_reason;
    if (c.do_not_contact !== undefined) upd[L.doNotContact] = !!c.do_not_contact;
    if (c.pause_alex !== undefined) upd[L.pauseAlex] = !!c.pause_alex;
    if (c.priority === false) upd[L_PRIORITY] = false;
    if (c.name) upd[L.name] = c.name;
    if (c.mobile) { const m = normalisePhone(c.mobile); if (!isTextableMobile(m)) return 'NOT CHANGED: that mobile doesn\'t look right'; upd[L.phone] = m; }
    if (c.email) upd[L.email] = c.email;
    if (c.address) upd[L.address] = c.address;
    if (c.key_fact) { const t = melbNow().date; upd[L.keyFacts] = ((l.fields[L.keyFacts] || '').trim() + `\n• ${c.key_fact} (${dmy(t)}/${t.slice(2, 4)}, via ${ctx.author})`).trim(); }
    if (c.agent) { const a = await matchAgent(c.agent); if (!a) return `NOT CHANGED: no team member called "${c.agent}"`; upd[L.agent] = [a.id]; }
    const after = { noAnswer: c.no_answer === true };
    const statePatch = null;
    if (!Object.keys(upd).length && !after.noAnswer) return 'NOT CHANGED: nothing to change (already set, or no recognised change).';
    const prev = await applyCardChange(l.id, upd, input.note || '', ctx.author, ctx.text, statePatch);
    delete prev[L_COMPLETE];
    if (Object.keys(prev).length) ctx.undo.push({ leadId: l.id, prev });
    leadsChanged();
    let extra = '';
    try { extra = (await afterCardChange(l.id, upd, after, null)).trim(); } catch (e) { console.error('Alex leads: after card change failed', e.message); }
    const said = Object.entries(c).filter(([, v]) => v !== '' && v !== undefined && v !== null).map(([k, v]) => `${k}=${v}`).join(', ');
    ctx.done.push(`${l.fields[L.name]}: ${said}`);
    if (extra) ctx.extras.push(extra);
    return 'DONE: ' + said + (extra ? '\nALSO (tell the person, word for word if it is a question with a code): ' + extra : '');
  }
  if (name === 'create_card') {
    const nc = Object.assign({}, input);
    const missing = ['name', 'mobile', 'address'].filter(k => k === 'mobile' ? !isTextableMobile(normalisePhone(nc.mobile || '') || '') : !String(nc[k] || '').trim());
    if (missing.length) return 'NOT CREATED: missing ' + missing.join(', ') + ' – ask for them.';
    if (nc.stage && !STAGE_LIST.includes(nc.stage)) return 'NOT CREATED: stage must be one of ' + STAGE_LIST.join('; ');
    let owner = ctx.member;
    if (nc.agent) { if (!ctx.admin) return 'NOT CREATED: only Stu can add a card for another agent'; const a = await matchAgent(nc.agent); if (!a) return `NOT CREATED: no team member called "${nc.agent}"`; owner = a; }
    const res = await createCardFromText(owner, nc, ctx.text);
    leadsChanged();
    if (res.existingId) return 'ALREADY ON A CARD (' + res.existingId + '): ' + (res.reply || 'it is one of this person\'s cards – update that card instead.');
    if (!res.createdId) return 'NOT CREATED: ' + (res.reply || 'unknown problem');
    ctx.created.push(res.createdId);
    ctx.done.push(`created ${nc.name}`);
    return 'CREATED ' + res.createdId + ': ' + res.reply + (SOURCE_LIST.includes(nc.source) ? '' : ' (no lead source yet – ask where the lead came from)');
  }
  return 'Unknown tool ' + name;
}

function assistantSystem(ctx, playbook, cards, team, questions) {
  const c = melbClock();
  return `You are Alex, the sales assistant at Stone Real Estate Ballarat, texting with ${ctx.member.fields[TM.name]}${ctx.admin ? ' (the principal – may change any card)' : ' (a sales agent – may change only their own cards)'}.
NOW: ${c.weekday} ${c.date} ${String(c.hour).padStart(2, '0')}:${String(c.minute).padStart(2, '0')} Melbourne time.

You keep the team's Airtable sales pipeline up to date from their texts and answer their questions about it. You talk only to the team here – nothing you do sends a text to a contact (except the confirmations the tools offer, which the agent approves with a code).

HOW TO WORK
- When a person or property is mentioned, use search_cards (or the list below) to find the card. Never guess an id.
- Work out what they mean using the PLAYBOOK. If it's clear, do it with the tools, then reply with what you did in one or two short lines.
- If it isn't clear (two possible cards, an unknown phrase, a missing detail, a rule in the playbook says to check), ask ONE short question instead of acting. Offer the likely options, e.g. "Did you mean Track 5 · Cold (every 3 months)?".
- Big changes need a yes first: the tools will tell you. When the person replies "yes" to your question, do exactly what you proposed.
- Questions ("what's on my plate?", "when did we last hear from X?") → look it up and answer briefly.
- Never invent facts, prices or dates. Times are Melbourne local "YYYY-MM-DDTHH:MM"; "Thursday" means the NEXT Thursday; "this afternoon 1:30" means today 13:30.
- Replies are SMS: plain text, no markdown, under 500 characters unless listing cards. Use first names. No "Hi" every time.
- If a tool says ALSO with a question and code (e.g. "Want me to send … YES A12"), include it in your reply exactly.

VALID VALUES
Stages: ${STAGE_LIST.join('; ')}
Nurture reasons (tracks): ${NURTURE_REASONS.join('; ')}
Lost reasons: ${LOST_REASONS.join('; ')}
Sources: ${SOURCE_LIST.join('; ')}

PLAYBOOK (how we work – follow it)
${playbook || '(empty)'}
${questions.length ? `\nQUESTIONS ALEX ASKED ${firstName(ctx.member.fields[TM.name]).toUpperCase()} TODAY (they may answer by number, e.g. "1 booked Thu 2pm, 2 sent, 3b"; options in a question map to the actions written beside them):\n${questions.map(q => `${q.n ? q.n + ' – ' : ''}[${q.leadId}] ${q.question}`).join('\n')}\n` : ''}
${firstName(ctx.member.fields[TM.name]).toUpperCase()}'S ACTIVE CARDS (id | name | address | phone | agent | stage | …):
${cards.slice(0, 60).map(l => briefCard(l, team)).join('\n') || '(none)'}${cards.length > 60 ? `\n…and ${cards.length - 60} more – use search_cards / list_cards` : ''}`;
}

const assistantQueues = new Map(); // phone -> promise, so one person's texts are handled in order
function enqueueAssistant(key, job) {
  const prev = assistantQueues.get(key) || Promise.resolve();
  const next = prev.then(job, job);
  assistantQueues.set(key, next.catch(() => {}));
  return next;
}

async function runAssistant(member, from, text, reply) {
  const key = normalisePhone(from);
  const admin = isApprover(from);
  const author = firstName(member.fields[TM.name]) || member.fields[TM.name];
  const ctx = { member, admin, author, text, undo: [], created: [], done: [], extras: [] };
  try {
    const [playbook, team, cards] = [await playbookText(), await teamRows(), await agentCards(member)];
    const asked = checkinsByPhone.get(key);
    const questions = asked && asked.date === melbNow().date ? asked.items : [];
    const system = assistantSystem(ctx, playbook, cards, team, questions);
    // conversation so far (alternating, starting with the person)
    const msgs = [];
    for (const t of chatOf(member)) {
      const role = t.r === 'alex' ? 'assistant' : 'user';
      if (!msgs.length && role === 'assistant') continue;
      if (msgs.length && msgs.at(-1).role === role) msgs.at(-1).content += '\n' + t.t;
      else msgs.push({ role, content: t.t });
    }
    if (msgs.length && msgs.at(-1).role === 'user') msgs.at(-1).content += '\n' + text; else msgs.push({ role: 'user', content: text });
    let answer = '';
    for (let step = 0; step < ASSIST_MAX_STEPS; step++) {
      const r = await assistantCall({ model: process.env.ALEX_ASSISTANT_MODEL || MODEL, max_tokens: 1200, system, tools: ASSIST_TOOLS, messages: msgs });
      const uses = (r.content || []).filter(b => b.type === 'tool_use');
      answer = (r.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
      if (r.stop_reason !== 'tool_use' || !uses.length) break;
      msgs.push({ role: 'assistant', content: r.content });
      const results = [];
      for (const u of uses) {
        let out;
        try { out = await runTool(u.name, u.input || {}, ctx); } catch (e) { out = 'ERROR: ' + e.message; console.error('Alex leads: tool ' + u.name + ' failed', e.message); }
        console.log('Alex leads: tool ' + u.name + ' ' + JSON.stringify(u.input).slice(0, 300) + ' → ' + String(out).slice(0, 200).replace(/\n/g, ' / '));
        results.push({ type: 'tool_result', tool_use_id: u.id, content: String(out).slice(0, 8000) });
      }
      msgs.push({ role: 'user', content: results });
      answer = '';
    }
    if (!answer) answer = ctx.done.length ? 'Done: ' + ctx.done.join('; ') : "Sorry, I didn't get that – can you put it another way?";
    for (const x of ctx.extras) if (/\b[A]\d{1,2}\b/.test(x) && !answer.includes(x.match(/\bA\d{1,2}\b/)[0])) answer += '\n' + x;
    if (ctx.undo.length || ctx.created.length) {
      pendingByPhone.set(key, { kind: 'undo', items: ctx.undo, created: ctx.created, summary: ctx.done.join('\n'), at: Date.now() });
      if (!/undo/i.test(answer)) answer += '\nReply UNDO to reverse.';
    }
    await reply(answer.slice(0, 1500));
    await rememberTurn(member, text, answer + (ctx.done.length ? `\n[done: ${ctx.done.join('; ')}]` : ''));
  } catch (e) {
    console.error('Alex leads: assistant failed', e.message);
    await reply("Sorry, something went wrong on my side – please try again, or update the card in Airtable.");
  }
}

// ---------------------------------------------------------------- new enquiries (replaces Pipedrive)

async function createEnquiryLead({ name, phone, email, address, suburb, summary, outcome }) {
  if (!enabled()) return null;
  const existing = await findLeadByPhone(phone);
  if (existing && !['Lost', 'Lost / Not Progressing', 'Listed (Won)', 'Authority Signed'].includes(sel(existing.fields[L.stage]))) {
    await logActivity(existing.id, { summary: 'New Alex conversation – ' + outcome, detail: summary, type: 'SMS' });
    return existing.id;
  }
  const rec = await createRecord(T.leads, {
    [L.name]: name && name !== 'Unknown' ? name : (address || phone),
    [L.phone]: phone, [L.email]: email || undefined, [L.address]: address || (suburb ? suburb : undefined),
    [L.source]: 'Other', [L.sourceDetail]: 'Alex SMS – ' + outcome, [L.enteredVia]: 'Alex',
    [L.background]: summary
  });
  await logActivity(rec.id, { summary: 'Alex conversation summary – ' + outcome, detail: summary, type: 'SMS' });
  return rec.id;
}

// ---------------------------------------------------------------- start

let timer = null;
function start() {
  if (timer) return;
  if (!enabled()) { console.log('Alex leads: AIRTABLE_TOKEN not set – Airtable integration off'); return; }
  console.log('Alex leads: Airtable integration on' + (sweepEnabled() ? ', sweep every ' + SWEEP_MINUTES + ' min' : ' (sweep off – set ALEX_LEADS_ENABLED=true)'));
  timer = setInterval(sweep, SWEEP_MINUTES * 60000);
  setTimeout(sweep, 30000);
  // New leads (day and night), reminders and check-ins: every 2 minutes
  const fast = async () => {
    try { await newLeadTick(); } catch (e) { console.error('Alex leads: new lead tick failed', e.message); }
    try { await checkinTick(); } catch (e) { console.error('Alex leads: check-in tick failed', e.message); }
    try { await wonTick(); } catch (e) { console.error('Alex leads: won tick failed', e.message); }
    try { await noticeTick(); } catch (e) { console.error('Alex leads: notice tick failed', e.message); }
    try { await callTick(); } catch (e) { console.error('Alex leads: call tick failed', e.message); }
    try { await appraisalTick(); } catch (e) { console.error('Alex leads: appraisal tick failed', e.message); }
    try { await offerTick(); } catch (e) { console.error('Alex leads: offer tick failed', e.message); }
  };
  fastTimer = setInterval(fast, 2 * 60000);
  setTimeout(fast, 45000);
}

module.exports = { start, sweep, isApprover, handleApproverSMS, handleTeamSMS, handleVendorSMS, createEnquiryLead, normalisePhone, enabled };
