import type { Context, Config } from "@netlify/functions";
import { MongoClient } from "mongodb";
import twilio from "twilio";

let cachedClient: MongoClient | null = null;

async function getDb() {
  if (!cachedClient) {
    cachedClient = new MongoClient(Netlify.env.get("MONGODB_URL")!);
    await cachedClient.connect();
  }
  return cachedClient.db("frontline");
}

function verifyVapiSecret(req: Request): boolean {
  const secret = Netlify.env.get("VAPI_SERVER_SECRET");
  if (!secret) return true;
  const incoming = req.headers.get("x-vapi-secret");
  return incoming === secret;
}

async function sendPostCallSMS(callerNumber: string, businessName: string) {
  const accountSid = Netlify.env.get("TWILIO_ACCOUNT_SID");
  const authToken = Netlify.env.get("TWILIO_AUTH_TOKEN");
  const fromNumber = Netlify.env.get("TWILIO_FROM_NUMBER") ?? "+16159562344";
  if (!accountSid || !authToken) return;
  if (!callerNumber || callerNumber === "unknown" || !callerNumber.startsWith("+1")) return;
  const client = twilio(accountSid, authToken);
  const body = `Thanks for calling ${businessName || "us"} — we got your message and will be in touch shortly. Reply STOP to opt out.`;
  try {
    const msg = await client.messages.create({ body, from: fromNumber, to: callerNumber });
    console.log(`Post-call SMS sent: ${msg.sid}`);
  } catch (err: any) {
    console.error(`Post-call SMS failed:`, err.message);
  }
}

async function sendTelegramAlert(summary: string, callerNumber: string, durationSeconds: number) {
  const botToken = Netlify.env.get("TELEGRAM_BOT_TOKEN");
  const chatId = Netlify.env.get("TELEGRAM_CHAT_ID") ?? "8184023814";
  if (!botToken) return;
  const duration = durationSeconds ? `${Math.round(durationSeconds)}s` : "?";
  const text = `📞 *Jennifer call ended*\n\nCaller: ${callerNumber}\nDuration: ${duration}\n\n${summary ?? "No summary"}`;
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
    });
  } catch (err: any) {
    console.error("Telegram alert failed:", err.message);
  }
}

export default async (req: Request, context: Context) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (!verifyVapiSecret(req)) return new Response("Unauthorized", { status: 401 });

  let body: any;
  try { body = await req.json(); } catch { return new Response("Invalid JSON", { status: 400 }); }

  const msgType = body?.message?.type;
  if (msgType !== "end-of-call-report") {
    return new Response(JSON.stringify({ received: true, processed: false }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }

  const msg = body.message;
  const call = msg.call ?? {};
  const phoneNumber = call.customer?.number ?? call.phoneNumber?.number ?? "unknown";

  const record = {
    callId: call.id ?? null,
    assistantId: call.assistantId ?? null,
    callerNumber: phoneNumber,
    callerName: call.customer?.name ?? null,
    startedAt: call.startedAt ? new Date(call.startedAt) : null,
    endedAt: call.endedAt ? new Date(call.endedAt) : null,
    durationSeconds: msg.durationSeconds ?? null,
    endedReason: msg.endedReason ?? null,
    status: call.status ?? null,
    summary: msg.summary ?? null,
    transcript: msg.transcript ?? null,
    recordingUrl: msg.recordingUrl ?? null,
    toolCallResults: msg.artifact?.toolCallResults ?? null,
    analysis: msg.analysis ?? null,
    cost: msg.cost ?? null,
    costBreakdown: msg.costBreakdown ?? null,
    createdAt: new Date(),
    source: "vapi",
  };

  try {
    const db = await getDb();
    const result = await db.collection("calls").insertOne(record);
    console.log(`Call logged: ${result.insertedId} | ${phoneNumber} | ${msg.endedReason}`);
    await Promise.allSettled([
      sendPostCallSMS(phoneNumber, "Carson Systems"),
      sendTelegramAlert(record.summary, phoneNumber, record.durationSeconds),
    ]);
    return new Response(
      JSON.stringify({ success: true, id: result.insertedId, callId: record.callId }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    console.error("MongoDB error:", err.message);
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }
};

export const config: Config = { path: "/api/vapi/call-log" };
