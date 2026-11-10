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
  display_name: string | null;
  reminder_enabled: boolean;
  reminder_time: string | null;
  timezone: string | null;
  push_subscriptions: PushSubscriptionRow[] | null;
};

function localTime(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).format(date);
}

function localDate(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);

  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;

  if (!year || !month || !day) {
    throw new Error("Não foi possível calcular a data local.");
  }

  return `${year}-${month}-${day}`;
}

/**
 * Retorna a data local do lembrete se ele venceu agora
 * ou no minuto anterior. Isso permite uma pequena tolerância
 * caso o agendamento seja executado com atraso.
 */
function getDueReminderDate(
  timezone: string,
  reminderTime: string,
  now: Date
): string | null {
  for (const minutesAgo of [0, 1]) {
    const candidate = new Date(now.getTime() - minutesAgo * 60_000);

    if (localTime(candidate, timezone) === reminderTime) {
      return localDate(candidate, timezone);
    }
  }

  return null;
}

function getErrorStatusCode(error: unknown): number | undefined {
  if (
    error &&
    typeof error === "object" &&
    "statusCode" in error &&
    typeof error.statusCode === "number"
  ) {
    return error.statusCode;
  }

  return undefined;
}

export default {
  async fetch(request: Request): Promise<Response> {
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
      console.error("Erro ao buscar perfis:", profilesError.message);

      return Response.json(
        { error: profilesError.message },
        { status: 500 }
      );
    }

    let sent = 0;
    let skipped = 0;
    let failed = 0;

    const now = new Date();

    for (const profile of (profiles || []) as Profile[]) {
      const timezone = profile.timezone || "America/Sao_Paulo";
      const reminderTime = profile.reminder_time?.slice(0, 5);

      if (!reminderTime) {
        skipped++;
        continue;
      }

      let deliveryDate: string | null;

      try {
        deliveryDate = getDueReminderDate(
          timezone,
          reminderTime,
          now
        );
      } catch (error) {
        console.error(
          `Fuso horário inválido para o perfil ${profile.id}:`,
          error
        );

        skipped++;
        continue;
      }

      if (!deliveryDate) {
        continue;
      }

      const subscriptions = (profile.push_subscriptions || []).filter(
        (subscription) =>
          Boolean(
            subscription.endpoint &&
            subscription.p256dh &&
            subscription.auth
          )
      );

      /*
       * Não registra a entrega se não existir assinatura.
       * Assim, a ausência de assinatura não consome o lembrete do dia.
       */
      if (subscriptions.length === 0) {
        skipped++;
        continue;
      }

      /*
       * A restrição única em push_deliveries evita enviar
       * o mesmo lembrete mais de uma vez no mesmo dia.
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

        console.error(
          `Erro ao registrar entrega do perfil ${profile.id}:`,
          deliveryError.message
        );

        failed++;
        continue;
      }

      const payload = JSON.stringify({
        title: "Missões 007 — Hora da operação",
        body: `${
          profile.display_name || "Agente"
        }, escolha uma pequena missão e comece agora.`,
        url: "./",
        tag: `daily-reminder-${deliveryDate}`
      });

      let sentForProfile = 0;

      for (const subscription of subscriptions) {
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
          sentForProfile++;
        } catch (error) {
          const statusCode = getErrorStatusCode(error);

          console.error(
            `Falha ao enviar push para o perfil ${profile.id}:`,
            error
          );

          if (statusCode === 404 || statusCode === 410) {
            const { error: deleteError } = await admin
              .from("push_subscriptions")
              .delete()
              .eq("id", subscription.id);

            if (deleteError) {
              console.error(
                `Erro ao remover assinatura expirada ${subscription.id}:`,
                deleteError.message
              );
            }
          }

          failed++;
        }
      }

      /*
       * Se nenhuma assinatura recebeu o push, remove o registro
       * para permitir uma nova tentativa na próxima execução do cron.
       */
      if (sentForProfile === 0) {
        const { error: rollbackError } = await admin
          .from("push_deliveries")
          .delete()
          .eq("user_id", profile.id)
          .eq("delivery_date", deliveryDate)
          .eq("delivery_type", "daily_reminder");

        if (rollbackError) {
          console.error(
            `Erro ao liberar nova tentativa para o perfil ${profile.id}:`,
            rollbackError.message
          );
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
