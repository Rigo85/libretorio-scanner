import { Express, Request, Response, NextFunction } from "express";

// Controllers
import * as homeController from "(src)/controllers/home";

declare class AppRoute {
	path: string;
	method: keyof Express;

	action(request: Request, response: Response, next: NextFunction): Promise<any>;
}

// eslint-disable-next-line @typescript-eslint/naming-convention
export const AppRoutes: AppRoute[] = [
	{
		path: "/",
		method: "get",
		action: homeController.index
	}
];

