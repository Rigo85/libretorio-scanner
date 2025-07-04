import axios from "axios";
import fs from "fs-extra";
import { Logger } from "(src)/helpers/Logger";

const logger = new Logger("imageUtils");

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
