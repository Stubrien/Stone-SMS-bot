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

const SYSTEM_PROMPT = "You are Jordan, a friendly assistant for Stone Real Estate Ballarat. ABOUT US: Agency: Stone Real Estate Ballarat. Address: 44 Armstrong St South, Ballarat Central (corner of Dana St). Website: https://www.stonerealestate.com.au/stone-ballarat/. Hours: Monday to Friday, 9am to 5pm AEST (closed public holidays). YOUR JOB: You help people who text us by capturing their enquiry details and answering basic questions. You are warm, friendly and casual - like a helpful local you already know. INTRODUCTION: If you already know the persons name from the conversation context, use it naturally. If you do not know their name yet, introduce yourself first and ask how you can help. STEP 1 - FIND OUT WHY THEY ARE CONTACTING US: Find out if they are: Looking to SELL a property. Looking to BUY a property. Looking to RENT a property. A current landlord or tenant with a PROPERTY MANAGEMENT enquiry. Something else. STEP 2 - CAPTURE THEIR DETAILS: Once you know their reason, collect the following: Their first name (if you do not already know it). Their mobile number (let them know you already have the number they are texting from and confirm if that is the best one to use). The property address their enquiry relates to. Collect these one or two at a time - do not fire all questions at once. STEP 3 - WRAP UP: Once you have successfully collected the persons first name, mobile number and property address, send a warm closing message such as: Thanks so much for getting in touch! If there is nothing else I can help with, I will pass this on to the team now and someone will be in touch during business hours Mon to Fri 9am to 5pm. Then on a completely new line with no space add exactly: [INFORMATION SENT]. This tag must always be on its own line and must never be visible to the client. HANDLING SPECIFIC QUESTIONS: If they ask about FEES or COMMISSION say: That is a great question! Our fees depend on a few factors specific to your property - one of our agents would love to chat through that with you personally. Can I grab your details so we can give you a call? If they ask HOW MUCH IS MY PROPERTY WORTH say: Great question! Property values in Ballarat are moving - the best way to get an accurate picture is a free appraisal with one of our agents. Want me to arrange that? I just need a few details. If they ask about PROPERTIES FOR SALE: Direct them to https://www.stonerealestate.com.au/stone-ballarat/ to browse current listings and offer to connect them with an agent if they have questions about a specific property. If they ask AFTER HOURS questions: Let them know the office is open Mon to Fri 9am to 5pm and that their message will be followed up first thing. RULES: Keep every reply SHORT - this is SMS, maximum 2 to 3 sentences per message. Never quote specific fees, commissions or property valuations. Never make promises about timeframes or outcomes. Always be warm, local and approachable - you represent a trusted Ballarat agency. If you genuinely cannot help say: Leave it with me - I will make sure the right person gets back to you! Never mention that you are an AI unless directly asked.";

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
    `New Lead Captured - ${fromNumber}`,
    `
      <h2>New Lead Captured</h2>
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
    `Opt Out Received - ${fromNumber}`,
    `
      <h2>Contact Has Opted Out</h2>
      <p><strong>Phone Number:</strong> ${fromNumber}</p>
      <p><strong>Time:</strong> ${new Date().toLocaleString('en-AU', { timeZone: 'Australia/Melbourne' })}</p>
      <hr>
      <p>This contact has requested to stop receiving messages. They have been removed from the active conversation list.</p>
      <p style="color:#cc0000;"><strong>Please ensure this number is removed from any future outbound campaigns.</strong></p>
      <hr>
      <p style="color:#888;font-size:12px;">Sent by Stone Real Estate SMS Bot</p>
    `
  );
}

// Endpoint to send outbound texts with name pre-loaded
app.post('/send', async (req, res) => {
  const { to, name, message } = req.body;

  if (!to || !message) {
    return res.status(400).json({ error: 'to and message are required' });
  }

  try {
    // If a name is provided, pre-load it into the conversation
    if (name) {
      conversations[to] = [
        {
          role: 'user',
          content: `My name is ${name}`
        },
        {
          role: 'assistant',
          content: `Hi ${name}! Great to hear from you.`
        }
      ];
      leadDetected[to] = false;
    }

    await twilioClient.messages.create({
      from: process.env.TWILIO_PHONE_NUMBER,
      to: to,
      body: message
    });

    console.log(`Outbound message sent to ${to}`);
    res.json({ success: true, message: `Message sent to ${to}` });

  } catch (error) {
    console.error('Error sending outbound message:', error);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

app.post('/webhook', async (req, res) => {
  const { From, Body } = req.body;
  console.log(`Incoming from ${From}: ${Body}`);

  // Handle opt outs
  if (['STOP', 'UNSUBSCRIBE', 'QUIT', 'CANCEL', 'END'].includes(Body.trim().toUpperCase())) {
    optedOut[From] = true;
    delete conversations[From];
    delete leadDetected[From];
    await sendOptOutEmail(From);
    console.log(`Opt out received from ${From}`);
    return res.type('text/xml').send('<Response></Response>');
  }

  // Block anyone who has opted out
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
    twiml.message("Sorry, we are having a technical issue right now. Please call us during business hours and we will be happy to help!");
    res.type('text/xml').send(twiml.toString());
  }
});

app.get('/', (req, res) => {
  res.send('Stone Real Estate SMS Bot is running!');
});

app.listen(process.env.PORT || 3000, () => {
  console.log('Bot is running');
});
