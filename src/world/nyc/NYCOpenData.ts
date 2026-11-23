import type { GeographicBounds } from './NYCGeo';

export interface NYCGeoJSONGeometry { type: string; coordinates: unknown; }
export interface NYCGeoJSONFeature {
  type: 'Feature';
  id?: string | number;
  properties: Record<string, unknown>;
  geometry: NYCGeoJSONGeometry | null;
}
export interface NYCFeatureCollection {
  type: 'FeatureCollection';
  features: NYCGeoJSONFeature[];
}

export const NYC_DATASETS = {
  buildings: {
    id: '5zhs-2jue',
    title: 'NYC Building Footprints',
    attribution: 'NYC Open Data / NYC Office of Technology and Innovation',
  },
  streets: {
    id: 'inkn-q76z',
    title: 'NYC Street Centerline (CSCL)',
    attribution: 'NYC Open Data / NYC Office of Technology and Innovation',
  },
  signWorkOrders: {
    id: 'qt6m-xctn',
    title: 'Street Sign Work Orders',
    attribution: 'NYC Open Data / NYC Department of Transportation',
    integrated: false,
  },
} as const;

const PAGE_SIZE = 4000;
const MAX_PAGES = 5;
const REQUEST_TIMEOUT_MS = 25000;

function isFeatureCollection(value: unknown): value is NYCFeatureCollection {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { type?: unknown; features?: unknown };
  return candidate.type === 'FeatureCollection' && Array.isArray(candidate.features);
}

function isValidFeature(value: unknown): value is NYCGeoJSONFeature {
  if (!value || typeof value !== 'object') return false;
  const feature = value as { type?: unknown; properties?: unknown; geometry?: unknown };
  if (feature.type !== 'Feature' || !feature.properties || typeof feature.properties !== 'object') {
    return false;
  }
  if (!feature.geometry || typeof feature.geometry !== 'object') return false;
  const geometry = feature.geometry as { type?: unknown; coordinates?: unknown };
  return typeof geometry.type === 'string' && geometry.coordinates !== undefined;
}

export class NYCOpenDataClient {
  constructor(
    private readonly fetcher: typeof fetch = fetch,
    private readonly pageSize = PAGE_SIZE,
  ) {}

  loadBuildings(bounds: GeographicBounds, signal?: AbortSignal): Promise<NYCFeatureCollection> {
    return this.queryDataset(NYC_DATASETS.buildings.id, bounds, signal);
  }

  loadStreetCenterlines(bounds: GeographicBounds, signal?: AbortSignal): Promise<NYCFeatureCollection> {
    return this.queryDataset(NYC_DATASETS.streets.id, bounds, signal);
  }

  /**
   * Queries only the active geographic envelope. Results remain in memory for
   * the lifetime of their streamed chunk; no static source-data export is made.
   */
  async queryDataset(
    datasetId: string,
    bounds: GeographicBounds,
    signal?: AbortSignal,
  ): Promise<NYCFeatureCollection> {
    if (!Number.isFinite(bounds.north) || !Number.isFinite(bounds.south)
      || !Number.isFinite(bounds.east) || !Number.isFinite(bounds.west)
      || bounds.north <= bounds.south || bounds.east <= bounds.west) {
      throw new RangeError('Invalid geographic bounds supplied to NYC Open Data.');
    }

    const features: NYCGeoJSONFeature[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const url = new URL('https://data.cityofnewyork.us/resource/' + datasetId + '.geojson');
      url.searchParams.set('$select', '*');
      url.searchParams.set(
        '$where',
        'within_box(the_geom,' + bounds.north + ',' + bounds.west + ','
          + bounds.south + ',' + bounds.east + ')',
      );
      url.searchParams.set('$limit', String(this.pageSize));
      url.searchParams.set('$offset', String(page * this.pageSize));

      const timeout = new AbortController();
      const timeoutId = setTimeout(() => timeout.abort(), REQUEST_TIMEOUT_MS);
      const abortFromCaller = (): void => timeout.abort();
      signal?.addEventListener('abort', abortFromCaller, { once: true });

      let response: Response;
      try {
        response = await this.fetcher(url, {
          method: 'GET',
          headers: { Accept: 'application/geo+json, application/json' },
          signal: timeout.signal,
        });
      } finally {
        clearTimeout(timeoutId);
        signal?.removeEventListener('abort', abortFromCaller);
      }

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(
          'NYC Open Data request failed (' + response.status + ') for dataset '
          + datasetId + ': ' + detail.slice(0, 240),
        );
      }

      const payload: unknown = await response.json();
      if (!isFeatureCollection(payload)) {
        throw new Error('NYC Open Data returned an unexpected GeoJSON FeatureCollection.');
      }
      features.push(...payload.features.filter(isValidFeature));

      if (payload.features.length < this.pageSize) {
        return { type: 'FeatureCollection', features };
      }
    }

    throw new Error(
      'NYC Open Data result exceeded the safe page limit for dataset ' + datasetId
      + '; refusing to treat a truncated response as complete.',
    );
  }
}
