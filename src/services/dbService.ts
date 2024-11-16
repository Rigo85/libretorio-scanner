import { Pool } from "pg";
import * as dotenv from "dotenv";

import { Logger } from "(src)/helpers/Logger";
import { ScanRootResult } from "(src)/services/Scanner";
import { File } from "(src)/helpers/FileUtils";

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
		logger.error("executeQuery", {query, values, error});

		return undefined;
	}
}

export async function getScanRootByPath(path: string): Promise<ScanRoot> {
	logger.info("getScanRoot by path:", path);

	try {
		const query = "SELECT * FROM scan_root WHERE path = $1";
		const rows = await executeQuery(query, [path]);

		if (!rows?.length) {
			logger.error(`Scan root with path "${path}" not found.`);

			return undefined;
		}

		return rows[0];
	} catch (error) {
		logger.error("getScanRootByPath", error.message);

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
		logger.error("getScanRoots", error.message);

		return [];
	}
}

export async function updateScanRoot(directories: string, id: number): Promise<number> {
	logger.info(`updateScanRoot: "${id}"`);

	try {
		const query = `
			UPDATE scan_root SET directories = $1 WHERE id = $2
			RETURNING id
		`;

		const values = [directories, id];
		const scanRootIds = await executeQuery(query, values);

		if (!scanRootIds?.length) {
			logger.error(`Error updating scan root "${id}".`);

			return undefined;
		}

		const scanRootId = scanRootIds[0].id;
		logger.info(`Updated scan root with id: "${scanRootId}".`);

		return scanRootId;
	} catch (error) {
		logger.error(`insertScanRoot "${id}":`, error.message);

		return undefined;
	}
}

export async function insertScanRoot(scanResults: ScanRootResult): Promise<ScanRoot> {
	logger.info(`insertScanRoot: "${scanResults.root}"`);

	try {
		const query = `
			INSERT INTO scan_root (timestamp, path, directories) 
			VALUES ($1, $2, $3)
			RETURNING *
		`;
		const values = [new Date(), scanResults.root, scanResults.scan.directories];
		const scanRoot = await executeQuery(query, values);
		if (!scanRoot?.length) {
			logger.error(`Error inserting scan root "${scanResults.root}".`);

			return undefined;
		}

		logger.info(`Inserted scan root: "${scanResults.root}" with id: "${scanRoot[0].id}"`);

		return scanRoot[0];
	} catch (error) {
		logger.error(`insertScanRoot "${scanResults.root}":`, error.message);

		return undefined;
	}
}

export async function insertFile(file: File, scanRootId: number): Promise<number> {
	logger.info(`insertFile: "${file.name}" for scan root: "${scanRootId}".`);

	try {
		const query = `
			INSERT INTO archive (name, "parentPath", "parentHash", "fileHash", "localDetails", "webDetails", "size", "coverId", scan_root_id, "fileKind")
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            RETURNING id
        `;
		const values = [file.name, file.parentPath, file.parentHash, file.fileHash, file.localDetails, file.webDetails, file.size, file.coverId, scanRootId, file.fileKind];

		const fileIds = await executeQuery(query, values);

		if (!fileIds?.length) {
			logger.error(`Error inserting file: "${file.name}" for scan root: "${scanRootId}".`);

			return undefined;
		}

		// logger.info(`Inserted file "${file.name}" with id: "${fileId}" for scan root: "${scanRootId}"`);

		return fileIds[0].id;
	} catch (error) {
		logger.error(`insertFile "${scanRootId}":`, error.message);

		return undefined;
	}
}

export async function removeFileByParentHash(hashes: string[]): Promise<number> {
	logger.info(`removeFileByParentHash: parent hashes length="${hashes.length}".`);

	try {
		const query = `
			DELETE FROM archive a WHERE a."parentHash" <> ALL($1)
			RETURNING a.id;
			`;
		const values = [hashes];

		const removesFiles = await executeQuery(query, values);

		return (removesFiles || []).length;
	} catch (error) {
		logger.error(`removeFileByParentHash parent hashes length="${hashes.length}":`, error.message);

		return 0;
	}
}

export async function removeFileByFileHash(hashes: string[]): Promise<number> {
	logger.info(`removeFileByFileHash: file hashes length="${hashes.length}".`);

	try {
		const query = `
			DELETE FROM archive a 
			WHERE "fileHash" = ANY($1::text[])
            RETURNING a.id;
		`;
		const values = [hashes];

		const removesFiles = await executeQuery(query, values);

		return (removesFiles || []).length;
	} catch (error) {
		logger.error(`removeFileByFileHash file hashes length="${hashes.length}":`, error.message);

		return 0;
	}
}

export async function getFileHashes(scanRootId: number): Promise<{ hash: string }[]> {
	logger.info(`getFileHashes for scan root: "${scanRootId}".`);

	try {
		const query = `
			SELECT "fileHash" as "hash"
			FROM archive WHERE scan_root_id = $1
		`;
		const values = [scanRootId];

		const hashes = await executeQuery(query, values);

		return hashes || [];
	} catch (error) {
		logger.error(`getFileHashes "${scanRootId}":`, error.message);

		return [];
	}
}

export async function getSpecialArchives(scanRootId: number): Promise<File[]> {
	logger.info(`getSpecialArchives for scan root: "${scanRootId}".`);

	try {
		const query = `
            SELECT *
            FROM archive 
            WHERE 
	            scan_root_id = $1 AND 
	            "fileKind" <> 'FILE' AND 
	            "fileKind" <> 'NONE'
		`;
		const values = [scanRootId];

		const files = await executeQuery(query, values);

		return files || [];
	} catch (error) {
		logger.error(`getSpecialArchives "${scanRootId}":`, error.message);

		return [];
	}
}

export async function updateSpecialArchiveSize(id: number, size: string): Promise<number> {
	logger.info(`updateSpecialArchiveSize: "${id}".`);

	try {
		const query = `
			UPDATE archive SET size = $1 WHERE id = $2
			RETURNING id
		`;

		const values = [size, id];
		const fileIds = await executeQuery(query, values);

		if (!fileIds?.length) {
			logger.error(`Error updating special archive size "${id}".`);

			return undefined;
		}

		const fileId = fileIds[0].id;
		logger.info(`Updated special archive size with id: "${fileId}".`);

		return fileId;
	} catch (error) {
		logger.error(`updateSpecialArchiveSize "${id}":`, error.message);

		return undefined;
	}
}
