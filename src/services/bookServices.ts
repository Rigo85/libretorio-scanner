import { WebSocket } from "ws";

import { Logger } from "(src)/helpers/Logger";
import { BooksStore } from "(src)/services/BooksStore";
import { ConvertToPdfResponse, DecompressResponse, FileKind } from "(src)/helpers/FileUtils";

const logger = new Logger("Book Service");

export function onMessageEvent(message: any, ws: WebSocket) {
	let messageObj: { event: string; data: any };
	let event = "default";

	try {
		messageObj = JSON.parse(message);
		event = messageObj.event;
	} catch (error) {
		logger.error("onMessageEvent", error);
	}

	const eventHandlers: Record<string, () => Promise<void>> = {
		"ls": async () => {
			await onListEvent(ws, messageObj);
		},
		"search": async () => {
			await onSearchEvent(ws, messageObj);
		},
		// eslint-disable-next-line @typescript-eslint/naming-convention
		"search_text": async () => {
			await onSearchTextEvent(ws, messageObj);
		},
		"update": async () => {
			await onUpdateEvent(ws, messageObj);
		},
		"decompress": async () => {
			await onDecompressEvent(ws, messageObj);
		},
		// eslint-disable-next-line @typescript-eslint/naming-convention
		"convert_to_pdf": async () => {
			await onConvertToPdfEvent(ws, messageObj);
		},
		// eslint-disable-next-line @typescript-eslint/naming-convention
		"get_more_pages": async () => {
			await onGetMorePagesEvent(ws, messageObj);
		},
		"default": async () => {
			ws.send("{\"event\":\"errors\", \"data\": {\"errors\":[\"An error has occurred. Invalid event kind.\"]}}");
		}
	};

	if (!eventHandlers[event]) {
		event = "default";
	}

	eventHandlers[event]();
}

async function onListEvent(ws: WebSocket, messageObj: { event: string; data: any }) {
	try {
		const parentHash = messageObj.data?.parentHash;
		const offset = messageObj.data?.offset ?? 0;
		const limit = messageObj.data?.limit ?? 50;
		const scanResult = await BooksStore.getInstance().getBooksList(offset, limit, parentHash);
		sendMessage(ws, {event: "list", data: scanResult});
	} catch (error) {
		logger.error("onListEvent", error);
	}
}

async function onSearchEvent(ws: WebSocket, messageObj: { event: string; data: any }) {
	try {
		const bookInfo = await BooksStore.getInstance().searchBookInfoOpenLibrary(messageObj.data);
		sendMessage(ws, {event: "search_details", data: bookInfo});
	} catch (error) {
		logger.error("onSearchEvent", error);
	}
}

async function onSearchTextEvent(ws: WebSocket, messageObj: { event: string; data: any }) {
	try {
		const scanResult = await BooksStore.getInstance().searchBooksByTextOnDb(messageObj.data);
		sendMessage(ws, {event: "list", data: scanResult});
	} catch (error) {
		logger.error("onSearchTextEvent", error);
	}
}

async function onUpdateEvent(ws: WebSocket, messageObj: { event: string; data: any }) {
	try {
		const response = await BooksStore.getInstance().updateBooksDetails(messageObj.data);
		sendMessage(ws, {event: "update", data: {response}});
	} catch (error) {
		logger.error("onUpdateEvent", error);
	}
}

