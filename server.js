const express = require('express');
const alexBot = require('./alex');
const jordanPersonal = require('./jordan-personal');
const twilio = require('twilio');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const conversations = {};
const leadDetected = {};
const emailDetected = {};
const optedOut = {};
const sendQueue = [];
let isSendingQueue = false;

const SYSTEM_PROMPT = "You are Jordan, a friendly local assistant for Stone Real Estate Ballarat. ABOUT US: Agency: Stone Real Estate Ballarat. Address: 44 Armstrong St South, Ballarat Central (corner of Dana St). Website: https://www.stonerealestate.com.au/stone-ballarat/. Hours: Monday to Friday, 9am to 5pm AEST (closed public holidays). YOUR PERSONALITY: You are warm, natural and straightforward - like a helpful person at the front desk. You do not use filler phrases like: Great question, Absolutely, Certainly, Of course, No worries, Happy to help, That is a great point. Just respond naturally and get to the point. Never be robotic but never be over the top either. INTRODUCTION: If you already know the persons name from the conversation context, use it naturally. If you do not know their name yet, introduce yourself and ask how you can help. Say something like: Hi there, I am Jordan from Stone Real Estate Ballarat. What can I help you with? STEP 1 - FIND OUT WHY THEY ARE CONTACTING US: Find out if they are: Looking to SELL a property. Looking to BUY a property. Looking to RENT a property. A current landlord or tenant with a PROPERTY MANAGEMENT enquiry. Something else. STEP 2 - CAPTURE THEIR DETAILS: Once you know their reason, collect the following naturally through conversation: Their first name if you do not already know it. Their mobile number - let them know you already have the number they are texting from and check if that is the best one to use. The property address their enquiry relates to. Collect these one or two at a time and keep it conversational - do not fire all questions at once and do not make it feel like a form. STEP 3 - WRAP UP: Once you have successfully collected the persons first name, mobile number and property address, wrap up naturally. Say something like: Thanks for that. I will pass this on to the team and someone will be in touch during business hours, Mon to Fri 9am to 5pm. Anything else before I do? Then once they confirm or say nothing else, on a completely new line add exactly: [INFORMATION SENT]. This tag must never be visible to the client. WHEN SOMEONE IS NOT READY TO SELL OR BUY: If someone indicates they are not ready to sell, buy or rent right now, do not end the conversation. Instead pivot naturally and say something like: That is completely fine - no rush at all. We do send out regular Ballarat property market updates to people in the area if that is something you would find useful? It is free and you can unsubscribe any time. If they say yes to receiving updates: Ask for their email address to add them to the list. Once you have their email say something like: Perfect, I will get that set up for you. Stu or one of the team will be in touch if anything relevant comes up in your area. Then on a completely new line add exactly: [REQUEST RECEIVED]. This tag must never be visible to the client. If they say no to receiving updates: Respect their decision warmly and say something like: No problem at all. Feel free to reach out any time if things change. Have a great day. HANDLING SPECIFIC QUESTIONS: If they ask about FEES or COMMISSION say something like: Fees depend on a few things specific to your property - best to chat with one of our agents directly. Want me to get someone to give you a call? If they ask HOW MUCH IS MY PROPERTY WORTH say something like: Hard to say without knowing the specifics - a free appraisal with one of our agents is the best way to get a real picture. Want me to arrange that? If they ask about PROPERTIES FOR SALE direct them to https://www.stonerealestate.com.au/stone-ballarat/ and offer to connect them with an agent if they have questions about something specific. If they ask AFTER HOURS questions let them know the office is open Mon to Fri 9am to 5pm and that someone will follow up. RULES: Keep every reply SHORT - this is SMS, 1 to 3 sentences maximum. Never use exclamation marks unless the situation genuinely calls for it. Never quote specific fees, commissions or property valuations. Never make promises about timeframes or outcomes. If you genuinely cannot help say something like: I will make sure the right person gets back to you on that one. Never mention that you are an AI unless directly asked.";

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
      console.log('Queued message sent to ' + job.to + ' (' + sendQueue.length + ' remaining)');
    } catch (error) {
      console.error('Failed to send to ' + job.to + ': ' + error.message);
    }
    await new Promise(resolve => setTimeout(resolve, 1200));
  }
  isSendingQueue = false;
  console.log('Send queue complete');
}

async function generateSummary(conversationHistory) {
  const conversationText = conversationHistory
    .map(function(msg) {
      return (msg.role === 'user' ? 'Client' : 'Jordan') + ': ' + msg.content;
    })
    .join('\n\n');

  const summaryResponse = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 300,
    system: 'You are a helpful assistant that summarises real estate enquiry conversations into a brief professional summary for an agent. Extract and clearly list: the clients name, their mobile number, the property address, the type of enquiry (selling, buying, renting, property management or other), and any other relevant details mentioned. Keep it concise and easy to scan. Use plain text with no markdown.',
    messages: [
      {
        role: 'user',
        content: 'Please summarise this SMS conversation:\n\n' + conversationText
      }
    ]
  });

  return summaryResponse.content[0].text;
}

