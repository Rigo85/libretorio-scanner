import { WebSocket } from "ws";

import { Logger } from "(src)/helpers/Logger";

const logger = new Logger("Book Service");

export function onMessageEvent(message: any, ws: WebSocket) {
	// let messageObj: any;
	// let event = "default";
	//
	// try {
	// 	messageObj = JSON.parse(message);
	// 	event = messageObj.event;
	// } catch (error) {
	// 	logger.error("onMessageEvent", error);
	// }
	//
	// const eventHandlers: Record<string, () => Promise<void>> = {
	// 	"update": async () => {
	// 		await onUpdateEvent(ws, messageObj);
	// 	},
	// 	// eslint-disable-next-line @typescript-eslint/naming-convention
	// 	"update-hostnames": async () => {
	// 		await onUpdateHostnames(ws);
	// 	},
	// 	"default": async () => {
	// 		ws.send("{\"event\":\"errors\", \"data\": {\"errors\":[\"An error has occurred. Invalid event kind.\"]}}");
	// 	}
	// };
	//
	// if (!eventHandlers[event]) {
	// 	event = "default";
	// }
	//
	// eventHandlers[event]();
}
