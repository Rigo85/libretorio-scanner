import { WebSocket } from "ws";

import { Logger } from "(src)/helpers/Logger";
import { BooksStore } from "(src)/services/BooksStore";

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
		"update": async () => {
			await onUpdateEvent(ws, messageObj);
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

async function onUpdateEvent(ws: WebSocket, messageObj: { event: string; data: any }) {
	try {
		const response = await BooksStore.getInstance().updateBooksDetails(messageObj.data);
		sendMessage(ws, {event: "update", data: {response}});
	} catch (error) {
		logger.error("onUpdateEvent", error);
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
