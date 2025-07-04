import { Pool } from "pg";
import { config } from "(src)/config/configuration";
import { Logger } from "(src)/helpers/Logger";

const logger = new Logger("DataBaseService");

if (!config.production.db.databaseUrl) {
	throw new Error("The environment variable 'DATABASE_URL' is not defined.");
}

export class PostgresAdapter {
	private static instance: PostgresAdapter;
	private readonly _pool: Pool;

	private constructor() {
		this._pool = new Pool({
			connectionString: config.production.db.databaseUrl,
			// ssl: process.env.NODE_ENV === "production" ? {rejectUnauthorized: false} : false
			ssl: false
		});
	}

	public static getInstance(): PostgresAdapter {
		if (!PostgresAdapter.instance) {
			PostgresAdapter.instance = new PostgresAdapter();
		}
		return PostgresAdapter.instance;
	}

	public get pool(): Pool {
		return this._pool;
	}

	public async query(query: string, values: any[]): Promise<any> {
		try {
			const {rows} = await this._pool.query(query, values);

			return rows;
		} catch (error) {
			logger.error("query", {query, values, error});

			return undefined;
		}
	}

	public async disconnect(): Promise<void> {
		logger.info("Disconnecting from database...");
		try {
			await this._pool.end();
			logger.info("Database connections closed successfully");
		} catch (error) {
			logger.error("Error closing database connections:", error);
		}
	}
}
