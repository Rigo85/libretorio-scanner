import axios, { AxiosResponse } from "axios";
import { Logger } from "(src)/helpers/Logger";

const logger = new Logger("Book Info");

const apiKey = process.env.GOOGLE_BOOKS_API_KEY;

if (!apiKey) {
	logger.error("The environment variable 'GOOGLE_BOOKS_API_KEY' is not defined.");
	throw new Error("The environment variable 'GOOGLE_BOOKS_API_KEY' is not defined.");
}

export async function getBookInfoGoogleBooks(_title: string) {
	const title = _title.trim();
	const url: string = "https://www.googleapis.com/books/v1/volumes";

	if (!title) {
		logger.error("getBookInfoGoogleBooks: Title is empty");
		return undefined;
	}

	// logger.info(`getBookInfoGoogleBooks: ${title}`);

	try {
		const response = await axios.get(url, {
			params: {
				q: `intitle:${title}`,
				key: apiKey
			}
		}) as AxiosResponse;

		if (response.data.items) {
			const bookInfo = response.data.items[0].volumeInfo;
			const info = {
				title: bookInfo.title,
				authors: bookInfo.authors,
				publishedDate: bookInfo.publishedDate,
				isbn: bookInfo.industryIdentifiers ? bookInfo.industryIdentifiers[0].identifier : "N/A",
				cover: bookInfo.imageLinks ? bookInfo.imageLinks.thumbnail : "N/A"
			};

			// logger.info("getBookInfoGoogleBooks", info);

			return bookInfo;
		}
	} catch (error) {
		logger.error("getBookInfoGoogleBooks", {code: error.code, message: error.message});
	}

	return undefined;
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

		if (response.data.docs && response.data.docs.length > 0) {
			const bookInfo = response.data.docs[0];
			const coverId = bookInfo.cover_i;
			const coverUrl = coverId ? `https://covers.openlibrary.org/b/id/${coverId}-L.jpg` : "N/A";
			const info = {
				title: bookInfo.title,
				authorName: bookInfo.author_name,
				firstPublishYear: bookInfo.first_publish_year,
				isbn: bookInfo.isbn ? bookInfo.isbn[0] : "N/A",
				cover: coverUrl
			};

			// logger.info("getBookInfoOpenLibrary", info);

			return bookInfo;
		}
	} catch (error) {
		logger.error("getBookInfoOpenLibrary", {code: error.code, message: error.message});
	}

	return undefined;
}
