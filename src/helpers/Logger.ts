import { default as chalk } from "chalk";
import * as util from "util";

/** Check if object is defined */
export const isDefined = (obj: any): boolean => {
	return !(obj === undefined || typeof obj == "undefined" || !obj);
};

/** Check if object represents "true" */
export const isTrue = (str: string): boolean => {
	return isDefined(str) && (/^true$/i).test(str);
};

/** Check if string is JSON */
export const isJson = (str: string): boolean => {
	try {
		JSON.parse(str);
	} catch (e) {
		return false;
	}
	return true;
};

/** Check if variable is String */
export const isString = (str: any): boolean => {
	try {
		return (typeof str === "string" || str instanceof String);
	} catch (e) {
		return false;
	}
};

/* eslint-disable @typescript-eslint/naming-convention */
export enum LogType {
	Init,
	Success,
	Error,
	Info,
	Debug
}
/* eslint-enable @typescript-eslint/naming-convention */

const debugLoggingEnabled = isTrue(process.env.DEBUG_LOGGING);

/**
 * Generate log
 */
export const log = (sender: string, type: LogType, text: string, extra: any = "") => {
	console.log(`${getColoredLogType(type)}`, text, serializationHelper(extra));
};

const serializationHelper = (extra: any): string => {
	return typeof extra === "object" || extra instanceof Error ? util.inspect(extra, {
		breakLength: Infinity, // don't break long properties on new line
		compact: true, // don't break multiple properties on multiple lines
		depth: 4, // how deep to search
		showHidden: false,  // If true, object's non-enumerable symbols and properties are included in the formatted result. WeakMap and WeakSet entries are also included. Default: false
		colors: false // If true, the output is styled with ANSI color codes. Colors are customizable. See Customizing util.inspect colors. Default: false.
	}) : extra;
};

export class Logger {
	sender: string;

	constructor(sender: string) {
		this.sender = sender;
	}

	log = (type: LogType, text: string, extra: any = "") => {
		console.log(`${chalk.blue(this.sender)} ${getColoredLogType(type)}: ${text}`, serializationHelper(extra));
	};

	init = (text: string, extra: any = "") => {
		this.log(LogType.Init, text, extra);
	};

	success = (text: string, extra: any = "") => {
		this.log(LogType.Success, text, extra);
	};

	error = (text: string, extra: any = "") => {
		this.log(LogType.Error, text, extra);
	};

	info = (text: string, extra: any = "") => {
		this.log(LogType.Info, text, extra);
	};

	debug = (text: string, extra: any = "") => {
		if (debugLoggingEnabled)
			this.log(LogType.Debug, text, extra);
	};
}

/* eslint-disable @typescript-eslint/indent */
export const getColoredLogType = (type: LogType) => {
	switch (type) {
		case LogType.Init: {
			return chalk.cyan("Initializing");
		}
		case LogType.Success: {
			return chalk.green("Success");
		}
		case LogType.Error: {
			return chalk.red("Error");
		}
		case LogType.Info: {
			return chalk.blueBright("Info");
		}
		case LogType.Debug: {
			return chalk.yellow("Debug");
		}
		default: {
			return "";
		}
	}
};
/* eslint-enable @typescript-eslint/indent */