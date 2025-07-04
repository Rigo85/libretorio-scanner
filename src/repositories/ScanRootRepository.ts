import { Logger } from "(src)/helpers/Logger";
import { ScanRoot } from "(src)/models/interfaces/ScanRoot";
import { PostgresAdapter } from "(src)/db/PostgresAdapter";

const logger = new Logger("ScanRootRepository");

export class ScanRootRepository {
	private static instance: ScanRootRepository;

	private constructor() {
	}

	public static getInstance(): ScanRootRepository {
		if (!ScanRootRepository.instance) {
			ScanRootRepository.instance = new ScanRootRepository();
		}
		return ScanRootRepository.instance;
	}

	async getScanRootByPath(path: string): Promise<ScanRoot> {
		logger.info("getScanRoot by path:", path);

		try {
			const query = "SELECT * FROM scan_root WHERE path = $1";
			const rows = await PostgresAdapter.getInstance().query(query, [path]);

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

	async getScanRoots(): Promise<ScanRoot[]> {
		logger.info("getScanRoots");

		try {
			const query = "SELECT * FROM scan_root";
			const rows = await PostgresAdapter.getInstance().query(query, []);

			return rows || [];
		} catch (error) {
			logger.error("getScanRoots", error.message);

			return [];
		}
	}

	async updateScanRoot(directories: string, id: number): Promise<number> {
		logger.info(`updateScanRoot: "${id}"`);

		try {
			const query = `
                UPDATE scan_root
                SET directories = $1
                WHERE id = $2 RETURNING id
			`;

			const values = [directories, id];
			const scanRootIds = await PostgresAdapter.getInstance().query(query, values);

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
}
