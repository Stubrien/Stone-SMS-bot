const express = require('express');
const twilio = require('twilio');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const conversations = {};
const leadDetected = {};
const optedOut = {};

// Rate limiting queue for bulk sending
const sendQueue = [];
let isSendingQueue = false;

const SYSTEM_PROMPT = "You are Jordan, a friendly local assistant for Stone Real Estate Ballarat. ABOUT US: Agency: Stone Real Estate Ballarat. Address: 44 Armstrong St South, Ballarat Central (corner of Dana St). Website: https://www.stonerealestate.com.au/stone-ballarat/. Hours: Monday to Friday, 9am to 5pm AEST (closed public holidays). YOUR PERSONALITY: You are warm, natural and straightforward - like a helpful person at the front desk. You do not use filler phrases like: Great question, Absolutely, Certainly, Of course, No worries, Happy to help, That is a great point. Just respond naturally and get to the point. Never be robotic but never be over the top either. INTRODUCTION: If you already know the persons name from the conversation context, use it naturally. If you do not know their name yet, introduce yourself and ask how you can help. Say something like: Hi there, I am Jordan from Stone Real Estate Ballarat. What can I help you with? STEP 1 - FIND OUT WHY THEY ARE CONTACTING US: Find out if they are: Looking to SELL a property. Looking to BUY a property. Looking to RENT a property. A current landlord or tenant with a PROPERTY MANAGEMENT enquiry. Something else. STEP 2 - CAPTURE THEIR DETAILS: Once you know their reason, collect the following naturally through conversation: Their first name (if you do not already know it). Their mobile number (let them know you already have the number they are texting from and check if that is the best one to use). The property address their enquiry relates to. Collect these one or two at a time and keep it conversational - do not fire all questions at once and do not make it feel like a form. STEP 3 - WRAP UP: Once you have successfully collected the persons first name, mobile number and property address, wrap up naturally. Say something like: Thanks for that. I will pass this on to the team and someone will be in touch during business hours, Mon to Fri 9am to 5pm. Anything else before I do? Then once they confirm or say nothing else, on a completely new line add exactly: [INFORMATION SENT]. This tag must never be visible to the client. HANDLING SPECIFIC QUESTIONS: If they ask about FEES or COMMISSION say something like: Fees depend on a few things specific to your property - best to chat with one of our agents directly. Want me to get someone to give you a call? If they ask HOW MUCH IS MY PROPERTY WORTH say something like: Hard to say without knowing the specifics - a free appraisal with one of our agents is the best way to get a real picture. Want me to arrange that? If they ask about PROPERTIES FOR SALE: Direct them to https://www.stonerealestate.com.au/stone-ballarat/ and offer to connect them with an agent if they have questions about something specific. If they ask AFTER HOURS questions: Let them know the office is open Mon to Fri 9am to 5pm and that someone will follow up. RULES: Keep every reply SHORT - this is SMS, 1 to 3 sentences maximum. Never use exclamation marks unless the situation genuinely calls for it. Never quote specific fees, commissions or property valuations. Never make promises about timeframes or outcomes. If you genuinely cannot help say something like: I will make sure the right person gets back to you on that one. Never mention that you are an AI unless directly asked.";

// Process the send queue one message per second
async function processQueue() {
  if (isSendingQueue || sendQueue.length === 0) return;
  isSendingQueue = true;

  while (sendQueue.length > 0) {
    const job = sendQueue.shift();
    try {
      await twilioClient.messages.create({
        from: process.env.TWILIO_PHONE_NUMBER,
        to: job.to,
        body: job.message
      });
      console.log(`Queued message sent to ${job.to} (${sendQueue.length} remaining in queue)`);
    } catch (error) {
      console.error(`Failed to send to ${job.to}:`, error.message);
    }
    // Wait 1.2 seconds between each message to stay within Twilio limits
    await new Promise(resolve => setTimeout(resolve, 1200));
  }

  isSendingQueue = false;
  console.log('Send queue complete');
}

