import path from "path";
import * as dotenv from "dotenv";

dotenv.config({path: ".env"});

function getMinOneInt(value: string | undefined, fallback: number): number {
	const parsed = parseInt(value || `${fallback}`);
	return Number.isFinite(parsed) && parsed >= 1 ? parsed : fallback;
}

function getBoolean(value: string | undefined, fallback: boolean): boolean {
	if (value === undefined) {
		return fallback;
	}

	const normalized = value.trim().toLowerCase();
	if (normalized === "true") return true;
	if (normalized === "false") return false;
	return fallback;
}

function getClampedInt(value: string | undefined, fallback: number, min: number, max: number): number {
	const parsed = parseInt(value || `${fallback}`);
	if (!Number.isFinite(parsed)) {
		return fallback;
	}

	return Math.min(max, Math.max(min, parsed));
}

export const config = {
	production: {
		db: {
			databaseUrl: process.env.DATABASE_URL,
			redisUrl: process.env.REDIS_URL
		},
		server: {
			port: parseInt(process.env.PORT || "3006"),
			environment: process.env.NODE_ENV || "development"
		},
		paths: {
			scanRoot: path.join(__dirname, "..", "public", "books"),
			cache: path.join(__dirname, "..", "public", "cache"),
			temp: path.join(__dirname, "..", "tmp")
		},
		scan: {
			openLibrary: (process.env.CAN_USE_OPENLIBRARY_API || "false").toLowerCase() === "true",
			cron: process.env.CRON_SCHEDULE || "0 */1 * * *",
			action: process.env.ACTION || "update-books-info",
			concurrency: getMinOneInt(process.env.SCAN_CONCURRENCY, 4),
			cacheConcurrency: getMinOneInt(process.env.SCAN_CACHE_CONCURRENCY, 1),
			cacheChunkBytes: parseInt(process.env.SCAN_CACHE_CHUNK_BYTES || `${10 * 1024 * 1024}`),
			cacheProbe: {
				enabled: getBoolean(process.env.SCAN_CACHE_PROBE_ENABLED, true),
				maxEntries: getMinOneInt(process.env.SCAN_CACHE_PROBE_MAX_ENTRIES, 40),
				minImages: getMinOneInt(process.env.SCAN_CACHE_PROBE_MIN_IMAGES, 8)
			},
			cacheResize: {
				enabled: getBoolean(process.env.SCAN_CACHE_RESIZE_ENABLED, true),
				readerMaxDimension: getClampedInt(process.env.SCAN_CACHE_READER_MAX_DIMENSION, 2400, 512, 10000),
				readerQuality: getClampedInt(process.env.SCAN_CACHE_READER_QUALITY, 82, 1, 100),
				readerFormat: (process.env.SCAN_CACHE_READER_FORMAT || "jpeg").toLowerCase() === "webp" ? "webp" : "jpeg",
				vipsConcurrency: getMinOneInt(process.env.SCAN_CACHE_VIPS_CONCURRENCY, 1)
			}
		}
	},
	development: {}
};
