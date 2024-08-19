import * as dotenv from "dotenv";

dotenv.config({path: ".env"});

import express from "express";
import compression from "compression";
import lusca from "lusca";
import helmet from "helmet";
import cors from "cors";
import path from "path";
import fs from "fs-extra";

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

app.get("/*", function (req, res, next) {
	if (/\.[^\/]+$/.test(req.path)) {
		const filePath = path.join(__dirname, "public", req.path);
		if (fs.pathExistsSync(filePath)) {
			res.sendFile(filePath);
		} else {
			res.status(404).send("Not Found");
		}
	} else {
		res.sendFile(path.join(__dirname, "public", "index.html"));
	}
});


BooksStore.getInstance().updateBooksInfo()
	.catch((error) => {
		logger.error("Initializing:", error);
	});

export { app };
