import { WebSocket } from "ws";

import { Logger } from "(src)/helpers/Logger";
import { BooksStore } from "(src)/services/BooksStore";
import { DecompressResponse } from "(src)/helpers/FileUtils";

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
		const scanResult = await BooksStore.getInstance().getBooksList(messageObj.data?.parentHash);
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
		logger.error("onSearchEvent", error);
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

async function onDecompressEvent(ws: WebSocket, messageObj: { event: string; data: any }) {
	try {
		const extension = messageObj.data.filePath.split(".").pop() ?? "";
		const dispatch: Record<string, (data: { filePath: string }) => Promise<DecompressResponse>> = {
			"cb7": BooksStore.getInstance().decompressCB7.bind(BooksStore.getInstance()),
			"rar": BooksStore.getInstance().decompressRAR.bind(BooksStore.getInstance())
		};

		if (dispatch[extension]) {
			const response = await dispatch[extension](messageObj.data);
			sendMessage(ws, {event: "decompress", data: {...response}});
		} else {
			sendMessage(ws, {event: "errors", data: {errors: ["An error has occurred. Invalid file extension kind."]}});
		}
	} catch (error) {
		logger.error("onDecompressEvent", error);
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
