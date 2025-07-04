import { Logger } from "(src)/helpers/Logger";
import { File } from "(src)/models/interfaces/File";
import { PostgresAdapter } from "(src)/db/PostgresAdapter";

const logger = new Logger("FileRepository");

export class FileRepository {
	static instance: FileRepository;

	private constructor() {
	}

	static getInstance(): FileRepository {
		if (!FileRepository.instance) {
			FileRepository.instance = new FileRepository();
		}
		return FileRepository.instance;
	}

	async insertFile(file: File, scanRootId: number): Promise<number> {
		logger.info(`insertFile: "${file.name}" for scan root: "${scanRootId}".`);

		try {
			const query = `
                INSERT INTO archive (name, "parentPath", "parentHash", "fileHash", "localDetails", "webDetails", "size",
                                     "coverId", scan_root_id, "fileKind")
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id
			`;
			const values = [file.name, file.parentPath, file.parentHash, file.fileHash, file.localDetails, file.webDetails, file.size, file.coverId, scanRootId, file.fileKind];

			const fileIds = await PostgresAdapter.getInstance().query(query, values);

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

	async removeFileByParentHash(hashes: string[]): Promise<number> {
		logger.info(`removeFileByParentHash: parent hashes length="${hashes.length}".`);

		try {
			const query = `
                DELETE
                FROM archive a
                WHERE a."parentHash" <> ALL ($1) RETURNING a.id;
			`;
			const values = [hashes];

			const removesFiles = await PostgresAdapter.getInstance().query(query, values);

			return (removesFiles || []).length;
		} catch (error) {
			logger.error(`removeFileByParentHash parent hashes length="${hashes.length}":`, error.message);

			return 0;
		}
	}

	async removeFileByFileHash(hashes: string[]): Promise<number> {
		logger.info(`removeFileByFileHash: file hashes length="${hashes.length}".`);

		try {
			const query = `
                DELETE
                FROM archive a
                WHERE "fileHash" = ANY ($1::text[]) RETURNING a.id;
			`;
			const values = [hashes];

			const removesFiles = await PostgresAdapter.getInstance().query(query, values);

			return (removesFiles || []).length;
		} catch (error) {
			logger.error(`removeFileByFileHash file hashes length="${hashes.length}":`, error.message);

			return 0;
		}
	}


	async getFileHashes(scanRootId: number): Promise<{ hash: string }[]> {
		logger.info(`getFileHashes for scan root: "${scanRootId}".`);

		try {
			const query = `
                SELECT "fileHash" as "hash"
                FROM archive
                WHERE scan_root_id = $1
			`;
			const values = [scanRootId];

			const hashes = await PostgresAdapter.getInstance().query(query, values);

			return hashes || [];
		} catch (error) {
			logger.error(`getFileHashes "${scanRootId}":`, error.message);

			return [];
		}
	}

	async getSpecialArchives(scanRootId: number): Promise<File[]> {
		logger.info(`getSpecialArchives for scan root: "${scanRootId}".`);

		try {
			const query = `
                SELECT *
                FROM archive
                WHERE scan_root_id = $1
                  AND "fileKind" <> 'FILE'
                  AND "fileKind" <> 'NONE'
			`;
			const values = [scanRootId];

			const files = await PostgresAdapter.getInstance().query(query, values);

			return files || [];
		} catch (error) {
			logger.error(`getSpecialArchives "${scanRootId}":`, error.message);

			return [];
		}
	}

	async updateSpecialArchiveSize(id: number, size: string): Promise<number> {
		logger.info(`updateSpecialArchiveSize: "${id}".`);

		try {
			const query = `
                UPDATE archive
                SET size = $1
                WHERE id = $2 RETURNING id
			`;

			const values = [size, id];
			const fileIds = await PostgresAdapter.getInstance().query(query, values);

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

}
