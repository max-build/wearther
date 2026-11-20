import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import compression from "compression";
import express, { type NextFunction, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import helmet from "helmet";
import { z } from "zod";
import { config } from "./config.js";
import { nearestCity, resolveCity, searchCities, warmGeoIndex } from "./locations.js";
import { OUTFIT_STYLES, OutfitRefusedError, streamOutfit } from "./outfit.js";
import { RecommendationCache } from "./recommendationCache.js";
import { getWeather, WeatherError } from "./weather.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, "../public");

const app = express();
app.disable("x-powered-by");

// Liveness probe for container platforms (Railway, Docker, etc.). Registered
// first so it is cheap and never rate limited.
app.get("/health", (_req, res) => {
  res.set("Cache-Control", "no-store").json({ status: "ok" });
});
app.set("trust proxy", config.trustProxy);
app.use(
  helmet({
    // The app is often served over plain http (localhost, LAN). Forcing HTTPS
    // upgrades/HSTS makes browsers rewrite /js/app.js to https:// and the page
    // never loads. If you deploy behind HTTPS, set these headers at the proxy.
    hsts: false,
    contentSecurityPolicy: { useDefaults: true, directives: { "upgrade-insecure-requests": null } },
  }),
);
app.use(express.json({ limit: "4kb" }));

const recommendSchema = z.object({
  cityId: z.string().regex(/^[A-Z]{2}:\d+$/),
  style: z.enum(OUTFIT_STYLES),
});

/** Finished recommendations, reused for 30 minutes per city + outfit style. */
const recommendations = new RecommendationCache(config.recommendationCacheMs);

// ---- Rate limits -------------------------------------------------------------

/** The expensive endpoint (weather + LLM): N uses per client per hour. */
const recommendLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: config.rateLimitPerHour,
  standardHeaders: "draft-8",
  legacyHeaders: true, // X-RateLimit-Remaining / -Reset, easy for the UI to read
  // Requests that fail before streaming starts (bad input, weather outage,
  // client disconnects) don't use up the user's quota.
  skipFailedRequests: true,
  // Repeat requests answered from the 30-minute cache cost nothing (no Claude or
  // weather call), so they don't use up the user's quota either.
  skip: (req) => {
    const p = recommendSchema.safeParse(req.body);
    return p.success && recommendations.get(RecommendationCache.key(p.data.cityId, p.data.style)) !== undefined;
  },
  handler: (_req, res, _next, options) => {
    res.status(options.statusCode).json({
      error: `You've reached the limit of ${config.rateLimitPerHour} outfit recommendations per hour. Please try again later.`,
    });
  },
});

/** Generous guard for the cheap lookup endpoints. */
const lookupLimiter = rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: "draft-8", legacyHeaders: false });

// ---- Lookup endpoints ---------------------------------------------------------

const api = express.Router();

const searchLimiter = rateLimit({ windowMs: 60 * 1000, limit: 300, standardHeaders: "draft-8", legacyHeaders: false });
const searchSchema = z.object({ q: z.string().trim().min(2).max(80) });

/** Live city search across all countries (the browser debounces and cancels stale requests). */
api.get("/cities/search", searchLimiter, (req, res) => {
  const parsed = searchSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Type at least 2 letters." });
    return;
  }
  // The dataset is static, so identical searches can be cached by the browser.
  res.set("Cache-Control", "public, max-age=300").json(searchCities(parsed.data.q));
});

const locateSchema = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
});

api.post("/locate", lookupLimiter, (req, res) => {
  const parsed = locateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "lat and lon must be valid coordinates" });
    return;
  }
  const hit = nearestCity(parsed.data.lat, parsed.data.lon);
  const loc = hit && resolveCity(hit.cityId);
  if (!hit || !loc) {
    res.status(404).json({ error: "No nearby city found" });
    return;
  }
  res.json({ cityId: hit.cityId, city: loc.city, region: loc.region, country: loc.country, distanceKm: Math.round(hit.distanceKm) });
});

// ---- Recommendation (Server-Sent Events) ---------------------------------------


