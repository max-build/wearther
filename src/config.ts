import type { MessageCreateParams } from "@anthropic-ai/sdk/resources/beta/messages/messages";

type Effort = NonNullable<NonNullable<MessageCreateParams["output_config"]>["effort"]>;

const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  return n;
}

function effortEnv(): Effort {
  const raw = (process.env.CLAUDE_EFFORT ?? "low") as Effort;
  if (!EFFORTS.includes(raw)) throw new Error(`CLAUDE_EFFORT must be one of ${EFFORTS.join(", ")}`);
  return raw;
}

export const config = Object.freeze({
  port: intEnv("PORT", 3000),
  model: process.env.CLAUDE_MODEL ?? "claude-sonnet-5-5",
  effort: effortEnv(),
  rateLimitPerHour: intEnv("RATE_LIMIT_PER_HOUR", 6),
  trustProxy: intEnv("TRUST_PROXY", 0),
  weatherCacheMs: 10 * 60 * 1000,
  /** A repeat request for the same city + outfit style within this window gets the first answer back. */
  recommendationCacheMs: 30 * 60 * 1000,
  upstreamTimeoutMs: 8_000,
});
