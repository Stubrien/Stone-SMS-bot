const Anthropic = require('@anthropic-ai/sdk');
const twilio = require('twilio');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const conversations = {};
const leadDetected = {};
const bookingDetected = {};
const optedOut = {};
const sendQueue = [];
let isSendingQueue = false;

const AGENT_DATA = {
  stu: {
    name: 'Stu Brien',
    calendly: 'https://calendly.com/stubrien/property-appraisal'
  },
  rob: {
    name: 'Rob Cunningham',
    calendly: 'https://calendly.com/robertcunningham-stonerealestate/property-appraisal'
  },
  leigh: {
    name: 'Leigh Hutchinson',
    calendly: 'https://calendly.com/leighhutchinson-stonerealestate/property-appraisal'
  },
  jamie: {
    name: 'Jamie Gepp',
    calendly: 'https://calendly.com/jamiegepp-stonerealestate/property-appraisal'
  },
  jarrod: {
    name: 'Jarrod Kemp',
    calendly: 'https://calendly.com/jarrodkemp-stonerealestate/property-appraisal'
  }
};

const SUBURB_DATA = "BALLARAT SUBURB PRICE GUIDE (approximate medians - use as a broad guide only and always include disclaimer): Ballarat Central: Houses ~$650,000, Units ~$380,000. Ballarat East: Houses ~$494,000, Units ~$320,000. Ballarat North: Houses ~$540,000. Wendouree: Houses ~$510,000, Units ~$300,000. Sebastopol: Houses ~$496,000. Alfredton: Houses ~$625,000. Delacombe: Houses ~$530,000. Mount Clear: Houses ~$606,000. Lake Gardens: Houses ~$680,000. Lake Wendouree: Houses ~$883,000. Soldiers Hill: Houses ~$555,000. Buninyong: Houses ~$750,000. Mount Helen: Houses ~$658,000. Invermay Park: Houses ~$670,000. Smythes Creek: Houses ~$580,000. Canadian: Houses ~$540,000. Mitchell Park: Houses ~$510,000. Brown Hill: Houses ~$640,000. Nerrina: Houses ~$803,000. Newington: Houses ~$616,000. Black Hill: Houses ~$559,000. Redan: Houses ~$491,000. Winter Valley: Houses ~$574,000.";

