import axios, { AxiosResponse } from "axios";
import fs from "fs-extra";
import path from "path";

import { Logger } from "(src)/helpers/Logger";

const logger = new Logger("Book Info");

export async function getBookInfoOpenLibrary(_title: string) {
	const title = _title.trim();
	const url = "https://openlibrary.org/search.json";

	if (!title) {
		logger.error("getBookInfoOpenLibrary: Title is empty");
		return undefined;
	}

	// logger.info(`getBookInfoOpenLibrary: ${title}`);

	try {
		const response = await axios.get(url, {
			params: {
				title: title
			}
		}) as AxiosResponse;

		if (response.data.docs?.length > 0) {
			const bookInfo = response.data.docs[0];
			const coverId = bookInfo.cover_i;
			const coverUrl = coverId ? `https://covers.openlibrary.org/b/id/${coverId}-L.jpg` : "N/A";
			// const info = {
			// 	title: bookInfo.title,
			// 	authorName: bookInfo.author_name,
			// 	firstPublishYear: bookInfo.first_publish_year,
			// 	isbn: bookInfo.isbn ? bookInfo.isbn[0] : "N/A",
			// 	cover: coverUrl
			// };

			// logger.info("getBookInfoOpenLibrary", info);
			if (coverId) {
				const coverPath = path.join(__dirname, "..", "public", "covers", `${coverId}.jpg`);
				await downloadImage(coverUrl, coverPath);
			}

			return bookInfo;
		}
	} catch (error) {
		logger.error("getBookInfoOpenLibrary", {code: error.code, message: error.message});
	}

	return undefined;
}

async function downloadImage(url: string, filepath: string): Promise<void> {
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
