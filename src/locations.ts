import { City, Country, State } from "country-state-city";

export interface CountryOption {
  code: string;
  name: string;
  flag: string;
}

export interface CityOption {
  /** Stable id: `${countryCode}:${index}` into the dataset's (unsorted) city list for that country. */
  id: string;
  name: string;
  region: string;
  lat: number;
  lon: number;
}

export interface ResolvedLocation {
  city: string;
  region: string;
  country: string;
  countryCode: string;
  lat: number;
  lon: number;
}

// Built once at startup — the dataset is static.
const countries: CountryOption[] = Country.getAllCountries()
  .map((c) => ({ code: c.isoCode, name: c.name, flag: c.flag }))
  .sort((a, b) => a.name.localeCompare(b.name));

const countryByCode = new Map(countries.map((c) => [c.code, c]));

// City lists are built lazily per country and memoised.
const cityCache = new Map<string, CityOption[]>();
const cityById = new Map<string, CityOption>();

export function listCountries(): CountryOption[] {
  return countries;
}

export function getCountry(code: string): CountryOption | undefined {
  return countryByCode.get(code.toUpperCase());
}

export function listCities(countryCode: string): CityOption[] {
  const code = countryCode.toUpperCase();
  const cached = cityCache.get(code);
  if (cached) return cached;
  if (!countryByCode.has(code)) return [];

  const regionNames = new Map(State.getStatesOfCountry(code).map((s) => [s.isoCode, s.name]));
  const raw = City.getCitiesOfCountry(code) ?? [];

  const cities = raw
    .map((c, i) => ({
      id: `${code}:${i}`,
      name: c.name,
      region: regionNames.get(c.stateCode) ?? "",
      lat: Number(c.latitude),
      lon: Number(c.longitude),
    }))
    .filter((c) => Number.isFinite(c.lat) && Number.isFinite(c.lon))
    .sort((a, b) => a.name.localeCompare(b.name) || a.region.localeCompare(b.region));

  cityCache.set(code, cities);
  for (const c of cities) cityById.set(c.id, c);
  return cities;
}

export function resolveCity(cityId: string): ResolvedLocation | undefined {
  const [code] = cityId.split(":");
  if (!code) return undefined;
  const country = getCountry(code);
  if (!country) return undefined;
  listCities(code); // ensure the country's cities are indexed
  const city = cityById.get(cityId);
  if (!city) return undefined;
  return {
    city: city.name,
    region: city.region,
    country: country.name,
    countryCode: country.code,
    lat: city.lat,
    lon: city.lon,
  };
}

// ---- Nearest-city lookup for "find my location" -----------------------------
// Done fully offline against the bundled dataset, so the user's coordinates
// never leave this server. Uses packed typed arrays for a fast linear scan.

interface GeoIndex {
  lat: Float64Array;
  lon: Float64Array;
  ids: string[]; // CityOption.id for each slot
}

let geoIndex: GeoIndex | undefined;

function buildGeoIndex(): GeoIndex {
  const all = countries.flatMap((c) => listCities(c.code));
  const lat = new Float64Array(all.length);
  const lon = new Float64Array(all.length);
  const ids: string[] = new Array(all.length);
  all.forEach((c, i) => {
    lat[i] = c.lat;
    lon[i] = c.lon;
    ids[i] = c.id;
  });
  return { lat, lon, ids };
}

/** Builds the nearest-city and city-search indexes ahead of the first request. */
export function warmGeoIndex(): void {
  geoIndex ??= buildGeoIndex();
  searchIndex ??= buildSearchIndex();
}

// ---- Search across every country -----------------------------------------------
// ~150k cities are indexed in memory with pre-normalised keys, so a query is a
// single fast scan on the server and the browser only ever receives ~30 results.

export interface CitySearchResult {
  id: string;
  name: string;
  region: string;
  country: string;
  flag: string;
}

interface SearchEntry extends CitySearchResult {
  nameKey: string;
  fullKey: string;
}

let searchIndex: SearchEntry[] | undefined;

/** Lower-case and strip accents so "sao paulo" finds "São Paulo". */
const norm = (s: string): string => s.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase().trim();

function buildSearchIndex(): SearchEntry[] {
  return countries.flatMap((c) =>
    listCities(c.code).map((city) => {
      const nameKey = norm(city.name);
      return {
        id: city.id,
        name: city.name,
        region: city.region,
        country: c.name,
        flag: c.flag,
        nameKey,
        fullKey: `${nameKey} ${norm(city.region)} ${norm(c.name)}`,
      };
    }),
  );
}

/**
 * Finds cities in any country. Every word typed must appear in the city, region
 * or country name, so "paris", "paris texas" and "paris, france" all work.
 * Ranking: exact name, name starts with the query, name contains it, other.
 */
export function searchCities(query: string, limit = 30): CitySearchResult[] {
  const tokens = norm(query).split(/[\s,]+/).filter(Boolean);
  const first = tokens[0];
  if (!first) return [];
  searchIndex ??= buildSearchIndex();

  const joined = tokens.join(" ");
  const buckets: SearchEntry[][] = [[], [], [], []];
  for (const e of searchIndex) {
    if (!tokens.every((t) => e.fullKey.includes(t))) continue;
    const rank = e.nameKey === joined ? 0 : e.nameKey.startsWith(first) ? 1 : e.nameKey.includes(first) ? 2 : 3;
    buckets[rank]!.push(e);
  }

  const out: CitySearchResult[] = [];
  for (const b of buckets) {
    if (out.length >= limit) break;
    // Shorter names first ("Paris" before "Parisot"); sort is stable, so ties keep A–Z order.
    b.sort((x, y) => x.nameKey.length - y.nameKey.length);
    for (const e of b) {
      if (out.length >= limit) break;
      out.push({ id: e.id, name: e.name, region: e.region, country: e.country, flag: e.flag });
    }
  }
  return out;
}

const toRad = (d: number) => (d * Math.PI) / 180;

export function nearestCity(lat: number, lon: number): { countryCode: string; cityId: string; distanceKm: number } | undefined {
  geoIndex ??= buildGeoIndex();
  const g = geoIndex;
  const cosLat = Math.cos(toRad(lat));
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < g.lat.length; i++) {
    // Equirectangular approximation is plenty for ranking candidates.
    let dLon = Math.abs(g.lon[i]! - lon);
    if (dLon > 180) dLon = 360 - dLon;
    const x = dLon * cosLat;
    const y = g.lat[i]! - lat;
    const d = x * x + y * y;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  if (best < 0) return undefined;

  const cityId = g.ids[best]!;
  const countryCode = cityId.slice(0, cityId.indexOf(":"));
  return { countryCode, cityId, distanceKm: Math.sqrt(bestD) * 111.2 };
}