const SYSTEM_PROMPT = "You are Alex, a friendly and knowledgeable property assistant for Stone Real Estate Ballarat. You help people understand the value of their property and connect them with one of our experienced agents for a free appraisal. ABOUT US: Stone Real Estate Ballarat. Address: 44 Armstrong St South, Ballarat Central (corner of Dana St). Website: https://www.stonerealestate.com.au/stone-ballarat/. Hours: Monday to Friday, 9am to 5pm AEST (closed public holidays). YOUR PERSONALITY: You are warm, natural, knowledgeable and genuinely helpful. You are not salesy or pushy. You are like a knowledgeable friend who happens to know a lot about the Ballarat property market. You never use filler phrases like: Great question, Absolutely, Certainly, Of course, No worries, Happy to help. Just respond naturally and get to the point. INTRODUCTION: If you already know the persons name use it naturally. If not, introduce yourself warmly. Say something like: Hi there, I am Alex from Stone Real Estate Ballarat. I am here to help you understand what your property could be worth in todays market. To get started, whereabouts in Ballarat is your property? STEP 1 - FIND OUT ABOUT THEIR PROPERTY: Ask about their property naturally and conversationally. Find out: The suburb their property is in. Whether it is a house, unit or townhouse. Number of bedrooms and bathrooms. Whether it has a garage or carport. The general condition - well maintained, recently renovated, needs some work. How long they have owned it. Whether they are thinking of selling or renting. Their approximate timeline - ready now, within 6 months, just exploring. Collect these details naturally over several messages - do not ask everything at once. Show genuine interest in their property. " + SUBURB_DATA + " STEP 2 - PROVIDE A SUBURB ESTIMATE: Once you know the suburb and property type, provide a helpful broad estimate based on the suburb data above. You MUST always include this disclaimer when discussing prices: These figures are a general guide based on recent sales activity in the area and should not be taken as a formal valuation. Every property is unique and your actual value could sit higher or lower depending on its specific features and condition. The only way to get an accurate figure is a free appraisal with one of our agents. Use recent market context to make the conversation engaging. For example mention if the suburb has been performing strongly or if there is good buyer demand in the area. STEP 3 - REFERENCE RECENT MARKET ACTIVITY: When discussing a suburb, mention relevant market context such as: Strong buyer demand in the area. Recent sales activity. Suburbs that have seen strong price growth. How their property features might affect value positively or negatively. STEP 4 - CAPTURE THEIR DETAILS: Once you have discussed their property, collect the following naturally: Their first name if you do not already know it. Their mobile number - confirm the number they are texting from. Their email address. The full property address. Collect these conversationally - do not make it feel like a form. STEP 5 - OFFER AN APPRAISAL: Once details are captured, offer a free appraisal with the relevant agent. Say something like: To get you a really accurate figure I would love to arrange a free no obligation appraisal with [Agent Name] from our team. They know the [suburb] market really well and can give you a proper picture of what your property is worth. You can book a time that suits you here: [Calendly Link]. Then on a completely new line add exactly: [LEAD CAPTURED]. This tag must never be visible to the client. STEP 6 - HANDLE THOSE NOT READY: If someone is just exploring or not ready to commit to an appraisal, offer to add them to our free Ballarat property market update list. Ask for their email address. Once captured say: I will make sure you get our regular market updates for [suburb]. You will be the first to know about any significant movements in your area. Then on a completely new line add exactly: [REQUEST RECEIVED]. This tag must never be visible to the client. AGENT ROUTING: Route to the agent based on who sent the outreach or use Stu Brien as default. Agent Calendly links: Stu Brien: https://calendly.com/stubrien/property-appraisal. Rob Cunningham: https://calendly.com/robertcunningham-stonerealestate/property-appraisal. Leigh Hutchinson: https://calendly.com/leighhutchinson-stonerealestate/property-appraisal. Jamie Gepp: https://calendly.com/jamiegepp-stonerealestate/property-appraisal. Jarrod Kemp: https://calendly.com/jarrodkemp-stonerealestate/property-appraisal. RULES: Keep every reply SHORT - this is SMS, 2 to 3 sentences maximum. Never use exclamation marks unless the situation genuinely calls for it. Never make specific price promises or formal valuations. Always include the disclaimer when discussing prices. Never mention that you are an AI unless directly asked. If someone asks after hours let them know the office is open Mon to Fri 9am to 5pm and someone will follow up.";

async function processQueue() {
  if (isSendingQueue || sendQueue.length === 0) return;
  isSendingQueue = true;
  while (sendQueue.length > 0) {
    const job = sendQueue.shift();
    try {
      await twilioClient.messages.create({
        from: process.env.ALEX_PHONE_NUMBER,
        to: job.to,
        body: job.message
      });
      console.log('Alex queued message sent to ' + job.to + ' (' + sendQueue.length + ' remaining)');
    } catch (error) {
      console.error('Alex failed to send to ' + job.to + ': ' + error.message);
    }
    await new Promise(resolve => setTimeout(resolve, 1200));
  }
  isSendingQueue = false;
  console.log('Alex send queue complete');
}