api.post("/recommend", recommendLimiter, async (req, res) => {
  const parsed = recommendSchema.safeParse(req.body);
  const loc = parsed.success ? resolveCity(parsed.data.cityId) : undefined;
  if (!parsed.success || !loc) {
    res.status(400).json({ error: "Please choose a city and an outfit style." });
    return;
  }

  // Cancel upstream work if the browser goes away.
  const abort = new AbortController();
  res.on("close", () => abort.abort());

  const { style } = parsed.data;
  const key = RecommendationCache.key(parsed.data.cityId, style);

  const startStream = () => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
  };
  const send = (event: string, data: unknown) => {
    if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Repeat request within 30 minutes (or one already being generated): replay the
  // first answer. No Open-Meteo call, no Claude call.
  const cached = recommendations.get(key) ?? (await recommendations.waitForPending(key));
  if (abort.signal.aborted) return;
  if (cached) {
    startStream();
    send("weather", { location: cached.location, weather: cached.weather });
    send("delta", cached.text);
    send("done", { model: cached.model, usedFallback: cached.usedFallback });
    res.end();
    return;
  }

  // First request for this city + style: we generate it, and others wait for us.
  const generation = recommendations.begin(key);
  try {
    let weather;
    try {
      weather = await getWeather(loc.lat, loc.lon);
    } catch (err) {
      console.error("weather error:", err);
      res.status(502).json({ error: err instanceof WeatherError ? err.message : "Could not fetch the weather." });
      return;
    }
    if (abort.signal.aborted) return;

    startStream();
    send("weather", { location: loc, weather });

    let text = "";
    try {
      for await (const ev of streamOutfit(loc, weather, style, abort.signal)) {
        if (ev.type === "text") {
          text += ev.text;
          send("delta", ev.text);
        } else {
          generation.resolve({ location: loc, weather, text, model: ev.model, usedFallback: ev.usedFallback });
          send("done", { model: ev.model, usedFallback: ev.usedFallback });
        }
      }
    } catch (err) {
      if (abort.signal.aborted) return; // client disconnected; nothing to report
      console.error("LLM error:", err);
      send("error", { error: llmErrorMessage(err) });
    } finally {
      res.end();
    }
  } finally {
    generation.fail(); // no-op if it completed; otherwise lets waiting requests retry on their own
  }
});

function llmErrorMessage(err: unknown): string {
  if (err instanceof OutfitRefusedError) return "Sorry, a recommendation couldn't be generated for this request.";
  if (err instanceof Anthropic.AuthenticationError) return "The server's AI credentials are invalid. Please contact the administrator.";
  if (err instanceof Anthropic.RateLimitError) return "The AI service is busy right now. Please try again in a minute.";
  if (err instanceof Anthropic.APIConnectionError) return "Couldn't reach the AI service. Please try again.";
  if (err instanceof Anthropic.APIError) return `The AI service returned an error (${err.status ?? "unknown"}).`;
  return "Something went wrong generating your outfit.";
}

app.use("/api", api);
// Safe to compress from here on: the /api router (including the SSE stream) is mounted above.
app.use(compression());

// Serve the page with the script and stylesheet URLs stamped with their
// modification times (?v=...). Whenever the client is rebuilt the URLs change,
// so a browser can never keep using an old cached copy.
app.get(["/", "/index.html"], async (_req, res, next) => {
  try {
    const [html, js, css] = await Promise.all([
      readFile(path.join(publicDir, "index.html"), "utf8"),
      stat(path.join(publicDir, "js/app.js")),
      stat(path.join(publicDir, "styles.css")),
    ]);
    res
      .set("Cache-Control", "no-cache")
      .type("html")
      .send(
        html
          .replace("/js/app.js", `/js/app.js?v=${Math.floor(js.mtimeMs)}`)
          .replace("/styles.css", `/styles.css?v=${Math.floor(css.mtimeMs)}`),
      );
  } catch (err) {
    next(err);
  }
});

// HTML/JS/CSS are revalidated on every load (cheap 304s via ETag), so a rebuild
// is picked up immediately and the page can never run mismatched HTML and JS.
app.use(express.static(publicDir, { maxAge: 0, etag: true, cacheControl: true, setHeaders: (res) => res.setHeader("Cache-Control", "no-cache") }));

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
});

const server = app.listen(config.port, () => {
  console.log(`Wearther running at http://localhost:${config.port}`);
  // Build the location index off the request path so the first "find my location" is fast.
  setImmediate(() => {
    const t = performance.now();
    warmGeoIndex();
    console.log(`Location index ready in ${Math.round(performance.now() - t)} ms`);
  });
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5_000).unref();
  });
}
