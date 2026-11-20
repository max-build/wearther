// ---- Types shared with the server's JSON responses ---------------------------

interface CityHit { id: string; name: string; region: string; country: string; flag: string }
interface Weather {
  observedAt: string; timezone: string; isDay: boolean; condition: string;
  temperatureC: number; feelsLikeC: number; humidityPct: number; precipitationMm: number;
  windKph: number; windGustKph: number; cloudCoverPct: number;
  uvIndexMax: number | null; todayMinC: number | null; todayMaxC: number | null;
  precipProbabilityMaxPct: number | null;
}
interface Location { city: string; region: string; country: string }

// ---- DOM ---------------------------------------------------------------------

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const form = $<HTMLFormElement>("form");
const cityInput = $<HTMLInputElement>("city");
const cityList = $<HTMLUListElement>("city-results");
const styleSel = $<HTMLSelectElement>("style");
const againBtn = $<HTMLButtonElement>("again");
const locateBtn = $<HTMLButtonElement>("locate");
const submitBtn = $<HTMLButtonElement>("submit");
const statusEl = $<HTMLParagraphElement>("status");
const spinnerEl = $<HTMLSpanElement>("spinner");
const quotaEl = $<HTMLParagraphElement>("quota");
const resultEl = $<HTMLElement>("result");
const weatherEl = $<HTMLDivElement>("weather");
const outfitEl = $<HTMLDivElement>("outfit");
const metaEl = $<HTMLParagraphElement>("meta");

// ---- Helpers -----------------------------------------------------------------

function setStatus(msg: string, isError = false, loading = false): void {
  statusEl.textContent = msg;
  statusEl.className = isError ? "alert alert-error alert-soft w-full text-sm" : "text-sm text-base-content/70";
  spinnerEl.classList.toggle("hidden", !loading);
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Request failed (${res.status})`);
  }
  return (await res.json()) as T;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Tiny, safe renderer for the "## heading" / "- bullet" format we ask the LLM for. */
function renderOutfit(text: string): string {
  let html = "";
  let inList = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const isItem = /^[-*•]\s+/.test(line);
    if (inList && !isItem) { html += "</ul>"; inList = false; }
    if (!line) continue;
    if (line.startsWith("#")) {
      html += `<h3 class="mb-2 mt-6 text-xs font-bold uppercase tracking-widest text-primary first:mt-0">${escapeHtml(line.replace(/^#+\s*/, ""))}</h3>`;
    } else if (isItem) {
      if (!inList) { html += '<ul class="list rounded-box bg-base-200/60">'; inList = true; }
      html += `<li class="list-row items-center"><span class="status status-primary"></span><span>${escapeHtml(line.replace(/^[-*•]\s+/, ""))}</span></li>`;
    } else {
      html += `<p class="leading-relaxed text-base-content/80">${escapeHtml(line)}</p>`;
    }
  }
  return inList ? html + "</ul>" : html;
}

// ---- City search (all countries, live as you type) ------------------------------

let selectedCityId = "";
let selectedLabel = "";
let matches: CityHit[] = [];
let activeIdx = -1;
let debounceTimer: number | undefined;
let searchAbort: AbortController | undefined;
const searchMemo = new Map<string, CityHit[]>();

const cityLabel = (c: CityHit): string => [c.name, c.region, c.country].filter(Boolean).join(", ");

function setActive(i: number): void {
  activeIdx = i;
  cityList.querySelectorAll<HTMLElement>("[role=option]").forEach((el, n) => {
    const on = n === i;
    el.classList.toggle("bg-primary/10", on);
    el.classList.toggle("text-primary", on);
    el.setAttribute("aria-selected", String(on));
    if (on) {
      el.scrollIntoView({ block: "nearest" });
      cityInput.setAttribute("aria-activedescendant", el.id);
    }
  });
  if (i < 0) cityInput.removeAttribute("aria-activedescendant");
}

function showList(html: string): void {
  cityList.innerHTML = html;
  cityList.hidden = false;
  cityInput.setAttribute("aria-expanded", "true");
}

function showMessage(text: string, kind: "hint" | "loading" | "error" = "hint"): void {
  matches = [];
  const spinner = kind === "loading" ? '<span class="loading loading-dots loading-xs"></span> ' : "";
  const tone = kind === "error" ? ' class="text-error"' : "";
  showList(`<li class="menu-disabled"><span${tone}>${spinner}${escapeHtml(text)}</span></li>`);
  setActive(-1);
}

function showMatches(hits: CityHit[], query: string): void {
  matches = hits;
  if (hits.length === 0) return showMessage(`No cities match “${query}”`);
  showList(
    hits
      .map(
        (c, i) =>
          `<li role="presentation"><button type="button" role="option" id="city-opt-${i}" data-i="${i}" aria-selected="false" class="flex flex-col items-start gap-0 text-left">` +
          `<span class="font-medium">${escapeHtml(c.name)}</span>` +
          `<span class="text-xs opacity-60">${c.region ? `${escapeHtml(c.region)} · ` : ""}${escapeHtml(c.flag)} ${escapeHtml(c.country)}</span>` +
          `</button></li>`,
      )
      .join(""),
  );
  cityList.scrollTop = 0;
  setActive(0);
}

function closeResults(): void {
  clearTimeout(debounceTimer);
  searchAbort?.abort(); // a late response must not reopen the list
  cityList.hidden = true;
  cityInput.setAttribute("aria-expanded", "false");
  cityInput.removeAttribute("aria-activedescendant");
}

async function runSearch(query: string): Promise<void> {
  const ctrl = (searchAbort = new AbortController());
  try {
    let hits = searchMemo.get(query.toLocaleLowerCase());
    if (!hits) {
      hits = await getJson<CityHit[]>(`/api/cities/search?q=${encodeURIComponent(query)}`, { signal: ctrl.signal });
      searchMemo.set(query.toLocaleLowerCase(), hits);
    }
    if (!ctrl.signal.aborted) showMatches(hits, query);
  } catch (err) {
    if (!ctrl.signal.aborted) showMessage((err as Error).message, "error");
  }
}

/** Called on every keystroke: waits a beat for typing to pause, cancels any stale request, then searches. */
function scheduleSearch(): void {
  clearTimeout(debounceTimer);
  searchAbort?.abort();
  const query = cityInput.value.trim();
  if (query.length < 2) return showMessage("Type at least 2 letters of your city…");
  if (matches.length === 0 || cityList.hidden) showMessage("Searching…", "loading");
  debounceTimer = window.setTimeout(() => void runSearch(query), 120);
}

function chooseCity(c: CityHit): void {
  selectedCityId = c.id;
  selectedLabel = cityLabel(c);
  cityInput.value = selectedLabel;
  closeResults();
  updateSubmit();
}

function updateSubmit(): void {
  submitBtn.disabled = busy || !selectedCityId || !styleSel.value;
}

// ---- Find my location ------------------------------------------------------------

function getPosition(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) return reject(new Error("Geolocation isn't supported by this browser."));
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: false, // city-level is all we need; faster and less battery
      timeout: 10_000,
      maximumAge: 10 * 60_000,
    });
  });
}