async function sendEmail(subject, htmlContent) {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + process.env.RESEND_API_KEY,
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
    console.log('Email sent: ' + subject);
  } else {
    console.error('Failed to send email:', await response.text());
  }
}

async function sendLeadEmail(fromNumber, conversationHistory) {
  const conversationText = conversationHistory
    .map(function(msg) {
      return (msg.role === 'user' ? 'Client' : 'Jordan') + ': ' + msg.content;
    })
    .join('\n\n');

  const summary = await generateSummary(conversationHistory);

  await sendEmail(
    'New Lead - ' + fromNumber,
    '<h2>New Lead</h2>' +
    '<p><strong>Client Phone:</strong> ' + fromNumber + '</p>' +
    '<p><strong>Time:</strong> ' + new Date().toLocaleString('en-AU', { timeZone: 'Australia/Melbourne' }) + '</p>' +
    '<hr>' +
    '<h3>Summary</h3>' +
    '<div style="background:#e8f4e8;padding:15px;border-radius:5px;font-family:sans-serif;font-size:14px;line-height:1.6;">' + summary.replace(/\n/g, '<br>') + '</div>' +
    '<br>' +
    '<h3>Full Conversation Transcript</h3>' +
    '<pre style="background:#f4f4f4;padding:15px;border-radius:5px;font-family:sans-serif;font-size:14px;line-height:1.6;">' + conversationText + '</pre>' +
    '<hr>' +
    '<p style="color:#888;font-size:12px;">Sent by Stone Real Estate SMS Bot</p>'
  );
}

async function sendEmailCapturedNotification(fromNumber, conversationHistory) {
  const conversationText = conversationHistory
    .map(function(msg) {
      return (msg.role === 'user' ? 'Client' : 'Jordan') + ': ' + msg.content;
    })
    .join('\n\n');

  const emailMatch = conversationText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  const capturedEmail = emailMatch ? emailMatch[0] : 'Not found in transcript';

  await sendEmail(
    'New Property Update Subscriber - ' + fromNumber,
    '<h2>New Property Update Subscriber</h2>' +
    '<p><strong>Client Phone:</strong> ' + fromNumber + '</p>' +
    '<p><strong>Email Address:</strong> ' + capturedEmail + '</p>' +
    '<p><strong>Time:</strong> ' + new Date().toLocaleString('en-AU', { timeZone: 'Australia/Melbourne' }) + '</p>' +
    '<hr>' +
    '<p>This contact has requested to receive Ballarat property market updates. Please add them to your email marketing list.</p>' +
    '<hr>' +
    '<h3>Full Conversation Transcript</h3>' +
    '<pre style="background:#f4f4f4;padding:15px;border-radius:5px;font-family:sans-serif;font-size:14px;line-height:1.6;">' + conversationText + '</pre>' +
    '<hr>' +
    '<p style="color:#888;font-size:12px;">Sent by Stone Real Estate SMS Bot</p>'
  );
}

async function sendOptOutEmail(fromNumber) {
  await sendEmail(
    'Opt Out - ' + fromNumber,
    '<h2>Contact Has Opted Out</h2>' +
    '<p><strong>Phone Number:</strong> ' + fromNumber + '</p>' +
    '<p><strong>Time:</strong> ' + new Date().toLocaleString('en-AU', { timeZone: 'Australia/Melbourne' }) + '</p>' +
    '<hr>' +
    '<p>This contact has requested to stop receiving messages and has been removed from the active conversation list.</p>' +
    '<p style="color:#cc0000;"><strong>Please ensure this number is removed from any future outbound campaigns.</strong></p>' +
    '<hr>' +
    '<p style="color:#888;font-size:12px;">Sent by Stone Real Estate SMS Bot</p>'
  );
}

app.post('/send', async function(req, res) {
  const rawName = req.body.name || req.body['First Name'] || req.body.first_name || '';
  const name = rawName.trim().split(/\s+/)[0];
  const to = req.body.to || req.body.To;
  const message = req.body.message || req.body.Message;

  if (!to || !message) {
    return res.status(400).json({ error: 'to and message are required' });
  }

  if (optedOut[to]) {
    console.log('Skipped opted out number ' + to);
    return res.json({ success: false, message: to + ' has opted out' });
  }

  if (name) {
    conversations[to] = [
      { role: 'user', content: 'My name is ' + name },
      { role: 'assistant', content: 'Hi ' + name + ', I am Jordan from Stone Real Estate Ballarat.' }
    ];
    leadDetected[to] = false;
    emailDetected[to] = false;
  }

  sendQueue.push({ to: to, message: message });
  processQueue();

  console.log('Queued message for ' + to + ' (queue length: ' + sendQueue.length + ')');
  res.json({ success: true, message: 'Message queued for ' + to, queueLength: sendQueue.length });
});

