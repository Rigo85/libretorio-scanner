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

export async function getScanRoot(scanRootId: number): Promise<ScanRoot> {
	logger.info("getScanRoot by id:", scanRootId);

	try {
		const query = "SELECT * FROM scan_root WHERE id = $1";
		const rows = await executeQuery(query, [scanRootId]);

		if (!rows?.length) {
			logger.error(`Scan root with id "${scanRootId}" not found.`);

			return undefined;
		}

		return rows[0];
	} catch (error) {
		logger.error("getScanRoot", error.message);

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
			INSERT INTO archive (name, "parentPath", "parentHash", "localDetails", "webDetails", "size", "coverId", scan_root_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING id
        `;
		const values = [file.name, file.parentPath, file.parentHash, file.localDetails, file.webDetails, file.size, file.coverId, scanRootId];

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

// export async function updateFile(parentHash: string, oldFileName: string, newFileName: string): Promise<number> {
// 	logger.info(`updateFile: "${oldFileName}" -> "${newFileName}" for parent hash: "${parentHash}".`);
//
// 	try {
// 		const query = `
// 			UPDATE archive SET name = $1 WHERE "parentHash" = $2 AND name = $3
// 			RETURNING id
//         `;
// 		const values = [newFileName, parentHash, oldFileName];
//
// 		const fileIds = await executeQuery(query, values);
//
// 		if (!fileIds || fileIds.length === 0) {
// 			logger.error(`Error updating file: "${oldFileName}" -> "${newFileName}" for parent hash: "${parentHash}".`);
//
// 			return undefined;
// 		}
//
// 		// logger.info(`Updated file "${oldFileName}" -> "${newFileName}" with id: "${fileId}" for parent hash: "${parentHash}"`);
//
// 		return fileIds[0].id;
// 	} catch (error) {
// 		logger.error(`updateFile "${oldFileName}":`, error.message);
//
// 		return undefined;
// 	}
// }
//
// export async function getFileFromDb(parentHash: string, parentPath: string, name: string): Promise<number> {
// 	logger.info(`getFileFromDb: "${name}" for parent hash: "${parentHash}" and parentPath: "${parentPath}".`);
//
// 	try {
// 		const query = `
// 			SELECT id FROM archive WHERE "parentHash" = $1 AND "parentPath" = $2 AND name = $3
// 		`;
// 		const values = [parentHash, parentPath, name];
//
// 		const files = await executeQuery(query, values);
//
// 		return files && files.length ? files[0] : undefined;
// 	} catch (error) {
// 		logger.error(`getFileFromDb "${name}":`, error.message);
//
// 		return undefined;
// 	}
// }
//
// export async function updateFileOnDirectoryRenamed(oldHashes: string[], oldFile: string, newFile: string): Promise<number> {
// 	logger.info(`updateFileOnDirectoryRenamed: old hashes length="${oldHashes.length}" old file="${oldFile}" new file="${newFile}".`);
//
// 	try {
// 		const query = `
// 		UPDATE archive
// 		SET
// 			"parentPath" = replace("parentPath", $2, $3),
// 			"parentHash" =  substring(encode(digest(replace("parentPath", $2, $3), 'sha256'), 'hex') from 1 for 16)
// 		WHERE
// 			"parentHash" = ANY($1)
// 		RETURNING id;
// 		`;
// 		const values = [oldHashes, oldFile, newFile];
//
// 		const files = await executeQuery(query, values);
//
// 		if (files) {
// 			logger.info(`Updated ${files.length} files: for directory rename: "${oldFile}" -> "${newFile}".`);
// 		}
//
// 		return (files || []).length;
// 	} catch (error) {
// 		logger.error(`updateFileOnDirectoryRenamed "${oldFile}":`, error.message);
//
// 		return undefined;
// 	}
// }
// export async function removeFile(hashes: string[], file?: string): Promise<number> {
// 	logger.info(`removeFile: parent hashes length="${hashes.length}" ${file ? `file=${file}` : ""}.`);
//
// 	try {
// 		let query: string;
// 		let values: any[];
//
// 		if (file) {
// 			query = `
// 			DELETE FROM archive a WHERE a."parentHash" = ANY($1) and a.name = $2
// 			RETURNING a.id;
// 			`;
// 			values = [hashes, file];
// 		} else {
// 			query = `
// 			DELETE FROM archive a WHERE a."parentHash" = ANY($1)
// 			RETURNING a.id;
// 			`;
// 			values = [hashes];
// 		}
//
// 		const removesFileIds = await executeQuery(query, values);
//
// 		return (removesFileIds || []).length;
// 	} catch (error) {
// 		logger.error(`removeFile parent hashes length="${hashes.length}" ${file ? `file=${file}` : ""}:`, error.message);
//
// 		return undefined;
// 	}
// }

export async function removeFile(hashes: string[]): Promise<number> {
	logger.info(`removeFile: parent hashes length="${hashes.length}".`);

	try {
		const query = `
			DELETE FROM archive a WHERE a."parentHash" <> ALL($1)
			RETURNING a.id;
			`;
		const values = [hashes];

		const removesFiles = await executeQuery(query, values);

		return (removesFiles || []).length;
	} catch (error) {
		logger.error(`removeFile parent hashes length="${hashes.length}":`, error.message);

		return 0;
	}
}

export async function getFileHashes(scanRootId: number): Promise<{ hash: string }[]> {
	logger.info(`getFileHashes for scan root: "${scanRootId}".`);

	try {
		const query = `
			SELECT encode(digest(
			 case 
				 when right("parentPath", 1) = '/'then 
					 concat("parentPath", name)
				 else 
				 	concat("parentPath", '/', name)
			 end
			 , 'sha256'), 'hex') as "hash"
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

export async function getFiles(parentHash: string): Promise<File[]> {
	try {
		const query = `
		SELECT * FROM archive a WHERE a."parentHash" = $1
		`;
		const values = [parentHash];
		const rows = await executeQuery(query, values);

		return rows || [];
	} catch (error) {
		logger.error("getFiles", error.message);

		return [];
	}
}
