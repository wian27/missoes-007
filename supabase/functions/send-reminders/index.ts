import { createSupabaseContext } from "npm:@supabase/server@1";

import * as webpush from "npm:web-push";



type PushSubscriptionRow = {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
};

type Profile = {
  id: string;
  display_name: string;
  reminder_enabled: boolean;
  reminder_time: string | null;
  timezone: string | null;
  push_subscriptions: PushSubscriptionRow[];
};

function localTime(timezone: string) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).format(new Date());
}

function localDate(timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());

  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;

  return `${year}-${month}-${day}`;
}

export default {
  async fetch(request: Request) {
    const { data: context, error: contextError } =
      await createSupabaseContext(request, {
        auth: "secret"
      });

    if (contextError || !context) {
      return Response.json(
        { error: "Não autorizado." },
        { status: 401 }
      );
    }

   const vapidPublicKey = Deno.env.get("VAPID_PUBLIC_KEY");
const vapidPrivateKey = Deno.env.get("VAPID_PRIVATE_KEY");

// Aceita o nome que foi configurado antes e o nome usado no código original.
const configuredSubject =
  Deno.env.get("VAPID_SUBJECT") ||
  Deno.env.get("VAPID_CONTACT_EMAIL");

const vapidSubject = configuredSubject
  ? (/^(mailto:|https:\/\/)/i.test(configuredSubject)
      ? configuredSubject
      : `mailto:${configuredSubject}`)
  : null;

if (!vapidPublicKey || !vapidPrivateKey || !vapidSubject) {
  console.error("Falta configurar um ou mais secrets VAPID.");
  return Response.json(
    { error: "Chaves VAPID não configuradas." },
    { status: 500 }
  );
}

webpush.setVapidDetails(
  vapidSubject,
  vapidPublicKey,
  vapidPrivateKey
);


    const admin = context.supabaseAdmin;

    const { data: profiles, error: profilesError } = await admin
      .from("profiles")
      .select(`
        id,
        display_name,
        reminder_enabled,
        reminder_time,
        timezone,
        push_subscriptions (
          id,
          endpoint,
          p256dh,
          auth
        )
      `)
      .eq("reminder_enabled", true);

    if (profilesError) {
      return Response.json(
        { error: profilesError.message },
        { status: 500 }
      );
    }

    let sent = 0;
    let skipped = 0;
    let failed = 0;

    for (const profile of (profiles || []) as Profile[]) {
      const timezone = profile.timezone || "America/Sao_Paulo";
      const reminderTime = profile.reminder_time?.slice(0, 5);

      if (!reminderTime || reminderTime !== localTime(timezone)) {
        continue;
      }

      const deliveryDate = localDate(timezone);

      /*
        Inserir primeiro evita notificações duplicadas.
        A restrição unique impede novo envio no mesmo dia.
      */
      const { error: deliveryError } = await admin
        .from("push_deliveries")
        .insert({
          user_id: profile.id,
          delivery_date: deliveryDate,
          delivery_type: "daily_reminder"
        });

      if (deliveryError) {
        if (deliveryError.code === "23505") {
          skipped++;
          continue;
        }

        failed++;
        continue;
      }

      const payload = JSON.stringify({
        title: "Missões 007 — Hora da operação",
        body: `${profile.display_name || "Agente"}, escolha uma pequena missão e comece agora.`,
        url: "./",
        tag: `daily-reminder-${deliveryDate}`
      });

      for (const subscription of profile.push_subscriptions || []) {
        try {
          await webpush.sendNotification(
            {
              endpoint: subscription.endpoint,
              keys: {
                p256dh: subscription.p256dh,
                auth: subscription.auth
              }
            },
            payload,
            {
              TTL: 120
            }
          );

          sent++;
        } catch (error: any) {
          const statusCode = error?.statusCode;

          /*
            404 ou 410 indicam que a assinatura expirou,
            foi removida ou deixou de ser válida.
          */
          if (statusCode === 404 || statusCode === 410) {
            await admin
              .from("push_subscriptions")
              .delete()
              .eq("id", subscription.id);
          }

          failed++;
        }
      }
    }

    return Response.json({
      success: true,
      sent,
      skipped,
      failed
    });
  }
};
