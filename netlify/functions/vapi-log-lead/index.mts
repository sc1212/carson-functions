// vapi-log-lead — called by Jennifer mid-call to capture a qualified lead
// Writes to MongoDB + Notion Prospect Queue + Telegram alert to Samuel
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

async function pushToNotion(lead: any) {
  const notionKey = Netlify.env.get("NOTION_API_KEY");
  // Frontline Clients / Leads DB — same DB as prospect queue
  const dbId = Netlify.env.get("NOTION_LEADS_DB_ID") ?? "32d9954a12c2815187a5f47e3a1b65de";
  if (!notionKey) return;

  const props: any = {
    "Name": { title: [{ text: { content: lead.callerName ?? "Unknown" } }] },
    "Email": lead.callerEmail ? { email: lead.callerEmail } : undefined,
    "Status": { select: { name: "Hot Lead — Called Jennifer" } },
    "Vertical": lead.vertical ? { select: { name: lead.vertical } } : undefined,
    "Notes": lead.notes ? { rich_text: [{ text: { content: lead.notes } }] } : undefined,
  };

  // Remove undefined props
  Object.keys(props).forEach(k => props[k] === undefined && delete props[k]);

  try {
    await fetch("https://api.notion.com/v1/pages", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${notionKey}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ parent: { database_id: dbId }, properties: props }),
    });
  } catch (err: any) {
    console.error("Notion push failed:", err.message);
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
    `Urgency: ${lead.urgency ?? "unknown"}\n` +
    (lead.notes ? `\n${lead.notes}` : "");

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

  const args = body?.message?.toolCalls?.[0]?.function?.arguments ?? body;

  const {
    callerName,
    callerPhone,
    callerEmail,
    businessName,     // their business
    vertical,         // HVAC, Dental, Law, Electrical, Roofing, etc.
    urgency,          // high, medium, low
    notes,            // what they're interested in, pain points, etc.
    followUpNeeded,   // boolean
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
    console.log(`Lead logged: ${result.insertedId} | ${callerName} | ${vertical} | urgency: ${urgency}`);

    // Push to Notion and Telegram in parallel
    await Promise.allSettled([
      pushToNotion(lead),
      sendTelegramLead(lead),
    ]);

    // Jennifer's spoken confirmation
    const response = followUpNeeded !== false
      ? `Perfect — I've got all your information. Someone from our team will reach out to you at ${callerPhone ?? "the number you provided"} shortly. Is there anything else I can help you with before we wrap up?`
      : `Got it — I've noted everything. You're all set. Is there anything else?`;

    return new Response(JSON.stringify({ result: response }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });

  } catch (err: any) {
    console.error("Lead log error:", err.message);
    return new Response(JSON.stringify({
      result: "I've noted your information and someone will be in touch. Anything else I can help with?"
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
};

export const config: Config = { path: "/api/vapi/log-lead" };
