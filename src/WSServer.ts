import { Express } from "express";
import { Server, WebSocket } from "ws";
import http from "http";

import { Logger } from "(src)/helpers/Logger";
import { onMessageEvent } from "(src)/services/bookServices";

const logger = new Logger("WS Server");

interface ExtendedWebSocket extends WebSocket {
	isAlive: boolean;
}

export class WSServer {
	private app: Express;
	private wss: Server;
	private readonly server: http.Server;

	constructor(app: Express) {
		this.app = app;
		this.server = http.createServer(app);
		this.wss = new Server({server: this.server});

		this.wss.on("connection", (ws: ExtendedWebSocket) => {
			ws.isAlive = true;

			ws.on("pong", () => {
				ws.isAlive = true;
			});

			ws.on("error", (error) => {
				logger.error("Error in WebSocket connection:", error);
			});

			ws.on("close", () => {
				logger.info("Client disconnected.");
			});

			ws.on("message", (message) => {
				onMessageEvent(message, ws);
			});
		});

		// Ping/Pong para mantener la conexión activa
		setInterval(() => {
			this.wss.clients.forEach((ws: ExtendedWebSocket) => {
				if (!ws.isAlive) return ws.terminate();
				ws.isAlive = false;
				ws.ping(undefined, false, (err: Error) => {
					if (err) logger.error("ping", err);
				});
			});
		}, 30000);
	}

	public listen(port: number) {
		this.server.listen(port, () => {
			logger.success(`Server running on port ${port} in ${process.env.NODE_ENV} mode`);
		});
	}
}
