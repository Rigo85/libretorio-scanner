import { Pool } from "pg";
import * as dotenv from "dotenv";

import { Logger } from "(src)/helpers/Logger";
import { File, ScanRootResult } from "(src)/services/Scanner";

dotenv.config({path: ".env"});

const logger = new Logger("DB Service");

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
	throw new Error("The environment variable 'DATABASE_URL' is not defined.");
}

const pool = new Pool({
	connectionString: databaseUrl,
	// ssl: process.env.NODE_ENV === "production" ? {rejectUnauthorized: false} : false
	ssl: false
});

export interface ScanRoot {
	id: number;
	timestamp: Date;
	path: string;
	directories: string;
}

async function executeQuery(query: string, values: any[]): Promise<any> {
	try {
		const {rows} = await pool.query(query, values);

		return rows;
	} catch (error) {
		logger.error("executeQuery", error);

		return undefined;
	}
}

export async function getScanRoots(): Promise<ScanRoot[]> {
	logger.info("getScanRoots");

	try {
		const query = "SELECT * FROM scan_root";
		const rows = await executeQuery(query, []);

		return rows || [];
	} catch (error) {
		logger.error("getScanRoots", error);

		return [];
	}
}

export async function insertScanRoot(scanResults: ScanRootResult): Promise<number> {
	logger.info(`insertScanRoot: "${scanResults.root}"`);

	try {
		const query = `
			INSERT INTO scan_root (timestamp, path, directories) 
			VALUES ($1, $2, $3)
			RETURNING id
		`;
		const values = [new Date(), scanResults.root, scanResults.scan.directories];
		const scanRootIds = await executeQuery(query, values);
		if (!scanRootIds || scanRootIds.length === 0) {
			throw new Error(`Error inserting scan root "${scanResults.root}".`);
		}

		const scanRootId = scanRootIds[0].id;
		logger.info(`Inserted scan root: "${scanResults.root}" with id: "${scanRootId}"`);

		return scanRootId;
	} catch (error) {
		logger.error(`insertScanRoot "${scanResults.root}":`, error);

		return undefined;
	}
}

export async function insertFile(file: File, scanRootId: number): Promise<number> {
	logger.info(`insertFile: "${file.name}" for scan root: "${scanRootId}"`);

	try {
		const query = `
			INSERT INTO archive (name, "parentPath", "parentHash", "localDetails", "webDetails", scan_root_id)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING id
        `;
		const values = [file.name, file.parentPath, file.parentHash, file.localDetails, file.webDetails, scanRootId];

		const fileIds = await executeQuery(query, values);

		if (!fileIds || fileIds.length === 0) {
			throw new Error(`Error inserting file: "${file.name}" for scan root: "${scanRootId}".`);
		}

		const fileId = fileIds[0].id;
		logger.info(`Inserted file "${file.name}" with id: "${fileId}" for scan root: "${scanRootId}"`);

		return fileId;
	} catch (error) {
		logger.error(`insertFile "${scanRootId}":`, error);

		return undefined;
	}
}

