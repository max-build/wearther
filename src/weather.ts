import { AsyncTtlCache } from "./cache.js";
import { config } from "./config.js";

/** Normalised weather reading passed to the UI and to the LLM. */
export interface WeatherReading {
  observedAt: string; // local time at the location, ISO without offset
  timezone: string;
  isDay: boolean;
  condition: string;
  temperatureC: number;
  feelsLikeC: number;
  humidityPct: number;
  precipitationMm: number;
  windKph: number;
  windGustKph: number;
  cloudCoverPct: number;
  uvIndexMax: number | null;
  todayMinC: number | null;
  todayMaxC: number | null;
  precipProbabilityMaxPct: number | null;
}

export class WeatherError extends Error {}

// WMO weather interpretation codes used by Open-Meteo.
const WMO: Record<number, string> = {
  0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
  45: "Fog", 48: "Depositing rime fog",
  51: "Light drizzle", 53: "Moderate drizzle", 55: "Dense drizzle",
  56: "Light freezing drizzle", 57: "Dense freezing drizzle",
  61: "Slight rain", 63: "Moderate rain", 65: "Heavy rain",
  66: "Light freezing rain", 67: "Heavy freezing rain",
  71: "Slight snowfall", 73: "Moderate snowfall", 75: "Heavy snowfall", 77: "Snow grains",
  80: "Slight rain showers", 81: "Moderate rain showers", 82: "Violent rain showers",
  85: "Slight snow showers", 86: "Heavy snow showers",
  95: "Thunderstorm", 96: "Thunderstorm with slight hail", 99: "Thunderstorm with heavy hail",
};

interface OpenMeteoResponse {
  timezone: string;
  current: {
    time: string;
    temperature_2m: number;
    apparent_temperature: number;
    relative_humidity_2m: number;
    precipitation: number;
    weather_code: number;
    cloud_cover: number;
    wind_speed_10m: number;
    wind_gusts_10m: number;
    is_day: number;
  };
  daily?: {
    temperature_2m_min?: (number | null)[];
    temperature_2m_max?: (number | null)[];
    uv_index_max?: (number | null)[];
    precipitation_probability_max?: (number | null)[];
  };
}

const cache = new AsyncTtlCache<WeatherReading>(config.weatherCacheMs);

/**
 * Fetches current conditions from Open-Meteo (free, no API key).
 * Results are cached for 10 minutes per ~1 km grid cell, and concurrent
 * requests for the same cell share one upstream call.
 */
export function getWeather(lat: number, lon: number): Promise<WeatherReading> {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  return cache.get(key, () => fetchWeather(lat, lon));
}

async function fetchWeather(lat: number, lon: number): Promise<WeatherReading> {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.search = new URLSearchParams({
    latitude: lat.toFixed(4),
    longitude: lon.toFixed(4),
    current: [
      "temperature_2m", "apparent_temperature", "relative_humidity_2m", "precipitation",
      "weather_code", "cloud_cover", "wind_speed_10m", "wind_gusts_10m", "is_day",
    ].join(","),
    daily: "temperature_2m_min,temperature_2m_max,uv_index_max,precipitation_probability_max",
    forecast_days: "1",
    timezone: "auto",
    wind_speed_unit: "kmh",
  }).toString();

  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(config.upstreamTimeoutMs) });
  } catch (err) {
    throw new WeatherError(`Weather service unreachable: ${(err as Error).message}`);
  }
  if (!res.ok) throw new WeatherError(`Weather service returned HTTP ${res.status}`);

  const data = (await res.json()) as OpenMeteoResponse;
  const c = data.current;
  const d = data.daily;
  const round = (n: number) => Math.round(n * 10) / 10;

  return {
    observedAt: c.time,
    timezone: data.timezone,
    isDay: c.is_day === 1,
    condition: WMO[c.weather_code] ?? `Weather code ${c.weather_code}`,
    temperatureC: round(c.temperature_2m),
    feelsLikeC: round(c.apparent_temperature),
    humidityPct: c.relative_humidity_2m,
    precipitationMm: c.precipitation,
    windKph: round(c.wind_speed_10m),
    windGustKph: round(c.wind_gusts_10m),
    cloudCoverPct: c.cloud_cover,
    uvIndexMax: d?.uv_index_max?.[0] ?? null,
    todayMinC: d?.temperature_2m_min?.[0] ?? null,
    todayMaxC: d?.temperature_2m_max?.[0] ?? null,
    precipProbabilityMaxPct: d?.precipitation_probability_max?.[0] ?? null,
  };
}
