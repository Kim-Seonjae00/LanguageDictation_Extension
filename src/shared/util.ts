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

const PREFIX: Record<LogLevel, string> = {
    DEBUG: "[SubFluent][DEBUG]",
    INFO: "[SubFluent][INFO]",
    WARN: "[SubFluent][WARN]",
    ERROR: "[SubFluent][ERROR]",
};

// ---- Facade APIs ----

export function subFluentDebug(msg: any, ...args: any[]) {
    if (!shouldLog("DEBUG")) return;
    // Make the first console argument a plain string to keep logs clean under minifiers.
    if (typeof msg === "string") console.debug(`${PREFIX.DEBUG} ${msg}`, ...args);
    else console.debug(PREFIX.DEBUG, msg, ...args);
}

export function subFluentInfo(msg: any, ...args: any[]) {
    if (!shouldLog("INFO")) return;
    if (typeof msg === "string") console.info(`${PREFIX.INFO} ${msg}`, ...args);
    else console.info(PREFIX.INFO, msg, ...args);
}

export function subFluentWarn(msg: any, ...args: any[]) {
    if (!shouldLog("WARN")) return;
    if (typeof msg === "string") console.warn(`${PREFIX.WARN} ${msg}`, ...args);
    else console.warn(PREFIX.WARN, msg, ...args);
}

export function subFluentError(msg: any, ...args: any[]) {
    if (!shouldLog("ERROR")) return;
    if (typeof msg === "string") console.error(`${PREFIX.ERROR} ${msg}`, ...args);
    else console.error(PREFIX.ERROR, msg, ...args);
}

// Backward compatibility (optional): keep old name as INFO
export function subFluentLog(msg: string, ...args: any[]) {
    subFluentInfo(msg, ...args);
}