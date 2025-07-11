import { exec } from "child_process";
import util from "util";
import path from "path";

import { Logger } from "(src)/helpers/Logger";
import { checkIfPathExistsAndIsFile } from "(src)/utils/fileUtils";

const logger = new Logger("Calibre Service");
const execPromise = util.promisify(exec);

export class CalibreService {
	private static instance: CalibreService;

	private constructor() {
	}

	public static getInstance(): CalibreService {
		if (!CalibreService.instance) {
			CalibreService.instance = new CalibreService();
		}

		return CalibreService.instance;
	}

	async getEbookMeta(filePath: string, coverId: string): Promise<any> {
		// logger.info(`getEbookMeta: "${filePath}"`);

		try {
			if (!checkIfPathExistsAndIsFile(filePath)) {
				logger.error(`getEbookMeta: File not found: "${filePath}"`);
				return undefined;
			}

			const calibrePath = path.join(__dirname, "calibre", "ebook-meta");
			const coverPath = path.join(__dirname, "..", "public", "covers", `${coverId}.jpg`);

			const {
				stdout,
				stderr
			} = await execPromise(`${calibrePath} "${filePath}" --get-cover ${coverPath}`);
			if (stderr) {
				logger.error(`getEbookMeta: ${stderr}`);
				return undefined;
			}

			return this.parseMeta(stdout);
		} catch (error) {
			logger.error(`getEbookMeta: ${error}`);

			return undefined;
		}
	}


	private parseMeta(metadata: any): any {
		const metaLines = metadata.split("\n");
		const metaObj: Record<string, string> = {};
		metaLines.forEach((line: string) => {
			const [key, ...value] = line.split(":");
			if (key && value.length > 0) {
				metaObj[key.trim().toLowerCase()] =
					value.join(":").trim()
						.replace(/\\u0000/g, "") // Eliminar caracteres nulos
						.replace(/\n/g, "")      // Eliminar saltos de línea
						.replace(/\r/g, "")      // Eliminar retornos de carro
						.replace(/\t/g, "")      // Eliminar tabulaciones
						.replace(/[\x00-\x1F\x7F]/g, ""); // Eliminar otros caracteres de control
			}
		});
		return metaObj;
	}

}