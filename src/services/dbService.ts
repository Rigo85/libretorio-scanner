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
		logger.error("executeQuery", error);

		return undefined;
	}
}

export async function getScanRoot(scanRootId: number): Promise<ScanRoot> {
	logger.info("getScanRoot by id:", scanRootId);

	try {
		const query = "SELECT * FROM scan_root WHERE id = $1";
		const rows = await executeQuery(query, [scanRootId]);

		if (!rows || !rows.length) {
			throw new Error(`Scan root with id "${scanRootId}" not found.`);
		}

		return rows[0];
	} catch (error) {
		logger.error("getScanRoots", error.message);

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

		if (!scanRootIds || scanRootIds.length === 0) {
			throw new Error(`Error updating scan root "${id}".`);
		}

		const scanRootId = scanRootIds[0].id;
		logger.info(`Updated scan root with id: "${scanRootId}"`);

		return scanRootId;
	} catch (error) {
		logger.error(`insertScanRoot "${id}":`, error.message);

		return undefined;
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
		logger.error(`insertScanRoot "${scanResults.root}":`, error.message);

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

		// logger.info(`Inserted file "${file.name}" with id: "${fileId}" for scan root: "${scanRootId}"`);

		return fileIds[0].id;
	} catch (error) {
		logger.error(`insertFile "${scanRootId}":`, error.message);

		return undefined;
	}
}

export async function updateFile(parentHash: string, oldFileName: string, newFileName: string): Promise<number> {
	logger.info(`updateFile: "${oldFileName}" -> "${newFileName}" for parent hash: "${parentHash}".`);

	try {
		const query = `
			UPDATE archive SET name = $1 WHERE "parentHash" = $2 AND name = $3
			RETURNING id
        `;
		const values = [newFileName, parentHash, oldFileName];

		const fileIds = await executeQuery(query, values);

		if (!fileIds || fileIds.length === 0) {
			throw new Error(`Error updating file: "${oldFileName}" -> "${newFileName}" for parent hash: "${parentHash}".`);
		}

		// logger.info(`Updated file "${oldFileName}" -> "${newFileName}" with id: "${fileId}" for parent hash: "${parentHash}"`);

		return fileIds[0].id;
	} catch (error) {
		logger.error(`updateFile "${oldFileName}":`, error.message);

		return undefined;
	}
}

export async function getFileFromDb(parentHash: string, parentPath: string, name: string): Promise<number> {
	logger.info(`getFileFromDb: "${name}" for parent hash: "${parentHash}" and parentPath: "${parentPath}".`);

	try {
		const query = `
			SELECT id FROM archive WHERE "parentHash" = $1 AND "parentPath" = $2 AND name = $3
		`;
		const values = [parentHash, parentPath, name];

		const files = await executeQuery(query, values);

		return files && files.length ? files[0] : undefined;
	} catch (error) {
		logger.error(`getFileFromDb "${name}":`, error.message);

		return undefined;
	}
}

export async function updateFileOnDirectoryRenamed(oldHashes: string[], oldFile: string, newFile: string): Promise<number> {
	logger.info(`updateFileOnDirectoryRenamed: old hashes length="${oldHashes.length}" old file="${oldFile}" new file="${newFile}".`);

	try {
		const query = `
		UPDATE archive 
		SET 
			"parentPath" = replace("parentPath", $2, $3),
			"parentHash" =  substring(encode(digest(replace("parentPath", $2, $3), 'sha256'), 'hex') from 1 for 16)
		WHERE
			"parentHash" = ANY($1)
		RETURNING id;
		`;
		const values = [oldHashes, oldFile, newFile];

		const files = await executeQuery(query, values);

		if (files) {
			logger.info(`Updated ${files.length} files: for directory rename: "${oldFile}" -> "${newFile}".`);
		}

		return (files || []).length;
	} catch (error) {
		logger.error(`updateFileOnDirectoryRenamed "${oldFile}":`, error.message);

		return undefined;
	}
}

export async function removeFile(hashes: string[], file?: string): Promise<number> {
	logger.info(`removeFile: parent hashes length="${hashes.length}" ${file ? `file=${file}` : ""}.`);

	try {
		let query: string;
		let values: any[];

		if (file) {
			query = `
			DELETE FROM archive a WHERE a."parentHash" = ANY($1) and a.name = $2
			RETURNING a.id;
			`;
			values = [hashes, file];
		} else {
			query = `
			DELETE FROM archive a WHERE a."parentHash" = ANY($1)
			RETURNING a.id;
			`;
			values = [hashes];
		}

		const removesFileIds = await executeQuery(query, values);

		return (removesFileIds || []).length;
	} catch (error) {
		logger.error(`removeFile parent hashes length="${hashes.length}" ${file ? `file=${file}` : ""}:`, error.message);

		return undefined;
	}
}
