import { createRequire } from "node:module";
import * as Sentry from "@sentry/node";

const require = createRequire(import.meta.url);

const PACKAGE_VERSION = (() => {
	try {
		const pkg = require("../../package.json") as { version?: string };
		return pkg.version ?? "0.0.0";
	} catch {
		return "0.0.0";
	}
})();

export const SENTRY_RELEASE = `@bramburn/pi-loop@${PACKAGE_VERSION}`;

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

export interface SentryOptions {
	environment?: string;
	tracesSampleRate?: number;
	debug?: boolean;
	/** Capture console-style debug logs into Sentry. Defaults to true. */
	captureLogs?: boolean;
}

let initialized = false;
let captureLogsEnabled = false;

const ABS_WINDOWS_PATH = /[A-Z]:\\[^\s"'<>|]+/g;
const ABS_UNIX_PATH = /(?:\/Users|\/home|\/root)\/[^\s"'<>|]+/g;
const ENV_REF = /\bprocess\.env\.[A-Z_]+/g;
const SENTRY_DSN_REDACT = /https:\/\/[a-f0-9]+@[a-z0-9.]+\.ingest\.[a-z.]+\/\d+/g;
const SENSITIVE_KEYS = new Set(["prompt", "message", "text", "body", "content", "description"]);

const REDACTION_TOKEN = "[redacted]";

function scrubString(value: string): string {
	return value
		.replace(ABS_WINDOWS_PATH, REDACTION_TOKEN)
		.replace(ABS_UNIX_PATH, REDACTION_TOKEN)
		.replace(ENV_REF, REDACTION_TOKEN)
		.replace(SENTRY_DSN_REDACT, REDACTION_TOKEN);
}

export function scrubPii(input: unknown): unknown {
	if (input == null) return input;
	if (typeof input === "string") return scrubString(input);
	if (Array.isArray(input)) return input.map(scrubPii);
	if (typeof input === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
			if (k === "abs_path" || k === "filename") {
				out[k] = REDACTION_TOKEN;
				continue;
			}
			if (SENSITIVE_KEYS.has(k) && typeof v === "string" && v.length > 0) {
				out[k] = REDACTION_TOKEN;
				continue;
			}
			out[k] = scrubPii(v);
		}
		return out;
	}
	return input;
}

export function isSentryInitialized(): boolean {
	return initialized;
}

export function initSentry(opts: SentryOptions = {}): boolean {
	if (initialized) return true;

	const dsn = process.env.SENTRY_DSN;
	if (!dsn) return false;

	captureLogsEnabled = opts.captureLogs ?? process.env.SENTRY_CAPTURE_LOGS !== "false";

	Sentry.init({
		dsn,
		release: SENTRY_RELEASE,
		environment:
			opts.environment ?? process.env.SENTRY_ENVIRONMENT ?? "development",
		tracesSampleRate:
			opts.tracesSampleRate ??
			(process.env.SENTRY_TRACES_SAMPLE_RATE
				? Number(process.env.SENTRY_TRACES_SAMPLE_RATE)
				: 0.1),
		debug: opts.debug ?? process.env.SENTRY_DEBUG === "true",
		enableLogs: captureLogsEnabled,
		dataCollection: {
			userInfo: false,
			httpBodies: [],
		},
		beforeSend: (event) => scrubPii(event) as Sentry.ErrorEvent,
		beforeBreadcrumb: (crumb) => scrubPii(crumb) as Sentry.Breadcrumb,
		beforeSendLog: (log) => scrubPii(log) as Sentry.Log,
	});

	initialized = true;
	installProcessHandlers();
	return true;
}

export function captureException(
	err: unknown,
	context?: Record<string, unknown>,
): void {
	if (!initialized) return;
	Sentry.captureException(err, { extra: context });
}

export function addBreadcrumb(
	message: string,
	data?: Record<string, unknown>,
): void {
	if (!initialized) return;
	Sentry.addBreadcrumb({ message, data, level: "info" });
}

export function log(level: LogLevel, message: string, ...args: unknown[]): void {
	if (!initialized) return;
	if (!captureLogsEnabled) return;
	const formatted = args.length > 0 ? `${message} ${args.map(stringifyArg).join(" ")}` : message;
	// Sentry.logger[level] is the public API; the cast keeps TS strict without
	// pulling the SDK's internal Logger type.
	(Sentry.logger as unknown as Record<LogLevel, (msg: string) => void>)[level](formatted);
}

export const logInfo = (message: string, ...args: unknown[]) => log("info", message, ...args);
export const logWarn = (message: string, ...args: unknown[]) => log("warn", message, ...args);
export const logError = (message: string, ...args: unknown[]) => log("error", message, ...args);
export const logDebug = (message: string, ...args: unknown[]) => log("debug", message, ...args);

export async function flushSentry(timeoutMs = 2000): Promise<void> {
	if (!initialized) return;
	await Sentry.flush(timeoutMs);
}

export function wrapToolExecute<TArgs extends unknown[], TResult>(
	toolName: string,
	fn: (...args: TArgs) => Promise<TResult>,
): (...args: TArgs) => Promise<TResult> {
	return async (...args: TArgs) => {
		addBreadcrumb(`tool:${toolName}`);
		try {
			return await fn(...args);
		} catch (err) {
			captureException(err, { tool: toolName });
			throw err;
		}
	};
}

function stringifyArg(arg: unknown): string {
	if (typeof arg === "string") return arg;
	try {
		return JSON.stringify(arg);
	} catch {
		return String(arg);
	}
}

function installProcessHandlers(): void {
	process.on("uncaughtException", (err) => {
		captureException(err, { kind: "uncaughtException" });
		void flushSentry().finally(() => process.exit(1));
	});
	process.on("unhandledRejection", (reason) => {
		captureException(reason, { kind: "unhandledRejection" });
	});
}