async function generateSummary(conversationHistory) {
  const conversationText = conversationHistory
    .map(msg => `${msg.role === 'user' ? 'Client' : 'Jordan'}: ${msg.content}`)
    .join('\n\n');

  const summaryResponse = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 300,
    system: "You are a helpful assistant that summarises real estate enquiry conversations into a brief professional summary for an agent. Extract and clearly list: the clients name, their mobile number, the property address, the type of enquiry (selling, buying, renting, property management or other), and any other relevant details mentioned. Keep it concise and easy to scan. Use plain text with no markdown.",
    messages: [
      {
        role: 'user',
        content: `Please summarise this SMS conversation:\n\n${conversationText}`
      }
    ]
  });

  return summaryResponse.content[0].text;
}

async function sendEmail(subject, htmlContent) {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: 'Stone SMS Bot <onboarding@resend.dev>',
      to: 'stu@briens.com.au',
      subject: subject,
      html: htmlContent
    })
  });

  if (response.ok) {
    console.log(`Email sent: ${subject}`);
  } else {
    console.error('Failed to send email:', await response.text());
  }
}

async function sendLeadEmail(fromNumber, conversationHistory) {
  const conversationText = conversationHistory
    .map(msg => `${msg.role === 'user' ? 'Client' : 'Jordan'}: ${msg.content}`)
    .join('\n\n');

  const summary = await generateSummary(conversationHistory);

  await sendEmail(
    `New Lead - ${fromNumber}`,
    `
      <h2>New Lead</h2>
      <p><strong>Client Phone:</strong> ${fromNumber}</p>
      <p><strong>Time:</strong> ${new Date().toLocaleString('en-AU', { timeZone: 'Australia/Melbourne' })}</p>
      <hr>
      <h3>Summary</h3>
      <div style="background:#e8f4e8;padding:15px;border-radius:5px;font-family:sans-serif;font-size:14px;line-height:1.6;">
        ${summary.replace(/\n/g, '<br>')}
      </div>
      <br>
      <h3>Full Conversation Transcript</h3>
      <pre style="background:#f4f4f4;padding:15px;border-radius:5px;font-family:sans-serif;font-size:14px;line-height:1.6;">${conversationText}</pre>
      <hr>
      <p style="color:#888;font-size:12px;">Sent by Stone Real Estate SMS Bot</p>
    `
  );
}

async function sendOptOutEmail(fromNumber) {
  await sendEmail(
    `Opt Out - ${fromNumber}`,
    `
      <h2>Contact Has Opted Out</h2>
      <p><strong>Phone Number:</strong> ${fromNumber}</p>
      <p><strong>Time:</strong> ${new Date().toLocaleString('en-AU', { timeZone: 'Australia/Melbourne' })}</p>
      <hr>
      <p>This contact has requested to stop receiving messages and has been removed from the active conversation list.</p>
      <p style="color:#cc0000;"><strong>Please ensure this number is removed from any future outbound campaigns.</strong></p>
      <hr>
      <p style="color:#888;font-size:12px;">Sent by Stone Real Estate SMS Bot</p>
    `
  );
}

// Single send endpoint — used by Pipedrive automations
app.post('/send', async (req, res) => {
  const { to, name, message } = req.body;

  if (!to || !message) {
    return res.status(400).json({ error: 'to and message are required' });
  }

  // Do not send to opted out numbers
  if (optedOut[to]) {
    console.log(`Skipped opted out number ${to}`);
    return res.json({ success: false, message: `${to} has opted out` });
  }

  try {
    // Pre-load name into conversation if provided
    if (name) {
      conversations[to] = [
        {
          role: 'user',
          content: `My name is ${name}`
        },
        {
          role: 'assistant',
          content: `Hi ${name}, I am Jordan from Stone Real Estate Ballarat.`
        }
      ];
      leadDetected[to] = false;
    }

    // Add to queue instead of sending directly
    sendQueue.push({ to, message });
    processQueue();

    console.log(`Queued message for ${to} (queue length: ${sendQueue.length})`);
    res.json({ success: true, message: `Message queued for ${to}`, queueLength: sendQueue.length });

  } catch (error) {
    console.error('Error queuing message:', error);
    res.status(500).json({ error: 'Failed to queue message' });
  }
});

