import axios, { AxiosResponse } from "axios";
import fs from "fs-extra";
import path from "path";

import { Logger } from "(src)/helpers/Logger";

const logger = new Logger("Book Info");

// const apiKey = process.env.GOOGLE_BOOKS_API_KEY;
//
// if (!apiKey) {
// 	logger.error("The environment variable 'GOOGLE_BOOKS_API_KEY' is not defined.");
// 	throw new Error("The environment variable 'GOOGLE_BOOKS_API_KEY' is not defined.");
// }

// export async function getBookInfoGoogleBooks(_title: string) {
// 	const title = _title.trim();
// 	const url: string = "https://www.googleapis.com/books/v1/volumes";
//
// 	if (!title) {
// 		logger.error("getBookInfoGoogleBooks: Title is empty");
// 		return undefined;
// 	}
//
// 	// logger.info(`getBookInfoGoogleBooks: ${title}`);
//
// 	try {
// 		const response = await axios.get(url, {
// 			params: {
// 				q: `intitle:${title}`,
// 				key: apiKey
// 			}
// 		}) as AxiosResponse;
//
// 		if (response.data.items) {
// 			const bookInfo = response.data.items[0].volumeInfo;
// 			const info = {
// 				title: bookInfo.title,
// 				authors: bookInfo.authors,
// 				publishedDate: bookInfo.publishedDate,
// 				isbn: bookInfo.industryIdentifiers ? bookInfo.industryIdentifiers[0].identifier : "N/A",
// 				cover: bookInfo.imageLinks ? bookInfo.imageLinks.thumbnail : "N/A"
// 			};
//
// 			// logger.info("getBookInfoGoogleBooks", info);
//
// 			return bookInfo;
// 		}
// 	} catch (error) {
// 		logger.error("getBookInfoGoogleBooks", {code: error.code, message: error.message});
// 	}
//
// 	return undefined;
// }

export async function searchBookInfoOpenLibrary(title: string, author: string): Promise<any[]> {
	const url = "https://openlibrary.org/search.json";

	try {
		const params = {limit: 50} as Record<string, any>;
		if (title?.trim()) {
			params.title = title;
		}
		if (author?.trim()) {
			params.author = author;
		}

		const response = await axios.get(url, {params});

		if (response.data.docs) {
			await clearDirectory(path.join(__dirname, "..", "public", "temp_covers"));

			logger.info("searchBookInfoOpenLibrary", response.data.docs.length);

			for (const doc of response.data.docs) {
				const coverId = doc.cover_i;
				const coverUrl = coverId ? `https://covers.openlibrary.org/b/id/${coverId}-L.jpg` : "N/A";

				if (coverId) {
					const coverPath = path.join(__dirname, "..", "public", "temp_covers", `${coverId}.jpg`);
					await downloadImage(coverUrl, coverPath);
				}
			}

			logger.info("searchBookInfoOpenLibrary", "Done.");

			return response.data.docs;
		}
	} catch (error) {
		logger.error("searchBookInfoOpenLibrary", error);
	}

	return [];
}

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

async function clearDirectory(path: string): Promise<boolean> {
	try {
		await fs.emptyDir(path);

		return true;
	} catch (error) {
		logger.error("clearDirectory", error);

		return false;
	}
}
