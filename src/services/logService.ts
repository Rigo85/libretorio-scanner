// import { WebSocket } from "ws";
//
// import { Logger } from "(src)/helpers/Logger";
// import { getHostnames, getLogs } from "(src)/services/dbService";
//
// const logger = new Logger("Log Service");
//
// async function onUpdateEvent(ws: WebSocket, messageObj: any) {
// 	try {
// 		const logs = await getLogs(messageObj);
// 		const message = {event: "update", data: {logs}};
// 		sendMessage(ws, message);
// 	} catch (error) {
// 		logger.error("onUpdateEvent", error);
// 	}
// }
//
// async function onUpdateHostnames(ws: WebSocket) {
// 	try {
// 		const hostnames = await getHostnames();
// 		const message = {event: "hostnames", data: {hostnames}};
// 		sendMessage(ws, message);
// 	} catch (error) {
// 		logger.error("onUpdateHostnames", error);
// 	}
// }
//
// export function onMessageEvent(message: any, ws: WebSocket) {
// 	let messageObj: any;
// 	let event = "default";
//
// 	try {
// 		messageObj = JSON.parse(message);
// 		event = messageObj.event;
// 	} catch (error) {
// 		logger.error("onMessageEvent", error);
// 	}
//
// 	const eventHandlers: Record<string, () => Promise<void>> = {
// 		"update": async () => {
// 			await onUpdateEvent(ws, messageObj);
// 		},
// 		// eslint-disable-next-line @typescript-eslint/naming-convention
// 		"update-hostnames": async () => {
// 			await onUpdateHostnames(ws);
// 		},
// 		"default": async () => {
// 			ws.send("{\"event\":\"errors\", \"data\": {\"errors\":[\"An error has occurred. Invalid event kind.\"]}}");
// 		}
// 	};
//
// 	if (!eventHandlers[event]) {
// 		event = "default";
// 	}
//
// 	eventHandlers[event]();
// }
//
// function sendMessage(ws: WebSocket, data: any) {
// 	if (ws.readyState === WebSocket.OPEN) {
// 		ws.send(JSON.stringify(data), (error: Error) => {
// 			if (error) {
// 				logger.error("Error sending data:", error);
// 			}
// 		});
// 	}
// }
