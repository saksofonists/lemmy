export interface InterceptorConfig {
    logDirectory?: string;
    logBaseName?: string;
    enableRealTimeHTML?: boolean;
    logLevel?: "debug" | "info" | "warn" | "error";
}
export declare class ClaudeTrafficLogger {
    private logDir;
    private logFile;
    private htmlFile;
    private pendingRequests;
    private pairs;
    private config;
    private htmlGenerator;
    private replacements;
    constructor(config?: InterceptorConfig);
    private isClaudeAPI;
    private generateRequestId;
    private redactSensitiveHeaders;
    private cloneResponse;
    private loadReplacements;
    private escapeRegExp;
    private applyToMessageContent;
    private applyReplacements;
    private parseRequestBody;
    private parseResponseBody;
    instrumentAll(): void;
    instrumentFetch(): void;
    instrumentNodeHTTP(): void;
    private interceptNodeRequest;
    private parseNodeRequestURL;
    private parseResponseBodyFromString;
    private writePairToLog;
    private generateHTML;
    cleanup(): void;
    getStats(): {
        totalPairs: number;
        pendingRequests: number;
        logFile: string;
        htmlFile: string;
    };
}
export declare function initializeInterceptor(config?: InterceptorConfig): ClaudeTrafficLogger;
export declare function getLogger(): ClaudeTrafficLogger | null;
//# sourceMappingURL=interceptor.d.ts.map