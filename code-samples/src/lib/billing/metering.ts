import { Prisma, type PrismaClient, type UsageEvent, type UsageEventStatus } from "@prisma/client";
import type Stripe from "stripe";
import { logger } from "@/lib/logger";

/**
 * Metering — ver ARCHITECTURE.md §Estrategia de metering y §4.4 (retry,
 * interrupción, streaming). La idempotencia de `POST /api/usage` la
 * garantiza el `UNIQUE` constraint de `UsageEvent.idempotencyKey` en
 * Postgres, nunca un `SELECT`-before-`INSERT` (vulnerable a race condition
 * si dos retries llegan casi simultáneos) — se intenta el `INSERT`
 * directamente y se captura la violación de constraint (P2002).
 */

/** Nombre del meter event reportado a Stripe Billing Meters. TODO: customize
 * si el comprador usa varios meters (ej. uno por endpoint) en vez de uno solo. */
const STRIPE_METER_EVENT_NAME = "usage_event";

/**
 * Qué estados de `UsageEvent` se reportan a Stripe. `'completed'` siempre.
 * `'partial'` es opt-in — un comprador cuyo trabajo parcial sigue teniendo
 * valor para su cliente puede añadirlo aquí. `'failed'` nunca es billable
 * bajo ninguna configuración (no se lista ni se debe listar).
 * TODO: customize.
 */
const BILLABLE_STATUSES: UsageEventStatus[] = ["completed"];

function isBillable(status: UsageEventStatus): boolean {
  return BILLABLE_STATUSES.includes(status);
}

function isUniqueConstraintViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

export interface RecordUsageParams {
  userId: string;
  idempotencyKey: string;
  endpoint: string;
  units: number;
  status: UsageEventStatus;
}

export type RecordUsageResult =
  | { alreadyRecorded: true; event: null }
  | { alreadyRecorded: false; event: UsageEvent };

/**
 * Reporta un evento billable a Stripe Billing Meters. Nunca lanza: un fallo
 * de Stripe se loguea y `UsageEvent.syncedAt` queda `null` — un retry job
 * (fuera del alcance de este módulo, ver SESSION_SUMMARY_MODULE5.md) lo
 * reintenta más tarde. La request original que registró el evento no debe
 * fallar por esto.
 */
async function syncToStripe(
  prisma: PrismaClient,
  stripe: Stripe,
  event: UsageEvent,
  stripeCustomerId: string,
): Promise<UsageEvent> {
  try {
    const meterEvent = await stripe.billing.meterEvents.create({
      event_name: STRIPE_METER_EVENT_NAME,
      payload: {
        value: String(event.units),
        stripe_customer_id: stripeCustomerId,
      },
      // Reutiliza el idempotencyKey del evento como identifier de Stripe —
      // doble guardia de idempotencia (Postgres + ventana de 24h de Stripe).
      identifier: event.idempotencyKey,
    });

    return await prisma.usageEvent.update({
      where: { id: event.id },
      data: { stripeUsageRecordId: meterEvent.identifier, syncedAt: new Date() },
    });
  } catch (error) {
    logger.error("Failed to sync usage event to Stripe", {
      userId: event.userId,
      eventId: event.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return event;
  }
}

/**
 * Registra un `UsageEvent`. `idempotencyKey` duplicado → `alreadyRecorded:
 * true`, no se reprocesa ni se vuelve a reportar a Stripe (el caller
 * responde 200 igualmente — es indistinguible de una confirmación tardía
 * del primer intento). Si el evento es billable, reporta a Stripe siempre
 * que el usuario ya tenga `stripeCustomerId` (lazy, creado en el primer
 * checkout) — si no lo tiene todavía (plan free, nunca hizo checkout),
 * no hay a quién reportar el uso: `syncedAt` queda `null` a propósito, no
 * es un fallo transitorio reintentable.
 */
export async function recordUsage(
  prisma: PrismaClient,
  stripe: Stripe,
  params: RecordUsageParams,
): Promise<RecordUsageResult> {
  let event: UsageEvent;
  try {
    event = await prisma.usageEvent.create({
      data: {
        userId: params.userId,
        idempotencyKey: params.idempotencyKey,
        endpoint: params.endpoint,
        units: params.units,
        status: params.status,
      },
    });
  } catch (error) {
    if (isUniqueConstraintViolation(error)) {
      return { alreadyRecorded: true, event: null };
    }
    throw error;
  }

  if (!isBillable(event.status)) {
    return { alreadyRecorded: false, event };
  }

  const user = await prisma.user.findUnique({
    where: { id: params.userId },
    select: { stripeCustomerId: true },
  });

  if (!user?.stripeCustomerId) {
    logger.debug("Skipping Stripe usage sync: user has no stripeCustomerId yet", {
      userId: params.userId,
      eventId: event.id,
    });
    return { alreadyRecorded: false, event };
  }

  const synced = await syncToStripe(prisma, stripe, event, user.stripeCustomerId);
  return { alreadyRecorded: false, event: synced };
}
