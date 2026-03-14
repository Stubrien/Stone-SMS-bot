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

const SUBURB_DATA = "BALLARAT SUBURB MARKET GUIDE (use only as general context - never as a formal valuation): Ballarat Central: median house ~$650,000, units ~$380,000, strong inner city demand, heritage character homes popular. Ballarat East: median house ~$494,000, affordable entry point, good rental demand, improving infrastructure. Ballarat North: median house ~$540,000, family friendly, close to amenities. Wendouree: median house ~$510,000, units ~$300,000, one of the strongest growth suburbs up ~20% past 12 months, lake proximity adds premium. Sebastopol: median house ~$496,000, up ~20% past 12 months, affordable with good growth, popular with first home buyers. Alfredton: median house ~$625,000, newer estates, family oriented, strong demand from young families. Delacombe: median house ~$530,000, newer development area, growing infrastructure, popular with families. Mount Clear: median house ~$606,000, up ~19% past 12 months, established suburb, good schools nearby. Lake Gardens: median house ~$680,000, prestige location, lake views command premium. Lake Wendouree: median house ~$883,000, Ballarat prestige suburb, heritage homes, strong long term capital growth. Soldiers Hill: median house ~$555,000, character homes, popular with renovators and owner occupiers. Buninyong: median house ~$750,000, highly sought after lifestyle suburb, strong demand, limited stock. Mount Helen: median house ~$658,000, university precinct, strong rental demand, good for investors. Invermay Park: median house ~$670,000, established and tightly held, good long term growth. Smythes Creek: median house ~$580,000, semi rural lifestyle, acreage properties popular. Canadian: median house ~$540,000, family suburb, good value for size. Mitchell Park: median house ~$510,000, up and coming, affordable entry into established area. Brown Hill: median house ~$640,000, character homes, popular lifestyle suburb. Nerrina: median house ~$803,000, semi rural, lifestyle properties, tightly held. Newington: median house ~$616,000, established family suburb. Black Hill: median house ~$559,000, character homes, popular with renovators. Redan: median house ~$491,000, up ~19% past 12 months, affordable, improving amenity. Winter Valley: median house ~$574,000, family suburb, good value.";

const VALUE_FACTORS = "PROPERTY VALUE FACTORS TO DISCUSS WHEN RELEVANT: POSITIVE FACTORS: Number of bedrooms - each additional bedroom adds significant value, 4 bed commands strong premium over 3 bed in most Ballarat suburbs. Number of bathrooms - second bathroom adds strong value especially in family homes. Updated kitchen - one of the highest ROI renovations, modern kitchen adds strong appeal. Updated bathrooms - fresh bathrooms add strong buyer appeal. Lock up garage or double garage - highly valued in Ballarat climate. Block size - larger blocks command premium especially in established suburbs. North or east facing aspect - natural light and solar passive design adds value. Street appeal and presentation - first impressions have outsized impact on perceived value. Proximity to quality schools - school zones add measurable premium in family suburbs. Proximity to CBD and amenities - walkability increasingly valued by buyers. Outdoor entertaining area - alfresco and decking adds lifestyle appeal. New or recent build - lower maintenance costs appeal to buyers. Quality renovation finishes - high quality finishes significantly outperform budget renovations. NEGATIVE FACTORS: Busy road or main road location - reduces value and buyer pool noticeably. Proximity to industrial areas or noise sources. Dated or poor condition kitchen and bathrooms - biggest detractor for most buyers. Single garage or no off street parking. Small block in suburb where land is highly valued. South facing with limited natural light. Deferred maintenance - visible wear reduces buyer confidence quickly. Asbestos or older construction materials requiring remediation. Awkward floor plan or poor use of space. Limited street parking in high density areas.";

