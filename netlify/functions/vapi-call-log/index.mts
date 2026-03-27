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

export default async (req: Request, context: Context) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const msgType = body?.message?.type;

  // Only process end-of-call reports
  if (msgType !== "end-of-call-report") {
    return new Response(JSON.stringify({ received: true, processed: false, reason: "not end-of-call-report" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  const msg = body.message;
  const call = msg.call ?? {};
  const phoneNumber = call.customer?.number ?? call.phoneNumber?.number ?? "unknown";

  const record = {
    // Identity
    callId: call.id ?? null,
    assistantId: call.assistantId ?? null,

    // Caller info
    callerNumber: phoneNumber,
    callerName: call.customer?.name ?? null,

    // Timing
    startedAt: call.startedAt ? new Date(call.startedAt) : null,
    endedAt: call.endedAt ? new Date(call.endedAt) : null,
    durationSeconds: msg.durationSeconds ?? null,

    // Outcome
    endedReason: msg.endedReason ?? null,
    status: call.status ?? null,

    // Content
    summary: msg.summary ?? null,
    transcript: msg.transcript ?? null,
    recordingUrl: msg.recordingUrl ?? null,

    // Cost
    cost: msg.cost ?? null,
    costBreakdown: msg.costBreakdown ?? null,

    // Meta
    createdAt: new Date(),
    source: "vapi",
  };

  try {
    const db = await getDb();
    const result = await db.collection("calls").insertOne(record);
    console.log(`Call logged: ${result.insertedId} | ${phoneNumber} | ${msg.endedReason}`);

    return new Response(
      JSON.stringify({ success: true, id: result.insertedId, callId: record.callId }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    console.error("MongoDB write error:", err.message);
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};

export const config: Config = {
  path: "/api/vapi/call-log",
};
