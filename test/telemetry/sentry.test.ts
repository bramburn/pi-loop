import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const captureException = vi.fn();
const addBreadcrumb = vi.fn();
const init = vi.fn();
const flush = vi.fn().mockResolvedValue(undefined);
const loggerInfo = vi.fn();
const loggerDebug = vi.fn();
const loggerWarn = vi.fn();
const loggerError = vi.fn();
const loggerFatal = vi.fn();
const loggerTrace = vi.fn();

vi.mock("@sentry/node", () => ({
	init,
	captureException,
	addBreadcrumb,
	flush,
	logger: {
		info: loggerInfo,
		debug: loggerDebug,
		warn: loggerWarn,
		error: loggerError,
		fatal: loggerFatal,
		trace: loggerTrace,
	},
}));

beforeEach(() => {
	delete process.env.SENTRY_DSN;
	delete process.env.SENTRY_ENVIRONMENT;
	delete process.env.SENTRY_DEBUG;
	delete process.env.SENTRY_TRACES_SAMPLE_RATE;
	delete process.env.SENTRY_CAPTURE_LOGS;
	vi.resetModules();
	init.mockClear();
	captureException.mockClear();
	addBreadcrumb.mockClear();
	flush.mockClear();
	loggerInfo.mockClear();
	loggerDebug.mockClear();
	loggerWarn.mockClear();
	loggerError.mockClear();
	loggerFatal.mockClear();
	loggerTrace.mockClear();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("initSentry", () => {
	it("is a no-op when SENTRY_DSN is unset", async () => {
		const { initSentry, isSentryInitialized } = await import("../../src/telemetry/sentry.js");
		expect(initSentry()).toBe(false);
		expect(isSentryInitialized()).toBe(false);
		expect(init).not.toHaveBeenCalled();
	});

	it("calls Sentry.init with the DSN when set", async () => {
		process.env.SENTRY_DSN = "https://publickey@o123.ingest.sentry.io/456";
		const { initSentry, isSentryInitialized } = await import("../../src/telemetry/sentry.js");
		expect(initSentry()).toBe(true);
		expect(isSentryInitialized()).toBe(true);
		expect(init).toHaveBeenCalledTimes(1);
		const opts = init.mock.calls[0][0];
		expect(opts.dsn).toBe("https://publickey@o123.ingest.sentry.io/456");
		expect(opts.release).toMatch(/^@bramburn\/pi-loop@/);
	});

	it("respects SENTRY_TRACES_SAMPLE_RATE override", async () => {
		process.env.SENTRY_DSN = "https://x@o1.ingest.sentry.io/1";
		process.env.SENTRY_TRACES_SAMPLE_RATE = "0.5";
		const { initSentry } = await import("../../src/telemetry/sentry.js");
		initSentry();
		expect(init.mock.calls[0][0].tracesSampleRate).toBe(0.5);
	});

	it("disables logs when SENTRY_CAPTURE_LOGS=false", async () => {
		process.env.SENTRY_DSN = "https://x@o1.ingest.sentry.io/1";
		process.env.SENTRY_CAPTURE_LOGS = "false";
		const { initSentry } = await import("../../src/telemetry/sentry.js");
		initSentry();
		expect(init.mock.calls[0][0].enableLogs).toBe(false);
	});
});

describe("captureException", () => {
	it("is a no-op when not initialized", async () => {
		const sentryModule = await import("../../src/telemetry/sentry.js");
		const sentrySdk = await import("@sentry/node");
		sentryModule.captureException(new Error("x"));
		// The Sentry SDK mock should not have been called.
		expect(sentrySdk.captureException).not.toHaveBeenCalled();
	});

	it("forwards to Sentry.captureException when initialized", async () => {
		process.env.SENTRY_DSN = "https://x@o1.ingest.sentry.io/1";
		const sentryModule = await import("../../src/telemetry/sentry.js");
		const sentrySdk = await import("@sentry/node");
		sentryModule.initSentry();
		sentryModule.captureException(new Error("boom"), { tag: "test" });
		expect(sentrySdk.captureException).toHaveBeenCalled();
	});
});

describe("addBreadcrumb", () => {
	it("is a no-op when not initialized", async () => {
		const sentryModule = await import("../../src/telemetry/sentry.js");
		const sentrySdk = await import("@sentry/node");
		sentryModule.addBreadcrumb("hello");
		expect(sentrySdk.addBreadcrumb).not.toHaveBeenCalled();
	});

	it("forwards to Sentry.addBreadcrumb when initialized", async () => {
		process.env.SENTRY_DSN = "https://x@o1.ingest.sentry.io/1";
		const sentryModule = await import("../../src/telemetry/sentry.js");
		const sentrySdk = await import("@sentry/node");
		sentryModule.initSentry();
		sentryModule.addBreadcrumb("session_switch", { reason: "resume" });
		expect(sentrySdk.addBreadcrumb).toHaveBeenCalledWith(
			expect.objectContaining({ message: "session_switch", data: { reason: "resume" } }),
		);
	});
});

describe("log helpers", () => {
	it("are no-ops when not initialized", async () => {
		const { logDebug, logInfo, logWarn, logError } = await import("../../src/telemetry/sentry.js");
		logDebug("d");
		logInfo("i");
		logWarn("w");
		logError("e");
		expect(loggerDebug).not.toHaveBeenCalled();
		expect(loggerInfo).not.toHaveBeenCalled();
		expect(loggerWarn).not.toHaveBeenCalled();
		expect(loggerError).not.toHaveBeenCalled();
	});

	it("delegate to Sentry.logger when initialized", async () => {
		process.env.SENTRY_DSN = "https://x@o1.ingest.sentry.io/1";
		const { initSentry, logDebug, logInfo, logWarn, logError } = await import("../../src/telemetry/sentry.js");
		initSentry();
		logDebug("d");
		logInfo("i");
		logWarn("w");
		logError("e");
		expect(loggerDebug).toHaveBeenCalledWith("d");
		expect(loggerInfo).toHaveBeenCalledWith("i");
		expect(loggerWarn).toHaveBeenCalledWith("w");
		expect(loggerError).toHaveBeenCalledWith("e");
	});
});

describe("scrubPii", () => {
	it("strips Windows paths from strings", async () => {
		const { scrubPii } = await import("../../src/telemetry/sentry.js");
		expect(scrubPii("file at C:\\Users\\alice\\file.txt")).toBe("file at [redacted]");
	});

	it("strips Unix user paths from strings", async () => {
		const { scrubPii } = await import("../../src/telemetry/sentry.js");
		expect(scrubPii("reading /home/bob/secret")).toBe("reading [redacted]");
	});

	it("strips process.env references", async () => {
		const { scrubPii } = await import("../../src/telemetry/sentry.js");
		expect(scrubPii("value: process.env.API_KEY")).toBe("value: [redacted]");
	});

	it("strips Sentry DSN URLs", async () => {
		const { scrubPii } = await import("../../src/telemetry/sentry.js");
		const dsn = "https://abc123def@o12345.ingest.us.sentry.io/1234567";
		expect(scrubPii(`dsn: ${dsn}`)).toBe("dsn: [redacted]");
	});

	it("redacts prompt text in objects", async () => {
		const { scrubPii } = await import("../../src/telemetry/sentry.js");
		const result = scrubPii({ prompt: "secret deploy prompt here" }) as Record<string, string>;
		expect(result.prompt).toBe("[redacted]");
	});

	it("redacts filename and abs_path in objects", async () => {
		const { scrubPii } = await import("../../src/telemetry/sentry.js");
		const result = scrubPii({ filename: "C:\\Users\\alice\\file.ts", abs_path: "/home/bob/x" }) as Record<string, string>;
		expect(result.filename).toBe("[redacted]");
		expect(result.abs_path).toBe("[redacted]");
	});

	it("recurses into nested arrays", async () => {
		const { scrubPii } = await import("../../src/telemetry/sentry.js");
		const result = scrubPii(["C:\\a\\b", "ok", "/home/u/x"]) as string[];
		expect(result).toEqual(["[redacted]", "ok", "[redacted]"]);
	});

	it("passes through primitives unchanged", async () => {
		const { scrubPii } = await import("../../src/telemetry/sentry.js");
		expect(scrubPii(42)).toBe(42);
		expect(scrubPii(null)).toBe(null);
		expect(scrubPii(undefined)).toBe(undefined);
	});
});

describe("wrapToolExecute", () => {
	it("adds a breadcrumb and returns the result", async () => {
		process.env.SENTRY_DSN = "https://x@o1.ingest.sentry.io/1";
		const { initSentry, wrapToolExecute } = await import("../../src/telemetry/sentry.js");
		initSentry();
		const fn = vi.fn().mockResolvedValue("ok");
		const wrapped = wrapToolExecute("loop_create", fn);
		await expect(wrapped("arg1", "arg2")).resolves.toBe("ok");
		expect(fn).toHaveBeenCalledWith("arg1", "arg2");
		expect(addBreadcrumb).toHaveBeenCalledWith(
			expect.objectContaining({ message: "tool:loop_create" }),
		);
	});

	it("captures and re-throws on error", async () => {
		process.env.SENTRY_DSN = "https://x@o1.ingest.sentry.io/1";
		const { initSentry, wrapToolExecute } = await import("../../src/telemetry/sentry.js");
		initSentry();
		const err = new Error("tool failed");
		const fn = vi.fn().mockRejectedValue(err);
		const wrapped = wrapToolExecute("monitor_create", fn);
		await expect(wrapped()).rejects.toBe(err);
		// The mock's captureException was called with the error
		expect(captureException).toHaveBeenCalled();
	});
});

describe("flushSentry", () => {
	it("is a no-op when not initialized", async () => {
		const { flushSentry } = await import("../../src/telemetry/sentry.js");
		await expect(flushSentry()).resolves.toBeUndefined();
		expect(flush).not.toHaveBeenCalled();
	});

	it("calls Sentry.flush when initialized", async () => {
		process.env.SENTRY_DSN = "https://x@o1.ingest.sentry.io/1";
		const { initSentry, flushSentry } = await import("../../src/telemetry/sentry.js");
		initSentry();
		await flushSentry(5000);
		expect(flush).toHaveBeenCalledWith(5000);
	});
});
