import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import type { ResolvedLocation } from "./locations.js";
import type { WeatherReading } from "./weather.js";

// One client for the process: reuses HTTP keep-alive connections.
// Credentials come from ANTHROPIC_API_KEY (or another SDK-supported source).
const client = new Anthropic({ maxRetries: 2, timeout: 60_000 });

const SYSTEM_PROMPT = `You are a local fashion stylist who knows how people actually dress in cities around the world.

Given a city and its current weather, recommend one complete outfit for the user's day today.

The user lives in this city. They are a resident, not a visitor. Write to them like a stylist who knows their city and their daily life: speak directly to "you", in a natural, friendly tone, and never as if they are new to the place. Do not mention tourists, visitors, travellers, sightseeing or "when in" the city, do not explain local customs or landmarks they already know, and do not suggest things like a day pack for exploring. Local norms should shape what you pick, but treat them as a given rather than something to be explained or warned about. Never describe the city's style from an outsider's point of view: avoid phrases like "the kind you see all over [place]", "effortless Parisian", "like a local" or "locals wear", and do not name neighbourhoods as style examples. Mention the city name at most once, and only if it is natural to do so.

The outfit must:
- Suit the weather: temperature, feels-like temperature, rain/snow, wind, sun/UV, and how much the temperature swings during the day.
- Fit in with how people in that specific city usually dress in everyday public life: local style conventions, typical levels of formality, modesty norms, religious or cultural considerations, and anything that would look out of place or be disrespectful there. Be specific to the city, not just the country, when the city has a distinct style.
- Be practical and match the requested outfit style exactly (see below).

The user will tell you whether they want a masculine, feminine or unisex outfit. Recommend one outfit exclusively for that choice. Never describe, mention or offer alternatives for any other style. For "unisex", choose genuinely gender-neutral pieces. Follow local norms for the requested style (for example, how coverage or formality expectations apply to feminine or masculine clothing in that city).

Build the local style into the outfit itself: choose pieces that people in this city actually wear day to day, and where a local norm shapes a choice (for example a cut, coverage, colour or formality level), simply let the piece reflect it without lecturing. Do not add a separate section about local style.

Format your answer in plain text using exactly these sections, each heading on its own line starting with "## ":
## Outfit
A bulleted list ("- " prefix) of the pieces, from top layer to footwear, plus accessories, with local style and norms woven into the descriptions.
## Why it works for the weather
Two or three short sentences.

Keep the whole answer under 200 words. Do not use bold, tables or other markdown.`;

function describe(loc: ResolvedLocation, w: WeatherReading): string {
  const where = [loc.city, loc.region, loc.country].filter(Boolean).join(", ");
  const lines = [
    `City: ${where}`,
    `Local time: ${w.observedAt} (${w.timezone}), ${w.isDay ? "daytime" : "night-time"}`,
    `Conditions: ${w.condition}`,
    `Temperature: ${w.temperatureC}°C (feels like ${w.feelsLikeC}°C)`,
    w.todayMinC !== null && w.todayMaxC !== null ? `Today's range: ${w.todayMinC}°C to ${w.todayMaxC}°C` : null,
    `Humidity: ${w.humidityPct}%`,
    `Wind: ${w.windKph} km/h, gusts ${w.windGustKph} km/h`,
    `Precipitation now: ${w.precipitationMm} mm`,
    w.precipProbabilityMaxPct !== null ? `Chance of precipitation today: ${w.precipProbabilityMaxPct}%` : null,
    w.uvIndexMax !== null ? `Max UV index today: ${w.uvIndexMax}` : null,
    `Cloud cover: ${w.cloudCoverPct}%`,
  ];
  return lines.filter(Boolean).join("\n");
}

export const OUTFIT_STYLES = ["female", "male", "unisex"] as const;
export type OutfitStyle = (typeof OUTFIT_STYLES)[number];

const STYLE_LABEL: Record<OutfitStyle, string> = {
  female: "feminine outfit",
  male: "masculine outfit",
  unisex: "unisex (gender-neutral) outfit",
};

export type OutfitEvent =
  | { type: "text"; text: string }
  | { type: "done"; model: string; usedFallback: boolean };

export class OutfitRefusedError extends Error {}

/**
 * Streams an outfit recommendation from Claude, yielding text as it is
 * generated so the UI can render it progressively.
 */
export async function* streamOutfit(
  loc: ResolvedLocation,
  weather: WeatherReading,
  style: OutfitStyle,
  signal: AbortSignal,
): AsyncGenerator<OutfitEvent> {
  const stream = client.beta.messages.stream(
    {
      model: config.model,
      max_tokens: 4000,
      output_config: { effort: config.effort },
      // If the primary model declines, the API retries on a suitable fallback
      // model within the same call.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: `${describe(loc, weather)}\n\nI live in this city. Requested style: ${STYLE_LABEL[style]}\n\nWhat should I wear today?` }],
    },
    { signal },
  );

  for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      yield { type: "text", text: event.delta.text };
    }
  }

  const final = await stream.finalMessage();
  if (final.stop_reason === "refusal") {
    throw new OutfitRefusedError("The model declined to answer this request.");
  }
  const usedFallback = (final.usage.iterations ?? []).some((i) => i.type === "fallback_message");
  yield { type: "done", model: final.model, usedFallback };
}