async function findMyLocation(): Promise<void> {
  locateBtn.disabled = true;
  setStatus("Finding your location…", false, true);
  try {
    const pos = await getPosition();
    const hit = await getJson<{ cityId: string; city: string; region: string; country: string }>("/api/locate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
    });
    chooseCity({ id: hit.cityId, name: hit.city, region: hit.region, country: hit.country, flag: "" });
    setStatus(`Found you near ${hit.city}.`);
  } catch (err) {
    const msg =
      err instanceof GeolocationPositionError
        ? err.code === err.PERMISSION_DENIED
          ? "Location permission was denied — please search for your city instead."
          : "Couldn't determine your location — please search for your city instead."
        : (err as Error).message;
    setStatus(msg, true);
  } finally {
    locateBtn.disabled = false;
  }
}

// ---- Recommendation (streamed over SSE) --------------------------------------------

let busy = false;

function renderWeather(loc: Location, w: Weather): void {
  const place = [loc.city, loc.region, loc.country].filter(Boolean).map(escapeHtml).join(", ");
  const tile = (k: string, v: string) =>
    `<div class="stats bg-base-200"><div class="stat px-4 py-3"><div class="stat-title text-xs uppercase tracking-wider">${k}</div><div class="stat-value text-lg">${escapeHtml(v)}</div></div></div>`;
  const range = w.todayMinC !== null && w.todayMaxC !== null ? `${Math.round(w.todayMinC)}° / ${Math.round(w.todayMaxC)}°` : "—";
  weatherEl.innerHTML =
    `<div class="mb-4 flex items-center justify-between gap-4">` +
    `<div><h2 class="text-xl font-extrabold tracking-tight sm:text-2xl">${place}</h2>` +
    `<span class="badge badge-secondary badge-soft mt-1">${escapeHtml(w.condition)}</span></div>` +
    `<div class="text-5xl font-extrabold text-primary sm:text-6xl">${Math.round(w.temperatureC)}°</div></div>` +
    `<div class="grid grid-cols-2 gap-3 sm:grid-cols-3">` +
    tile("Feels like", `${Math.round(w.feelsLikeC)}°C`) +
    tile("Today", range) +
    tile("Rain chance", w.precipProbabilityMaxPct !== null ? `${w.precipProbabilityMaxPct}%` : "—") +
    tile("Wind", `${Math.round(w.windKph)} km/h`) +
    tile("Humidity", `${w.humidityPct}%`) +
    tile("UV max", w.uvIndexMax !== null ? String(Math.round(w.uvIndexMax)) : "—") +
    `</div>`;
}

let quotaText = "";

