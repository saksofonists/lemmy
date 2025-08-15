import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { RawPair, ReplacementsConfig, Replacement } from "./types";
import { HTMLGenerator } from "./html-generator";

export interface InterceptorConfig {
	logDirectory?: string;
	logBaseName?: string;
	enableRealTimeHTML?: boolean;
	logLevel?: "debug" | "info" | "warn" | "error";
}

export class ClaudeTrafficLogger {
	private logDir: string;
	private logFile: string;
	private htmlFile: string;
	private pendingRequests: Map<string, any> = new Map();
	private pairs: RawPair[] = [];
	private config: InterceptorConfig;
	private htmlGenerator: HTMLGenerator;
	private replacements: Replacement[] = [];

	constructor(config: InterceptorConfig = {}) {
		this.config = {
			logDirectory: ".claude-trace",
			enableRealTimeHTML: true,
			logLevel: "info",
			...config,
		};

		// Create log directory if it doesn't exist
		this.logDir = this.config.logDirectory!;
		if (!fs.existsSync(this.logDir)) {
			fs.mkdirSync(this.logDir, { recursive: true });
		}

		// Generate filenames based on custom name or timestamp
		const logBaseName = config?.logBaseName || process.env.CLAUDE_TRACE_LOG_NAME;
		const fileBaseName =
			logBaseName || `log-${new Date().toISOString().replace(/[:.]/g, "-").replace("T", "-").slice(0, -5)}`; // Remove milliseconds and Z

		this.logFile = path.join(this.logDir, `${fileBaseName}.jsonl`);
		this.htmlFile = path.join(this.logDir, `${fileBaseName}.html`);

		// Initialize HTML generator
		this.htmlGenerator = new HTMLGenerator();

		// Load replacements if specified
		this.loadReplacements();

		// Clear log file
		fs.writeFileSync(this.logFile, "");

		// Output the actual filenames with absolute paths
		console.log(`Logs will be written to:`);
		console.log(`  JSONL: ${path.resolve(this.logFile)}`);
		console.log(`  HTML:  ${path.resolve(this.htmlFile)}`);
	}

	private isClaudeAPI(url: string | URL): boolean {
		const urlString = typeof url === "string" ? url : url.toString();
		const includeAllRequests = process.env.CLAUDE_TRACE_INCLUDE_ALL_REQUESTS === "true";

		// Support custom ANTHROPIC_BASE_URL
		const baseUrl = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";
		const apiHost = new URL(baseUrl).hostname;

		// Check for direct Anthropic API calls
		const isAnthropicAPI = urlString.includes(apiHost);

		// Check for AWS Bedrock Claude API calls
		const isBedrockAPI = urlString.includes("bedrock-runtime.") && urlString.includes(".amazonaws.com");

		if (includeAllRequests) {
			return isAnthropicAPI || isBedrockAPI; // Capture all Claude API requests
		}

		return (isAnthropicAPI && urlString.includes("/v1/messages")) || isBedrockAPI;
	}