async function generateSummary(conversationHistory) {
  const conversationText = conversationHistory
    .map(function(msg) {
      return (msg.role === 'user' ? 'Client' : 'Alex') + ': ' + msg.content;
    })
    .join('\n\n');

  const summaryResponse = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 300,
    system: 'You are a helpful assistant that summarises real estate property enquiry conversations into a brief professional summary for an agent. Extract and clearly list: the clients name, their mobile number, their email address, the property address, the suburb, property type, number of bedrooms, condition, selling or renting intention, their timeline, and any other relevant details. Keep it concise and easy to scan. Use plain text with no markdown.',
    messages: [
      {
        role: 'user',
        content: 'Please summarise this property enquiry conversation:\n\n' + conversationText
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
    console.log('Alex email sent: ' + subject);
  } else {
    console.error('Alex failed to send email:', await response.text());
  }
}

async function sendLeadEmail(fromNumber, conversationHistory, agentName) {
  const conversationText = conversationHistory
    .map(function(msg) {
      return (msg.role === 'user' ? 'Client' : 'Alex') + ': ' + msg.content;
    })
    .join('\n\n');

  const summary = await generateSummary(conversationHistory);

  await sendEmail(
    'New Appraisal Lead - ' + fromNumber,
    '<h2>New Appraisal Lead</h2>' +
    '<p><strong>Client Phone:</strong> ' + fromNumber + '</p>' +
    '<p><strong>Assigned Agent:</strong> ' + (agentName || 'Stu Brien') + '</p>' +
    '<p><strong>Time:</strong> ' + new Date().toLocaleString('en-AU', { timeZone: 'Australia/Melbourne' }) + '</p>' +
    '<hr>' +
    '<h3>Summary</h3>' +
    '<div style="background:#e8f4e8;padding:15px;border-radius:5px;font-family:sans-serif;font-size:14px;line-height:1.6;">' + summary.replace(/\n/g, '<br>') + '</div>' +
    '<br>' +
    '<h3>Full Conversation Transcript</h3>' +
    '<pre style="background:#f4f4f4;padding:15px;border-radius:5px;font-family:sans-serif;font-size:14px;line-height:1.6;">' + conversationText + '</pre>' +
    '<hr>' +
    '<p style="color:#888;font-size:12px;">Sent by Stone Real Estate Alex Campaign Bot</p>'
  );
}

async function sendSubscriberEmail(fromNumber, conversationHistory) {
  const conversationText = conversationHistory
    .map(function(msg) {
      return (msg.role === 'user' ? 'Client' : 'Alex') + ': ' + msg.content;
    })
    .join('\n\n');

  const emailMatch = conversationText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  const capturedEmail = emailMatch ? emailMatch[0] : 'Not found in transcript';

  await sendEmail(
    'New Market Update Subscriber - ' + fromNumber,
    '<h2>New Market Update Subscriber</h2>' +
    '<p><strong>Client Phone:</strong> ' + fromNumber + '</p>' +
    '<p><strong>Email Address:</strong> ' + capturedEmail + '</p>' +
    '<p><strong>Time:</strong> ' + new Date().toLocaleString('en-AU', { timeZone: 'Australia/Melbourne' }) + '</p>' +
    '<hr>' +
    '<p>This contact has requested to receive Ballarat property market updates. Please add them to your email marketing list.</p>' +
    '<hr>' +
    '<h3>Full Conversation Transcript</h3>' +
    '<pre style="background:#f4f4f4;padding:15px;border-radius:5px;font-family:sans-serif;font-size:14px;line-height:1.6;">' + conversationText + '</pre>' +
    '<hr>' +
    '<p style="color:#888;font-size:12px;">Sent by Stone Real Estate Alex Campaign Bot</p>'
  );
}

async function sendOptOutEmail(fromNumber) {
  await sendEmail(
    'Opt Out - Alex Campaign - ' + fromNumber,
    '<h2>Contact Has Opted Out</h2>' +
    '<p><strong>Phone Number:</strong> ' + fromNumber + '</p>' +
    '<p><strong>Time:</strong> ' + new Date().toLocaleString('en-AU', { timeZone: 'Australia/Melbourne' }) + '</p>' +
    '<hr>' +
    '<p>This contact has opted out of the Alex campaign and has been removed from the active conversation list.</p>' +
    '<p style="color:#cc0000;"><strong>Please ensure this number is removed from any future campaigns.</strong></p>' +
    '<hr>' +
    '<p style="color:#888;font-size:12px;">Sent by Stone Real Estate Alex Campaign Bot</p>'
  );
}

module.exports = function(app) {

  app.post('/campaign', async function(req, res) {
    const From = req.body.From;
    const Body = req.body.Body;
    console.log('Alex incoming from ' + From + ': ' + Body);

    if (['STOP', 'UNSUBSCRIBE', 'QUIT', 'CANCEL', 'END'].includes(Body.trim().toUpperCase())) {
      optedOut[From] = true;
      delete conversations[From];
      delete leadDetected[From];
      delete bookingDetected[From];
      await sendOptOutEmail(From);
      console.log('Alex opt out received from ' + From);
      return res.type('text/xml').send('<Response></Response>');
    }

    if (optedOut[From]) {
      console.log('Alex blocked message from opted out number ' + From);
      return res.type('text/xml').send('<Response></Response>');
    }

    if (!conversations[From]) {
      conversations[From] = [];
      leadDetected[From] = false;
      bookingDetected[From] = false;
    }

    conversations[From].push({ role: 'user', content: Body });

    if (conversations[From].length > 20) {
      conversations[From] = conversations[From].slice(-20);
    }

    const agentKey = conversations[From].agentKey || 'stu';
    const agentData = AGENT_DATA[agentKey] || AGENT_DATA.stu;

    try {
      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 300,
        system: SYSTEM_PROMPT,
        messages: conversations[From]
      });

      let reply = response.content[0].text;

      if (reply.includes('[LEAD CAPTURED]') && !leadDetected[From]) {
        leadDetected[From] = true;
        reply = reply.replace('[LEAD CAPTURED]', '').trim();
        await sendLeadEmail(From, conversations[From], agentData.name);
      }

      if (reply.includes('[REQUEST RECEIVED]') && !bookingDetected[From]) {
        bookingDetected[From] = true;
        reply = reply.replace('[REQUEST RECEIVED]', '').trim();
        await sendSubscriberEmail(From, conversations[From]);
      }

      conversations[From].push({ role: 'assistant', content: reply });
      console.log('Alex reply to ' + From + ': ' + reply);

      const twiml = new twilio.twiml.MessagingResponse();
      twiml.message(reply);
      res.type('text/xml').send(twiml.toString());

    } catch (error) {
      console.error('Alex error:', error);
      const twiml = new twilio.twiml.MessagingResponse();
      twiml.message('Sorry, having a technical issue right now. Please call us during business hours and we will be happy to help.');
      res.type('text/xml').send(twiml.toString());
    }
  });

  app.post('/campaign-send', async function(req, res) {
    const rawName = req.body.name || req.body['First Name'] || req.body.first_name || '';
    const name = rawName.trim().split(/\s+/)[0];
    const to = req.body.to || req.body.To;
    const message = req.body.message || req.body.Message;
    const agentKey = req.body.agent || 'stu';

    if (!to || !message) {
      return res.status(400).json({ error: 'to and message are required' });
    }

    if (optedOut[to]) {
      console.log('Alex skipped opted out number ' + to);
      return res.json({ success: false, message: to + ' has opted out' });
    }

    conversations[to] = [
      { role: 'user', content: 'My name is ' + (name || 'there') },
      { role: 'assistant', content: message }
    ];
    conversations[to].agentKey = agentKey;
    leadDetected[to] = false;
    bookingDetected[to] = false;

    sendQueue.push({ to: to, message: message });
    processQueue();

    console.log('Alex queued message for ' + to);
    res.json({ success: true, message: 'Message queued for ' + to });
  });

  app.get('/campaign', function(req, res) {
    res.send('Alex campaign endpoint is ready!');
  });

};