app.post('/send-bulk', async function(req, res) {
  const contacts = req.body.contacts;
  const message = req.body.message;

  if (!contacts || !Array.isArray(contacts) || !message) {
    return res.status(400).json({ error: 'contacts array and message are required' });
  }

  let queued = 0;
  let skipped = 0;

  for (let i = 0; i < contacts.length; i++) {
    const contact = contacts[i];
    const to = contact.to || contact.To;
    const rawName = contact.name || contact['First Name'] || contact.first_name || '';
    const name = rawName.trim().split(/\s+/)[0];

    if (!to) continue;

    if (optedOut[to]) {
      skipped++;
      continue;
    }

    if (name) {
      conversations[to] = [
        { role: 'user', content: 'My name is ' + name },
        { role: 'assistant', content: 'Hi ' + name + ', I am Jordan from Stone Real Estate Ballarat.' }
      ];
      leadDetected[to] = false;
      emailDetected[to] = false;
    }

    sendQueue.push({ to: to, message: message });
    queued++;
  }

  processQueue();

  console.log('Bulk send queued: ' + queued + ' messages, ' + skipped + ' skipped');
  res.json({
    success: true,
    queued: queued,
    skipped: skipped,
    estimatedMinutes: Math.ceil(queued / 50)
  });
});

app.post('/webhook', async function(req, res) {
  const From = req.body.From;
  const Body = req.body.Body;
  console.log('Incoming from ' + From + ': ' + Body);

  const cleanFrom = From.replace(/\s/g, '');
  const delegated = jordanPersonal.getDelegatedConversations();
const trustedContact = jordanPersonal.getTrustedContact(From);

if (delegated && delegated[cleanFrom]) {
  console.log('Delegated reply received from ' + From);
  await jordanPersonal.handleDelegatedReply(cleanFrom, Body);
  return res.type('text/xml').send('<Response></Response>');
}

if (trustedContact) {
  console.log('Trusted contact message from ' + trustedContact.name);
  await jordanPersonal.handleTrustedContact(From, Body, trustedContact);
  return res.type('text/xml').send('<Response></Response>');
}

  if (['STOP', 'UNSUBSCRIBE', 'QUIT', 'CANCEL', 'END'].includes(Body.trim().toUpperCase())) {
    optedOut[From] = true;
    delete conversations[From];
    delete leadDetected[From];
    delete emailDetected[From];
    await sendOptOutEmail(From);
    console.log('Opt out received from ' + From);
    return res.type('text/xml').send('<Response></Response>');
  }

  if (optedOut[From]) {
    console.log('Blocked message from opted out number ' + From);
    return res.type('text/xml').send('<Response></Response>');
  }

  if (!conversations[From]) {
    conversations[From] = [];
    leadDetected[From] = false;
    emailDetected[From] = false;
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
      messages: conversations[From]
    });

    let reply = response.content[0].text;

    if (reply.includes('[INFORMATION SENT]') && !leadDetected[From]) {
      leadDetected[From] = true;
      reply = reply.replace('[INFORMATION SENT]', '').trim();
      await sendLeadEmail(From, conversations[From]);
    }

    if (reply.includes('[REQUEST RECEIVED]') && !emailDetected[From]) {
      emailDetected[From] = true;
      reply = reply.replace('[REQUEST RECEIVED]', '').trim();
      await sendEmailCapturedNotification(From, conversations[From]);
    }

    conversations[From].push({ role: 'assistant', content: reply });
    console.log('Reply to ' + From + ': ' + reply);

    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(reply);
    res.type('text/xml').send(twiml.toString());

  } catch (error) {
    console.error('Error:', error);
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message('Sorry, having a technical issue right now. Please call us during business hours and we will be happy to help.');
    res.type('text/xml').send(twiml.toString());
  }
});

alexBot(app);
jordanPersonal(app);

app.get('/', function(req, res) {
  res.send('Stone Real Estate SMS Bot is running!');
});

app.get('/send', function(req, res) {
  res.send('Send endpoint is ready!');
});

app.get('/text-alex', function(req, res) {
  res.redirect('sms:+61483949906?body=Hi');
});

app.listen(process.env.PORT || 3000, function() {
  console.log('Bot is running');
});
