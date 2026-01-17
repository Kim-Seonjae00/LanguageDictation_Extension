// SubFluent logging utility
// Design: Facade (simple API) + Strategy (level filtering)

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
    DEBUG: 10,
    INFO: 20,
    WARN: 30,
    ERROR: 40,
};

let currentLogLevel: LogLevel = "INFO";

export function setSubFluentLogLevel(level: LogLevel) {
    currentLogLevel = level;
}

function shouldLog(level: LogLevel): boolean {
    return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[currentLogLevel];
}

function formatPrefix(level: LogLevel) {
    return `[SubFluent][${level}]`;
}

// ---- Facade APIs ----

export function subFluentDebug(msg: string, ...args: any[]) {
    if (!shouldLog("DEBUG")) return;
    console.debug(formatPrefix("DEBUG"), msg, ...args);
}

export function subFluentInfo(msg: string, ...args: any[]) {
    if (!shouldLog("INFO")) return;
    console.info(formatPrefix("INFO"), msg, ...args);
}

export function subFluentWarn(msg: string, ...args: any[]) {
    if (!shouldLog("WARN")) return;
    console.warn(formatPrefix("WARN"), msg, ...args);
}

export function subFluentError(msg: string, ...args: any[]) {
    if (!shouldLog("ERROR")) return;
    console.error(formatPrefix("ERROR"), msg, ...args);
}

// Backward compatibility (optional): keep old name as INFO
export function subFluentLog(msg: string, ...args: any[]) {
    subFluentInfo(msg, ...args);
}