	private generateRequestId(): string {
		return `req_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
	}

	private redactSensitiveHeaders(headers: Record<string, string>): Record<string, string> {
		const redactedHeaders = { ...headers };
		const sensitiveKeys = [
			"authorization",
			"x-api-key",
			"x-auth-token",
			"cookie",
			"set-cookie",
			"x-session-token",
			"x-access-token",
			"bearer",
			"proxy-authorization",
		];

		for (const key of Object.keys(redactedHeaders)) {
			const lowerKey = key.toLowerCase();
			if (sensitiveKeys.some((sensitive) => lowerKey.includes(sensitive))) {
				// Keep first 10 chars and last 4 chars, redact middle
				const value = redactedHeaders[key];
				if (value && value.length > 14) {
					redactedHeaders[key] = `${value.substring(0, 10)}...${value.slice(-4)}`;
				} else if (value && value.length > 4) {
					redactedHeaders[key] = `${value.substring(0, 2)}...${value.slice(-2)}`;
				} else {
					redactedHeaders[key] = "[REDACTED]";
				}
			}
		}

		return redactedHeaders;
	}

	private async cloneResponse(response: Response): Promise<Response> {
		// Clone the response to avoid consuming the body
		return response.clone();
	}

	private loadReplacements(): void {
		const replacementsFile = process.env.CLAUDE_TRACE_REPLACEMENTS_FILE;
		if (!replacementsFile) return;

		try {
			const content = fs.readFileSync(replacementsFile, "utf-8");
			const config: ReplacementsConfig = JSON.parse(content);
			this.replacements = config.replacements || [];
			console.log(`Loaded ${this.replacements.length} replacement patterns from ${replacementsFile}`);
		} catch (error) {
			console.error(`Failed to load replacements file: ${error}`);
		}
	}

	private escapeRegExp(string: string): string {
		// Escape special regex characters for literal string matching
		return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	}

	private applyToMessageContent(content: any, regex: RegExp, replace: string): any {
		// Handle both string format and array of content blocks
		if (typeof content === "string") {
			// Simple string content (older API format)
			return content.replace(regex, replace);
		} else if (Array.isArray(content)) {
			// Array of content blocks (current API format)
			for (const item of content) {
				if (item.type === "text" && item.text) {
					item.text = item.text.replace(regex, replace);
				}
			}
			return content;
		}
		return content;
	}

	private applyReplacements(body: any): any {
		if (!body || this.replacements.length === 0) return body;

		// Deep clone the body to avoid modifying the original
		const modifiedBody = JSON.parse(JSON.stringify(body));

		for (const replacement of this.replacements) {
			// Create regex based on the regex flag
			const pattern = replacement.regex ? replacement.find : this.escapeRegExp(replacement.find);
			const regex = new RegExp(pattern, "g");

			switch (replacement.where) {
				case "system-prompt":
					// Handle both string and array formats for system prompt
					if (typeof modifiedBody.system === "string") {
						modifiedBody.system = modifiedBody.system.replace(regex, replacement.replace);
					} else if (Array.isArray(modifiedBody.system)) {
						for (const item of modifiedBody.system) {
							if (item.type === "text" && item.text) {
								item.text = item.text.replace(regex, replacement.replace);
							}
						}
					}
					break;

				case "user-message":
					if (modifiedBody.messages && Array.isArray(modifiedBody.messages)) {
						for (const message of modifiedBody.messages) {
							if (message.role === "user") {
								message.content = this.applyToMessageContent(message.content, regex, replacement.replace);
							}
						}
					}
					break;

				case "assistant-message":
					if (modifiedBody.messages && Array.isArray(modifiedBody.messages)) {
						for (const message of modifiedBody.messages) {
							if (message.role === "assistant") {
								message.content = this.applyToMessageContent(message.content, regex, replacement.replace);
							}
						}
					}
					break;

				case "all-messages":
					// Apply to system prompt
					if (typeof modifiedBody.system === "string") {
						modifiedBody.system = modifiedBody.system.replace(regex, replacement.replace);
					} else if (Array.isArray(modifiedBody.system)) {
						for (const item of modifiedBody.system) {
							if (item.type === "text" && item.text) {
								item.text = item.text.replace(regex, replacement.replace);
							}
						}
					}
					// Apply to all messages
					if (modifiedBody.messages && Array.isArray(modifiedBody.messages)) {
						for (const message of modifiedBody.messages) {
							message.content = this.applyToMessageContent(message.content, regex, replacement.replace);
						}
					}
					break;

				case "tool-description":
					// Apply to tool descriptions
					if (modifiedBody.tools && Array.isArray(modifiedBody.tools)) {
						for (const tool of modifiedBody.tools) {
							if (tool.description && typeof tool.description === "string") {
								tool.description = tool.description.replace(regex, replacement.replace);
							}
							// Also check for nested input_schema description
							if (
								tool.input_schema &&
								tool.input_schema.description &&
								typeof tool.input_schema.description === "string"
							) {
								tool.input_schema.description = tool.input_schema.description.replace(
									regex,
									replacement.replace,
								);
							}
						}
					}
					break;
			}
		}

		return modifiedBody;
	}

	private async parseRequestBody(body: any): Promise<any> {
		if (!body) return null;

		if (typeof body === "string") {
			try {
				return JSON.parse(body);
			} catch {
				return body;
			}
		}

		if (body instanceof FormData) {
			const formObject: Record<string, any> = {};
			for (const [key, value] of body.entries()) {
				formObject[key] = value;
			}
			return formObject;
		}

		return body;
	}

	private async parseResponseBody(response: Response): Promise<{ body?: any; body_raw?: string }> {
		const contentType = response.headers.get("content-type") || "";

		try {
			if (contentType.includes("application/json")) {
				const body = await response.json();
				return { body };
			} else if (contentType.includes("text/event-stream")) {
				const body_raw = await response.text();
				return { body_raw };
			} else if (contentType.includes("text/")) {
				const body_raw = await response.text();
				return { body_raw };
			} else {
				// For other types, try to read as text
				const body_raw = await response.text();
				return { body_raw };
			}
		} catch (error) {
			// Silent error handling during runtime
			return {};
		}
	}

	public instrumentAll(): void {
		this.instrumentFetch();
		this.instrumentNodeHTTP();
	}

	public instrumentFetch(): void {
		if (!global.fetch) {
			// Silent - fetch not available
			return;
		}

		// Check if already instrumented by checking for our marker
		if ((global.fetch as any).__claudeTraceInstrumented) {
			return;
		}

		const originalFetch = global.fetch;
		const logger = this;

		global.fetch = async function (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
			// Convert input to URL for consistency
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

			// Only intercept Claude API calls
			if (!logger.isClaudeAPI(url)) {
				return originalFetch(input, init);
			}

			const requestId = logger.generateRequestId();
			const requestTimestamp = Date.now();

			// Parse the request body
			let parsedBody = await logger.parseRequestBody(init.body);

			// Apply replacements to the parsed body
			const modifiedBody = logger.applyReplacements(parsedBody);

			// Capture request details (for logging)
			const requestData = {
				timestamp: requestTimestamp / 1000, // Convert to seconds (like Python version)
				method: init.method || "GET",
				url: url,
				headers: logger.redactSensitiveHeaders(Object.fromEntries(new Headers(init.headers || {}).entries())),
				body: modifiedBody, // Log the modified body
			};

			// Update init.body with the modified body for the actual request
			if (modifiedBody !== parsedBody && modifiedBody) {
				init.body = JSON.stringify(modifiedBody);
			}

			// Store pending request
			logger.pendingRequests.set(requestId, requestData);

			try {
				// Make the actual request
				const response = await originalFetch(input, init);
				const responseTimestamp = Date.now();

				// Clone response to avoid consuming the body
				const clonedResponse = await logger.cloneResponse(response);

				// Parse response body
				const responseBodyData = await logger.parseResponseBody(clonedResponse);

				// Create response data
				const responseData = {
					timestamp: responseTimestamp / 1000,
					status_code: response.status,
					headers: logger.redactSensitiveHeaders(Object.fromEntries(response.headers.entries())),
					...responseBodyData,
				};

				// Create paired request-response object
				const pair: RawPair = {
					request: requestData,
					response: responseData,
					logged_at: new Date().toISOString(),
				};

				// Remove from pending and add to pairs
				logger.pendingRequests.delete(requestId);
				logger.pairs.push(pair);

				// Write to log file
				await logger.writePairToLog(pair);

				// Generate HTML if enabled
				if (logger.config.enableRealTimeHTML) {
					await logger.generateHTML();
				}

				return response;
			} catch (error) {
				// Remove from pending requests on error
				logger.pendingRequests.delete(requestId);
				throw error;
			}
		};

		// Mark fetch as instrumented
		(global.fetch as any).__claudeTraceInstrumented = true;

		// Silent initialization
	}

	public instrumentNodeHTTP(): void {
		try {
			const http = require("http");
			const https = require("https");
			const logger = this;

			// Instrument http.request
			if (http.request && !(http.request as any).__claudeTraceInstrumented) {
				const originalHttpRequest = http.request;
				http.request = function (options: any, callback?: any) {
					return logger.interceptNodeRequest(originalHttpRequest, options, callback, false);
				};
				(http.request as any).__claudeTraceInstrumented = true;
			}

			// Instrument http.get
			if (http.get && !(http.get as any).__claudeTraceInstrumented) {
				const originalHttpGet = http.get;
				http.get = function (options: any, callback?: any) {
					return logger.interceptNodeRequest(originalHttpGet, options, callback, false);
				};
				(http.get as any).__claudeTraceInstrumented = true;
			}

			// Instrument https.request
			if (https.request && !(https.request as any).__claudeTraceInstrumented) {
				const originalHttpsRequest = https.request;
				https.request = function (options: any, callback?: any) {
					return logger.interceptNodeRequest(originalHttpsRequest, options, callback, true);
				};
				(https.request as any).__claudeTraceInstrumented = true;
			}

			// Instrument https.get
			if (https.get && !(https.get as any).__claudeTraceInstrumented) {
				const originalHttpsGet = https.get;
				https.get = function (options: any, callback?: any) {
					return logger.interceptNodeRequest(originalHttpsGet, options, callback, true);
				};
				(https.get as any).__claudeTraceInstrumented = true;
			}
		} catch (error) {
			// Silent error handling
		}
	}

	private interceptNodeRequest(originalRequest: any, options: any, callback: any, isHttps: boolean) {
		// Parse URL from options
		const url = this.parseNodeRequestURL(options, isHttps);

		if (!this.isClaudeAPI(url)) {
			return originalRequest.call(this, options, callback);
		}

		const requestId = this.generateRequestId();
		const requestTimestamp = Date.now();
		let requestBody = "";

		// Create the request
		const req = originalRequest.call(this, options, (res: any) => {
			const responseTimestamp = Date.now();
			let responseBody = "";

			// Capture response data
			res.on("data", (chunk: any) => {
				responseBody += chunk;
			});

			res.on("end", async () => {
				// Process the captured request/response
				const requestData = {
					timestamp: requestTimestamp / 1000,
					method: options.method || "GET",
					url: url,
					headers: this.redactSensitiveHeaders(options.headers || {}),
					body: requestBody ? await this.parseRequestBody(requestBody) : null,
				};

				const responseData = {
					timestamp: responseTimestamp / 1000,
					status_code: res.statusCode,
					headers: this.redactSensitiveHeaders(res.headers || {}),
					...(await this.parseResponseBodyFromString(responseBody, res.headers["content-type"])),
				};

				const pair: RawPair = {
					request: requestData,
					response: responseData,
					logged_at: new Date().toISOString(),
				};

				this.pairs.push(pair);
				await this.writePairToLog(pair);

				if (this.config.enableRealTimeHTML) {
					await this.generateHTML();
				}
			});

			// Call original callback if provided
			if (callback) {
				callback(res);
			}
		});

		// Capture request body
		const originalWrite = req.write;
		req.write = function (chunk: any) {
			if (chunk) {
				requestBody += chunk;
			}
			return originalWrite.call(this, chunk);
		};

		return req;
	}

	private parseNodeRequestURL(options: any, isHttps: boolean): string {
		if (typeof options === "string") {
			return options;
		}

		const protocol = isHttps ? "https:" : "http:";
		const hostname = options.hostname || options.host || "localhost";
		const port = options.port ? `:${options.port}` : "";
		const path = options.path || "/";

		return `${protocol}//${hostname}${port}${path}`;
	}

