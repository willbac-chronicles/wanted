// Wanted — envoi des notifications web (Web Push).
// Repris de l'ancien dépôt (evasion-urbaine-poitiers), simplifié :
//  - { mode: "public-key" } : renvoie la clé publique VAPID (créée et stockée en base au premier appel) ;
//  - sinon (appel de la base, protégé par x-dispatch-token) : envoie les notifications dues de push_jobs.
// À déployer SANS vérification JWT : la base l'appelle avec son jeton, le front seulement pour la clé publique.
import { createClient } from "jsr:@supabase/supabase-js@2";

// Polyfills base64 attendus par @daaku/webpush sur certaines versions de Deno.
if (!(Uint8Array as any).fromBase64) {
  (Uint8Array as any).fromBase64 = (input: string, options: any = {}) => {
    let value = input;
    if (options?.alphabet === "base64url") value = value.replace(/-/g, "+").replace(/_/g, "/");
    while (value.length % 4) value += "=";
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  };
}
if (!(Uint8Array.prototype as any).toBase64) {
  (Uint8Array.prototype as any).toBase64 = function (options: any = {}) {
    let binary = "";
    for (let i = 0; i < this.length; i += 1) binary += String.fromCharCode(this[i]);
    let value = btoa(binary);
    if (options?.alphabet === "base64url") value = value.replace(/\+/g, "-").replace(/\//g, "_");
    if (options?.omitPadding) value = value.replace(/=+$/g, "");
    return value;
  };
}

const { generateVapidKey, send, vapidPublicKey } = await import("jsr:@daaku/webpush@0.2.0");

const SUBSCRIBER = "https://willbac-chronicles.github.io/wanted/";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-dispatch-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Clé serveur fournie automatiquement par Supabase aux fonctions (ancienne ou nouvelle forme).
function getAdminKey(): string {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  const raw = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (!raw) throw new Error("Clé serveur Supabase indisponible");
  const parsed = JSON.parse(raw);
  const candidate = parsed.default ?? Object.values(parsed)[0];
  if (typeof candidate === "string") return candidate;
  if (candidate && typeof candidate === "object") {
    const obj = candidate as Record<string, unknown>;
    const value = obj.key ?? obj.secret ?? obj.value;
    if (typeof value === "string") return value;
  }
  throw new Error("Clé serveur Supabase invalide");
}

async function ensureVapid(supabase: ReturnType<typeof createClient>) {
  const { data, error } = await supabase
    .from("app_private_config")
    .select("key,value")
    .in("key", ["vapid_private_jwk", "vapid_public_key"]);
  if (error) throw error;

  const map = new Map((data ?? []).map((row: any) => [row.key, row.value]));
  let privateJwk = map.get("vapid_private_jwk") as string | undefined;
  let publicKey = map.get("vapid_public_key") as string | undefined;

  if (!privateJwk || !publicKey) {
    const generated = await generateVapidKey();
    publicKey = await vapidPublicKey(generated);
    privateJwk = JSON.stringify(generated);
    const now = new Date().toISOString();
    // ignoreDuplicates : si deux appels simultanés génèrent des clés, la première écrite gagne.
    const { error: insertError } = await supabase
      .from("app_private_config")
      .upsert([
        { key: "vapid_private_jwk", value: privateJwk, updated_at: now },
        { key: "vapid_public_key", value: publicKey, updated_at: now },
      ], { onConflict: "key", ignoreDuplicates: true });
    if (insertError) throw insertError;
    const { data: again, error: againError } = await supabase
      .from("app_private_config")
      .select("key,value")
      .in("key", ["vapid_private_jwk", "vapid_public_key"]);
    if (againError) throw againError;
    const m2 = new Map((again ?? []).map((row: any) => [row.key, row.value]));
    privateJwk = m2.get("vapid_private_jwk") as string;
    publicKey = m2.get("vapid_public_key") as string;
  }
  return { privateJwk, publicKey };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, getAdminKey(), {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    let body: any = {};
    try { body = await req.json(); } catch { body = {}; }

    if (body?.mode === "public-key") {
      const { publicKey } = await ensureVapid(supabase);
      return json({ publicKey });
    }

    // Envoi : réservé à la base, qui connaît le jeton.
    const { data: tokenRow, error: tokenError } = await supabase
      .from("app_private_config")
      .select("value")
      .eq("key", "push_dispatch_token")
      .single();
    if (tokenError) throw tokenError;
    const requestToken = req.headers.get("x-dispatch-token") ?? "";
    if (!requestToken || requestToken !== tokenRow?.value) return json({ error: "Unauthorized" }, 401);

    const { privateJwk } = await ensureVapid(supabase);
    const results: any[] = [];

    // Plusieurs tours au cas où d'autres notifications deviennent dues pendant l'envoi.
    for (let round = 0; round < 3; round += 1) {
      const { data: jobs, error: jobsError } = await supabase.rpc("claim_push_jobs");
      if (jobsError) throw jobsError;
      if (!jobs || !jobs.length) break;

      for (const job of jobs as any[]) {
        const payload = JSON.stringify({
          title: job.title,
          body: job.body,
          tag: job.tag,
          urgent: !!job.urgent,
          kind: job.kind,
          url: "./",
        });
        let sent = 0, failed = 0, dropped = 0;
        await Promise.all((job.subs ?? []).map(async (sub: any) => {
          try {
            await send(
              { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
              payload,
              {
                vapid: privateJwk,
                subscriber: SUBSCRIBER,
                ttl: job.ttl,
                urgency: job.urgent ? "high" : "normal",
                // Topic ≤ 32 caractères : une nouvelle notification du même sujet remplace l'ancienne non livrée.
                topic: String(job.tag).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || undefined,
              },
            );
            sent += 1;
          } catch (error: any) {
            failed += 1;
            const status = error?.statusCode ?? error?.status;
            if (error?.permanent || status === 404 || status === 410) {
              dropped += 1;
              await supabase.rpc("drop_push_subscription", { p_endpoint: sub.endpoint });
            }
            console.error("push", job.id, status, String(error?.message ?? error).slice(0, 200));
          }
        }));
        await supabase.rpc("finish_push_job", { p_id: job.id, p_result: { sent, failed, dropped } });
        results.push({ id: job.id, kind: job.kind, sent, failed, dropped });
      }
    }

    return json({ ok: true, jobs: results });
  } catch (error: any) {
    console.error(error);
    return json({ error: String(error?.message ?? error) }, 500);
  }
});
