const Anthropic = require('@anthropic-ai/sdk');
const twilio = require('twilio');
const { Pool } = require('pg');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const pool = new Pool({
  connectionString: process.env.SUPABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const conversations = {};
const trustedConversations = {};
const delegatedConversations = {};
const pendingSnooze = {};

const STU_NUMBER = process.env.STU_WHATSAPP_NUMBER;
const STU_WHATSAPP = 'whatsapp:' + (process.env.STU_WHATSAPP_NUMBER || '');
const WHATSAPP_FROM = process.env.WHATSAPP_FROM || 'whatsapp:' + process.env.TWILIO_PHONE_NUMBER;

function getMelbourneOffset() {
  const now = new Date();
  const melbourne = new Date(now.toLocaleString('en-AU', { timeZone: 'Australia/Melbourne' }));
  const utc = new Date(now.toLocaleString('en-AU', { timeZone: 'UTC' }));
  return (melbourne - utc) / (60 * 60 * 1000);
}

function melbourneToUTC(dateTimeStr) {
  try {
    const clean = dateTimeStr.trim().replace('.', ':');
    console.log('Converting Melbourne time: ' + clean);
    const parts = clean.match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/);
    if (!parts) {
      console.error('Could not parse datetime: ' + clean);
      return new Date().toISOString();
    }
    const year = parseInt(parts[1]);
    const month = parseInt(parts[2]) - 1;
    const day = parseInt(parts[3]);
    const hour = parseInt(parts[4]);
    const minute = parseInt(parts[5]);
    const offset = getMelbourneOffset();
    console.log('Melbourne offset: ' + offset);
    const utc = new Date(Date.UTC(year, month, day, hour - offset, minute));
    console.log('UTC result: ' + utc.toISOString());
    return utc.toISOString();
  } catch (e) {
    console.error('melbourneToUTC error: ' + e.message);
    return new Date().toISOString();
  }
}
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS memories (
        id SERIAL PRIMARY KEY,
        category TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(category, key)
      );
      CREATE TABLE IF NOT EXISTS reminders (
        id SERIAL PRIMARY KEY,
        type TEXT NOT NULL,
        message TEXT NOT NULL,
        context TEXT,
        recipient TEXT,
        recipient_number TEXT,
        scheduled_for TIMESTAMP NOT NULL,
        recurrence TEXT,
        status TEXT DEFAULT 'pending',
        follow_up_count INTEGER DEFAULT 0,
        last_follow_up TIMESTAMP,
        set_by TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS follow_ups (
        id SERIAL PRIMARY KEY,
        contact_name TEXT NOT NULL,
        contact_number TEXT NOT NULL,
        message_sent TEXT NOT NULL,
        sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        prompted INTEGER DEFAULT 0,
        resolved INTEGER DEFAULT 0
      );
    `);
    console.log('Supabase database initialised successfully');
  } catch (error) {
    console.error('Database init error:', error.message);
  }
}

const TRUSTED_CONTACTS = {
  '+61414682861': { name: 'Yasna', relationship: 'Wife' },
  '+61412185312': { name: 'Fiona Hart', relationship: 'Personal Assistant' },
  '+61414410117': { name: 'Gwen', relationship: 'Mum' },
  '+61434308724': { name: 'Josh', relationship: 'Son' },
  '+61498327669': { name: 'Aiden', relationship: 'Son' },
  '+61429097002': { name: 'Leanne Madigan', relationship: 'Sales Associate' },
  '+61418318251': { name: 'Tammy Edwards', relationship: 'Sales Admin' }
};

const CONTACTS = {
  'yasna': { name: 'Yasna', number: '+61414682861', method: 'sms', relationship: 'Wife' },
  'fiona': { name: 'Fiona Hart', number: '+61412185312', method: 'sms', relationship: 'Personal Assistant' },
  'fiona hart': { name: 'Fiona Hart', number: '+61412185312', method: 'sms', relationship: 'Personal Assistant' },
  'leanne': { name: 'Leanne Madigan', number: '+61429097002', method: 'sms', relationship: 'Sales Associate' },
  'leanne madigan': { name: 'Leanne Madigan', number: '+61429097002', method: 'sms', relationship: 'Sales Associate' },
  'tammy': { name: 'Tammy Edwards', number: '+61418318251', method: 'sms', relationship: 'Sales Admin' },
  'tammy edwards': { name: 'Tammy Edwards', number: '+61418318251', method: 'sms', relationship: 'Sales Admin' },
  'gwen': { name: 'Gwen Brien', number: '+61414410117', method: 'sms', relationship: 'Mum' },
  'mum': { name: 'Gwen Brien', number: '+61414410117', method: 'sms', relationship: 'Mum' },
  'gwen brien': { name: 'Gwen Brien', number: '+61414410117', method: 'sms', relationship: 'Mum' },
  'glenn': { name: 'Glenn Brien', number: '+61418301954', method: 'sms', relationship: 'Brother' },
  'glenn brien': { name: 'Glenn Brien', number: '+61418301954', method: 'sms', relationship: 'Brother' },
  'josh': { name: 'Josh Brien', number: '+61434308724', method: 'sms', relationship: 'Son' },
  'josh brien': { name: 'Josh Brien', number: '+61434308724', method: 'sms', relationship: 'Son' },
  'aiden': { name: 'Aiden Brien', number: '+61498327669', method: 'sms', relationship: 'Son' },
  'aiden brien': { name: 'Aiden Brien', number: '+61498327669', method: 'sms', relationship: 'Son' },
  'rob': { name: 'Rob Cunningham', number: '+61418543634', method: 'sms', relationship: 'Sales Agent' },
  'rob cunningham': { name: 'Rob Cunningham', number: '+61418543634', method: 'sms', relationship: 'Sales Agent' },
  'leigh': { name: 'Leigh Hutchinson', number: '+61407861960', method: 'sms', relationship: 'Sales Agent' },
  'leigh hutchinson': { name: 'Leigh Hutchinson', number: '+61407861960', method: 'sms', relationship: 'Sales Agent' },
  'jamie': { name: 'Jamie Gepp', number: '+61459201710', method: 'sms', relationship: 'Sales Agent' },
  'jamie gepp': { name: 'Jamie Gepp', number: '+61459201710', method: 'sms', relationship: 'Sales Agent' },
  'jarrod': { name: 'Jarrod Kemp', number: '+61450836257', method: 'sms', relationship: 'Sales Agent' },
  'jarrod kemp': { name: 'Jarrod Kemp', number: '+61450836257', method: 'sms', relationship: 'Sales Agent' },
  'linda': { name: 'Linda Turk', number: '+61414287337', method: 'sms', relationship: 'Senior Property Manager' },
  'linda turk': { name: 'Linda Turk', number: '+61414287337', method: 'sms', relationship: 'Senior Property Manager' },
  'josh shanahan': { name: 'Josh Shanahan', number: '+61491118698', method: 'sms', relationship: 'Property Manager' }
};

function resolveContactNumber(nameOrNumber) {
  if (!nameOrNumber) return null;
  const str = nameOrNumber.toString().trim();
  if (str.startsWith('+') || /^\d/.test(str)) return str.replace(/\s/g, '');
  const lower = str.toLowerCase();
  if (CONTACTS[lower]) return CONTACTS[lower].number;
  return str;
}

async function getContactByNumber(number) {
  const clean = number.replace('whatsapp:', '').replace(/\s/g, '');
  for (const key in CONTACTS) {
    if (CONTACTS[key].number.replace(/\s/g, '') === clean) return CONTACTS[key];
  }
  try {
    const result = await pool.query('SELECT key, value FROM memories WHERE category = $1', ['contacts']);
    for (const row of result.rows) {
      const parts = row.value.split(' - ');
      const memNumber = parts[0].replace(/\s/g, '');
      if (memNumber === clean) {
        return { name: row.key, number: memNumber, method: parts[1] ? parts[1].trim() : 'sms', relationship: 'Contact' };
      }
    }
  } catch (e) {}
  return null;
}

function getTrustedContact(number) {
  const clean = number.replace('whatsapp:', '').replace(/\s/g, '');
  return TRUSTED_CONTACTS[clean] || null;
}

function getCurrentDateTime() {
  return new Date().toLocaleString('en-AU', {
    timeZone: 'Australia/Melbourne',
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
}

function isActiveHours() {
  const hour = parseInt(new Date().toLocaleString('en-AU', {
    timeZone: 'Australia/Melbourne', hour: '2-digit', hour12: false
  }));
  return hour >= 7 && hour < 21;
}

async function saveMemory(category, key, value) {
  try {
    await pool.query(`
      INSERT INTO memories (category, key, value, updated_at)
      VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
      ON CONFLICT (category, key) DO UPDATE SET
      value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP
    `, [category, key, value]);
    console.log('Memory saved: [' + category + '] ' + key + ' = ' + value);
    return true;
  } catch (error) {
    console.error('Failed to save memory:', error.message);
    return false;
  }
}

async function loadAllMemories() {
  try {
    const result = await pool.query('SELECT category, key, value FROM memories ORDER BY category, key');
    return result.rows;
  } catch (error) {
    console.error('Failed to load memories:', error.message);
    return [];
  }
}

async function deleteMemory(category, key) {
  try {
    await pool.query('DELETE FROM memories WHERE category = $1 AND key = $2', [category, key]);
    return true;
  } catch (error) {
    return false;
  }
}

async function saveReminder(type, message, context, recipient, recipientNumber, scheduledFor, recurrence, setBy) {
  try {
    const utcDateTime = melbourneToUTC(scheduledFor);
    console.log('Saving reminder: type=' + type + ' message=' + message + ' utc=' + utcDateTime);
    const result = await pool.query(`
      INSERT INTO reminders (type, message, context, recipient, recipient_number, scheduled_for, recurrence, set_by, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')
      RETURNING id
    `, [type, message, context || null, recipient || 'Stu', recipientNumber || null, utcDateTime, recurrence || 'ONCE', setBy || 'Stu']);
    console.log('Reminder saved successfully ID:' + result.rows[0].id + ' UTC: ' + utcDateTime);
    return true;
  } catch (error) {
    console.error('Failed to save reminder:', error.message);
    return false;
  }
}

async function saveFollowUp(contactName, contactNumber, messageSent) {
  try {
    await pool.query('INSERT INTO follow_ups (contact_name, contact_number, message_sent) VALUES ($1, $2, $3)', [contactName, contactNumber, messageSent]);
    return true;
  } catch (error) {
    return false;
  }
}

async function buildMemoryContext() {
  const memories = await loadAllMemories();
  if (memories.length === 0) return '';
  const grouped = {};
  for (const mem of memories) {
    if (!grouped[mem.category]) grouped[mem.category] = [];
    grouped[mem.category].push(mem.key + ': ' + mem.value);
  }
  let context = '\n\nSTU PREFERENCES AND MEMORY:\n';
  for (const category in grouped) {
    context += category.toUpperCase() + ':\n';
    for (const item of grouped[category]) context += '- ' + item + '\n';
  }
  return context;
}

async function getPendingRemindersContext() {
  try {
    const result = await pool.query(`
      SELECT * FROM reminders
      WHERE status IN ('pending', 'prompted')
      ORDER BY scheduled_for ASC LIMIT 10
    `);
    if (result.rows.length === 0) return '';
    const offset = getMelbourneOffset();
    let context = '\n\nPENDING REMINDERS:\n';
    for (const r of result.rows) {
      const melbTime = new Date(new Date(r.scheduled_for).getTime() + offset * 60 * 60 * 1000);
      const timeStr = melbTime.toLocaleString('en-AU', { timeZone: 'UTC', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
      context += '- [ID:' + r.id + '] ' + timeStr + ' - ' + (r.recipient !== 'Stu' ? 'To ' + r.recipient + ': ' : '') + r.message + (r.set_by && r.set_by !== 'Stu' ? ' (set by ' + r.set_by + ')' : '') + '\n';
    }
    return context;
  } catch (e) {
    return '';
  }
}

async function getPendingRemindersForTrusted() {
  try {
    const result = await pool.query(`
      SELECT * FROM reminders
      WHERE status IN ('pending', 'prompted')
      ORDER BY scheduled_for ASC LIMIT 5
    `);
    if (result.rows.length === 0) return 'Stu has no pending reminders.';
    const offset = getMelbourneOffset();
    let text = 'Stu current reminders:\n';
    for (const r of result.rows) {
      const melbTime = new Date(new Date(r.scheduled_for).getTime() + offset * 60 * 60 * 1000);
      const timeStr = melbTime.toLocaleString('en-AU', { timeZone: 'UTC', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
      text += '- ' + timeStr + ': ' + r.message + '\n';
    }
    return text;
  } catch (e) {
    return 'Could not retrieve reminders.';
  }
}

async function callClaudeWithSearch(systemPrompt, messages, maxTokens) {
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: maxTokens || 1000,
    system: systemPrompt,
    tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    messages: messages
  });

  let fullText = '';
  for (const block of response.content) {
    if (block.type === 'text') fullText += block.text;
  }

  if (response.stop_reason === 'tool_use') {
    const toolUseBlock = response.content.find(b => b.type === 'tool_use');
    if (toolUseBlock) {
      console.log('Jordan searched: ' + toolUseBlock.input.query);
      const toolResultMessages = [
        ...messages,
        { role: 'assistant', content: response.content },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseBlock.id, content: 'Search completed for: ' + toolUseBlock.input.query }] }
      ];
      const followUp = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: maxTokens || 1000,
        system: systemPrompt,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: toolResultMessages
      });
      fullText = '';
      for (const block of followUp.content) {
        if (block.type === 'text') fullText += block.text;
      }
    }
  }
  return fullText;
}

async function sendMessageOnBehalf(to, message, contactName) {
  try {
    const cleanTo = resolveContactNumber(to);
    if (!cleanTo) { console.error('Could not resolve number for: ' + to); return false; }
    console.log('Sending to ' + cleanTo + ': ' + message);
    await twilioClient.messages.create({ from: process.env.TWILIO_PHONE_NUMBER, to: cleanTo, body: message });
    const contact = await getContactByNumber(cleanTo);
    const name = contactName || (contact ? contact.name : cleanTo);
    delegatedConversations[cleanTo] = { contactName: name, messages: [{ role: 'sent', content: message, sentAt: new Date().toISOString() }] };
    await saveFollowUp(name, cleanTo, message);
    console.log('Message sent successfully to ' + cleanTo);
    return true;
  } catch (error) {
    console.error('Failed to send to ' + to + ': ' + error.message);
    return false;
  }
}

async function notifyStu(message) {
  try {
    console.log('Notifying Stu - from: ' + WHATSAPP_FROM + ' to: ' + STU_WHATSAPP);
    await twilioClient.messages.create({ from: WHATSAPP_FROM, to: STU_WHATSAPP, body: message });
    console.log('Stu notified successfully: ' + message.substring(0, 60));
  } catch (error) {
    console.error('Failed to notify Stu: ' + error.message);
  }
}

async function replySMS(to, message) {
  try {
    await twilioClient.messages.create({ from: process.env.TWILIO_PHONE_NUMBER, to: to, body: message });
    console.log('Replied to ' + to);
  } catch (error) {
    console.error('Failed to reply to ' + to + ': ' + error.message);
  }
}

async function handleTrustedContact(from, body, trustedContact) {
  const currentDateTime = getCurrentDateTime();
  console.log('Trusted contact message from ' + trustedContact.name + ': ' + body);

  if (!trustedConversations[from]) trustedConversations[from] = [];
  trustedConversations[from].push({ role: 'user', content: body });
  if (trustedConversations[from].length > 10) trustedConversations[from] = trustedConversations[from].slice(-10);

  const pendingReminders = await getPendingRemindersForTrusted();

  const trustedSystemPrompt = 'You are Jordan, an AI assistant working for Stu Brien. You are currently talking to ' + trustedContact.name + ' (' + trustedContact.relationship + ') who is a trusted contact. They can set reminders for Stu and view his current reminders. CURRENT DATE AND TIME: ' + currentDateTime + ' Melbourne Australia time. WHAT ' + trustedContact.name.toUpperCase() + ' CAN DO: 1. Set a reminder for Stu. 2. View Stu current reminders. STU CURRENT REMINDERS: ' + pendingReminders + ' SETTING A REMINDER: When ' + trustedContact.name + ' asks you to set a reminder for Stu confirm the details and include this tag: [TRUSTED_REMINDER:message:scheduled_datetime:context] where scheduled_datetime is YYYY-MM-DD HH:MM in Melbourne time. Tell ' + trustedContact.name + ' the reminder has been set. Be warm and brief - this is SMS. If they ask about anything else politely explain you can only help with reminders and Stu schedule on this number.';

  try {
    const response = await callClaudeWithSearch(trustedSystemPrompt, trustedConversations[from], 500);
    let reply = response;

    const reminderTagMatch = reply.match(/\[TRUSTED_REMINDER:([^:]+):([^:]+):([^\]]+)\]/);
    if (reminderTagMatch) {
      const message = reminderTagMatch[1].trim();
      const scheduledFor = reminderTagMatch[2].trim();
      const context = reminderTagMatch[3].trim();
      await saveReminder('STU', message, context, 'Stu', null, scheduledFor, 'ONCE', trustedContact.name);
      reply = reply.replace(/\[TRUSTED_REMINDER:[^\]]+\]/g, '').trim();
      await notifyStu(trustedContact.name + ' has set a reminder for you:\n"' + message + '"\nScheduled for: ' + scheduledFor + '\n\nAdded to your reminders.');
    }

    trustedConversations[from].push({ role: 'assistant', content: reply });
    await replySMS(from, reply);
  } catch (error) {
    console.error('Error handling trusted contact:', error);
    await replySMS(from, 'Sorry, having a technical issue. Please try again.');
  }
}

async function handleDelegatedReply(fromNumber, body) {
  const delegation = delegatedConversations[fromNumber];
  if (!delegation) return;

  console.log('Delegated reply from ' + fromNumber + ': ' + body);
  delegation.messages.push({ role: 'received', content: body });

  try { await pool.query('UPDATE follow_ups SET resolved = 1 WHERE contact_number = $1 AND resolved = 0', [fromNumber]); } catch (e) {}

  const contact = await getContactByNumber(fromNumber);
  const contactName = contact ? contact.name : fromNumber;
  const stuFrom = STU_WHATSAPP;

  if (!conversations[stuFrom]) conversations[stuFrom] = [];
  const contextMessage = contactName + ' replied: "' + body + '"';
  conversations[stuFrom].push({ role: 'user', content: contextMessage });

  try {
    const currentDateTime = getCurrentDateTime();
    const memoryContext = await buildMemoryContext();
    const systemPrompt = BASE_SYSTEM_PROMPT + memoryContext + '\n\nCURRENT DATE AND TIME: ' + currentDateTime + ' Melbourne time.';
    const reply = await callClaudeWithSearch(systemPrompt, conversations[stuFrom]);

    const allSendTags = [...reply.matchAll(/\[SEND:(\+[\d]+):([^\]]+)\]/g)];
    let cleanReply = reply;
    if (allSendTags.length > 0) {
      cleanReply = reply.replace(/\[SEND:(\+[\d]+):([^\]]+)\]/g, '').trim();
      for (const match of allSendTags) await sendMessageOnBehalf(match[1].trim(), match[2].trim());
    }

    await processTagsFromReply(reply);
    cleanReply = stripAllTags(cleanReply);
    conversations[stuFrom].push({ role: 'assistant', content: cleanReply });
    await notifyStu(cleanReply);
  } catch (error) {
    console.error('Error handling delegated reply:', error);
    await notifyStu(contactName + ' replied: "' + body + '"');
  }
}

async function processTagsFromReply(reply) {
  const memoryTags = [...reply.matchAll(/\[MEMORY:([^:]+):([^:]+):([^\]]+)\]/g)];
  for (const match of memoryTags) await saveMemory(match[1].trim(), match[2].trim(), match[3].trim());

  const forgetTags = [...reply.matchAll(/\[FORGET:([^:]+):([^\]]+)\]/g)];
  for (const match of forgetTags) await deleteMemory(match[1].trim(), match[2].trim());

  const reminderTags = [...reply.matchAll(/\[REMINDER:([^|]+)\|([^|]+)\|([^|]+)\|([^|]+)\|([^|]+)\|([^|]+)\|([^\]]+)\]/g)];
  for (const match of reminderTags) {
    console.log('Reminder tag found: type=' + match[1] + ' scheduled=' + match[4] + ' message=' + match[6]);
    await saveReminder(
      match[1].trim(),
      match[6].trim(),
      match[7].trim(),
      match[2].trim(),
      match[3].trim() === 'none' ? null : match[3].trim(),
      match[4].trim(),
      match[5].trim(),
      'Stu'
    );
  }

  const cancelTags = [...reply.matchAll(/\[CANCEL_REMINDER:(\d+)\]/g)];
  for (const match of cancelTags) {
    try { await pool.query('UPDATE reminders SET status = $1 WHERE id = $2', ['cancelled', parseInt(match[1])]); } catch (e) {}
  }

  const followUpTags = [...reply.matchAll(/\[FOLLOW_UP:([^:]+):([^:]+):([^\]]+)\]/g)];
  for (const match of followUpTags) await saveFollowUp(match[1].trim(), match[2].trim(), match[3].trim());
}

function stripAllTags(reply) {
  return reply
    .replace(/\[MEMORY:[^\]]+\]/g, '')
    .replace(/\[FORGET:[^\]]+\]/g, '')
    .replace(/\[REMINDER:[^\]]+\]/g, '')
    .replace(/\[CANCEL_REMINDER:[^\]]+\]/g, '')
    .replace(/\[FOLLOW_UP:[^\]]+\]/g, '')
    .replace(/\[SEND:[^\]]+\]/g, '')
    .replace(/\[TRUSTED_REMINDER:[^\]]+\]/g, '')
    .trim();
}

async function checkRemindersAndFollowUps() {
  if (!isActiveHours()) return;

  try {
    const now = new Date().toISOString();
    console.log('Checking reminders at UTC: ' + now);

    const dueResult = await pool.query(`
      SELECT * FROM reminders
      WHERE status = 'pending' AND scheduled_for <= $1
    `, [now]);

    console.log('Due reminders found: ' + dueResult.rows.length);

    for (const reminder of dueResult.rows) {
      console.log('Reminder due: [ID:' + reminder.id + '] ' + reminder.message);
      if (reminder.type === 'STU') {
        const setByText = reminder.set_by && reminder.set_by !== 'Stu' ? '\n(Set by ' + reminder.set_by + ')' : '';
        await notifyStu(
          'Reminder: ' + reminder.message +
          (reminder.context && reminder.context !== 'none' ? '\n' + reminder.context : '') +
          setByText +
          '\n\nReply DONE, SNOOZE or CANCEL'
        );
        await pool.query(`
          UPDATE reminders SET status = 'prompted', last_follow_up = $1 WHERE id = $2
        `, [new Date().toISOString(), reminder.id]);
        console.log('Reminder prompted to Stu: ID ' + reminder.id);
      } else if (reminder.type === 'CONTACT' && reminder.recipient_number) {
        await sendMessageOnBehalf(reminder.recipient_number, reminder.message, reminder.recipient);
        await notifyStu('Sent reminder to ' + reminder.recipient + ': "' + reminder.message + '"');
        await pool.query('UPDATE reminders SET status = $1 WHERE id = $2', ['done', reminder.id]);
      }
    }

    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const followUpResult = await pool.query(`
      SELECT * FROM reminders
      WHERE status = 'prompted'
      AND last_follow_up <= $1
      AND type = 'STU'
    `, [twoHoursAgo]);

    for (const reminder of followUpResult.rows) {
      console.log('Following up on reminder ID:' + reminder.id);
      await notifyStu('Just checking in - did you get to this?\n"' + reminder.message + '"\n\nReply DONE, SNOOZE or CANCEL');
      await pool.query(`
        UPDATE reminders SET
        follow_up_count = follow_up_count + 1,
        last_follow_up = $1
        WHERE id = $2
      `, [new Date().toISOString(), reminder.id]);
    }

    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const msgFollowUpResult = await pool.query(`
      SELECT * FROM follow_ups
      WHERE resolved = 0 AND prompted = 0
      AND sent_at <= $1
    `, [threeHoursAgo]);

    for (const followUp of msgFollowUpResult.rows) {
      await notifyStu(followUp.contact_name + ' has not replied to your message from 3 hours ago.\n"' + followUp.message_sent.substring(0, 80) + '"\nWant me to follow up?');
      await pool.query('UPDATE follow_ups SET prompted = 1 WHERE id = $1', [followUp.id]);
    }

  } catch (error) {
    console.error('Reminder check error:', error.message);
  }
}

async function handleReminderResponse(body) {
  const bodyUpper = body.trim().toUpperCase();

  if (bodyUpper === 'DONE') {
    try {
      const result = await pool.query(`
        UPDATE reminders SET status = 'done'
        WHERE status = 'prompted'
        RETURNING id, message, recurrence, scheduled_for
      `);
      if (result.rows.length > 0) {
        const reminder = result.rows[0];
        if (reminder.recurrence && reminder.recurrence !== 'ONCE') {
          let nextDate = new Date(reminder.scheduled_for);
          if (reminder.recurrence === 'DAILY') nextDate.setDate(nextDate.getDate() + 1);
          else if (reminder.recurrence === 'WEEKLY') nextDate.setDate(nextDate.getDate() + 7);
          else if (reminder.recurrence === 'MONTHLY') nextDate.setMonth(nextDate.getMonth() + 1);
          await pool.query(`
            INSERT INTO reminders (type, message, context, recipient, scheduled_for, recurrence, set_by, status)
            SELECT type, message, context, recipient, $1, recurrence, set_by, 'pending'
            FROM reminders WHERE id = $2
          `, [nextDate.toISOString(), reminder.id]);
          const offset = getMelbourneOffset();
          const melbNext = new Date(nextDate.getTime() + offset * 60 * 60 * 1000);
          await notifyStu('Done - marked as complete. Next reminder scheduled for ' + melbNext.toLocaleDateString('en-AU') + '.');
        } else {
          await notifyStu('Done - marked as complete and removed.');
        }
        console.log('Reminder marked done: ID ' + reminder.id);
        return true;
      }
    } catch (e) { console.error('Error marking done:', e.message); }
  }

  if (bodyUpper === 'CANCEL') {
    try {
      const result = await pool.query(`
        UPDATE reminders SET status = 'cancelled'
        WHERE status = 'prompted'
        RETURNING id, message
      `);
      if (result.rows.length > 0) {
        await notifyStu('Reminder cancelled and removed.');
        console.log('Reminder cancelled: ID ' + result.rows[0].id);
        return true;
      }
    } catch (e) { console.error('Error cancelling:', e.message); }
  }

  if (bodyUpper === 'SNOOZE') {
    pendingSnooze[STU_WHATSAPP] = true;
    await notifyStu('When would you like me to remind you again?');
    return true;
  }

  if (pendingSnooze[STU_WHATSAPP]) {
    try {
      const result = await pool.query(`
        SELECT id, message FROM reminders WHERE status = 'prompted' LIMIT 1
      `);
      if (result.rows.length > 0) {
        delete pendingSnooze[STU_WHATSAPP];
        const currentDateTime = getCurrentDateTime();
        const snoozeResponse = await anthropic.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 50,
          messages: [{ role: 'user', content: 'Current time is ' + currentDateTime + ' Melbourne time. Convert this snooze request to a datetime in YYYY-MM-DD HH:MM format in Melbourne time. Reply with ONLY the datetime, nothing else. Request: "' + body + '"' }]
        });
        const newDateTime = snoozeResponse.content[0].text.trim();
        const utcDateTime = melbourneToUTC(newDateTime);
        await pool.query(`
          UPDATE reminders SET scheduled_for = $1, status = 'pending', follow_up_count = 0, last_follow_up = NULL
          WHERE id = $2
        `, [utcDateTime, result.rows[0].id]);
        await notifyStu('Rescheduled for ' + newDateTime + ' Melbourne time.');
        console.log('Reminder snoozed to ' + newDateTime + ' (UTC: ' + utcDateTime + ')');
        return true;
      }
    } catch (e) { console.error('Error snoozing:', e.message); }
  }

  return false;
}

const BASE_SYSTEM_PROMPT = "You are Jordan, a personal AI assistant for Stu Brien - Principal of Stone Real Estate Ballarat. You help Stu with day to day productivity tasks via WhatsApp. You are efficient, direct and genuinely helpful. You know Stu well and communicate naturally - not overly formal. You have access to web search and use it proactively whenever Stu asks for current information, property data, news, business details, weather, prices or anything that requires up to date information. ABOUT STU: Stu Brien is the Principal and Licensed Real Estate Agent at Stone Real Estate Ballarat. Address: 44 Armstrong St South, Ballarat Central. Phone: 0416 183 566. Email: stubrien@stonerealestate.com.au. STU CONTACTS AND THEIR NUMBERS: Yasna (Wife) +61414682861 - sms. Fiona Hart (Personal Assistant) +61412185312 - sms. Leanne Madigan (Sales Associate) +61429097002 - sms. Tammy Edwards (Sales Admin) +61418318251 - sms. Gwen Brien (Mum) +61414410117 - sms. Glenn Brien (Brother) +61418301954 - sms. Josh Brien (Son) +61434308724 - sms. Aiden Brien (Son) +61498327669 - sms. Rob Cunningham (Sales Agent) +61418543634 - sms. Leigh Hutchinson (Sales Agent) +61407861960 - sms. Jamie Gepp (Sales Agent) +61459201710 - sms. Jarrod Kemp (Sales Agent) +61450836257 - sms. Linda Turk (Property Manager) +61414287337 - sms. Josh Shanahan (Property Manager) +61491118698 - sms. Additional contacts are stored in memory and available in your context. WHAT YOU CAN HELP WITH: Web research and information lookup. Drafting and sending messages. Contacting people on Stu behalf. Coordinating meetings and scheduling. Setting reminders. Remembering preferences and contacts. Drafting listing copy. Drafting social media posts. Property market questions. Calculations. Writing correspondence. General knowledge. WEB SEARCH BEHAVIOUR: When using web search do not narrate your search process to Stu. Just search silently and present the final result cleanly and directly. ADDING CONTACTS: When Stu asks you to add a contact save it using: [MEMORY:contacts:Full Name:+61XXXXXXXXX - sms]. Confirm back to Stu that the contact has been saved. HOW TO HANDLE TASKS: Draft immediately and present cleanly. Answer questions directly. Give 2 to 3 clear options when asked. CONTACTING PEOPLE - TWO STEP PROCESS: STEP 1 - Show draft messages in plain text and ask shall I send these. Do NOT include any [SEND:] tags yet. STEP 2 - When Stu confirms with yes, send, go ahead, ok, yep, yeah or similar - include [SEND:] tags. Format: [SEND:+PHONENUMBER:message text] one per line per recipient. ALWAYS INTRODUCE AS AI ASSISTANT: When contacting someone for the first time say: Hi [name], this is Jordan - I am Stu Brien AI assistant. MEMORY SYSTEM - SAVING: When Stu tells you something worth remembering save it using: [MEMORY:category:key:value]. Categories: preferences, contacts, instructions, tasks. Tell Stu: Got it - I will remember that. MEMORY SYSTEM - DELETING: [FORGET:category:key]. REMINDER SYSTEM: When Stu sets a reminder use this exact format with pipe symbols as separators: [REMINDER:type|recipient|recipient_number|scheduled_datetime|recurrence|message|context]. Type is STU or CONTACT. Recurrence is ONCE, DAILY, WEEKLY or MONTHLY. Datetime format is YYYY-MM-DD HH:MM in Melbourne local time. Use pipe symbols | not colons as separators. Example: [REMINDER:STU|Stu|none|2026-03-23 14:03|ONCE|Call the vendor|Re Buninyong listing]. Confirm back with exact date and time. CANCEL REMINDER BY ID: [CANCEL_REMINDER:id]. FOLLOW UP TRACKING: When you send a message expecting a reply use: [FOLLOW_UP:contact_name:contact_number:message_summary]. DELEGATED CONVERSATIONS: When someone replies their message will be forwarded to you. Report back to Stu and ask how to respond. TONE: Direct, efficient and natural. No excessive formality. Concise. Dot points for lists. IMPORTANT: Confidential.";

module.exports = function(app) {

  module.exports.getDelegatedConversations = function() { return delegatedConversations; };
  module.exports.handleDelegatedReply = handleDelegatedReply;
  module.exports.handleTrustedContact = handleTrustedContact;
  module.exports.getTrustedContact = getTrustedContact;

  initDB().then(() => {
    setInterval(checkRemindersAndFollowUps, 60 * 1000);
    console.log('Jordan reminder checker started - using Supabase');
  });

  app.post('/whatsapp', async function(req, res) {
    const From = req.body.From;
    const Body = req.body.Body;
    const bodyUpper = Body.trim().toUpperCase();

    console.log('WhatsApp from ' + From + ': ' + Body);

    const cleanFrom = From.replace('whatsapp:', '').replace(/\s/g, '').replace('+', '');
    const cleanStu = (STU_NUMBER || '').replace(/\s/g, '').replace('+', '');

    if (!cleanStu || !cleanFrom.includes(cleanStu)) {
      console.log('Blocked non-authorised WhatsApp number: ' + From);
      return res.type('text/xml').send('<Response></Response>');
    }

    if (!conversations[From]) conversations[From] = [];

    if (bodyUpper === 'CLEAR') {
      conversations[From] = [];
      const twiml = new twilio.twiml.MessagingResponse();
      twiml.message('Conversation cleared.');
      return res.type('text/xml').send(twiml.toString());
    }

    const reminderHandled = await handleReminderResponse(Body);
    if (reminderHandled) {
      return res.type('text/xml').send('<Response></Response>');
    }

    conversations[From].push({ role: 'user', content: Body });
    if (conversations[From].length > 30) conversations[From] = conversations[From].slice(-30);

    try {
      const currentDateTime = getCurrentDateTime();
      const memoryContext = await buildMemoryContext();
      const remindersContext = await getPendingRemindersContext();
      const systemPrompt = BASE_SYSTEM_PROMPT + memoryContext + remindersContext + '\n\nCURRENT DATE AND TIME: It is currently ' + currentDateTime + ' Melbourne Australia time. Use this to accurately calculate all future dates and times.';

      const reply = await callClaudeWithSearch(systemPrompt, conversations[From]);
      console.log('Jordan raw reply: ' + reply);

      const allSendTags = [...reply.matchAll(/\[SEND:(\+[\d]+):([^\]]+)\]/g)];
      let cleanReply = reply;

      if (allSendTags.length > 0) {
        cleanReply = reply.replace(/\[SEND:(\+[\d]+):([^\]]+)\]/g, '').trim();
        const results = [];
        for (const match of allSendTags) {
          const toNumber = match[1].trim();
          const messageToSend = match[2].trim();
          const contact = await getContactByNumber(toNumber);
          const contactName = contact ? contact.name : toNumber;
          const success = await sendMessageOnBehalf(toNumber, messageToSend, contactName);
          results.push({ name: contactName, success: success });
        }
        const successNames = results.filter(r => r.success).map(r => r.name);
        const failNames = results.filter(r => !r.success).map(r => r.name);
        if (successNames.length > 0) cleanReply = cleanReply + '\n\nSent to ' + successNames.join(' and ') + '. I will let you know when they reply.';
        if (failNames.length > 0) cleanReply = cleanReply + '\nFailed to send to ' + failNames.join(' and ') + '.';
      }

      await processTagsFromReply(reply);
      cleanReply = stripAllTags(cleanReply);

      conversations[From].push({ role: 'assistant', content: cleanReply });
      console.log('WhatsApp reply to ' + From + ': ' + cleanReply);

      const twiml = new twilio.twiml.MessagingResponse();
      twiml.message(cleanReply);
      res.type('text/xml').send(twiml.toString());

    } catch (error) {
      console.error('WhatsApp error:', error);
      const twiml = new twilio.twiml.MessagingResponse();
      twiml.message('Having a technical issue - try again in a moment.');
      res.type('text/xml').send(twiml.toString());
    }
  });

  app.get('/whatsapp', function(req, res) {
    res.send('Jordan WhatsApp personal assistant is running!');
  });

};