	private async parseResponseBodyFromString(
		body: string,
		contentType?: string,
	): Promise<{ body?: any; body_raw?: string }> {
		try {
			if (contentType && contentType.includes("application/json")) {
				return { body: JSON.parse(body) };
			} else if (contentType && contentType.includes("text/event-stream")) {
				return { body_raw: body };
			} else {
				return { body_raw: body };
			}
		} catch (error) {
			return { body_raw: body };
		}
	}

	private async writePairToLog(pair: RawPair): Promise<void> {
		try {
			const jsonLine = JSON.stringify(pair) + "\n";
			fs.appendFileSync(this.logFile, jsonLine);
		} catch (error) {
			// Silent error handling during runtime
		}
	}

	private async generateHTML(): Promise<void> {
		try {
			const includeAllRequests = process.env.CLAUDE_TRACE_INCLUDE_ALL_REQUESTS === "true";
			await this.htmlGenerator.generateHTML(this.pairs, this.htmlFile, {
				title: `${this.pairs.length} API Calls`,
				timestamp: new Date().toISOString().replace("T", " ").slice(0, -5),
				includeAllRequests,
			});
			// Silent HTML generation
		} catch (error) {
			// Silent error handling during runtime
		}
	}

	public cleanup(): void {
		console.log("Cleaning up orphaned requests...");

		for (const [, requestData] of this.pendingRequests.entries()) {
			const orphanedPair = {
				request: requestData,
				response: null,
				note: "ORPHANED_REQUEST - No matching response received",
				logged_at: new Date().toISOString(),
			};

			try {
				const jsonLine = JSON.stringify(orphanedPair) + "\n";
				fs.appendFileSync(this.logFile, jsonLine);
			} catch (error) {
				console.log(`Error writing orphaned request: ${error}`);
			}
		}

		this.pendingRequests.clear();
		console.log(`Cleanup complete. Logged ${this.pairs.length} pairs`);

		// Open browser if requested
		const shouldOpenBrowser = process.env.CLAUDE_TRACE_OPEN_BROWSER === "true";
		if (shouldOpenBrowser && fs.existsSync(this.htmlFile)) {
			try {
				spawn("open", [this.htmlFile], { detached: true, stdio: "ignore" }).unref();
				console.log(`Opening ${this.htmlFile} in browser`);
			} catch (error) {
				console.log(`Failed to open browser: ${error}`);
			}
		}
	}

	public getStats() {
		return {
			totalPairs: this.pairs.length,
			pendingRequests: this.pendingRequests.size,
			logFile: this.logFile,
			htmlFile: this.htmlFile,
		};
	}
}

// Global logger instance
let globalLogger: ClaudeTrafficLogger | null = null;

// Track if event listeners have been set up
let eventListenersSetup = false;

export function initializeInterceptor(config?: InterceptorConfig): ClaudeTrafficLogger {
	if (globalLogger) {
		console.warn("Interceptor already initialized");
		return globalLogger;
	}

	globalLogger = new ClaudeTrafficLogger(config);
	globalLogger.instrumentAll();

	// Setup cleanup on process exit only once
	if (!eventListenersSetup) {
		const cleanup = () => {
			if (globalLogger) {
				globalLogger.cleanup();
			}
		};

		process.on("exit", cleanup);
		process.on("SIGINT", cleanup);
		process.on("SIGTERM", cleanup);
		process.on("uncaughtException", (error) => {
			console.error("Uncaught exception:", error);
			cleanup();
			process.exit(1);
		});

		eventListenersSetup = true;
	}

	return globalLogger;
}

export function getLogger(): ClaudeTrafficLogger | null {
	return globalLogger;
}
