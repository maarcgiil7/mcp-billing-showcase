import type { Redis } from "@upstash/redis";

/**
 * Sliding window rate limiter — un solo Lua script atómico (log basado en
 * sorted set), compartido por Módulo 4 (rate limiting) y Módulo 5 (quota
 * check), ver ARCHITECTURE.md §4.3 nota de garantía atómica: "el contador de
 * quota se decrementa en el mismo Lua script que evalúa el sliding window de
 * rate limit — ambas operaciones son una sola transacción Redis". Se
 * implementa una única vez aquí; Módulo 5 reutiliza `checkSlidingWindow` sin
 * tocar el script.
 *
 * Interfaz del script (KEYS/ARGV) — no renombrar sin actualizar ambos módulos:
 *   KEYS[1] = clave del sorted set de la ventana (el "log" de timestamps).
 *   KEYS[2] = clave de quota — RESERVADO PARA MÓDULO 5. Módulo 4 SIEMPRE pasa
 *             "" (string vacío): el script comprueba `quotaKey ~= ""` antes
 *             de tocar esa clave, así que un valor vacío es un no-op seguro,
 *             nunca una key real de Redis.
 *   ARGV[1] = now, epoch en milisegundos.
 *   ARGV[2] = windowSeconds.
 *   ARGV[3] = limit.
 *   ARGV[4] = quotaDelta — RESERVADO PARA MÓDULO 5 (unidades a decrementar de
 *             KEYS[2]). Ignorado si KEYS[2] === "". Módulo 4 siempre pasa "0".
 *
 * Devuelve una tabla Lua `{allowed(0|1), count, resetAtMs}`.
 */
const SLIDING_WINDOW_SCRIPT = `
local windowKey = KEYS[1]
local quotaKey = KEYS[2]
local now = tonumber(ARGV[1])
local windowSeconds = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local quotaDelta = tonumber(ARGV[4])

local windowMs = windowSeconds * 1000
local minScore = now - windowMs

redis.call("ZREMRANGEBYSCORE", windowKey, "-inf", minScore)

local current = redis.call("ZCARD", windowKey)

if current >= limit then
  local oldest = redis.call("ZRANGE", windowKey, 0, 0, "WITHSCORES")
  local resetAt = now + windowMs
  if oldest[2] then
    resetAt = tonumber(oldest[2]) + windowMs
  end
  return {0, current, resetAt}
end

redis.call("ZADD", windowKey, now, now .. "-" .. math.random(1, 1000000000))
redis.call("PEXPIRE", windowKey, windowMs)

-- Reservado para Módulo 5: decremento atómico de quota en la MISMA
-- transacción que el chequeo de rate limit (sin ventana check-then-set entre
-- ambos). Módulo 4 nunca entra en esta rama porque siempre pasa quotaKey="".
if quotaKey ~= "" then
  redis.call("DECRBY", quotaKey, quotaDelta)
end

return {1, current + 1, now + windowMs}
`;

/** Clave para tráfico autenticado (API key o access token OAuth ya validados). */
export function buildUserRateLimitKey(userId: string, endpoint: string): string {
  return `rl:user:${userId}:${endpoint}`;
}

/** Clave para tráfico SIN credencial — ver `lib/ratelimit/anonymous-limits.ts`. */
export function buildAnonymousRateLimitKey(ip: string, endpoint: string): string {
  return `rl:anon:${ip}:${endpoint}`;
}

export interface SlidingWindowQuotaParams {
  /** RESERVADO para Módulo 5. No pasar este campo desde Módulo 4. */
  key: string;
  /** RESERVADO para Módulo 5. No pasar este campo desde Módulo 4. */
  delta: number;
}

export interface SlidingWindowParams {
  key: string;
  limit: number;
  windowSeconds: number;
  /** Inyectable para tests; por defecto `Date.now()`. */
  now?: number;
  /** RESERVADO para Módulo 5 — omitir desde Módulo 4. */
  quota?: SlidingWindowQuotaParams;
}

export interface SlidingWindowResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Epoch ms en el que la ventana actual deja de contar la entrada más antigua. */
  resetAt: number;
}

/**
 * Evalúa (y, si `allowed`, registra) una request contra el sliding window de
 * `params.key`. Atómico: una sola llamada Redis (Lua script), sin ventana
 * check-then-set entre leer el contador y escribir la nueva entrada.
 */
export async function checkSlidingWindow(
  redis: Redis,
  params: SlidingWindowParams,
): Promise<SlidingWindowResult> {
  const now = params.now ?? Date.now();
  const quotaKey = params.quota?.key ?? "";
  const quotaDelta = params.quota?.delta ?? 0;

  const [allowedFlag, count, resetAt] = await redis.eval<string[], [number, number, number]>(
    SLIDING_WINDOW_SCRIPT,
    [params.key, quotaKey],
    [String(now), String(params.windowSeconds), String(params.limit), String(quotaDelta)],
  );

  return {
    allowed: allowedFlag === 1,
    limit: params.limit,
    remaining: Math.max(params.limit - count, 0),
    resetAt,
  };
}