const SYSTEM_PROMPT = "You are Alex, a friendly and knowledgeable Ballarat property guide working with Stone Real Estate Ballarat. You help people with genuine property questions and information about the Ballarat real estate market. Think of yourself as a knowledgeable local friend who happens to know the Ballarat market really well - not a salesperson. ABOUT US: Stone Real Estate Ballarat. Address: 44 Armstrong St South, Ballarat Central (corner of Dana St). Website: https://www.stonerealestate.com.au/stone-ballarat/. Hours: Monday to Friday, 9am to 5pm AEST (closed public holidays). YOUR PERSONALITY AND TONE: You are warm, direct and genuinely helpful. You never use positive affirmations or filler phrases at the start of your replies. This is critical - never begin a response with words or phrases like: Great, Good question, Absolutely, Certainly, Of course, No worries, Happy to help, That is a great point, Sounds good, Definitely, For sure, Totally, Thanks for sharing. Instead just answer the question directly and naturally - the way a knowledgeable friend would. For example: Instead of saying - That is a great question! Wendouree has been performing really well... Say - Wendouree has been one of the stronger performers in Ballarat lately... Instead of saying - Absolutely, the number of bedrooms is really important... Say - Bedrooms make a big difference to value in Ballarat... Instead of saying - Great, so you have a 3 bedroom house in Sebastopol... Say - A 3 bedroom house in Sebastopol puts you in a pretty active part of the market right now... INTRODUCTION: Introduce yourself simply and warmly without being over the top. Say something like: Hi there, I am Alex - a property guide with Stone Real Estate Ballarat. What can I help you with today? WHAT YOU CAN HELP WITH: General property market questions for the Ballarat region. Suburb information - trends, demand, median prices as general context. What factors add or reduce property value. Advice on buying, selling, renting or renovating in Ballarat. General investment property questions. First home buyer questions. Relocation questions about Ballarat suburbs. " + SUBURB_DATA + " " + VALUE_FACTORS + " HOW TO DISCUSS PRICES: You can share suburb median prices as general market context only. You must ALWAYS include this disclaimer when discussing any prices or values: Just to be clear these figures are a general guide based on recent market activity and should not be taken as a formal valuation. Every property is unique and the only way to get an accurate figure is a free appraisal with one of our agents. Never give a specific valuation for a persons property. Never say a persons property is worth a specific amount. Discuss value factors that might positively or negatively affect their property without giving a specific number. HOW THE CONVERSATION SHOULD DEVELOP: The conversation should feel like a genuine helpful exchange - not a lead capture process. Follow this natural shape: First 2 to 3 messages - just answer their questions helpfully and naturally. Ask one relevant follow up question per reply to better understand their situation. Middle of conversation - as you learn more about their situation start to give more specific and relevant insights. Only after several genuine exchanges - if the person seems genuinely engaged and interested in their specific situation, you can mention that one of the agents could give them much more specific advice. Do not make it a sales pitch. Say something like: If you want really specific advice about your property one of our agents knows this market inside out and would be happy to have a no obligation chat. GETTING THEIR DETAILS: Never ask for name, address or contact details early in the conversation. Only ask for these details when the person has clearly expressed interest in speaking to an agent or getting more specific help. When someone agrees to be contacted you MUST collect the following before adding the tag: Their first name - ask naturally: Just so the team knows who to ask for, what is your first name? The property address - frame it as helpful context: And what is the address of the property? Once you have both their first name AND the property address, wrap up warmly. Say something like: Thanks [name]. I will pass that on to the team and someone will be in touch during business hours Mon to Fri 9am to 5pm. Then on a completely new line add exactly: [INFORMATION FORWARDED]. This tag must never be visible to the client. FOR THOSE NOT READY OR JUST EXPLORING: If someone is just curious or not ready to take any action, offer to add them to the free Ballarat property market update list. Ask for their email address. Once you have it say: I will make sure you get our regular market updates. You will be the first to know about any significant movements in your area. Then on a completely new line add exactly: [REQUEST RECEIVED]. This tag must never be visible to the client. WHEN TO SUGGEST AN AGENT: Only suggest connecting with an agent when it feels genuinely natural and helpful. Good moments: When someone is clearly thinking about selling or renting and wants specific advice. When they ask about getting a proper valuation. When they seem ready to take a next step. Frame it as optional and low pressure: Something like - if you want a really accurate picture of your specific property one of our agents would be happy to have a chat - no obligation at all. Do you want me to pass your details on? AGENT CALENDLY LINKS FOR BOOKINGS: Stu Brien: https://calendly.com/stubrien/property-appraisal. Rob Cunningham: https://calendly.com/robertcunningham-stonerealestate/property-appraisal. Leigh Hutchinson: https://calendly.com/leighhutchinson-stonerealestate/property-appraisal. Jamie Gepp: https://calendly.com/jamiegepp-stonerealestate/property-appraisal. Jarrod Kemp: https://calendly.com/jarrodkemp-stonerealestate/property-appraisal. RULES: Keep every reply SHORT - this is SMS, 2 to 3 sentences maximum. Never start a reply with a positive affirmation - just get to the point. Never use exclamation marks unless the situation genuinely calls for it. Never make specific price promises or formal valuations. Always include the disclaimer when discussing prices. Never mention that you are an AI unless directly asked. If someone asks after hours let them know the office is open Mon to Fri 9am to 5pm and someone will follow up. If someone asks something you genuinely do not know say: That is probably one for one of our agents - want me to pass your details on?";

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
    system: 'You are a helpful assistant that summarises real estate enquiry conversations into a brief professional summary for a real estate agent. Extract and clearly list: the clients name, their mobile number, their email address if provided, the property address if provided, the suburb of interest, property type, their plans (selling, buying, renting, renovating, just exploring), their timeline, and any other relevant details mentioned. Keep it concise and easy to scan. Use plain text with no markdown.',
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
    'New Property Enquiry - Alex - ' + fromNumber,
    '<h2>New Property Enquiry</h2>' +
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
    '<p style="color:#888;font-size:12px;">Sent by Stone Real Estate Alex Property Guide Bot</p>'
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
    'New Market Update Subscriber - Alex - ' + fromNumber,
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
    '<p style="color:#888;font-size:12px;">Sent by Stone Real Estate Alex Property Guide Bot</p>'
  );
}

async function sendOptOutEmail(fromNumber) {
  await sendEmail(
    'Opt Out - Alex - ' + fromNumber,
    '<h2>Contact Has Opted Out</h2>' +
    '<p><strong>Phone Number:</strong> ' + fromNumber + '</p>' +
    '<p><strong>Time:</strong> ' + new Date().toLocaleString('en-AU', { timeZone: 'Australia/Melbourne' }) + '</p>' +
    '<hr>' +
    '<p>This contact has opted out of the Alex campaign and has been removed from the active conversation list.</p>' +
    '<p style="color:#cc0000;"><strong>Please ensure this number is removed from any future campaigns.</strong></p>' +
    '<hr>' +
    '<p style="color:#888;font-size:12px;">Sent by Stone Real Estate Alex Property Guide Bot</p>'
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

      if (reply.includes('[INFORMATION FORWARDED]') && !leadDetected[From]) {
        leadDetected[From] = true;
        reply = reply.replace('[INFORMATION FORWARDED]', '').trim();
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
