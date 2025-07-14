import winston from "winston";
import chalk from "chalk";
import "winston-daily-rotate-file";
import util from "util";

// Destructure necessary formatters from Winston
const { combine, timestamp, printf, errors } = winston.format;

// Define colors for log levels and messages
const levelColors: Record<string, chalk.Chalk> = {
	error: chalk.bold.red, // Bright red for errors
	warn: chalk.hex("#FFA500"), // Orange for warnings
	info: chalk.blue, // Blue for information
	debug: chalk.green, // Green for debugging
	default: chalk.white, // Default color for others
};

const messageColors: Record<string, chalk.Chalk> = {
	error: chalk.redBright, // Highlight error messages
	warn: chalk.yellowBright, // Bright yellow for warnings
	info: chalk.cyan, // Cyan for information messages
	debug: chalk.magentaBright, // Bright magenta for debugging
	default: chalk.gray, // Default gray for fallback
};

// Custom log format
const logFormat = printf(({ level, message, timestamp, stack }) => {
	const levelColor = levelColors[level] || levelColors.default; // Colorize level
	const messageColor = messageColors[level] || messageColors.default; // Colorize message

	const coloredLevel = levelColor(`[${level.toUpperCase()}]`); // Apply color to log level
	const coloredTimestamp = chalk.dim(timestamp); // Dim timestamp
	const coloredMessage = messageColor(message); // Apply message-specific color
	const coloredStack = stack ? chalk.dim(stack) : ""; // Dim stack trace if present

	return `${coloredTimestamp} ${coloredLevel}: ${coloredMessage} ${coloredStack}`;
});

// Determine log level based on environment
const logLevel = process.env.NODE_ENV === "production" ? "info" : "debug";

// Configure Winston logger
const winstonLogger = winston.createLogger({
	level: logLevel,
	format: combine(
		timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
		errors({ stack: true }), // Include stack trace in error messages
		logFormat
	),
	transports: [
		// Console transport with colorized output
		new winston.transports.Console(),
		new winston.transports.DailyRotateFile({
			dirname: "logs", // Log files directory
			filename: "application-%DATE%.log", // Log file naming pattern
			datePattern: "YYYY-MM-DD", // Date pattern for log file rotation
			maxFiles: "30d", // Retain logs for 30 days
			zippedArchive: true, // Compress archived log files
		}),
	],
});

// Create a custom logger with methods that accept multiple arguments
const logger = {
	info: (...args: any[]) => {
		winstonLogger.info(util.format(...args));
	},
	warn: (...args: any[]) => {
		winstonLogger.warn(util.format(...args));
	},
	error: (...args: any[]) => {
		winstonLogger.error(util.format(...args));
	},
	debug: (...args: any[]) => {
		winstonLogger.debug(util.format(...args));
	},
	// You can add more methods if needed (e.g., verbose, silly)
};

export default logger;
