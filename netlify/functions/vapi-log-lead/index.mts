// vapi-log-lead — called by Jennifer mid-call to capture a qualified lead
// Writes to MongoDB + Notion Prospect Queue (with "Hot Lead" status) + Telegram alert
import type { Context, Config } from "@netlify/functions";
import { MongoClient } from "mongodb";

let cachedClient: MongoClient | null = null;
async function getDb() {
  if (!cachedClient) {
    cachedClient = new MongoClient(Netlify.env.get("MONGODB_URL")!);
    await cachedClient.connect();
  }
  return cachedClient.db("frontline");
}

async function pushToNotionProspectQueue(lead: any) {
  const notionKey = Netlify.env.get("NOTION_API_KEY");
  // Prospect Queue DB — where all outreach and inbound leads live
  const dbId = "32d9954a12c2815187a5f47e3a1b65de";
  if (!notionKey) return;

  // Map vertical to existing Notion select options
  const verticalMap: Record<string, string> = {
    "HVAC": "HVAC/Plumbing/Electrical",
    "Plumbing": "HVAC/Plumbing/Electrical",
    "Electrical": "HVAC/Plumbing/Electrical",
    "HVAC/Plumbing/Electrical": "HVAC/Plumbing/Electrical",
    "Dental": "Dental",
    "Law": "Legal",
    "Legal": "Legal",
    "Real Estate": "Real Estate",
    "Roofing": "Home Services",
    "Home Services": "Home Services",
    "Construction": "Construction GC",
    "Construction GC": "Construction GC",
  };
  const notionVertical = verticalMap[lead.vertical] ?? "Home Services";

  const props: any = {
    "Prospect Name": { title: [{ text: { content: lead.callerName ?? "Unknown" } }] },
    "Status": { select: { name: "Replied" } }, // "Replied" = they engaged — closest fit for inbound
    "Source": { select: { name: "Referral" } }, // Closest to "inbound call"
    "Notes": {
      rich_text: [{
        text: {
          content: `🔥 HOT LEAD — Called Jennifer directly\n${lead.urgency ? `Urgency: ${lead.urgency}\n` : ""}${lead.notes ?? ""}`
        }
      }]
    },
    ...(lead.callerPhone ? { "Phone": { phone_number: lead.callerPhone } } : {}),
    ...(lead.callerEmail ? { "Email": { email: lead.callerEmail } } : {}),
    ...(lead.businessName ? { "Business Name": { rich_text: [{ text: { content: lead.businessName } }] } } : {}),
    ...(lead.vertical ? { "Vertical": { select: { name: notionVertical } } } : {}),
    "Region": { select: { name: "US-South" } }, // Default for Nashville area
  };

  try {
    const r = await fetch("https://api.notion.com/v1/pages", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${notionKey}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ parent: { database_id: dbId }, properties: props }),
    });
    if (!r.ok) {
      const err = await r.text();
      console.error("Notion push failed:", err);
    } else {
      console.log("Lead pushed to Notion Prospect Queue");
    }
  } catch (err: any) {
    console.error("Notion push error:", err.message);
  }
}

async function sendTelegramLead(lead: any) {
  const botToken = Netlify.env.get("TELEGRAM_BOT_TOKEN");
  const chatId = Netlify.env.get("TELEGRAM_CHAT_ID") ?? "8184023814";
  if (!botToken) return;

  const urgencyEmoji = lead.urgency === "high" ? "🔴" : lead.urgency === "medium" ? "🟡" : "🟢";
  const text = `${urgencyEmoji} *Hot lead — Jennifer captured*\n\n` +
    `Name: ${lead.callerName ?? "Unknown"}\n` +
    `Phone: ${lead.callerPhone ?? "Unknown"}\n` +
    (lead.callerEmail ? `Email: ${lead.callerEmail}\n` : "") +
    (lead.vertical ? `Vertical: ${lead.vertical}\n` : "") +
    (lead.businessName ? `Business: ${lead.businessName}\n` : "") +
    `Urgency: ${lead.urgency ?? "medium"}\n` +
    (lead.notes ? `\nNotes: ${lead.notes}` : "");

  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
    });
  } catch (err: any) {
    console.error("Telegram lead alert failed:", err.message);
  }
}

export default async (req: Request, context: Context) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  let body: any;
  try { body = await req.json(); } catch { return new Response("Invalid JSON", { status: 400 }); }

  // Vapi sends tool call args here
  const args = body?.message?.toolCalls?.[0]?.function?.arguments ?? body;

  const {
    callerName,
    callerPhone,
    callerEmail,
    businessName,
    vertical,
    urgency,
    notes,
    followUpNeeded,
  } = args ?? {};

  if (!callerPhone && !callerName) {
    return new Response(JSON.stringify({
      result: "Can you give me a name and the best number to reach you at?"
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }

  const lead = {
    callerName: callerName ?? "Unknown",
    callerPhone: callerPhone ?? "Unknown",
    callerEmail: callerEmail ?? null,
    businessName: businessName ?? null,
    vertical: vertical ?? null,
    urgency: urgency ?? "medium",
    notes: notes ?? null,
    followUpNeeded: followUpNeeded ?? true,
    status: "hot_lead",
    source: "jennifer_inbound",
    createdAt: new Date(),
  };

  try {
    const db = await getDb();
    const result = await db.collection("leads").insertOne(lead);
    console.log(`Lead logged: ${result.insertedId} | ${callerName} | ${vertical} | ${urgency}`);

    // Push to Notion + Telegram in parallel
    await Promise.allSettled([
      pushToNotionProspectQueue(lead),
      sendTelegramLead(lead),
    ]);

    const response = followUpNeeded !== false
      ? `Perfect — I've got all your information. Someone will reach out to you at ${callerPhone ?? "the number you gave me"} shortly. Is there anything else before we hang up?`
      : `Got it — all noted. Is there anything else I can help with?`;

    return new Response(JSON.stringify({ result: response }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });

  } catch (err: any) {
    console.error("Lead log error:", err.message);
    return new Response(JSON.stringify({
      result: "I've got your information and someone will be in touch. Anything else I can help with?"
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
};

export const config: Config = { path: "/api/vapi/log-lead" };