function updateQuota(res: Response): void {
  const remaining = res.headers.get("X-RateLimit-Remaining");
  const limit = res.headers.get("X-RateLimit-Limit");
  if (remaining !== null && limit !== null) {
    quotaText = `${remaining} of ${limit} recommendations left this hour.`;
    quotaEl.textContent = quotaText;
  }
}

/** Parses a text/event-stream body into {event, data} pairs as they arrive. */
async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = "message";
      const data: string[] = [];
      for (const line of chunk.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      }
      yield { event, data: data.join("\n") };
    }
  }
}

let currentRequest: AbortController | undefined;

function showForm(): void {
  currentRequest?.abort();
  resultEl.hidden = true;
  againBtn.hidden = true;
  form.hidden = false;
  setStatus("");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function recommend(e: SubmitEvent): Promise<void> {
  e.preventDefault();
  if (busy || !selectedCityId || !styleSel.value) return;
  busy = true;
  updateSubmit();
  setStatus("Checking the weather…", false, true);
  resultEl.hidden = true;
  againBtn.hidden = true;
  outfitEl.innerHTML = "";
  metaEl.textContent = "";

  const request = (currentRequest = new AbortController());
  let text = "";
  let frame = 0;
  try {
    const res = await fetch("/api/recommend", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cityId: selectedCityId, style: styleSel.value }),
      signal: request.signal,
    });
    updateQuota(res);
    if (!res.ok || !res.body) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `Request failed (${res.status})`);
    }

    // Batch DOM updates to one per animation frame, however fast tokens arrive.
    const scheduleRender = () => {
      frame ||= requestAnimationFrame(() => {
        frame = 0;
        outfitEl.innerHTML = renderOutfit(text);
      });
    };

    for await (const { event, data } of readSse(res.body)) {
      const payload: unknown = JSON.parse(data);
      if (event === "weather") {
        const { location, weather } = payload as { location: Location; weather: Weather };
        renderWeather(location, weather);
        // Results page: hide the questions, show the recommendation.
        form.hidden = true;
        resultEl.hidden = false;
        window.scrollTo({ top: 0 });
        outfitEl.insertAdjacentHTML("afterend", '<span id="typing" class="loading loading-dots loading-sm self-center text-primary"></span>');
        setStatus("", false, false);
      } else if (event === "delta") {
        text += payload as string;
        scheduleRender();
      } else if (event === "done") {
        metaEl.textContent = quotaText;
      } else if (event === "error") {
        throw new Error((payload as { error: string }).error);
      }
    }
  } catch (err) {
    if (!request.signal.aborted) {
      const msg = (err as Error).message;
      if (resultEl.hidden) setStatus(msg, true);
      else {
        // Failed after the results page opened: show the error there.
        outfitEl.innerHTML = renderOutfit(text) + `<div role="alert" class="alert alert-error alert-soft mt-4 text-sm">${escapeHtml(msg)}</div>`;
      }
    }
  } finally {
    cancelAnimationFrame(frame);
    if (!resultEl.hidden && !request.signal.aborted) {
      const html = renderOutfit(text);
      if (html && !outfitEl.querySelector('[role="alert"]')) outfitEl.innerHTML = html;
      againBtn.hidden = false;
    }
    document.getElementById("typing")?.remove();
    busy = false;
    updateSubmit();
  }
}

// ---- Wire up -----------------------------------------------------------------------

// Results update live on every keystroke.
cityInput.addEventListener("input", () => {
  selectedCityId = ""; // typing invalidates a previous pick
  updateSubmit();
  scheduleSearch();
});
cityInput.addEventListener("focus", () => {
  if (selectedCityId) cityInput.select();
  else scheduleSearch();
});
cityInput.addEventListener("blur", () => {
  closeResults();
  // Restore the chosen city's name if the user typed over it and left.
  if (selectedCityId) cityInput.value = selectedLabel;
});
cityInput.addEventListener("keydown", (e) => {
  const open = !cityList.hidden;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    if (!open) return scheduleSearch();
    if (!matches.length) return;
    const step = e.key === "ArrowDown" ? 1 : -1;
    setActive((activeIdx + step + matches.length) % matches.length);
  } else if (e.key === "Enter" && open) {
    e.preventDefault(); // don't submit the form while picking a city
    const pick = matches[activeIdx];
    if (pick) chooseCity(pick);
  } else if (e.key === "Escape" && open) {
    e.preventDefault();
    closeResults();
  }
});
// mousedown (not click) fires before the input's blur, so the pick isn't lost.
cityList.addEventListener("mousedown", (e) => {
  e.preventDefault();
  const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-i]");
  const pick = btn ? matches[Number(btn.dataset.i)] : undefined;
  if (pick) chooseCity(pick);
});
cityList.addEventListener("mousemove", (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-i]");
  if (btn && Number(btn.dataset.i) !== activeIdx) setActive(Number(btn.dataset.i));
});
styleSel.addEventListener("change", updateSubmit);
againBtn.addEventListener("click", showForm);
locateBtn.addEventListener("click", () => void findMyLocation());
form.addEventListener("submit", (e) => void recommend(e));
