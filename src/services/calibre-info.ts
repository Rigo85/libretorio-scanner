import { exec } from "child_process";
import util from "util";
import fs from "fs";
import path from "path";
import { Logger } from "(src)/helpers/Logger";

const logger = new Logger("Calibre Info");
const execPromise = util.promisify(exec);

function checkIfPathExistsAndIsFile(filePath: string): boolean {
	if (fs.existsSync(filePath)) {
		return fs.statSync(filePath).isFile();
	}
	return false;
}

export async function getEbookMeta(filePath: string, coverId: string): Promise<any> {
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

		return parseMeta(stdout);
	} catch (error) {
		logger.error(`getEbookMeta: ${error}`);

		return undefined;
	}
}

function parseMeta(metadata: any): any {
	const metaLines = metadata.split("\n");
	const metaObj: Record<string, string> = {};
	metaLines.forEach((line: string) => {
		const [key, ...value] = line.split(":");
		if (key && value.length > 0) {
			metaObj[key.trim().toLowerCase()] = value.join(":").trim();
		}
	});
	return metaObj;
}
