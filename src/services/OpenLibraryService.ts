import axios, { AxiosResponse } from "axios";
import path from "path";
import { Logger } from "(src)/helpers/Logger";
import { downloadImage } from "(src)/utils/imageUtils";

const logger = new Logger("OpenLibraryService");

export class OpenLibraryService {
	private static instance: OpenLibraryService;

	private constructor() {
	}

	public static getInstance(): OpenLibraryService {
		if (!OpenLibraryService.instance) {
			OpenLibraryService.instance = new OpenLibraryService();
		}
		return OpenLibraryService.instance;
	}

	async getBookInfoOpenLibrary(_title: string) {
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
}
