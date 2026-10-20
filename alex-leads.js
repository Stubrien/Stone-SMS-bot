// alex-leads.js
// Alex <-> Airtable Sales Leads integration.
// - Nurture: drafts the day's nurture texts each weekday morning (max 5 per agent), texts each agent ONE midday
//   preview, and sends at 2pm unless the agent replies CHANGE <code> … or CANCEL <code> (no per-text approval)
// - Track 8 (listed with another agency): monthly check-ins, one offer of help around when their agreement ends,
//   stops when Market Sales shows it sold, moves back to Qualifying when the agreement ends unsold
// - Agents text Alex to update their cards ("Booked Sarah Thu 2pm") – applied with UNDO, or confirmed first if unclear
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

// Soft opt-out added to the end of the first text Alex sends anyone.
// Any reply asking to be left alone is treated as an opt-out (see handleVendorSMS).
const OPT_OUT_LINE = "If it's not the right time or you'd rather be left alone, just let me know.";
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
  const text = f[M.finalText] || f[M.draft];
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
async function activeDrafts() {
  return listAll(T.messages, { filterByFormula: `OR({${M.status}}='Awaiting approval',{${M.status}}='Scheduled',{${M.status}}='Previewed')` });
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

async function handleApproverSMS(body) {
  const text = (body || '').trim();
  const parsed = parseApproverCommand(text);
  if (!parsed) return false;
  const { cmd } = parsed;
  let code = parsed.code;
  const rest = parsed.rest;
  const waiting = await waitingDrafts();

  if (cmd === 'LIST') {
    await sendSMS(approverMobile(), waiting.length ? 'Waiting: ' + waiting.map(w => w.fields[M.code]).join(', ') : 'Nothing waiting for approval.');
    return true;
  }
  if (!code) {
    if (waiting.length === 1) code = String(waiting[0].fields[M.code]).toUpperCase();
    else {
      await sendSMS(approverMobile(), waiting.length ? `Which one? Waiting: ${waiting.map(w => w.fields[M.code]).join(', ')}. e.g. YES ${waiting[0].fields[M.code]}` : 'Nothing waiting for approval.');
      return true;
    }
  }

  if (cmd === 'KEEP') {
    // Undo a follow-up date change Alex made while reading a vendor reply
    const all = await listAll(T.messages, { filterByFormula: `AND(UPPER({${M.code}})='${code}',{${M.direction}}='To vendor')`, maxRecords: '5', 'sort[0][field]': M.created, 'sort[0][direction]': 'desc' });
    const rec = all[0];
    const m2 = rec && String(rec.fields[M.reasoning] || '').match(/PREV_FOLLOW_UP=(\d{4}-\d{2}-\d{2}|none)/);
    if (!rec || !m2) { await sendSMS(approverMobile(), `No follow-up change to undo on ${code}.`); return true; }
    const leadId = (rec.fields[M.lead] || [])[0];
    await updateRecord(T.leads, leadId, { [L.followUp]: m2[1] === 'none' ? null : m2[1] });
    await logActivity(leadId, { summary: 'Follow-up date change undone (KEEP)', type: 'Follow-up date changed', kind: 'History' });
    await sendSMS(approverMobile(), `Done – follow-up date on ${code} put back${m2[1] === 'none' ? '' : ' to ' + dmy(m2[1])}.`);
    return true;
  }

  const rec = waiting.find(w => String(w.fields[M.code]).toUpperCase() === code);
  if (!rec) { await sendSMS(approverMobile(), `${code} isn't waiting for approval.`); return true; }
  const by = process.env.APPROVER_NAME || 'Stu';

  if (cmd === 'NO' || cmd === 'N') {
    await updateRecord(T.messages, rec.id, { [M.status]: 'Rejected', [M.approverReply]: text, [M.approvedBy]: by, [M.approvedAt]: new Date().toISOString() });
    // A binned nurture check-in skips this round: roll the follow-up date on by the track so Alex
    // doesn't draft a fresh one at the next sweep (it used to re-draft within 15 minutes).
    let next = '';
    if (sel(rec.fields[M.purpose]) === 'Nurture check-in') {
      try { next = await skipNurtureRound((rec.fields[M.lead] || [])[0], code); } catch (e) { console.error('Alex leads: skip round failed', e.message); }
    }
    await sendSMS(approverMobile(), `${code} binned – nothing sent.` + (next ? ` Next check-in ${dmy(next)}.` : ''));
    return true;
  }
  if ((cmd === 'EDIT' || cmd === 'CHANGE') && !rest) { await sendSMS(approverMobile(), `Send the new wording after the code (EDIT ${code} Hey Sonya…) or an instruction (CHANGE ${code} make it shorter).`); return true; }

  // CHANGE, or an EDIT that reads like an instruction ("remove the opt out line"), is never sent as-is:
  // Alex rewrites the draft and sends it back for approval.
  if (cmd === 'CHANGE' || (cmd === 'EDIT' && looksLikeInstruction(rest))) {
    const current = rec.fields[M.finalText] || rec.fields[M.draft];
    const out = await claudeJSON(VOICE, `CURRENT DRAFT SMS: "${current}"\n\nTHE AGENT WANTS THIS CHANGE: "${rest}"\n\n` +
      'Rewrite the SMS applying exactly that change and nothing else. Keep the greeting and introduction unless asked to change them. ' +
      'Return JSON only: {"sms": "..."}', 400);
    const revised = String(out.sms || '').trim();
    if (!revised) { await sendSMS(approverMobile(), `Couldn't apply that to ${code} – try EDIT ${code} followed by the full wording.`); return true; }
    await updateRecord(T.messages, rec.id, { [M.draft]: revised, [M.approverReply]: text });
    await sendSMS(approverMobile(), `${code} revised:\n\nDraft: "${revised}"\n\nReply YES ${code} · CHANGE ${code} what to change · EDIT ${code} full wording · NO ${code}`);
    return true;
  }

  const fields = { [M.status]: cmd === 'EDIT' ? 'Edited & approved' : 'Approved', [M.approverReply]: text, [M.approvedBy]: by, [M.approvedAt]: new Date().toISOString() };
  if (cmd === 'EDIT') fields[M.finalText] = rest;
  await updateRecord(T.messages, rec.id, fields);

  if (!inSendWindow()) {
    await sendSMS(approverMobile(), `${code} approved – it will go out at 9am (outside Mon–Fri 9–6).`);
    return true;
  }
  const fresh = await getRecord(T.messages, rec.id);
  try {
    const result = await sendApproved(fresh);
    await sendSMS(approverMobile(), `${code} ${result}.`);
  } catch (e) {
    await sendSMS(approverMobile(), `${code} failed to send: ${e.message.slice(0, 120)}`);
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
// later texts -> "Hey Sonya,"
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
  if (!firstContact) return hey;
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
  let draft = opening + ' ' + body;
  if (firstContact && !draft.includes(OPT_OUT_LINE)) draft += ' ' + OPT_OUT_LINE;
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
    const text = `Alex – nurture texts going ${sendAt}:\n${lines.join('\n')}\n\nReply SHOW ${first} to see one, CHANGE ${first} [what to change] or CANCEL ${first}. No reply needed otherwise.`;
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

    // 3. Track 8 housekeeping (sold / agreement ended), once a day
    await track8Housekeeping();

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
    ' "wants_no_contact": true/false - true ONLY if they clearly ask us to stop texting / leave them alone / take them off the list, or say they are no longer selling and do not want to hear from us. "Not yet" or "try me in March" is NOT an opt-out - move the follow-up date instead. If unsure, false and set urgent_for_agent}';
  const out = await claudeJSON(VOICE + ' You also extract facts for the agent accurately and conservatively.', user, 700);

  if (out.wants_no_contact === true) {
    await updateRecord(T.leads, lead.id, { [L.doNotContact]: true });
    await logActivity(lead.id, { summary: 'Vendor asked to be left alone – Do Not Contact ticked by Alex', detail: text, type: 'General', kind: 'History' });
    await sendSMS(from, OPT_OUT_ACK);
    await sendSMS(approverMobile(), `${f[L.name]} asked to be left alone: "${text.slice(0, 200)}"\nDo Not Contact is now ticked and Alex replied: "${OPT_OUT_ACK}"\nIf Alex misread this, untick Do Not Contact on the card.`);
    return true;
  }

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
  const recs = await listAll(T.messages, { filterByFormula: `AND(UPPER({${M.code}})='${code}',OR({${M.status}}='Awaiting approval',{${M.status}}='Scheduled',{${M.status}}='Previewed'))` });
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
    await updateRecord(T.messages, rec.id, { [M.finalText]: rest, [M.approverReply]: parsed.raw });
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
  return bits.join(' | ');
}

async function applyCardChange(leadId, upd, note, authorName, rawText) {
  const lead = await getRecord(T.leads, leadId);
  const prev = {};
  for (const k of Object.keys(upd)) prev[k] = lead.fields[k] === undefined ? null : lead.fields[k];
  // selects come back as objects; write them back as names
  for (const k of Object.keys(prev)) if (prev[k] && typeof prev[k] === 'object' && !Array.isArray(prev[k]) && prev[k].name) prev[k] = prev[k].name;
  await updateRecord(T.leads, leadId, upd);
  await logActivity(leadId, { summary: `${authorName} updated the card by text`, detail: (note ? note + '\n' : '') + `Text: "${rawText}"`, type: 'SMS', kind: 'Note' });
  return prev;
}

async function handleAgentUpdate(member, from, text, reply) {
  const cards = await agentCards(member);
  if (!cards.length) { await reply("I couldn't find any cards for you yet."); return; }
  const now = melbNow();
  const user =
    `TODAY: ${now.weekday} ${now.date} (Melbourne). AGENT: ${member.fields[TM.name]}\n\n` +
    `THE AGENT'S CARDS (id | contact | address | stage | task or track):\n${cards.map(cardLine).join('\n')}\n\n` +
    `THE AGENT TEXTED ALEX: "${text}"\n\n` +
    `STAGES: ${STAGE_LIST.join('; ')}\nNURTURE REASONS: ${NURTURE_REASONS.join('; ')}\nLOST REASONS: ${LOST_REASONS.join('; ')}\n\n` +
    'Work out which ONE card this is about and what to change. Rules: change only what the agent clearly said. ' +
    'An appraisal booked → stage "Appraisal Booked" with appraisal_at. A listing meeting booked → "Listing Meeting Booked" with listing_meeting_at. ' +
    '"Sent the price update/desktop" → "Presentation Sent" only if it was a presentation; a price update sent → keep the stage and set complete_task true. ' +
    '"Sent the presentation/proposal" → "Presentation Sent". "They want to go ahead / verbal yes" → "Approved / Accepted". "Authority sent" → "Authority Sent – Awaiting Signatures". ' +
    '"Signed up / signed the authority" → "Listed (Won)". "Not ready / next year / later" → "Nurture" with the matching nurture_reason. ' +
    '"Listed with another agent" → "Lost / Not Progressing" with lost_reason "Listed with competitor". "No answer / left a message" → no change, note only. ' +
    'If they did the task without changing stage, complete_task true. Use 24h local times "YYYY-MM-DDTHH:MM"; resolve weekdays to the NEXT such date. ' +
    'If you cannot tell which card or what they mean, set question and leave changes empty. confidence "high" only when the card and the change are both unambiguous.\n' +
    'Return JSON only: {"lead_id": "rec... or empty", "confidence": "high|low", ' +
    '"changes": {"stage": "", "next_action": "", "next_action_date": "", "appraisal_at": "", "listing_meeting_at": "", "nurture_reason": "", "lost_reason": "", "authority_ends": "", "priority": false, "complete_task": false}, ' +
    '"note": "any fact worth logging on the card, or empty", "summary": "what you will change, e.g. Sarah Jones (14 Main St) → Appraisal Booked, Thu 23 Oct 2pm (say if you are ticking off a task)", "question": ""}';
  const out = await claudeJSON('You are Alex, the sales assistant at Stone Real Estate Ballarat. You read short texts from agents and update their lead cards accurately and conservatively.', user, 700);
  const card = cards.find(c => c.id === out.lead_id);
  if (!card || out.question) {
    await reply(out.question || "Sorry, I couldn't tell which card that's about – can you include the name or address?");
    return;
  }
  const c = out.changes || {};
  const upd = {};
  if (c.stage && STAGE_LIST.includes(c.stage) && c.stage !== sel(card.fields[L.stage])) upd[L.stage] = c.stage;
  if (c.next_action) upd[L.nextAction] = c.next_action;
  if (/^\d{4}-\d{2}-\d{2}$/.test(c.next_action_date || '')) upd[L.nextActionDate] = c.next_action_date;
  const appt = melbToISO(c.appraisal_at); if (appt) upd[L_APPT_AT] = appt;
  const mtg = melbToISO(c.listing_meeting_at); if (mtg) upd[L_MTG_AT] = mtg;
  if (c.nurture_reason && NURTURE_REASONS.includes(c.nurture_reason)) upd[L.nurtureReason] = c.nurture_reason;
  if (c.lost_reason && LOST_REASONS.includes(c.lost_reason)) upd[L_LOST_REASON] = c.lost_reason;
  if (/^\d{4}-\d{2}-\d{2}$/.test(c.authority_ends || '')) upd[L_AUTH_ENDS] = c.authority_ends;
  if (c.priority === true) upd[L_PRIORITY] = true;
  // Completing the task only when the stage isn't changing (a stage move brings its own new task)
  const complete = c.complete_task === true && !upd[L.stage] && card.fields[L.nextAction];
  const authorName = firstName(member.fields[TM.name]) || member.fields[TM.name];
  const note = String(out.note || '').trim();
  const summary = String(out.summary || '').trim() || `${card.fields[L.name]} updated`;
  if (!Object.keys(upd).length && !complete) {
    if (note) {
      await logActivity(card.id, { summary: `${authorName}: ${note}`, detail: `Text: "${text}"`, type: 'SMS', kind: 'Note' });
      await reply(`Noted on ${card.fields[L.name]}'s card: ${note}`);
    } else await reply(`Nothing to change on ${card.fields[L.name]}'s card – tell me what happened if something did.`);
    return;
  }
  if (complete) upd[L_COMPLETE] = '✓ Done';
  const key = normalisePhone(from);
  if (out.confidence !== 'high') {
    pendingByPhone.set(key, { kind: 'confirm', leadId: card.id, upd, note, summary, raw: text, author: authorName, at: Date.now() });
    await reply(`${summary} – OK? Reply YES, or tell me what's different.`);
    return;
  }
  const prev = await applyCardChange(card.id, upd, note, authorName, text);
  delete prev[L_COMPLETE];
  pendingByPhone.set(key, { kind: 'undo', leadId: card.id, prev, summary, at: Date.now() });
  await reply(`Done: ${summary}.` + (Object.keys(prev).length ? ' Reply UNDO to reverse.' : ''));
}

// Returns true when the text came from the team and was handled here
async function handleTeamSMS(from, body) {
  if (!enabled()) return false;
  const approver = isApprover(from);
  const member = await teamByPhone(from);
  if (!member && !approver) return false;
  const text = String(body || '').trim();
  const reply = msg => sendSMS(from, msg);
  const key = normalisePhone(from);

  // 1. UNDO / confirmation of the last card change
  let pend = pendingByPhone.get(key);
  if (pend && Date.now() - pend.at > PENDING_MINUTES * 60000) { pendingByPhone.delete(key); pend = null; }
  if (/^undo\b/i.test(text)) {
    if (!pend || pend.kind !== 'undo' || !Object.keys(pend.prev || {}).length) { await reply('Nothing to undo (a ticked-off task can be set again on the card).'); return true; }
    await updateRecord(T.leads, pend.leadId, pend.prev);
    await logActivity(pend.leadId, { summary: 'Card change by text undone', detail: pend.summary, type: 'General', kind: 'History' });
    pendingByPhone.delete(key);
    await reply(`Undone: ${pend.summary}.`);
    return true;
  }
  if (pend && pend.kind === 'confirm') {
    if (/^(yes|y|yep|yeah|ok|okay|sure|go|go ahead|correct|👍)\b/i.test(text) && !/\bA\s?\d{1,2}\b/i.test(text)) {
      const prev = await applyCardChange(pend.leadId, pend.upd, pend.note, pend.author, pend.raw);
      delete prev[L_COMPLETE];
      pendingByPhone.set(key, { kind: 'undo', leadId: pend.leadId, prev, summary: pend.summary, at: Date.now() });
      await reply(`Done: ${pend.summary}.` + (Object.keys(prev).length ? ' Reply UNDO to reverse.' : ''));
      return true;
    }
    if (/^(no|n|nope|nah|cancel)$/i.test(text)) { pendingByPhone.delete(key); await reply("OK, I've left the card as it was."); return true; }
    pendingByPhone.delete(key); // anything else is a fresh message
  }

  // 2. preview / approval commands with a code
  const parsed = parseApproverCommand(text);
  if (parsed) parsed.raw = text;
  if (parsed && parsed.code) {
    const rec = await findActiveByCode(parsed.code);
    if (rec && ['Scheduled', 'Previewed'].includes(sel(rec.fields[M.status]))) {
      await handlePreviewCommand({ parsed, rec, member, approver, reply });
      return true;
    }
  }
  // 3. Stu's approval flow
  if (approver && parsed && await handleApproverSMS(text)) return true;

  // 4. a card update from an Alex-active agent
  if (member && member.fields[TM.alexActive]) {
    try { await handleAgentUpdate(member, from, text, reply); }
    catch (e) { console.error('Alex leads: agent update failed', e.message); await reply("Sorry, I couldn't process that – please update the card in Airtable."); }
    return true;
  }
  return false;
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
}

module.exports = { start, sweep, isApprover, handleApproverSMS, handleTeamSMS, handleVendorSMS, createEnquiryLead, normalisePhone, enabled };
