import { PoolClient } from "pg";

import { PostgresAdapter } from "(src)/db/PostgresAdapter";
import { Logger } from "(src)/helpers/Logger";
import { CacheArtifactStateRow } from "(src)/models/interfaces/CacheArtifactSnapshot";

const logger = new Logger("CacheArtifactStateRepository");

const TABLE_NAME = "cache_artifact_state";
const TEMP_TABLE_NAME = "cache_artifact_state_snapshot";
const COLUMN_SQL = `
	cover_id TEXT PRIMARY KEY,
	reader_ready BOOLEAN NOT NULL,
	zip_ready BOOLEAN NOT NULL,
	status TEXT NULL,
	build_outcome TEXT NULL,
	chunk_count INTEGER NULL,
	total_pages INTEGER NULL,
	updated_at TIMESTAMPTZ NOT NULL,
	last_error TEXT NULL
`;
const INSERT_COLUMNS = [
	"cover_id",
	"reader_ready",
	"zip_ready",
	"status",
	"build_outcome",
	"chunk_count",
	"total_pages",
	"updated_at",
	"last_error"
];

export class CacheArtifactStateRepository {
	private static instance: CacheArtifactStateRepository;

	private constructor() {
	}

	public static getInstance(): CacheArtifactStateRepository {
		if (!CacheArtifactStateRepository.instance) {
			CacheArtifactStateRepository.instance = new CacheArtifactStateRepository();
		}
		return CacheArtifactStateRepository.instance;
	}

	public async replaceSnapshot(rows: CacheArtifactStateRow[]): Promise<boolean> {
		const client = await PostgresAdapter.getInstance().pool.connect();

		try {
			await client.query("BEGIN");
			await this.ensureTable(client);
			await client.query(`CREATE TEMP TABLE ${TEMP_TABLE_NAME} (${COLUMN_SQL}) ON COMMIT DROP`);

			for (let index = 0; index < rows.length; index += 500) {
				await this.insertBatch(client, TEMP_TABLE_NAME, rows.slice(index, index + 500));
			}

			await client.query(`TRUNCATE ${TABLE_NAME}`);
			await client.query(
				`INSERT INTO ${TABLE_NAME} (${INSERT_COLUMNS.join(", ")}) ` +
				`SELECT ${INSERT_COLUMNS.join(", ")} FROM ${TEMP_TABLE_NAME}`
			);
			await client.query("COMMIT");
			return true;
		} catch (error) {
			await client.query("ROLLBACK");
			logger.error("replaceSnapshot:", error);
			return false;
		} finally {
			client.release();
		}
	}

	private async ensureTable(client: PoolClient): Promise<void> {
		await client.query(`CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (${COLUMN_SQL})`);
	}

	private async insertBatch(client: PoolClient, tableName: string, rows: CacheArtifactStateRow[]): Promise<void> {
		if (!rows.length) {
			return;
		}

		const values: Array<boolean | number | string | undefined> = [];
		const placeholders = rows.map((row: CacheArtifactStateRow, rowIndex: number) => {
			const base = rowIndex * INSERT_COLUMNS.length;
			values.push(
				row.coverId,
				row.readerReady,
				row.zipReady,
				row.status,
				row.buildOutcome,
				row.chunkCount,
				row.totalPages,
				row.updatedAt,
				row.lastError
			);
			return `(${INSERT_COLUMNS.map((_, columnIndex: number) => `$${base + columnIndex + 1}`).join(", ")})`;
		});

		await client.query(
			`INSERT INTO ${tableName} (${INSERT_COLUMNS.join(", ")}) VALUES ${placeholders.join(", ")}`,
			values
		);
	}
}
