// Hack to get module importing from typescript correctly translated to Node.js (CommonJS)
const moduleAlias = require("module-alias");
moduleAlias.addAliases({
	"@root": __dirname + "/..",
	"(src)": __dirname
});

import { Request, Response, NextFunction } from "express";
import errorHandler from "errorhandler";

import { Logger } from "(src)/helpers/Logger";

import { WSServer } from "(src)/WSServer";
import { app } from "./app";

const logger = new Logger("server");

if (process.env.NODE_ENV === "development") {
	app.use(errorHandler());
} else {
	app.use((err: any, req: Request, res: Response, next: NextFunction) => {
		logger.error(err); // Registra el error internamente
		res.status(err.status || 500);
		res.send({error: "Ocurrió un error interno."});
	});
}

process.on("uncaughtException", (error) => {
	logger.error("Uncaught Exception:", error);
});

process.on("unhandledRejection", (reason, promise) => {
	logger.error("Unhandled Rejection:", reason);
});

const port = parseInt(process.env.PORT || "3005");
const server = new WSServer(app);

server.listen(port);