// Bulk send endpoint — accepts an array of contacts
app.post('/send-bulk', async (req, res) => {
  const { contacts, message } = req.body;

  if (!contacts || !Array.isArray(contacts) || !message) {
    return res.status(400).json({ error: 'contacts array and message are required' });
  }

  let queued = 0;
  let skipped = 0;

  for (const contact of contacts) {
    const { to, name } = contact;

    if (!to) continue;

    // Skip opted out numbers
    if (optedOut[to]) {
      skipped++;
      continue;
    }

    // Pre-load name if provided
    if (name) {
      conversations[to] = [
        {
          role: 'user',
          content: `My name is ${name}`
        },
        {
          role: 'assistant',
          content: `Hi ${name}, I am Jordan from Stone Real Estate Ballarat.`
        }
      ];
      leadDetected[to] = false;
    }

    sendQueue.push({ to, message });
    queued++;
  }

  processQueue();

  console.log(`Bulk send queued: ${queued} messages, ${skipped} skipped`);
  res.json({
    success: true,
    queued: queued,
    skipped: skipped,
    estimatedMinutes: Math.ceil(queued / 50)
  });
});

app.post('/webhook', async (req, res) => {
  const { From, Body } = req.body;
  console.log(`Incoming from ${From}: ${Body}`);

  if (['STOP', 'UNSUBSCRIBE', 'QUIT', 'CANCEL', 'END'].includes(Body.trim().toUpperCase())) {
    optedOut[From] = true;
    delete conversations[From];
    delete leadDetected[From];
    await sendOptOutEmail(From);
    console.log(`Opt out received from ${From}`);
    return res.type('text/xml').send('<Response></Response>');
  }

  if (optedOut[From]) {
    console.log(`Blocked message from opted out number ${From}`);
    return res.type('text/xml').send('<Response></Response>');
  }

  if (!conversations[From]) {
    conversations[From] = [];
    leadDetected[From] = false;
  }

  conversations[From].push({ role: 'user', content: Body });

  if (conversations[From].length > 20) {
    conversations[From] = conversations[From].slice(-20);
  }

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 300,
      system: SYSTEM_PROMPT,
      messages: conversations[From],
    });

    let reply = response.content[0].text;

    if (reply.includes('[INFORMATION SENT]') && !leadDetected[From]) {
      leadDetected[From] = true;
      reply = reply.replace('[INFORMATION SENT]', '').trim();
      await sendLeadEmail(From, conversations[From]);
    }

    conversations[From].push({ role: 'assistant', content: reply });
    console.log(`Reply to ${From}: ${reply}`);

    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(reply);
    res.type('text/xml').send(twiml.toString());

  } catch (error) {
    console.error('Error:', error);
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message("Sorry, having a technical issue right now. Please call us during business hours and we will be happy to help.");
    res.type('text/xml').send(twiml.toString());
  }
});

app.get('/', (req, res) => {
  res.send('Stone Real Estate SMS Bot is running!');
});

app.listen(process.env.PORT || 3000, () => {
  console.log('Bot is running');
});
```

5. Click **"Commit changes"** and confirm

---

## What Has Been Added

There are now two ways to send:

**Single send** — used by Pipedrive automations for individual contacts:
```
POST /send
{ "to": "+61412345678", "name": "Sarah", "message": "Hi Sarah..." }
```

**Bulk send** — used for campaigns to multiple contacts at once:
```
POST /send-bulk
{
  "message": "Hi [First Name], Jordan here from Stone...",
  "contacts": [
    { "to": "+61412345678", "name": "Sarah" },
    { "to": "+61487654321", "name": "James" }
  ]
}

app.listen(process.env.PORT || 3000, () => {
  console.log('Bot is running');
});
