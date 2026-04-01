// vapi-book-appointment — called by Jennifer mid-call via Vapi tool
// Phase 1: Logs booking to MongoDB + SMS notification to client owner
// Phase 2 (TODO): Google Calendar OAuth write when credentials are configured
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

export default async (req: Request, context: Context) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  let body: any;
  try { body = await req.json(); } catch { return new Response("Invalid JSON", { status: 400 }); }

  // Vapi sends tool call params under message.toolCalls[0].function.arguments
  // or directly as the body depending on server URL tool config
  const args = body?.message?.toolCalls?.[0]?.function?.arguments ?? body;

  const {
    callerName,
    callerPhone,
    preferredDate,    // e.g. "Thursday April 3rd"
    preferredTime,    // e.g. "2pm"
    appointmentType,  // e.g. "HVAC estimate", "dental cleaning", "consultation"
    businessName,     // client's business (will come from Jennifer's context)
    notes,
  } = args ?? {};

  if (!callerPhone && !callerName) {
    return new Response(JSON.stringify({
      result: "I need at least a name or phone number to log this appointment request. Can you give me one of those?"
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }

  const booking = {
    callerName: callerName ?? "Unknown",
    callerPhone: callerPhone ?? "Unknown",
    preferredDate: preferredDate ?? "Not specified",
    preferredTime: preferredTime ?? "Not specified",
    appointmentType: appointmentType ?? "General appointment",
    businessName: businessName ?? "Carson Systems",
    notes: notes ?? null,
    status: "pending_confirmation",   // Owner confirms via SMS reply / dashboard
    createdAt: new Date(),
    source: "jennifer_voice",
  };

  try {
    // Write to MongoDB bookings collection
    const db = await getDb();
    const result = await db.collection("bookings").insertOne(booking);
    console.log(`Booking logged: ${result.insertedId} | ${callerName} | ${preferredDate} ${preferredTime}`);

    // SMS notification to business owner — they confirm/decline the slot
    const accountSid = Netlify.env.get("TWILIO_ACCOUNT_SID");
    const authToken = Netlify.env.get("TWILIO_AUTH_TOKEN");
    const fromNumber = Netlify.env.get("TWILIO_FROM_NUMBER") ?? "+16159562344";
    const ownerNumber = Netlify.env.get("OWNER_PHONE") ?? "+16156313790"; // Samuel's number as default

    if (accountSid && authToken) {
      const client = twilio(accountSid, authToken);
      const smsBody = `📅 Booking request — Jennifer\n\n${callerName ?? "Caller"} (${callerPhone ?? "no number"})\nWants: ${appointmentType ?? "appointment"}\nDate/Time: ${preferredDate ?? "?"} at ${preferredTime ?? "?"}\n${notes ? `Notes: ${notes}` : ""}\n\nReply to confirm with the caller.`;
      try {
        await client.messages.create({ body: smsBody, from: fromNumber, to: ownerNumber });
      } catch (err: any) {
        console.error("Booking SMS failed:", err.message);
      }
    }

    // Return Jennifer's spoken response — this is what she says on the call
    const dateTime = [preferredDate, preferredTime].filter(Boolean).join(" at ");
    const response = dateTime
      ? `Got it — I've got you down for ${dateTime}. Someone will confirm that time with you shortly. Is there anything else you need?`
      : `Got it — I've logged your appointment request and someone will reach out to confirm a time. Is there anything else I can help you with?`;

    return new Response(JSON.stringify({ result: response }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });

  } catch (err: any) {
    console.error("Booking error:", err.message);
    // Graceful degradation — Jennifer doesn't tell the caller the system broke
    return new Response(JSON.stringify({
      result: "I've noted your request and someone will follow up with you to confirm. Is there anything else I can help you with?"
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
};

export const config: Config = { path: "/api/vapi/book-appointment" };
