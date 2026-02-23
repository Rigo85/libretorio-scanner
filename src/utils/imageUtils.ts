import { execSync } from "child_process";
import axios from "axios";
import fs from "fs-extra";
import { Logger } from "(src)/helpers/Logger";

const logger = new Logger("imageUtils");

/**
 * Converts a JPG file to WebP (quality 85) and removes the original.
 * If cwebp is not available or fails, the JPG is kept intact.
 */
export function convertToWebp(jpgPath: string): void {
	const webpPath = jpgPath.replace(/\.jpg$/i, ".webp");
	try {
		execSync(`cwebp -q 85 "${jpgPath}" -o "${webpPath}"`, {stdio: "ignore"});
		fs.removeSync(jpgPath);
	} catch (error) {
		logger.error(`convertToWebp: could not convert "${jpgPath}" — ${error}`);
	}
}

export async function downloadImage(url: string, filepath: string): Promise<void> {
	if (!url?.trim() || !filepath?.trim()) {
		logger.error(`downloadImage: Missing parameters. url="${url}", filepath="${filepath}"`);
		return;
	}

	return new Promise((resolve, reject) => {
		axios({
			url,
			method: "GET",
			responseType: "stream"
		})
			.then((response) => {
				const writer = fs.createWriteStream(filepath);

				response.data.pipe(writer);

				writer.on("finish", resolve);
				writer.on("error", reject);
			})
			.catch((error) => {
				reject(error);
			});
	});
}
