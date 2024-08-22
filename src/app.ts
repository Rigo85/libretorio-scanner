import * as dotenv from "dotenv";

dotenv.config({path: ".env"});

import express, { NextFunction, Request, Response } from "express";
import compression from "compression";
import lusca from "lusca";
import helmet from "helmet";
import cors from "cors";
import path from "path";

import { AppRoutes } from "./routes";
import { BooksStore } from "(src)/services/BooksStore";
import { Logger } from "(src)/helpers/Logger"; // Routes file

const logger = new Logger("App");

const app = express();

// Express configuration
app.set("port", process.env.PORT || 3000);
app.use(compression());
app.use(express.json()); // parse application/json type post data
app.use(express.urlencoded({extended: true})); // parse application/x-www-form-urlencoded post data
app.use(express.static(path.join(__dirname, "public"), {maxAge: 31557600000}));
app.use(lusca.xframe("SAMEORIGIN"));
app.use(lusca.xssProtection(true));
app.use(helmet());
app.use(cors());

AppRoutes.forEach(route => {
	(app as any)[route.method](route.path, (request: Request, response: Response, next: NextFunction) => {
		route.action(request, response, next)
			.then(() => next)
			.catch((err: any) => next(err));
	});
});

BooksStore.getInstance().updateBooksInfo()
	.catch((error) => {
		logger.error("Initializing:", error);
	});

export { app };
