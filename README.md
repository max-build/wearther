# WEARther

A TypeScript web app that recommends a weather-appropriate **and locally appropriate** outfit for the city you're in.

1. Type your **city** (results from every country appear as you type) and pick an **outfit style** (masculine, feminine or unisex), or click **📍 Find my location**.
2. The server fetches current conditions from [Open-Meteo](https://open-meteo.com/) (free, no key).
3. The weather goes to **Claude** (`claude-sonnet-5-5`), which writes an outfit that suits the weather and follows local dress conventions and norms.

## Quick start

```bash
npm install
cp .env.example .env      # then set ANTHROPIC_API_KEY
npm run build   # compiles Tailwind/daisyUI CSS + TypeScript
npm start                 # http://localhost:3000
```

For development, `npm run dev` watches and reloads both the server and the client.

## Deploy to Railway (Docker)

The repo ships with a multi-stage `Dockerfile`, a `.dockerignore` and a `railway.json`, so it deploys as-is.

1. In Railway: **New Project → Deploy from GitHub repo** and pick this repo and branch.
2. Open the service's **Variables** tab and add **`ANTHROPIC_API_KEY`** (required). Optional: `CLAUDE_MODEL`, `CLAUDE_EFFORT`, `RATE_LIMIT_PER_HOUR`.
3. Under **Settings → Networking**, click **Generate Domain**.

That's it. Railway builds the Dockerfile, injects `PORT`, and uses `GET /health` as the health check.

Notes:
- `TRUST_PROXY=1` is set in the Dockerfile because Railway puts one proxy in front of the app. Without it, every visitor would share the proxy's IP and the 6-per-hour limit would apply to everyone combined.
- The rate limit counter lives in memory, so run a single replica (or add a shared store such as Redis before scaling out).
- The API key is never baked into the image: `.dockerignore` excludes `.env*`, and the key is supplied at runtime.

Run the container locally:

```bash
docker build -t wearther .
docker run --rm -p 3000:3000 -e ANTHROPIC_API_KEY=your-key -e TRUST_PROXY=0 wearther
```

## Configuration (`.env`)

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Claude API key |
| `PORT` | `3000` | HTTP port |
| `CLAUDE_MODEL` | `claude-sonnet-5-5` | Model used for recommendations |
| `CLAUDE_EFFORT` | `low` | `low`/`medium`/`high`/`xhigh`/`max`. Low keeps responses fast |
| `RATE_LIMIT_PER_HOUR` | `6` | Recommendations allowed per client IP per hour |
| `TRUST_PROXY` | `0` | Number of reverse proxies in front of the app, so rate limiting sees the real client IP |

## How it works

```
src/
  server.ts     Express app, routes, rate limits, SSE streaming
  locations.ts  Countries/cities (offline dataset) + nearest-city lookup
  weather.ts    Open-Meteo client with 10-min cache + request de-duplication
  outfit.ts     Claude prompt + streaming
  cache.ts      Async TTL cache that shares in-flight promises
  config.ts     Validated env config
client/app.ts   Browser UI (compiled to public/js)
public/         index.html, styles.css
```

### API

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | Liveness probe used by Docker/Railway |
| GET | `/api/cities/search?q=` | Live city search across all countries (min. 2 letters, max 30 results, accent-insensitive; e.g. `paris`, `paris texas`) |
| POST | `/api/locate` `{lat, lon}` | Nearest city, computed on the server (no third-party geocoder) |
| POST | `/api/recommend` `{cityId, style}` (`style`: `female`, `male` or `unisex`) | **Rate limited.** Server-Sent Events: `weather` → `delta`… → `done` / `error` |

### Recommendation cache
A repeat request for the **same city and outfit style within 30 minutes** returns the original recommendation exactly (same weather snapshot, same outfit text). It makes no Claude or Open-Meteo call, and it doesn't count towards the hourly limit. The 30 minutes run from when the recommendation was first generated, and a different style or city gets a fresh one. Identical requests that arrive while the first is still being generated wait for it instead of starting a second Claude call. Only complete, successful results are cached. The cache is in memory (up to 2,000 entries), so it resets on restart and isn't shared between replicas. The window is `recommendationCacheMs` in `src/config.ts`.

### Rate limiting
`/api/recommend` allows **6 requests per IP per hour** (`express-rate-limit`). Requests that fail before streaming starts don't count: invalid input, a weather outage, or the client disconnecting. Responses include `X-RateLimit-Remaining`, and the UI shows how many uses are left. The lookup endpoints have a separate, generous limit of 120 per minute. The counter is kept in memory. If you run several instances, use a shared store such as Redis (`rate-limit-redis`).

### Performance
- Everything that does I/O is `async`. The server streams Claude's answer to the browser as it is written (this keeps the connection alive during long responses), but the page shows loading placeholders until the **complete** recommendation has arrived, then displays the weather and outfit together.
- Weather results are cached for 10 minutes per ~1 km grid cell, and concurrent requests for the same cell share one upstream call.
- The city search and nearest-city indexes (~150k cities) are built once at startup, outside the request path, so a search takes a few milliseconds. The browser waits for a pause in typing, cancels stale searches, and only ever receives ~30 results.
- Upstream calls have timeouts (Open-Meteo 8 s, Claude 60 s with 2 retries). If the browser disconnects, the Claude request is cancelled so no tokens are wasted.
- One Anthropic client is reused for HTTP keep-alive. Static files are gzipped, and search results are cached by the browser.

### Safety
`helmet` security headers, `zod` input validation, a 4 KB JSON body limit, and LLM output that is HTML-escaped before rendering. Server-side refusal fallbacks are on (`fallbacks: "default"`). If the primary model declines, the API retries on a fallback model in the same call.