async function onConvertToPdfEvent(ws: WebSocket, messageObj: { event: string; data: any }) {
	try {
		const extension = messageObj.data.filePath.split(".").pop() ?? "";
		const dispatch: Record<string, (data: { filePath: string }) => Promise<ConvertToPdfResponse>> = {
			"epub": BooksStore.getInstance().convertWithCalibreToPdf.bind(BooksStore.getInstance()),
			"doc": BooksStore.getInstance().convertOfficeToPdf.bind(BooksStore.getInstance()),
			"docx": BooksStore.getInstance().convertOfficeToPdf.bind(BooksStore.getInstance()),
			"ppt": BooksStore.getInstance().convertOfficeToPdf.bind(BooksStore.getInstance()),
			"pptx": BooksStore.getInstance().convertOfficeToPdf.bind(BooksStore.getInstance()),
			"xls": BooksStore.getInstance().convertOfficeToPdf.bind(BooksStore.getInstance()),
			"xlsx": BooksStore.getInstance().convertOfficeToPdf.bind(BooksStore.getInstance()),
			"rtf": BooksStore.getInstance().convertOfficeToPdf.bind(BooksStore.getInstance()),
			"txt": BooksStore.getInstance().convertHtmlToPdf.bind(BooksStore.getInstance()),
			"html": BooksStore.getInstance().convertHtmlToPdf.bind(BooksStore.getInstance()),
			"htm": BooksStore.getInstance().convertHtmlToPdf.bind(BooksStore.getInstance()),
			"lit": BooksStore.getInstance().convertWithCalibreToPdf.bind(BooksStore.getInstance())
		};

		if (dispatch[extension]) {
			const response = await dispatch[extension](messageObj.data);
			sendMessage(ws, {event: "convert_to_pdf", data: {...response}});
		} else {
			sendMessage(ws, {
				event: "convert_to_pdf",
				data: {success: "ERROR", error: "An error has occurred. Invalid file extension kind."}
			});
		}
	} catch (error) {
		logger.error("onConvertToPdfEvent", error);
		sendMessage(ws, {
			event: "convert_to_pdf",
			data: {success: "ERROR", error: "An error has occurred."}
		});
	}
}

async function onDecompressEvent(ws: WebSocket, messageObj: { event: string; data: any }) {
	try {
		// const extension = messageObj.data.filePath.split(".").pop() ?? "";
		const extension = messageObj.data.fileKind === FileKind.FILE ?
			BooksStore.getInstance().detectCompressionType(messageObj.data.filePath) :
			messageObj.data.fileKind.toLowerCase();

		const dispatch: Record<string, (data: { filePath: string }) => Promise<DecompressResponse>> = {
			"cb7": BooksStore.getInstance().decompressCB7.bind(BooksStore.getInstance()),
			"cbr": BooksStore.getInstance().decompressRAR.bind(BooksStore.getInstance()),
			"cbz": BooksStore.getInstance().decompressZIP.bind(BooksStore.getInstance()),
			// eslint-disable-next-line @typescript-eslint/naming-convention
			"comic-manga": BooksStore.getInstance().gettingComicMangaImages.bind(BooksStore.getInstance())
		};

		if (dispatch[extension]) {
			const response = await dispatch[extension](messageObj.data);
			sendMessage(ws, {event: "decompress", data: {...response}});
		} else {
			sendMessage(ws, {
				event: "decompress",
				data: {success: "ERROR", error: "An error has occurred. Invalid file extension kind."}
			});
		}
	} catch (error) {
		logger.error("onDecompressEvent", error);

		sendMessage(ws, {
			event: "decompress",
			data: {success: "ERROR", error: "An error has occurred."}
		});
	}
}

async function onGetMorePagesEvent(ws: WebSocket, messageObj: { event: string; data: any }) {
	try {
		const response = await BooksStore.getInstance().getMorePages(messageObj?.data?.id, messageObj?.data?.index);
		sendMessage(ws, {event: "decompress", data: {...response}});
	} catch (error) {
		logger.error("onGetMorePagesEvent", error);

		sendMessage(ws, {
			event: "decompress",
			data: {success: "ERROR", error: "An error has occurred."}
		});
	}
}

function sendMessage(ws: WebSocket, data: any) {
	if (ws.readyState === WebSocket.OPEN) {
		ws.send(JSON.stringify(data), (error: Error) => {
			if (error) {
				logger.error("Error sending data:", error);
			}
		});
	}
}
